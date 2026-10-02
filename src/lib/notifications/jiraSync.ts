import { createReadOnlyJiraClient, readOnlyJiraConfigFromEnv } from "@/lib/escalation/readOnlyJira";
import { searchByKeys } from "@/lib/escalation/sweep";
import { notificationsFromJiraChanges } from "@/lib/notifications/jiraChanges";
import { addNotifications } from "@/lib/notifications/store";
import { getRedis, isRedisConfigured } from "@/lib/redis";
import { listRegisteredJiraUsers } from "@/lib/userJiraTokens";

import type { ReadOnlyJiraClient } from "@/lib/escalation/readOnlyJira";
import type { JiraCommentRecord, JiraHistory, JiraUserRef, LinkedTicket, WatchedIssue } from "@/lib/notifications/jiraChanges";
import type { AppNotification } from "@/lib/notifications/types";

/**
 * Turns recent Jira activity into notifications. Vercel Hobby cron only runs
 * daily, so nothing here is scheduled: every open dashboard polls
 * /api/notifications, and the poll kicks off at most one sync per minute
 * across all browsers (Redis throttle). When nobody has the dashboard open,
 * nothing runs; the next sync then catches up from its cursor, up to a day
 * back.
 *
 * Reads go through the escalation pilot's read-only Jira client, so a sync
 * can't write to Jira even by mistake. It only asks for what a notification
 * shows: keys, statuses, assignees, summaries and the newest comments.
 */

const CURSOR_KEY = "notif:jira:cursor";
const THROTTLE_KEY = "notif:jira:throttle";
const RUNNING_KEY = "notif:jira:running";
const THROTTLE_SECONDS = 60;
const RUNNING_LOCK_SECONDS = 240;
/* Re-read a little before the cursor: Jira's search index can lag a write by a few seconds. Ids dedupe the overlap. */
const OVERLAP_MS = 2 * 60_000;
const FIRST_RUN_LOOKBACK_MS = 15 * 60_000;
const MAX_LOOKBACK_MS = 24 * 3_600_000;
const COMMENTS_PER_ISSUE = 10;
const COMMENT_FETCH_CONCURRENCY = 4;

const TS_FIELDS = ["assignee", "reporter", "status", "summary", "updated"];
const CP_LIGHT_FIELDS = ["issuelinks", "updated"];
const CP_FIELDS = ["assignee", "status", "summary", "updated"];

interface RawIssue {
  changelog?: { histories?: JiraHistory[] };
  fields: {
    assignee?: JiraUserRef | null;
    issuelinks?: Array<{ inwardIssue?: { key?: string }; outwardIssue?: { key?: string } }>;
    reporter?: JiraUserRef | null;
    summary?: string;
    updated?: string;
  };
  key: string;
}

export interface JiraSyncResult {
  added: number;
  cpsWatched: number;
  skipped?: "already_running" | "no_registered_users" | "throttled" | "unconfigured";
  ticketsWatched: number;
  windowMinutes: number;
}

/* Account ids are opaque ("557058:1b2c..." or hex), so they're quoted rather than trusted bare in JQL. */
function jqlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function linkedKeys(issue: RawIssue, prefix: string): string[] {
  return (issue.fields.issuelinks ?? [])
    .map((link) => (link.inwardIssue ?? link.outwardIssue)?.key)
    .filter((key): key is string => typeof key === "string" && key.startsWith(prefix));
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        out[index] = await fn(items[index] as T);
      }
    }),
  );
  return out;
}

export interface CollectedJiraNotifications {
  cpsWatched: number;
  notifications: AppNotification[];
  ticketsWatched: number;
}

/**
 * The read half of a sync: what changed for these users since `sinceMs`,
 * as notifications. Writes nothing anywhere - scripts/preview-notifications.ts
 * runs it against live Jira to show what the bell would say.
 */
export async function collectJiraNotifications(args: {
  baseUrl: string;
  client: ReadOnlyJiraClient;
  nowMs: number;
  sinceMs: number;
  users: Array<{ accountId: string }>;
}): Promise<CollectedJiraNotifications> {
  const { baseUrl, client, nowMs, sinceMs, users } = args;
  /* Relative JQL dates ("-17m") are evaluated by Jira itself, so the service account's profile timezone can't skew the window. */
  const windowMinutes = Math.max(1, Math.ceil((nowMs - sinceMs) / 60_000));
  const registered = new Set(users.map((user) => user.accountId));
  const assignees = users.map((user) => jqlString(user.accountId)).join(", ");

  /* Newest first: if a long catch-up (a quiet night, up to a day) hits the cap, it's the oldest changes that get dropped. */
  const [tsIssues, cpLight] = await Promise.all([
    client.searchJql<RawIssue>(
      `project = TS AND assignee in (${assignees}) AND updated >= -${windowMinutes}m ORDER BY updated DESC`,
      TS_FIELDS,
      { expand: "changelog", maxTotal: 200 },
    ),
    client.searchJql<RawIssue>(`project = CP AND updated >= -${windowMinutes}m ORDER BY updated DESC`, CP_LIGHT_FIELDS, { maxTotal: 300 }),
  ]);

  /* A CP only matters here if a registered user's TS ticket links to it. */
  const cpToTs = new Map(cpLight.map((cp) => [cp.key, linkedKeys(cp, "TS-")]));
  const linkedTsKeys = [...new Set([...cpToTs.values()].flat())];
  const ownedLinkedTs = await searchByKeys<RawIssue>(client, linkedTsKeys, ["assignee"], { extraJql: ` AND assignee in (${assignees})` });
  const ownerByTs = new Map(
    ownedLinkedTs.flatMap((issue) => (issue.fields.assignee?.accountId ? [[issue.key, issue.fields.assignee.accountId] as const] : [])),
  );
  const relevantCpKeys = [...cpToTs.entries()].filter(([, tsKeys]) => tsKeys.some((key) => ownerByTs.has(key))).map(([key]) => key);
  const cpIssues = relevantCpKeys.length > 0 ? await searchByKeys<RawIssue>(client, relevantCpKeys, CP_FIELDS, { expand: "changelog" }) : [];

  /* Comments aren't in the changelog: one small read per issue that changed inside the window. */
  const needComments = [...tsIssues, ...cpIssues].filter((issue) => {
    const updatedMs = Date.parse(issue.fields.updated ?? "");
    return Number.isNaN(updatedMs) || updatedMs >= sinceMs;
  });
  const commentLists = await mapLimit(needComments, COMMENT_FETCH_CONCURRENCY, async (issue): Promise<[string, JiraCommentRecord[]]> => {
    try {
      const page = await client.get<{ comments?: JiraCommentRecord[] }>(`/rest/api/3/issue/${issue.key}/comment`, {
        maxResults: COMMENTS_PER_ISSUE,
        orderBy: "-created",
      });
      return [issue.key, page.comments ?? []];
    } catch (error) {
      /* One unreadable issue mustn't sink the whole sync; its status changes still come through. */
      console.warn(`Notification sync: could not read comments on ${issue.key}.`, error instanceof Error ? error.message : error);
      return [issue.key, []];
    }
  });
  const commentsByKey = new Map<string, JiraCommentRecord[]>(commentLists);

  const toWatched = (issue: RawIssue): WatchedIssue => ({
    assignee: issue.fields.assignee ?? null,
    comments: commentsByKey.get(issue.key) ?? [],
    histories: issue.changelog?.histories ?? [],
    key: issue.key,
    reporterAccountId: issue.fields.reporter?.accountId,
    summary: issue.fields.summary,
  });

  const notifications = notificationsFromJiraChanges({
    baseUrl,
    cps: cpIssues.map((cp) => ({
      issue: toWatched(cp),
      linkedTickets: (cpToTs.get(cp.key) ?? []).flatMap((key): LinkedTicket[] => {
        const owner = ownerByTs.get(key);
        return owner ? [{ assigneeAccountId: owner, key }] : [];
      }),
    })),
    registeredAccountIds: registered,
    sinceMs,
    tickets: tsIssues.map(toWatched),
  });

  return { cpsWatched: cpIssues.length, notifications, ticketsWatched: tsIssues.length };
}

/** Throttled entry point for the poll route: runs a sync only if none started in the last minute. */
export async function maybeSyncJiraNotifications(): Promise<JiraSyncResult | null> {
  if (!isRedisConfigured()) {
    return null;
  }
  const acquired = await getRedis().set(THROTTLE_KEY, new Date().toISOString(), { ex: THROTTLE_SECONDS, nx: true });
  return acquired === "OK" ? syncJiraNotifications() : null;
}

export async function syncJiraNotifications(now: Date = new Date()): Promise<JiraSyncResult> {
  const empty = { added: 0, cpsWatched: 0, ticketsWatched: 0, windowMinutes: 0 };

  if (!isRedisConfigured()) {
    return { ...empty, skipped: "unconfigured" };
  }

  const redis = getRedis();
  if ((await redis.set(RUNNING_KEY, now.toISOString(), { ex: RUNNING_LOCK_SECONDS, nx: true })) !== "OK") {
    return { ...empty, skipped: "already_running" };
  }

  try {
    const users = await listRegisteredJiraUsers();
    if (users.length === 0) {
      return { ...empty, skipped: "no_registered_users" };
    }

    const nowMs = now.getTime();
    const cursorMs = Date.parse((await redis.get<string>(CURSOR_KEY)) ?? "");
    const sinceMs = Math.max((Number.isNaN(cursorMs) ? nowMs - FIRST_RUN_LOOKBACK_MS : cursorMs) - OVERLAP_MS, nowMs - MAX_LOOKBACK_MS);
    const config = readOnlyJiraConfigFromEnv();
    const collected = await collectJiraNotifications({
      baseUrl: config.baseUrl,
      client: createReadOnlyJiraClient(config),
      nowMs,
      sinceMs,
      users,
    });

    /* Scored when written, not when the sync started: the reads take seconds, and a Slack item written
       meanwhile must not sort above this batch (the bell only toasts what's newer than it has seen). */
    const added = await addNotifications(collected.notifications, new Date());
    await redis.set(CURSOR_KEY, now.toISOString(), { ex: 7 * 86_400 });

    return {
      added: added.length,
      cpsWatched: collected.cpsWatched,
      ticketsWatched: collected.ticketsWatched,
      windowMinutes: Math.max(1, Math.ceil((nowMs - sinceMs) / 60_000)),
    };
  } finally {
    await redis.del(RUNNING_KEY);
  }
}
