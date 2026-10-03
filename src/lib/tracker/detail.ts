import { deleteCache, getCache, setCache } from "@/lib/cache";
import { createReadOnlyJiraClient, readOnlyJiraConfigFromEnv } from "@/lib/escalation/readOnlyJira";
import { loadRecord } from "@/lib/escalation/runnerStore";
import { searchByKeys } from "@/lib/escalation/sweep";
import { adfToText } from "@/lib/notifications/jiraChanges";
import { listNotifications } from "@/lib/notifications/store";
import { getFollowedKeys } from "@/lib/tracker/follow";
import { getConversationsForTickets } from "@/lib/tracker/slackIndex";
import { fetchTrackerTicket, getTrackerSnapshot } from "@/lib/tracker/snapshot";

import type { ReadOnlyJiraClient } from "@/lib/escalation/readOnlyJira";
import type { JiraCommentRecord, JiraHistory } from "@/lib/notifications/jiraChanges";
import type { NotificationView } from "@/lib/notifications/types";
import type { SlackConversationRef, TimelineItem, TrackerDetail, TrackerTicket } from "@/lib/tracker/types";

/**
 * One ticket's detail panel: the snapshot row plus a live, merged timeline
 * (Pylon's "activity" column) of
 * - the TS ticket's comments and internal notes, and its status / priority /
 *   assignee / link changes
 * - up to 3 linked CPs: their comments and status moves (a tab per CP)
 * - every Slack conversation indexed for the ticket or those CPs (a tab each)
 * - Slack and escalation notifications from the team feed, and the bot's
 *   own escalation thread
 * Jira-sourced notifications are left out: the live comments and changelog
 * already show the same events, with their full text.
 *
 * Assembled at most once a minute per ticket (Redis cache), and never
 * throws - a piece that can't be read becomes a line in `errors`.
 */

const BODY_MAX_CHARS = 1_000;
const TS_COMMENTS = 50;
const CP_COMMENTS = 20;
const MAX_CPS = 3;
const NOTIFICATION_PAGES = 4;
const NOTIFICATION_PAGE_SIZE = 50;
const DETAIL_CACHE_SECONDS = 60;

type CachedDetail = Omit<TrackerDetail, "following">;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function issueUrl(baseUrl: string, key: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/browse/${key}`;
}

function isoOrNull(value: string | undefined): string | null {
  const ms = value ? Date.parse(value) : Number.NaN;
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/* Slack ts ("1727881200.000100") -> ISO. */
export function slackTsToIso(ts: string): string | null {
  const seconds = Number(ts);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(Math.floor(seconds * 1000)).toISOString() : null;
}

/* ------------------------------------------------------- pure: timeline */

/** TS or CP comments as timeline items. CP activity and TS internal notes are internal; public TS comments aren't. */
export function commentItems(comments: JiraCommentRecord[], args: { baseUrl: string; issueKey: string; on: "cp" | "ts" }): TimelineItem[] {
  return comments.flatMap((comment): TimelineItem[] => {
    const at = isoOrNull(comment.created);
    if (!at) {
      return [];
    }
    const actor = comment.author?.displayName;
    const name = actor ?? (comment.author?.accountType === "customer" ? "The customer" : "Someone");
    const url = `${issueUrl(args.baseUrl, args.issueKey)}${comment.id ? `?focusedCommentId=${encodeURIComponent(comment.id)}` : ""}`;
    const id = `${args.issueKey}:c${comment.id ?? at}`;
    const body = adfToText(comment.body, BODY_MAX_CHARS);

    if (args.on === "cp") {
      return [{ actor, at, body, id, internal: true, kind: "cp_comment", source: "cp", sourceLabel: args.issueKey, thread: args.issueKey, title: `${name} commented on ${args.issueKey}`, url }];
    }
    const internalNote = comment.jsdPublic === false;
    return [
      {
        actor,
        at,
        body,
        id,
        internal: internalNote,
        kind: internalNote ? "jira_internal_note" : "jira_comment",
        source: "jira",
        sourceLabel: args.issueKey,
        title: internalNote ? `${name} added an internal note` : comment.author?.accountType === "customer" ? `${name} replied` : `${name} commented`,
        url,
      },
    ];
  });
}

/** Changelog -> status / priority / assignee / link items (TS), or status moves only (CP). */
export function changelogItems(histories: JiraHistory[], args: { baseUrl: string; issueKey: string; on: "cp" | "ts" }): TimelineItem[] {
  const url = issueUrl(args.baseUrl, args.issueKey);
  const out: TimelineItem[] = [];
  for (const history of histories) {
    const at = isoOrNull(history.created);
    if (!at) {
      continue;
    }
    const actor = history.author?.displayName;
    for (const item of history.items ?? []) {
      const field = item.fieldId ?? item.field ?? "";
      const from = item.fromString ?? "none";
      const to = item.toString ?? "none";
      const base = { actor, at, id: `${args.issueKey}:h${history.id ?? at}:${field}`, sourceLabel: args.issueKey, url };

      if (args.on === "cp") {
        if (field === "status") {
          out.push({ ...base, body: `${from} → ${to}`, internal: true, kind: "cp_status", source: "cp", thread: args.issueKey, title: `${args.issueKey} moved to ${to}` });
        }
      } else if (field === "status") {
        out.push({ ...base, body: `${from} → ${to}`, internal: false, kind: "jira_status", source: "jira", title: `Moved to ${to}` });
      } else if (field === "priority") {
        out.push({ ...base, body: `${from} → ${to}`, internal: false, kind: "jira_priority", source: "jira", title: `Priority changed to ${to}` });
      } else if (field === "assignee") {
        out.push({ ...base, internal: false, kind: "jira_assignee", source: "jira", title: item.toString ? `Assigned to ${item.toString}` : "Unassigned" });
      } else if (field === "Link" || field === "issuelinks") {
        const added = Boolean(item.toString);
        out.push({
          ...base,
          body: (item.toString ?? item.fromString) || undefined,
          internal: false,
          kind: "jira_link",
          source: "jira",
          title: added ? "Linked an issue" : "Removed a link",
        });
      }
    }
  }
  return out;
}

export function conversationItems(conversations: SlackConversationRef[]): TimelineItem[] {
  return conversations.map((conv) => {
    const channel = `#${conv.channelName ?? conv.channel}`;
    const replies = conv.replyCount === 1 ? "1 reply" : `${conv.replyCount} replies`;
    return {
      actor: conv.startedByName,
      at: slackTsToIso(conv.rootTs) ?? conv.firstSeenAt,
      body: conv.snippet,
      id: `slack:${conv.id}`,
      internal: true,
      kind: "slack_conversation",
      source: "slack",
      sourceLabel: channel,
      thread: conv.id,
      title: `${conv.startedByName ?? "Someone"} started a thread in ${channel} (${replies})`,
      url: conv.permalink,
    };
  });
}

/** Team-feed notifications about this ticket or its CPs, minus Jira-sourced ones the live timeline already shows. */
export function notificationItems(views: NotificationView[], keys: ReadonlySet<string>): TimelineItem[] {
  return views
    .filter((view) => (view.ticketKey && keys.has(view.ticketKey)) || (view.cpKey && keys.has(view.cpKey)))
    .filter((view) => view.source !== "jira" || view.kind === "tracker_sla")
    .map((view) => ({
      actor: view.actor,
      at: view.at,
      body: view.detail,
      id: `notif:${view.id}`,
      internal: view.source !== "jira",
      kind: view.source === "slack" ? ("slack_message" as const) : ("notification" as const),
      source: view.source === "slack" ? ("slack" as const) : view.source === "escalation" ? ("bot" as const) : ("system" as const),
      sourceLabel: view.source === "slack" ? "Slack" : view.source === "escalation" ? "Escalation bot" : (view.cpKey ?? view.ticketKey ?? ""),
      title: view.title,
      url: view.url,
    }));
}

export function botItem(bot: NonNullable<TrackerTicket["botEscalation"]>, at: string): TimelineItem {
  return {
    at,
    body: `State: ${bot.state}${bot.levelSent > 0 ? ` · level ${bot.levelSent} sent` : ""}`,
    id: `bot:${bot.cpKey}`,
    internal: true,
    kind: "bot_escalation",
    source: "bot",
    sourceLabel: "Escalation bot",
    thread: bot.cpKey,
    title: `Escalation bot opened a thread for ${bot.cpKey}`,
    url: bot.permalink,
  };
}

/** Oldest first, one item per id. */
export function mergeTimeline(groups: TimelineItem[][]): TimelineItem[] {
  const byId = new Map<string, TimelineItem>();
  for (const item of groups.flat()) {
    if (!byId.has(item.id)) {
      byId.set(item.id, item);
    }
  }
  return [...byId.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/* ---------------------------------------------------------------- reads */

async function safely<T>(label: string, errors: string[], fallback: T, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    errors.push(`${label}: ${errorText(error)}`);
    return fallback;
  }
}

async function jiraItems(client: ReadOnlyJiraClient, baseUrl: string, ticket: TrackerTicket, errors: string[]): Promise<TimelineItem[][]> {
  const cpKeys = ticket.cps.map((cp) => cp.key).slice(0, MAX_CPS);
  const [tsComments, tsChangelog, cpChangelogs, cpComments] = await Promise.all([
    safely("Jira comments", errors, [] as JiraCommentRecord[], async () => {
      const page = await client.get<{ comments?: JiraCommentRecord[] }>(`/rest/api/3/issue/${ticket.key}/comment`, { maxResults: TS_COMMENTS, orderBy: "-created" });
      return page.comments ?? [];
    }),
    safely("Jira history", errors, [] as JiraHistory[], async () => {
      const [issue] = await client.searchJql<{ changelog?: { histories?: JiraHistory[] }; key: string }>(`key = ${ticket.key}`, ["status"], {
        expand: "changelog",
        maxTotal: 1,
      });
      return issue?.changelog?.histories ?? [];
    }),
    safely("CP history", errors, [] as Array<{ changelog?: { histories?: JiraHistory[] }; key: string }>, () =>
      searchByKeys<{ changelog?: { histories?: JiraHistory[] }; key: string }>(client, cpKeys, ["status"], { expand: "changelog" }),
    ),
    Promise.all(
      cpKeys.map((cpKey) =>
        safely(`${cpKey} comments`, errors, [] as JiraCommentRecord[], async () => {
          const page = await client.get<{ comments?: JiraCommentRecord[] }>(`/rest/api/3/issue/${cpKey}/comment`, { maxResults: CP_COMMENTS, orderBy: "-created" });
          return page.comments ?? [];
        }).then((comments) => commentItems(comments, { baseUrl, issueKey: cpKey, on: "cp" })),
      ),
    ),
  ]);

  return [
    commentItems(tsComments, { baseUrl, issueKey: ticket.key, on: "ts" }),
    changelogItems(tsChangelog, { baseUrl, issueKey: ticket.key, on: "ts" }),
    ...cpChangelogs.map((cp) => changelogItems(cp.changelog?.histories ?? [], { baseUrl, issueKey: cp.key, on: "cp" })),
    ...cpComments,
  ];
}

async function teamNotifications(accountId: string, keys: ReadonlySet<string>): Promise<TimelineItem[]> {
  const views: NotificationView[] = [];
  let before: number | undefined;
  for (let page = 0; page < NOTIFICATION_PAGES; page++) {
    const result = await listNotifications(accountId, { before, limit: NOTIFICATION_PAGE_SIZE, scope: "team" });
    views.push(...result.items);
    const last = result.items.at(-1);
    if (!result.hasMore || !last) {
      break;
    }
    before = last.score;
  }
  return notificationItems(views, keys);
}

function mergeConversations(byKey: Map<string, SlackConversationRef[]>, keys: string[]): SlackConversationRef[] {
  const byId = new Map<string, SlackConversationRef>();
  for (const key of keys) {
    for (const conv of byKey.get(key) ?? []) {
      byId.set(conv.id, conv);
    }
  }
  return [...byId.values()].sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt));
}

/* `errors` is filled in as reads fail, so the caller can tell "no such ticket" from "Jira didn't answer" when this returns null. */
async function assemble(key: string, accountId: string, errors: string[]): Promise<CachedDetail | null> {
  let config: ReturnType<typeof readOnlyJiraConfigFromEnv> | null = null;
  try {
    config = readOnlyJiraConfigFromEnv();
  } catch (error) {
    errors.push(errorText(error));
  }
  const client = config ? createReadOnlyJiraClient(config) : null;
  const baseUrl = config?.baseUrl ?? "";

  const snapshot = await getTrackerSnapshot();
  let ticket = snapshot?.tickets.find((row) => row.key === key) ?? null;
  if (!ticket && client) {
    ticket = await safely("Jira ticket", errors, null, () => fetchTrackerTicket(client, baseUrl, key, errors));
  }
  if (!ticket) {
    return null;
  }

  const cpKeys = ticket.cps.map((cp) => cp.key).slice(0, MAX_CPS);
  const keys = new Set([ticket.key, ...ticket.cps.map((cp) => cp.key)]);
  const bot = ticket.botEscalation;

  const [jira, conversationsByKey, notifications, botRecord] = await Promise.all([
    client ? jiraItems(client, baseUrl, ticket, errors) : Promise.resolve([] as TimelineItem[][]),
    safely("Slack conversations", errors, new Map<string, SlackConversationRef[]>(), () => getConversationsForTickets([ticket.key, ...cpKeys])),
    safely("Notifications", errors, [] as TimelineItem[], () => teamNotifications(accountId, keys)),
    bot ? safely("Bot escalation", errors, null, () => loadRecord(bot.cpKey)) : Promise.resolve(null),
  ]);

  const conversations = mergeConversations(conversationsByKey, [ticket.key, ...cpKeys]);
  const botAt = botRecord?.parentPostedAt ?? botRecord?.updatedAt ?? null;
  const timeline = mergeTimeline([...jira, conversationItems(conversations), notifications, bot && botAt ? [botItem(bot, botAt)] : []]);

  return { conversations, errors, ticket, timeline };
}

export type TrackerDetailResult = { detail: TrackerDetail; ok: true } | { error: string; ok: false; reason: "error" | "not_found" };

/* A clean read is reused for a minute. One that had failed sub-reads is reused only briefly: long enough that a
   flapping panel can't multiply the Jira fan-out, short enough that the missing pieces come back quickly. */
const DEGRADED_DETAIL_CACHE_SECONDS = 15;

/** Forget one ticket's cached detail so its next open rebuilds it (after linking a Slack thread, say). Never throws. */
export async function invalidateTrackerDetail(key: string): Promise<void> {
  await deleteCache(`tracker:detail:${key}`);
}

/** The detail panel for one TS ticket. Distinguishes "Jira doesn't know it" from "Jira couldn't be read". Never throws. */
export async function getTrackerDetail(key: string, accountId: string): Promise<TrackerDetailResult> {
  const cacheKey = `tracker:detail:${key}`;
  try {
    const [cached, followed] = await Promise.all([getCache<CachedDetail>(cacheKey), getFollowedKeys(accountId)]);
    let detail = cached?.value ?? null;
    if (!detail) {
      const errors: string[] = [];
      detail = await assemble(key, accountId, errors);
      if (!detail) {
        return errors.length > 0
          ? { error: `Couldn't read ${key} from Jira right now (${errors[0]}). Try again in a moment.`, ok: false, reason: "error" }
          : { error: `${key} could not be found in Jira.`, ok: false, reason: "not_found" };
      }
      await setCache(cacheKey, detail, detail.errors.length === 0 ? DETAIL_CACHE_SECONDS : DEGRADED_DETAIL_CACHE_SECONDS);
    }
    return { detail: { ...detail, following: followed.includes(key) }, ok: true };
  } catch (error) {
    console.warn(`Tracker: detail for ${key} failed.`, errorText(error));
    return { error: `Couldn't load ${key} right now. Try again in a moment.`, ok: false, reason: "error" };
  }
}
