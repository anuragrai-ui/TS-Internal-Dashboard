import { randomUUID } from "node:crypto";

import { getCacheMany, setCache } from "@/lib/cache";
import { cpOutcome } from "@/lib/escalation/classify";
import { EPIC_ISSUE_TYPE, POD_FIELD } from "@/lib/escalation/policy";
import { createReadOnlyJiraClient, readOnlyJiraConfigFromEnv } from "@/lib/escalation/readOnlyJira";
import { loadRecords } from "@/lib/escalation/runnerStore";
import { parseJsmSla } from "@/lib/escalation/slaParser";
import { mapLimit, searchByKeys, statusCategory, toCpSnapshot } from "@/lib/escalation/sweep";
import { addNotifications } from "@/lib/notifications/store";
import { getRedis, isRedisConfigured } from "@/lib/redis";
import { getFollowersByKey, isTrackerKey } from "@/lib/tracker/follow";
import { deriveSignals, isEscalated, latestIso, mergeAudience, slaNotifications, toTrackerSla, whoseMove } from "@/lib/tracker/signals";
import { extractSlackPermalinks, getConversationsForTickets, linkConversation } from "@/lib/tracker/slackIndex";
import { listRegisteredJiraUsers } from "@/lib/userJiraTokens";

import type { EscalationRecord } from "@/lib/escalation/runnerStore";
import type { ReadOnlyJiraClient } from "@/lib/escalation/readOnlyJira";
import type { JiraIssue } from "@/lib/escalation/sweep";
import type { JiraCommentRecord } from "@/lib/notifications/jiraChanges";
import type { SlackConversationRef, TrackerCp, TrackerPriority, TrackerSnapshot, TrackerTicket } from "@/lib/tracker/types";

/**
 * The escalation tracker's ticket list: every open High/Critical Support
 * Ticket, everything waiting on engineering whatever its priority, and the
 * High/Critical ones closed in the last week - about 410 tickets - with
 * their linked CPs, SLAs, Slack activity and escalation signals.
 *
 * Built from ~12 read-only Jira searches (the scope, the CPs it links, three
 * key-only signal searches) plus a capped number of comment reads, so it
 * runs from the same poll loop as the notification sync (Vercel Hobby has
 * no useful cron): at most once every 5 minutes across all browsers, and
 * the Refresh button at most once every 30 seconds.
 *
 * Redis layout (all expire after a day, so an abandoned dashboard costs nothing):
 * - tracker:snap:meta               { generation, chunks, builtAt, errors } - the only pointer readers follow
 * - tracker:snap:<generation>:<i>   up to 150 tickets each (one ~400 KB value would brush Upstash's request cap)
 * - tracker:refresh:throttle/lock/manual
 * A build writes every chunk of a NEW generation first and only then
 * repoints the meta key, so a reader sees the old list or the new one,
 * never half of each. The old generation is deleted after the switch.
 */

const SCOPE_WHERE =
  "project = TS AND issuetype = 10844 AND ((statusCategory != Done AND (priority in (High, Critical) OR status = 10633)) OR (priority in (High, Critical) AND statusCategory = Done AND statusCategoryChangedDate >= -7d))";
export const SCOPE_JQL = `${SCOPE_WHERE} ORDER BY priority DESC, updated DESC`;

const ORGANIZATIONS_FIELD = "customfield_10002";
const TTR_FIELD = "customfield_10650";
const FIRST_RESPONSE_FIELD = "customfield_10059";
const SENTIMENT_FIELD = "customfield_10251";
export const TICKET_FIELDS = [
  "summary",
  "status",
  "priority",
  "assignee",
  "reporter",
  "created",
  "updated",
  "resolutiondate",
  "issuelinks",
  "labels",
  ORGANIZATIONS_FIELD,
  POD_FIELD,
  TTR_FIELD,
  FIRST_RESPONSE_FIELD,
  SENTIMENT_FIELD,
];
const CP_FIELDS = ["summary", "status", "resolution", "assignee", POD_FIELD, "issuetype"];

/* Each manual-escalation trace, as a key-only search inside the scope. */
const SIGNAL_JQL = {
  escalationComment: 'comment ~ "escalat*" AND updated >= -30d',
  priorityRaised: "priority changed FROM (Medium, Low) AFTER -30d",
  slackLink: 'comment ~ "slack.com"',
} as const;

const SCOPE_MAX = 1_000;
export const CHUNK_SIZE = 150;
/* A week, not a day: a weekend with nobody on the dashboard must not read as "never built" and silence the SLA changes since Friday. */
const SNAPSHOT_TTL_SECONDS = 7 * 86_400;
const META_KEY = "tracker:snap:meta";
const THROTTLE_KEY = "tracker:refresh:throttle";
const LOCK_KEY = "tracker:refresh:lock";
const MANUAL_KEY = "tracker:refresh:manual";
const FAILURE_KEY = "tracker:refresh:failure";
/* After a failed first build, polls wait this long before starting another (the Retry button doesn't). */
const FAILURE_BACKOFF_SECONDS = 120;
const THROTTLE_SECONDS = 300;
const LOCK_SECONDS = 240;
const MANUAL_THROTTLE_SECONDS = 30;
const SUMMARY_MAX_CHARS = 160;
/* Slack-link comment reads per refresh. The rest wait for the next refresh (newest-updated first). */
const SLACK_SCAN_CAP = 25;
const SLACK_SCAN_CONCURRENCY = 4;
const SLACK_SCAN_TTL_SECONDS = 7 * 86_400;
const SLACK_ACTIVE_MS = 7 * 86_400_000;

/* ------------------------------------------------------------- Jira shape */

interface JiraUser {
  accountId?: string;
  displayName?: string;
}

export interface RawTrackerIssue {
  fields: Record<string, unknown> & {
    assignee?: JiraUser | null;
    created?: string;
    issuelinks?: Array<{ inwardIssue?: { key?: string }; outwardIssue?: { key?: string } }>;
    labels?: string[];
    priority?: { name?: string } | null;
    reporter?: JiraUser | null;
    resolutiondate?: string | null;
    status?: { id?: string; name?: string; statusCategory?: { key?: string } } | null;
    summary?: string;
    updated?: string;
  };
  key: string;
}

/* --------------------------------------------------------- pure mapping */

const PRIORITIES = new Set<TrackerPriority>(["Critical", "High", "Medium", "Low"]);

function toPriority(name: string | undefined): TrackerPriority {
  /* Scope also takes WfP tickets of any priority; an unset or renamed priority reads as Medium rather than vanishing. */
  return name && PRIORITIES.has(name as TrackerPriority) ? (name as TrackerPriority) : "Medium";
}

function clip(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1).trimEnd()}…` : collapsed;
}

/* Our own organization is on some tickets (internally raised ones) - it says nothing about the customer. */
const INTERNAL_ORGANIZATIONS = new Set(["certifyos", "certify", "certify os"]);

/** The customer: the first JSM Organization that isn't us, else the first label (labels are client tags), else null. */
function customerAccount(organizations: unknown, labels: string[] | undefined): string | null {
  const orgNames = (Array.isArray(organizations) ? organizations : [])
    .map((org: unknown) => (org && typeof org === "object" ? (org as Record<string, unknown>).name : null))
    .filter((name): name is string => typeof name === "string" && name.trim() !== "")
    .map((name) => name.trim());
  return orgNames.find((name) => !INTERNAL_ORGANIZATIONS.has(name.toLowerCase())) ?? labels?.find((label) => label.trim())?.trim() ?? null;
}

function firstName(raw: unknown, prop: "name" | "value"): string | null {
  const first: unknown = Array.isArray(raw) ? raw[0] : raw;
  if (first && typeof first === "object") {
    const value = (first as Record<string, unknown>)[prop];
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }
  return null;
}

/** CP keys linked to a ticket, any link type, either direction, sorted and deduplicated. */
export function linkedCpKeys(issue: Pick<RawTrackerIssue, "fields">): string[] {
  const keys = (issue.fields.issuelinks ?? [])
    .map((link) => (link.inwardIssue ?? link.outwardIssue)?.key)
    .filter((key): key is string => typeof key === "string" && key.startsWith("CP-"));
  return [...new Set(keys)].sort();
}

export function toTrackerCp(issue: JiraIssue, baseUrl: string): TrackerCp {
  const snapshot = toCpSnapshot(issue, baseUrl);
  const summary = issue.fields.summary;
  return {
    assigneeName: snapshot.assigneeName,
    ...(snapshot.issueTypeName === EPIC_ISSUE_TYPE ? { isEpic: true } : {}),
    key: snapshot.key,
    outcome: cpOutcome(snapshot),
    podName: snapshot.podName,
    statusName: snapshot.statusName,
    summary: typeof summary === "string" ? clip(summary, SUMMARY_MAX_CHARS) : null,
  };
}

/* Ongoing escalations before finished ones, then the highest ladder level - one thread stands for the ticket. */
const FINISHED_STATES = new Set(["frozen_pod_changed", "handed_back", "resolved", "suppressed"]);

export function pickBotEscalation(
  cpKeys: string[],
  records: ReadonlyMap<string, Pick<EscalationRecord, "levelSent" | "permalink" | "state">>,
): TrackerTicket["botEscalation"] {
  const candidates = cpKeys.flatMap((cpKey) => {
    const record = records.get(cpKey);
    return record ? [{ cpKey, levelSent: record.levelSent, permalink: record.permalink, state: record.state }] : [];
  });
  candidates.sort(
    (a, b) =>
      Number(FINISHED_STATES.has(a.state)) - Number(FINISHED_STATES.has(b.state)) ||
      b.levelSent - a.levelSent ||
      (a.cpKey < b.cpKey ? -1 : 1),
  );
  const [best] = candidates;
  return best ? { cpKey: best.cpKey, levelSent: best.levelSent, ...(best.permalink ? { permalink: best.permalink } : {}), state: best.state } : null;
}

export interface TicketContext {
  botRecords: ReadonlyMap<string, Pick<EscalationRecord, "levelSent" | "permalink" | "state">>;
  cps: ReadonlyMap<string, TrackerCp>;
  escalationCommentKeys: ReadonlySet<string>;
  nowMs: number;
  priorityRaisedKeys: ReadonlySet<string>;
  /* Most recent activity first. */
  slackByKey: ReadonlyMap<string, SlackConversationRef[]>;
  slackLinkKeys: ReadonlySet<string>;
}

/** One Jira issue plus everything already looked up about it -> the tracker row. Pure. */
export function toTrackerTicket(issue: RawTrackerIssue, ctx: TicketContext): TrackerTicket {
  const fields = issue.fields;
  const cps = linkedCpKeys(issue).flatMap((key) => {
    const cp = ctx.cps.get(key);
    return cp ? [cp] : [];
  });
  const category = statusCategory(fields.status);
  const statusId = fields.status?.id ?? "";
  const ttr = toTrackerSla(parseJsmSla(fields[TTR_FIELD]));
  const firstResponse = toTrackerSla(parseJsmSla(fields[FIRST_RESPONSE_FIELD]));
  const conversations = ctx.slackByKey.get(issue.key) ?? [];
  const botEscalation = pickBotEscalation(linkedCpKeys(issue), ctx.botRecords);
  const slackLast = latestIso(...conversations.map((conv) => conv.lastActivityAt)) || null;
  const signals = deriveSignals({
    botEscalation,
    cps,
    escalationComment: ctx.escalationCommentKeys.has(issue.key),
    firstResponse,
    priorityRaised: ctx.priorityRaisedKeys.has(issue.key),
    sentiment: firstName(fields[SENTIMENT_FIELD], "name"),
    slackConversations: conversations,
    slackPermalink: ctx.slackLinkKeys.has(issue.key),
    statusId,
    ttr,
  });
  const updated = fields.updated ?? "";
  const assignee = fields.assignee?.accountId ? { accountId: fields.assignee.accountId, name: fields.assignee.displayName ?? "Unknown" } : null;

  return {
    account: customerAccount(fields[ORGANIZATIONS_FIELD], fields.labels),
    assignee,
    botEscalation,
    cps,
    created: fields.created ?? "",
    escalated: isEscalated(signals),
    firstResponse,
    key: issue.key,
    lastActivityAt: latestIso(updated, slackLast) || updated,
    pod: firstName(fields[POD_FIELD], "value"),
    priority: toPriority(fields.priority?.name),
    reporterName: fields.reporter?.displayName ?? null,
    resolvedAt: fields.resolutiondate ?? null,
    signals,
    slack: {
      activeConversations: conversations.filter((conv) => ctx.nowMs - Date.parse(conv.lastActivityAt) <= SLACK_ACTIVE_MS).length,
      conversations: conversations.length,
      lastActivityAt: slackLast,
    },
    statusCategory: category,
    statusId,
    statusName: fields.status?.name ?? "",
    summary: clip(fields.summary ?? "", SUMMARY_MAX_CHARS),
    ttr,
    updated,
    whoseMove: whoseMove(statusId, category, cps.filter((cp) => !cp.isEpic).map((cp) => cp.outcome)),
  };
}

/** Distinct Slack threads linked from comment bodies (ADF link marks and smart links included - the raw JSON is scanned). */
export function slackThreadsInComments(comments: JiraCommentRecord[]): Array<{ at?: string; channel: string; rootTs: string }> {
  const seen = new Map<string, { at?: string; channel: string; rootTs: string }>();
  for (const comment of comments) {
    const text = typeof comment.body === "string" ? comment.body : JSON.stringify(comment.body ?? "");
    for (const link of extractSlackPermalinks(text)) {
      const rootTs = link.threadTs ?? link.ts;
      const id = `${link.channel}:${rootTs}`;
      if (!seen.has(id)) {
        seen.set(id, { at: comment.created, channel: link.channel, rootTs });
      }
    }
  }
  return [...seen.values()];
}

/* ---------------------------------------------------------- Redis layout */

/* The slice of Redis the snapshot uses - injectable so the generation logic is tested in memory. */
export interface SnapshotStore {
  del(keys: string[]): Promise<void>;
  get<T>(key: string): Promise<T | null>;
  mget<T>(keys: string[]): Promise<Array<T | null>>;
  set(key: string, value: unknown, ttlSeconds: number): Promise<void>;
  /* SET NX EX - true only for the call that created the key. */
  setIfAbsent(key: string, value: unknown, ttlSeconds: number): Promise<boolean>;
}

interface SnapshotMeta {
  builtAt: string;
  chunks: number;
  errors: string[];
  generation: string;
  scopeJql: string;
  ticketCount: number;
}

function chunkKey(generation: string, index: number): string {
  return `tracker:snap:${generation}:${index}`;
}

function ownersKey(generation: string): string {
  return `tracker:snap:${generation}:owners`;
}

function generationKeys(meta: Pick<SnapshotMeta, "chunks" | "generation">): string[] {
  return [...Array.from({ length: meta.chunks }, (_unused, index) => chunkKey(meta.generation, index)), ownersKey(meta.generation)];
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

export function newGeneration(nowMs: number = Date.now()): string {
  return `${nowMs.toString(36)}-${randomUUID().slice(0, 8)}`;
}

/** Chunks of a new generation first, then the meta switch, then the old generation's chunks go. */
export async function writeSnapshot(store: SnapshotStore, snapshot: TrackerSnapshot, generation: string): Promise<void> {
  const previous = await store.get<SnapshotMeta>(META_KEY);
  const chunks = chunk(snapshot.tickets, CHUNK_SIZE);

  const owners = Object.fromEntries(snapshot.tickets.map((ticket) => [ticket.key, ticket.assignee?.accountId ?? null]));
  await Promise.all([
    ...chunks.map((tickets, index) => store.set(chunkKey(generation, index), tickets, SNAPSHOT_TTL_SECONDS)),
    store.set(ownersKey(generation), owners, SNAPSHOT_TTL_SECONDS),
  ]);
  const meta: SnapshotMeta = {
    builtAt: snapshot.builtAt,
    chunks: chunks.length,
    errors: snapshot.errors,
    generation,
    scopeJql: snapshot.scopeJql,
    ticketCount: snapshot.tickets.length,
  };
  await store.set(META_KEY, meta, SNAPSHOT_TTL_SECONDS);

  if (previous && previous.generation !== generation) {
    await store.del(generationKeys(previous));
  }
}

/**
 * The current snapshot, or null. If a chunk is missing, a newer build
 * switched generations mid-read (and deleted ours), so it re-reads the
 * meta once and tries the new generation; a still-missing chunk means the
 * snapshot expired, which reads as "none yet".
 */
export async function readSnapshot(store: SnapshotStore): Promise<TrackerSnapshot | null> {
  let lastGeneration: string | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const meta = await store.get<SnapshotMeta>(META_KEY);
    if (!meta || meta.generation === lastGeneration) {
      return null;
    }
    lastGeneration = meta.generation;
    const parts = await store.mget<TrackerTicket[]>(Array.from({ length: meta.chunks }, (_unused, index) => chunkKey(meta.generation, index)));
    if (parts.every((part): part is TrackerTicket[] => Array.isArray(part))) {
      return { builtAt: meta.builtAt, errors: meta.errors, scopeJql: meta.scopeJql, tickets: parts.flat() };
    }
  }
  return null;
}

/**
 * Assignee accountId per ticket key in the current snapshot - a small
 * value of its own, so working out who to notify about a Slack mention
 * doesn't read the whole list. Null before the first build.
 */
export async function readSnapshotOwners(store: SnapshotStore): Promise<Map<string, string | null> | null> {
  const meta = await store.get<SnapshotMeta>(META_KEY);
  const owners = meta ? await store.get<Record<string, string | null>>(ownersKey(meta.generation)) : null;
  return owners ? new Map(Object.entries(owners)) : null;
}

export function upstashSnapshotStore(): SnapshotStore {
  const redis = getRedis();
  return {
    del: async (keys) => {
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    },
    get: (key) => redis.get(key),
    mget: async <T>(keys: string[]) => (keys.length === 0 ? [] : redis.mget<Array<T | null>>(...keys)),
    set: async (key, value, ttlSeconds) => {
      await redis.set(key, value, { ex: ttlSeconds });
    },
    setIfAbsent: async (key, value, ttlSeconds) => (await redis.set(key, value, { ex: ttlSeconds, nx: true })) === "OK",
  };
}

function defaultStore(): SnapshotStore | null {
  return isRedisConfigured() ? upstashSnapshotStore() : null;
}

/* ----------------------------------------------------------------- build */

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function keySet(client: ReadOnlyJiraClient, restrictJql: string, extra: string, label: string, errors: string[]): Promise<Set<string>> {
  try {
    const found = await client.searchJql<{ key: string }>(`(${restrictJql}) AND ${extra}`, ["key"], { maxTotal: SCOPE_MAX });
    return new Set(found.map((issue) => issue.key));
  } catch (error) {
    errors.push(`${label} search failed: ${errorText(error)}`);
    return new Set();
  }
}

/* Keyed by `updated` too: any new comment bumps it, so an unchanged ticket is never re-read. */
function scanCacheKey(issue: RawTrackerIssue): string {
  return `tracker:slackscan:${issue.key}:${issue.fields.updated ?? ""}`;
}

/**
 * Reads comments on tickets whose comments mention slack.com and links the
 * Slack threads they point at into the Slack index. A ticket is only re-read
 * when its `updated` changed since its last scan, and only SLACK_SCAN_CAP
 * per refresh (newest first), so a cold start catches up over a few refreshes.
 */
async function scanSlackLinks(client: ReadOnlyJiraClient, candidates: RawTrackerIssue[], errors: string[]): Promise<void> {
  const scanned = await getCacheMany<boolean>(candidates.map(scanCacheKey));
  const due = candidates.filter((_issue, index) => !scanned[index]);
  due.sort((a, b) => Date.parse(b.fields.updated ?? "") - Date.parse(a.fields.updated ?? ""));
  const batch = due.slice(0, SLACK_SCAN_CAP);
  const deferred = due.length - batch.length;
  if (deferred > 0) {
    console.info(`Tracker: deferred the Slack-link scan of ${deferred} tickets to the next refresh.`);
    errors.push(`Slack links in Jira comments: ${deferred} tickets left for the next refresh (${SLACK_SCAN_CAP} per refresh).`);
  }

  let failed = 0;
  await mapLimit(batch, SLACK_SCAN_CONCURRENCY, async (issue) => {
    try {
      const page = await client.get<{ comments?: JiraCommentRecord[] }>(`/rest/api/3/issue/${issue.key}/comment`, { maxResults: 100, orderBy: "-created" });
      for (const thread of slackThreadsInComments(page.comments ?? [])) {
        await linkConversation({ at: thread.at, channel: thread.channel, rootTs: thread.rootTs, source: "jira_link", ticketKeys: [issue.key] });
      }
      /* Marked scanned only after the comment read succeeded, so a Jira hiccup retries next refresh. (linkConversation never throws.) */
      await setCache(scanCacheKey(issue), true, SLACK_SCAN_TTL_SECONDS);
    } catch (error) {
      failed++;
      console.warn(`Tracker: Slack-link scan of ${issue.key} failed.`, errorText(error));
    }
  });
  if (failed > 0) {
    errors.push(`Slack links in Jira comments: ${failed} tickets could not be scanned; retried next refresh.`);
  }
}

/**
 * Everything around a set of Jira issues - CPs, signal searches (restricted
 * to `restrictJql`), bot records and Slack - mapped to tracker rows.
 * Shared by the full refresh and the detail panel's single-ticket fallback.
 */
export async function assembleTickets(args: {
  baseUrl: string;
  client: ReadOnlyJiraClient;
  errors: string[];
  issues: RawTrackerIssue[];
  nowMs: number;
  restrictJql: string;
  scanSlack: boolean;
}): Promise<TrackerTicket[]> {
  const { baseUrl, client, errors, issues, nowMs, restrictJql } = args;
  if (issues.length === 0) {
    return [];
  }

  const cpKeys = [...new Set(issues.flatMap(linkedCpKeys))];
  const [cpIssues, priorityRaisedKeys, escalationCommentKeys, slackLinkKeys, botRecords] = await Promise.all([
    searchByKeys(client, cpKeys, CP_FIELDS).catch((error: unknown) => {
      errors.push(`Linked CPs could not be read: ${errorText(error)}`);
      return [] as JiraIssue[];
    }),
    keySet(client, restrictJql, SIGNAL_JQL.priorityRaised, "Priority-raised", errors),
    keySet(client, restrictJql, SIGNAL_JQL.escalationComment, "Escalation-comment", errors),
    keySet(client, restrictJql, SIGNAL_JQL.slackLink, "Slack-link", errors),
    loadRecords().catch((error: unknown) => {
      errors.push(`Bot escalation records unavailable: ${errorText(error)}`);
      return new Map<string, EscalationRecord>();
    }),
  ]);

  if (args.scanSlack && slackLinkKeys.size > 0) {
    try {
      await scanSlackLinks(
        client,
        issues.filter((issue) => slackLinkKeys.has(issue.key)),
        errors,
      );
    } catch (error) {
      errors.push(`Slack links in Jira comments were not scanned: ${errorText(error)}`);
    }
  }

  let slackByKey = new Map<string, SlackConversationRef[]>();
  try {
    slackByKey = await getConversationsForTickets(issues.map((issue) => issue.key));
  } catch (error) {
    errors.push(`Slack index unavailable: ${errorText(error)}`);
  }

  const cps = new Map(cpIssues.map((issue) => [issue.key, toTrackerCp(issue, baseUrl)]));
  const ctx: TicketContext = { botRecords, cps, escalationCommentKeys, nowMs, priorityRaisedKeys, slackByKey, slackLinkKeys };
  return issues.map((issue) => toTrackerTicket(issue, ctx));
}

/** One ticket read live (for a detail panel on a key outside the snapshot), through the same mapper. Null if Jira doesn't return it. */
export async function fetchTrackerTicket(client: ReadOnlyJiraClient, baseUrl: string, key: string, errors: string[]): Promise<TrackerTicket | null> {
  if (!isTrackerKey(key) || !key.startsWith("TS-")) {
    return null;
  }
  const issues = await client.searchJql<RawTrackerIssue>(`key = ${key}`, TICKET_FIELDS, { maxTotal: 1 });
  const [ticket] = await assembleTickets({ baseUrl, client, errors, issues, nowMs: Date.now(), restrictJql: `key = ${key}`, scanSlack: false });
  return ticket ?? null;
}

async function buildSnapshot(client: ReadOnlyJiraClient, baseUrl: string, nowMs: number): Promise<TrackerSnapshot> {
  const errors: string[] = [];
  /* The scope itself is the one fatal read: without it there is no list to show. */
  const issues = await client.searchJql<RawTrackerIssue>(SCOPE_JQL, TICKET_FIELDS, { maxTotal: SCOPE_MAX });
  if (issues.length >= SCOPE_MAX) {
    errors.push(`The scope hit the ${SCOPE_MAX}-ticket cap; the oldest-updated tickets are missing.`);
  }
  const tickets = await assembleTickets({ baseUrl, client, errors, issues, nowMs, restrictJql: SCOPE_WHERE, scanSlack: true });
  return { builtAt: new Date(nowMs).toISOString(), errors, scopeJql: SCOPE_JQL, tickets };
}

/* Notifies assignees and followers of SLA changes since the previous snapshot. Never throws; false when it failed
   (the notification ids are write-once, so trying again is safe). */
async function notifySlaChanges(previous: TrackerSnapshot | null, current: TrackerSnapshot, baseUrl: string, nowMs: number): Promise<boolean> {
  try {
    const draft = slaNotifications({ audienceByKey: new Map(), baseUrl, current: current.tickets, nowMs, previous: previous?.tickets ?? null });
    if (draft.length === 0) {
      return true;
    }
    const keys = draft.flatMap((item) => (item.ticketKey ? [item.ticketKey] : []));
    const [users, followersByKey] = await Promise.all([listRegisteredJiraUsers(), getFollowersByKey(keys)]);
    const audienceByKey = mergeAudience({
      assigneeByKey: new Map(current.tickets.map((ticket) => [ticket.key, ticket.assignee?.accountId ?? null])),
      followersByKey,
      keys,
      registered: new Set(users.map((user) => user.accountId)),
    });
    const items = draft.map((item) => ({ ...item, audience: (item.ticketKey && audienceByKey.get(item.ticketKey)) || [] }));
    await addNotifications(items, new Date());
    return true;
  } catch (error) {
    console.warn("Tracker: SLA notifications failed.", errorText(error));
    return false;
  }
}

/* ---------------------------------------------------------------- public */

/** Assignee per key in the cached snapshot (see readSnapshotOwners). Never throws. */
export async function getTrackerOwners(): Promise<Map<string, string | null> | null> {
  const store = defaultStore();
  if (!store) {
    return null;
  }
  try {
    return await readSnapshotOwners(store);
  } catch (error) {
    console.warn("Tracker: owner index read failed.", errorText(error));
    return null;
  }
}

/** Why the first build failed, while that is recent news; null otherwise. Never throws. */
export async function getFirstBuildFailure(): Promise<string | null> {
  const store = defaultStore();
  if (!store) {
    return null;
  }
  try {
    const failure = await store.get<{ message?: string }>(FAILURE_KEY);
    return failure ? (failure.message ?? "The first build failed.") : null;
  } catch {
    return null;
  }
}

/** The cached tracker snapshot, or null before the first build. */
export async function getTrackerSnapshot(): Promise<TrackerSnapshot | null> {
  const store = defaultStore();
  if (!store) {
    return null;
  }
  try {
    return await readSnapshot(store);
  } catch (error) {
    console.warn("Tracker: snapshot read failed.", errorText(error));
    return null;
  }
}

/** Rebuild from Jira now (lock-protected). */
export async function refreshTrackerSnapshot(): Promise<TrackerSnapshot | null> {
  const store = defaultStore();
  if (!store) {
    return null;
  }

  if (!(await store.setIfAbsent(LOCK_KEY, new Date().toISOString(), LOCK_SECONDS))) {
    /* Another browser's refresh is already running; its result is the one to show. */
    return getTrackerSnapshot();
  }

  const previous = await getTrackerSnapshot();
  try {
    const config = readOnlyJiraConfigFromEnv();
    const nowMs = Date.now();
    const snapshot = await buildSnapshot(createReadOnlyJiraClient(config), config.baseUrl, nowMs);
    /* The snapshot written next is what the following refresh diffs against, so a notification that failed once is tried
       again before the transition it announces is forgotten. */
    if (!(await notifySlaChanges(previous, snapshot, config.baseUrl, nowMs))) {
      await notifySlaChanges(previous, snapshot, config.baseUrl, nowMs);
    }
    await writeSnapshot(store, snapshot, newGeneration(nowMs));
    await store.del([FAILURE_KEY]);
    return snapshot;
  } catch (error) {
    console.warn("Tracker: refresh failed; keeping the previous snapshot.", errorText(error));
    if (!previous) {
      /* Nothing to show yet: remember why, so the page says so (and polls don't retry every few seconds). */
      await store
        .set(FAILURE_KEY, { at: new Date().toISOString(), message: clip(errorText(error), 200) }, FAILURE_BACKOFF_SECONDS)
        .catch(() => undefined);
    }
    return previous ? { ...previous, errors: [...previous.errors, `Latest refresh failed: ${errorText(error)}`] } : null;
  } finally {
    await store.del([LOCK_KEY]);
  }
}

/** The Refresh button: at most once every 30 seconds across all browsers. */
export async function refreshTrackerSnapshotManually(): Promise<{ snapshot: TrackerSnapshot | null; throttled: boolean }> {
  const store = defaultStore();
  if (!store) {
    return { snapshot: null, throttled: false };
  }
  if (!(await store.setIfAbsent(MANUAL_KEY, new Date().toISOString(), MANUAL_THROTTLE_SECONDS))) {
    return { snapshot: await getTrackerSnapshot(), throttled: true };
  }
  return { snapshot: await refreshTrackerSnapshot(), throttled: false };
}

/** Throttled rebuild for the poll loop: at most once every few minutes across all browsers. Never throws. */
export async function maybeRefreshTrackerSnapshot(): Promise<void> {
  try {
    const store = defaultStore();
    if (!store || !(await store.setIfAbsent(THROTTLE_KEY, new Date().toISOString(), THROTTLE_SECONDS))) {
      return;
    }
    await refreshTrackerSnapshot();
  } catch (error) {
    console.warn("Tracker: background refresh failed.", errorText(error));
  }
}
