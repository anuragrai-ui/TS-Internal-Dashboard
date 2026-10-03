import { createHash } from "node:crypto";

import { getDb, redactDbError, sql } from "@/lib/db/client";
import { computeFirstResponseClock, computeResolutionClock, firstAgentResponseAt, jiraReading, SLA_RULES_VERSION } from "@/lib/cases/sla";
import {
  CERTIFY_SUPPORT_CALENDAR,
  PILOT_POD_OPTION_ID,
  POD_FIELD,
  POD_OPTIONS,
  SUPPORT_TICKET_ISSUE_TYPE_ID,
  TIME_TO_RESOLUTION_FIELD,
} from "@/lib/escalation/policy";
import { createReadOnlyJiraClient, readOnlyJiraConfigFromEnv } from "@/lib/escalation/readOnlyJira";
import { parseJsmSla } from "@/lib/escalation/slaParser";
import { fullChangelog, mapLimit, searchByKeys, statusCategory } from "@/lib/escalation/sweep";
import { adfToText } from "@/lib/notifications/jiraChanges";
import { getRedis, isRedisConfigured } from "@/lib/redis";

import type {
  CaseBundle,
  CaseEvent,
  CaseFields,
  CaseLink,
  CaseMessage,
  CaseSyncState,
  MessageVisibility,
  SlaClock,
  SyncTickResult,
  SyncTickSummary,
} from "@/lib/cases/types";
import type { SqlExecutor, SqlStatement } from "@/lib/db/client";
import type { ReadOnlyJiraClient } from "@/lib/escalation/readOnlyJira";
import type { BusinessCalendar } from "@/lib/escalation/types";
import type { JiraCommentRecord, JiraHistory, JiraUserRef } from "@/lib/notifications/jiraChanges";

/**
 * Keeps the case store (Postgres) in sync with Jira for the pilot pod.
 *
 * Jira stays authoritative until a later cutover, so this is a one-way copy:
 * every TS Support Ticket in the Credentialing pod, with all its comments,
 * its changelog as events, its links, and our own SLA clocks computed next
 * to Jira's. Everything is written with ON CONFLICT, so re-syncing an issue
 * any number of times leaves the same rows (and only bumps a case's
 * `version` when one of its own fields really changed).
 *
 * Like the other background jobs here there is no cron (Vercel Hobby): the
 * notification poll calls syncTick after its response, which runs at most
 * once every 2 minutes across all browsers (Redis throttle + SET NX lock)
 * and stops starting new issues after ~40 seconds. Each tick:
 * 1. retries issues that failed in earlier ticks,
 * 2. walks the backfill (open tickets + those resolved in the last 90 days)
 *    in key order from a saved cursor, until it is exhausted,
 * 3. then follows `updated` from a saved cursor (minus 2 minutes of overlap
 *    for Jira's search-index lag), oldest first.
 * Progress, the last tick and the last error live in sync_state.
 *
 * Reads go through the escalation pilot's read-only Jira client, so a sync
 * cannot write to Jira even by mistake.
 */

/* ------------------------------------------------------------ the scope */

/** The pilot pod's Pod option (customfield_10165) - same table the escalation pilot routes by. */
export const CASE_POD = POD_OPTIONS.find((option) => option.id === PILOT_POD_OPTION_ID) ?? { id: PILOT_POD_OPTION_ID, name: "Credentialing" };

/* By option VALUE in JQL (unambiguous across Jira versions); by option ID in
   code (isInCasePod), since values are admin-editable and the id is what the
   escalation pilot routes on. */
export const CASE_SCOPE_JQL = `project = TS AND issuetype = ${SUPPORT_TICKET_ISSUE_TYPE_ID} AND cf[10165] = "${CASE_POD.name}"`;
export const BACKFILL_WHERE = `${CASE_SCOPE_JQL} AND (statusCategory != Done OR resolutiondate >= -90d)`;

const ORGANIZATIONS_FIELD = "customfield_10002";
const FIRST_RESPONSE_FIELD = "customfield_10059";
export const CASE_FIELDS = [
  "summary",
  "description",
  "status",
  "priority",
  "assignee",
  "reporter",
  "created",
  "updated",
  "resolutiondate",
  "issuelinks",
  ORGANIZATIONS_FIELD,
  POD_FIELD,
  TIME_TO_RESOLUTION_FIELD,
  FIRST_RESPONSE_FIELD,
];

/* Our own organization is on internally raised tickets - it is not a customer account. */
const INTERNAL_ORGANIZATIONS = new Set(["certifyos", "certify", "certify os"]);

export const SYNC_STATE_KEY = "jira_case_sync";
const LOCK_KEY = "cases:sync:lock";
const THROTTLE_KEY = "cases:sync:throttle";
const MANUAL_KEY = "cases:sync:manual";
const LOCK_SECONDS = 120;
const THROTTLE_SECONDS = 120;
const MANUAL_THROTTLE_SECONDS = 30;

const DEFAULT_BUDGET_MS = 40_000;
const DEFAULT_MAX_ISSUES = 40;
/* No new issue starts with less than this left: one issue is a comment walk, a changelog walk and one transaction. */
const PER_ISSUE_RESERVE_MS = 5_000;
const ISSUE_CONCURRENCY = 3;
const OVERLAP_MS = 2 * 60_000;
/* Incremental search window: issues per search; unchanged ones (the overlap) are skipped cheaply. */
const INCREMENTAL_WINDOW = 200;
const MAX_RETRY_KEYS = 50;
const MAX_RETRY_ATTEMPTS = 3;
const MAX_TICK_ERRORS = 10;
const COMMENT_PAGE_SIZE = 100;
const MAX_COMMENTS = 2_000;
const BODY_MAX_CHARS = 20_000;
const SUMMARY_MAX_CHARS = 1_000;

/* ------------------------------------------------------------ Jira shape */

interface JiraUser extends JiraUserRef {
  emailAddress?: string;
}

export interface RawCaseIssue {
  fields: Record<string, unknown> & {
    assignee?: JiraUser | null;
    created?: string;
    description?: unknown;
    issuelinks?: Array<{
      inwardIssue?: { key?: string };
      outwardIssue?: { key?: string };
      type?: { inward?: string; name?: string; outward?: string };
    }>;
    priority?: { name?: string } | null;
    reporter?: JiraUser | null;
    resolutiondate?: string | null;
    status?: { id?: string; name?: string; statusCategory?: { key?: string } } | null;
    summary?: string;
    updated?: string;
  };
  key: string;
}

/** A comment as /rest/api/3/issue/{key}/comment?expand=properties returns it. */
export interface RawComment extends JiraCommentRecord {
  author?: JiraUser;
  properties?: Array<{ key?: string; value?: unknown }>;
  updated?: string;
  /* A role/group restriction - only possible on internal-facing comments. */
  visibility?: { type?: string; value?: string } | null;
}

/* ------------------------------------------------------- pure: mapping */

function isoOrNull(value: unknown): string | null {
  const ms = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function optionOf(raw: unknown): { id: string | null; value: string | null } {
  const option = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  return {
    id: typeof option?.id === "string" ? option.id : null,
    value: typeof option?.value === "string" ? option.value : null,
  };
}

/** Whether an issue's Pod is the pilot pod - by option id, falling back to the option value. */
export function isInCasePod(issue: Pick<RawCaseIssue, "fields">): boolean {
  const pod = optionOf(issue.fields[POD_FIELD]);
  return pod.id !== null ? pod.id === CASE_POD.id : pod.value === CASE_POD.name;
}

/** The customer account: the first JSM Organization that isn't us, else null. */
export function customerAccountName(organizations: unknown): string | null {
  const names = (Array.isArray(organizations) ? organizations : [])
    .map((org: unknown) => (org && typeof org === "object" ? (org as Record<string, unknown>).name : null))
    .filter((name): name is string => typeof name === "string" && name.trim() !== "")
    .map((name) => name.trim());
  return names.find((name) => !INTERNAL_ORGANIZATIONS.has(name.toLowerCase())) ?? null;
}

/**
 * Public or internal. JSM marks an internal note with `jsdPublic: false` on
 * the comment; the same fact also lives in the `sd.public.comment` entity
 * property ({ internal: true }) when the comment is read with
 * expand=properties - older payloads only have the property. A role/group
 * restriction is internal too. Anything else (incl. non-JSM projects, where
 * neither exists) is public.
 */
export function commentVisibility(comment: RawComment): MessageVisibility {
  if (comment.jsdPublic === false) {
    return "internal";
  }
  if (comment.visibility && typeof comment.visibility === "object" && comment.visibility.value) {
    return "internal";
  }
  if (comment.jsdPublic === true) {
    return "public";
  }
  const property = comment.properties?.find((entry) => entry.key === "sd.public.comment");
  const value = property?.value;
  if (value && typeof value === "object" && (value as Record<string, unknown>).internal === true) {
    return "internal";
  }
  return "public";
}

export function mapCaseFields(issue: RawCaseIssue): CaseFields {
  const fields = issue.fields;
  const reporter = fields.reporter?.accountId
    ? {
        accountId: fields.reporter.accountId,
        email: fields.reporter.emailAddress?.trim() || null,
        isCustomer: fields.reporter.accountType === "customer",
        name: fields.reporter.displayName?.trim() || "Unknown",
      }
    : null;
  const created = isoOrNull(fields.created);
  const updated = isoOrNull(fields.updated);
  if (!created || !updated) {
    /* Without these there is no SLA start and no sync cursor - refuse rather than invent. */
    throw new Error(`${issue.key}: Jira returned no created/updated timestamp`);
  }

  return {
    accountName: customerAccountName(fields[ORGANIZATIONS_FIELD]),
    assigneeAccountId: fields.assignee?.accountId ?? null,
    assigneeName: fields.assignee?.displayName ?? null,
    createdAt: created,
    descriptionText: adfToText(fields.description, BODY_MAX_CHARS),
    jiraKey: issue.key,
    jiraUpdated: updated,
    pod: optionOf(fields[POD_FIELD]).value,
    priority: fields.priority?.name ?? null,
    reporter,
    resolvedAt: isoOrNull(fields.resolutiondate),
    statusCategory: statusCategory(fields.status),
    statusId: fields.status?.id ?? "",
    statusName: fields.status?.name ?? "",
    summary: clip((fields.summary ?? "").trim(), SUMMARY_MAX_CHARS),
  };
}

/**
 * Hash of what counts as a "real change" to a case: every mapped field
 * except jiraUpdated (which moves on every comment - those land in
 * case_messages, not in the case's version).
 */
export function caseContentHash(fields: CaseFields): string {
  const ordered = Object.fromEntries(
    Object.entries(fields)
      .filter(([name]) => name !== "jiraUpdated")
      .sort(([a], [b]) => (a < b ? -1 : 1)),
  );
  return createHash("sha256").update(JSON.stringify(ordered)).digest("hex");
}

export function mapComments(comments: RawComment[]): CaseMessage[] {
  return comments.flatMap((comment): CaseMessage[] => {
    const createdAt = isoOrNull(comment.created);
    if (!comment.id || !createdAt) {
      return [];
    }
    const updated = isoOrNull(comment.updated);
    return [
      {
        authorAccountId: comment.author?.accountId ?? null,
        authorName: comment.author?.displayName ?? null,
        bodyText: adfToText(comment.body, BODY_MAX_CHARS),
        createdAt,
        editedAt: updated && updated !== createdAt ? updated : null,
        externalId: comment.id,
        source: "jira_comment",
        visibility: commentVisibility(comment),
      },
    ];
  });
}

function fieldOf(item: { field?: string; fieldId?: string }): string {
  return item.fieldId ?? item.field ?? "";
}

/**
 * The changelog (plus creation and each comment) as case_events. Ids are
 * derived from Jira's own ids so a re-sync inserts nothing new.
 */
export function mapEvents(issue: RawCaseIssue, histories: JiraHistory[], comments: RawComment[]): CaseEvent[] {
  const key = issue.key;
  const events: CaseEvent[] = [];
  const created = isoOrNull(issue.fields.created);
  const firstStatus = histories
    .flatMap((history) => (history.items ?? []).filter((item) => fieldOf(item) === "status").map((item) => ({ at: history.created ?? "", item })))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0]?.item;

  if (created) {
    events.push({
      actorAccountId: issue.fields.reporter?.accountId ?? null,
      actorName: issue.fields.reporter?.displayName ?? null,
      at: created,
      externalId: `jira:${key}:created`,
      fromId: null,
      fromValue: null,
      kind: "created",
      toId: firstStatus ? (firstStatus.from ?? null) : (issue.fields.status?.id ?? null),
      toValue: firstStatus ? (firstStatus.fromString ?? null) : (issue.fields.status?.name ?? null),
    });
  }

  for (const history of histories) {
    const at = isoOrNull(history.created);
    if (!at) {
      continue;
    }
    (history.items ?? []).forEach((item, index) => {
      const field = fieldOf(item);
      const kind: CaseEvent["kind"] | null =
        field === "status"
          ? "status"
          : field === "assignee"
            ? "assignee"
            : field === "priority"
              ? "priority"
              : field === "resolution"
                ? "resolved"
                : field === "Link" || field === "issuelinks"
                  ? "link"
                  : null;
      if (!kind) {
        return;
      }
      events.push({
        actorAccountId: history.author?.accountId ?? null,
        actorName: history.author?.displayName ?? null,
        at,
        externalId: `jira:${key}:h${history.id ?? at}:${field}:${index}`,
        fromId: item.from ?? null,
        fromValue: item.fromString ?? null,
        kind,
        toId: item.to ?? null,
        toValue: item.toString ?? null,
      });
    });
  }

  for (const comment of comments) {
    const at = isoOrNull(comment.created);
    if (!comment.id || !at) {
      continue;
    }
    events.push({
      actorAccountId: comment.author?.accountId ?? null,
      actorName: comment.author?.displayName ?? null,
      at,
      externalId: `jira:${key}:c${comment.id}`,
      fromId: null,
      fromValue: null,
      kind: "comment",
      toId: comment.id,
      toValue: commentVisibility(comment),
    });
  }

  return events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || (a.externalId < b.externalId ? -1 : 1));
}

/** Current issue links, any project, deduplicated on (key, type). */
export function mapLinks(issue: RawCaseIssue): CaseLink[] {
  const seen = new Map<string, CaseLink>();
  for (const link of issue.fields.issuelinks ?? []) {
    const other = link.inwardIssue ?? link.outwardIssue;
    const linkType = link.type?.name?.trim();
    if (!other?.key || !linkType) {
      continue;
    }
    const entry: CaseLink = { direction: link.inwardIssue ? "inward" : "outward", linkType, linkedKey: other.key };
    seen.set(`${entry.linkedKey}\u0000${entry.linkType}`, entry);
  }
  return [...seen.values()].sort((a, b) => (a.linkedKey < b.linkedKey ? -1 : a.linkedKey > b.linkedKey ? 1 : a.linkType < b.linkType ? -1 : 1));
}

/** Both SLA clocks - ours, with Jira's reading of the same metric alongside. */
export function computeSlaClocks(args: {
  calendar: BusinessCalendar;
  comments: RawComment[];
  fields: CaseFields;
  histories: JiraHistory[];
  issue: RawCaseIssue;
  nowMs: number;
}): SlaClock[] {
  const { calendar, comments, fields, histories, issue, nowMs } = args;
  const computedAt = new Date(nowMs).toISOString();
  const jiraTtr = parseJsmSla(issue.fields[TIME_TO_RESOLUTION_FIELD]);
  const jiraFrt = parseJsmSla(issue.fields[FIRST_RESPONSE_FIELD]);

  const statusChanges = histories.flatMap((history) =>
    (history.items ?? [])
      .filter((item) => fieldOf(item) === "status" && history.created)
      .map((item) => ({
        at: history.created ?? "",
        fromId: item.from ?? null,
        fromName: item.fromString ?? null,
        toId: item.to ?? null,
        toName: item.toString ?? null,
      })),
  );
  const resolutionChanges = histories.flatMap((history) =>
    (history.items ?? [])
      .filter((item) => fieldOf(item) === "resolution" && history.created)
      .map((item) => ({ at: history.created ?? "", set: Boolean(item.to) })),
  );

  const resolution = computeResolutionClock(
    {
      createdAt: fields.createdAt,
      currentStatus: { id: fields.statusId, name: fields.statusName },
      resolutionChanges,
      resolvedAt: fields.resolvedAt,
      statusChanges,
    },
    jiraTtr.goalMs,
    nowMs,
    calendar,
  );

  const firstResponseAt = firstAgentResponseAt(
    comments.flatMap((comment) => {
      const createdAt = isoOrNull(comment.created);
      return createdAt
        ? [{ authorAccountId: comment.author?.accountId ?? null, authorType: comment.author?.accountType ?? null, createdAt, visibility: commentVisibility(comment) }]
        : [];
    }),
    fields.reporter?.accountId ?? null,
  );
  const firstResponse = computeFirstResponseClock({ createdAt: fields.createdAt, firstResponseAt }, jiraFrt.goalMs, nowMs, calendar);

  return [
    { ...firstResponse, computedAt, jira: jiraReading(jiraFrt), metric: "first_response" },
    { ...resolution, computedAt, jira: jiraReading(jiraTtr), metric: "resolution" },
  ];
}

/** One Jira issue with its comments and changelog -> everything the store keeps about it. Pure. */
export function buildCaseBundle(args: {
  calendar?: BusinessCalendar;
  comments: RawComment[];
  histories: JiraHistory[];
  issue: RawCaseIssue;
  nowMs: number;
}): CaseBundle {
  const fields = mapCaseFields(args.issue);
  return {
    case: fields,
    contentHash: caseContentHash(fields),
    events: mapEvents(args.issue, args.histories, args.comments),
    links: mapLinks(args.issue),
    messages: mapComments(args.comments),
    sla: computeSlaClocks({
      calendar: args.calendar ?? CERTIFY_SUPPORT_CALENDAR,
      comments: args.comments,
      fields,
      histories: args.histories,
      issue: args.issue,
      nowMs: args.nowMs,
    }),
  };
}

/* --------------------------------------------------------- pure: writes */

/**
 * The statements that store one bundle, run as one transaction. Children
 * find their case by jira_key (a subselect), so the whole write is one round
 * trip with no ids read back first. Every statement is idempotent.
 */
export function caseWriteStatements(bundle: CaseBundle): SqlStatement[] {
  const c = bundle.case;
  const key = c.jiraKey;
  const statements: SqlStatement[] = [];

  if (c.accountName) {
    statements.push(sql("accounts.upsert", "INSERT INTO accounts (name, source) VALUES ($1, 'jira') ON CONFLICT (name) DO NOTHING", [c.accountName]));
  }

  if (c.reporter) {
    /* Only a customer reporter belongs to the customer's account; an agent raising a ticket for them does not. */
    statements.push(
      sql(
        "contacts.upsert",
        `INSERT INTO contacts (account_id, name, email, jira_account_id)
         VALUES ((SELECT id FROM accounts WHERE name = $1), $2, $3, $4)
         ON CONFLICT (jira_account_id) DO UPDATE SET
           name = EXCLUDED.name,
           email = COALESCE(EXCLUDED.email, contacts.email),
           account_id = COALESCE(EXCLUDED.account_id, contacts.account_id),
           updated_at = now()
         WHERE (contacts.name, contacts.email, contacts.account_id)
           IS DISTINCT FROM (EXCLUDED.name, COALESCE(EXCLUDED.email, contacts.email), COALESCE(EXCLUDED.account_id, contacts.account_id))`,
        [c.reporter.isCustomer ? c.accountName : null, c.reporter.name, c.reporter.email, c.reporter.accountId],
      ),
    );
  }

  statements.push(
    sql(
      "cases.upsert",
      `INSERT INTO cases (jira_key, account_id, pod, priority, status_id, status_name, status_category,
         assignee_account_id, assignee_name, reporter_contact_id, summary, description_text, content_hash,
         created_at, resolved_at, jira_updated, last_synced_at)
       VALUES ($1, (SELECT id FROM accounts WHERE name = $2), $3, $4, $5, $6, $7, $8, $9,
         (SELECT id FROM contacts WHERE jira_account_id = $10), $11, $12, $13,
         $14::timestamptz, $15::timestamptz, $16::timestamptz, now())
       ON CONFLICT (jira_key) DO UPDATE SET
         version = CASE WHEN cases.content_hash IS DISTINCT FROM EXCLUDED.content_hash THEN cases.version + 1 ELSE cases.version END,
         updated_at = CASE WHEN cases.content_hash IS DISTINCT FROM EXCLUDED.content_hash THEN now() ELSE cases.updated_at END,
         account_id = EXCLUDED.account_id,
         pod = EXCLUDED.pod,
         priority = EXCLUDED.priority,
         status_id = EXCLUDED.status_id,
         status_name = EXCLUDED.status_name,
         status_category = EXCLUDED.status_category,
         assignee_account_id = EXCLUDED.assignee_account_id,
         assignee_name = EXCLUDED.assignee_name,
         reporter_contact_id = EXCLUDED.reporter_contact_id,
         summary = EXCLUDED.summary,
         description_text = EXCLUDED.description_text,
         content_hash = EXCLUDED.content_hash,
         created_at = EXCLUDED.created_at,
         resolved_at = EXCLUDED.resolved_at,
         jira_updated = EXCLUDED.jira_updated,
         last_synced_at = now()`,
      [
        key,
        c.accountName,
        c.pod,
        c.priority,
        c.statusId,
        c.statusName,
        c.statusCategory,
        c.assigneeAccountId,
        c.assigneeName,
        c.reporter?.accountId ?? null,
        c.summary,
        c.descriptionText,
        bundle.contentHash,
        c.createdAt,
        c.resolvedAt,
        c.jiraUpdated,
      ],
    ),
  );

  if (bundle.messages.length > 0) {
    const rows = bundle.messages.map((m) => ({
      author_account_id: m.authorAccountId,
      author_name: m.authorName,
      body_text: m.bodyText,
      created_at: m.createdAt,
      edited_at: m.editedAt,
      external_id: m.externalId,
      source: m.source,
      visibility: m.visibility,
    }));
    statements.push(
      sql(
        "case_messages.upsert",
        `INSERT INTO case_messages (case_id, source, external_id, author_name, author_account_id, visibility, body_text, created_at, edited_at)
         SELECT (SELECT id FROM cases WHERE jira_key = $1), m.source, m.external_id, m.author_name, m.author_account_id,
           m.visibility, m.body_text, m.created_at, m.edited_at
         FROM jsonb_to_recordset($2::jsonb) AS m(source text, external_id text, author_name text, author_account_id text,
           visibility text, body_text text, created_at timestamptz, edited_at timestamptz)
         ON CONFLICT (source, external_id) DO UPDATE SET
           author_name = EXCLUDED.author_name,
           visibility = EXCLUDED.visibility,
           body_text = EXCLUDED.body_text,
           edited_at = EXCLUDED.edited_at
         WHERE (case_messages.author_name, case_messages.visibility, case_messages.body_text, case_messages.edited_at)
           IS DISTINCT FROM (EXCLUDED.author_name, EXCLUDED.visibility, EXCLUDED.body_text, EXCLUDED.edited_at)`,
        [key, JSON.stringify(rows)],
      ),
    );
  }

  if (bundle.events.length > 0) {
    const rows = bundle.events.map((e) => ({
      actor_account_id: e.actorAccountId,
      actor_name: e.actorName,
      at: e.at,
      external_id: e.externalId,
      from_id: e.fromId,
      from_value: e.fromValue,
      kind: e.kind,
      to_id: e.toId,
      to_value: e.toValue,
    }));
    statements.push(
      sql(
        "case_events.insert",
        `INSERT INTO case_events (case_id, kind, from_value, to_value, from_id, to_id, actor_name, actor_account_id, at, external_id)
         SELECT (SELECT id FROM cases WHERE jira_key = $1), e.kind, e.from_value, e.to_value, e.from_id, e.to_id,
           e.actor_name, e.actor_account_id, e.at, e.external_id
         FROM jsonb_to_recordset($2::jsonb) AS e(kind text, from_value text, to_value text, from_id text, to_id text,
           actor_name text, actor_account_id text, at timestamptz, external_id text)
         ON CONFLICT (external_id) DO NOTHING`,
        [key, JSON.stringify(rows)],
      ),
    );
  }

  /* Links mirror Jira's current set: anything no longer linked goes, the rest is upserted. */
  const linkRows = JSON.stringify(bundle.links.map((l) => ({ direction: l.direction, link_type: l.linkType, linked_key: l.linkedKey })));
  statements.push(
    sql(
      "case_links.prune",
      `DELETE FROM case_links
       WHERE case_id = (SELECT id FROM cases WHERE jira_key = $1)
         AND NOT EXISTS (
           SELECT 1 FROM jsonb_to_recordset($2::jsonb) AS l(linked_key text, link_type text)
           WHERE l.linked_key = case_links.linked_key AND l.link_type = case_links.link_type)`,
      [key, linkRows],
    ),
  );
  if (bundle.links.length > 0) {
    statements.push(
      sql(
        "case_links.upsert",
        `INSERT INTO case_links (case_id, linked_key, link_type, direction)
         SELECT (SELECT id FROM cases WHERE jira_key = $1), l.linked_key, l.link_type, l.direction
         FROM jsonb_to_recordset($2::jsonb) AS l(linked_key text, link_type text, direction text)
         ON CONFLICT (case_id, linked_key, link_type) DO UPDATE SET direction = EXCLUDED.direction
         WHERE case_links.direction IS DISTINCT FROM EXCLUDED.direction`,
        [key, linkRows],
      ),
    );
  }

  if (bundle.sla.length > 0) {
    const rows = bundle.sla.map((s) => ({
      breached_at: s.breachedAt,
      computed_at: s.computedAt,
      elapsed_business_ms: s.elapsedBusinessMs,
      goal_ms: s.goalMs,
      jira_breached: s.jira.breached,
      jira_goal_ms: s.jira.goalMs,
      jira_remaining_ms: s.jira.remainingMs,
      jira_state: s.jira.state,
      metric: s.metric,
      remaining_ms: s.remainingMs,
      state: s.state,
      stopped_at: s.stoppedAt,
    }));
    statements.push(
      sql(
        "sla_clocks.upsert",
        `INSERT INTO sla_clocks (case_id, metric, goal_ms, state, elapsed_business_ms, remaining_ms, breached_at, stopped_at,
           jira_state, jira_goal_ms, jira_remaining_ms, jira_breached, computed_at)
         SELECT (SELECT id FROM cases WHERE jira_key = $1), s.metric, s.goal_ms, s.state, s.elapsed_business_ms, s.remaining_ms,
           s.breached_at, s.stopped_at, s.jira_state, s.jira_goal_ms, s.jira_remaining_ms, s.jira_breached, s.computed_at
         FROM jsonb_to_recordset($2::jsonb) AS s(metric text, goal_ms bigint, state text, elapsed_business_ms bigint,
           remaining_ms bigint, breached_at timestamptz, stopped_at timestamptz, jira_state text, jira_goal_ms bigint,
           jira_remaining_ms bigint, jira_breached boolean, computed_at timestamptz)
         ON CONFLICT (case_id, metric) DO UPDATE SET
           goal_ms = EXCLUDED.goal_ms,
           state = EXCLUDED.state,
           elapsed_business_ms = EXCLUDED.elapsed_business_ms,
           remaining_ms = EXCLUDED.remaining_ms,
           breached_at = EXCLUDED.breached_at,
           stopped_at = EXCLUDED.stopped_at,
           jira_state = EXCLUDED.jira_state,
           jira_goal_ms = EXCLUDED.jira_goal_ms,
           jira_remaining_ms = EXCLUDED.jira_remaining_ms,
           jira_breached = EXCLUDED.jira_breached,
           computed_at = EXCLUDED.computed_at`,
        [key, JSON.stringify(rows)],
      ),
    );
  }

  return statements;
}

/* ----------------------------------------------------------- sync state */

export function emptySyncState(): CaseSyncState {
  return {
    backfill: { afterKey: null, completedAt: null, done: false, processed: 0, startedAt: null },
    incremental: { cursor: null, processed: 0 },
    lastError: null,
    lastTick: null,
    retry: [],
  };
}

/**
 * Stored clocks were computed with older SLA rules: restart the backfill so every ticket is rewritten with the current
 * engine (writes are idempotent). The incremental cursor is kept, so new changes keep flowing meanwhile. Mutates state.
 */
export function rewalkIfSlaRulesChanged(state: CaseSyncState): boolean {
  if ((state.slaRulesVersion ?? 1) === SLA_RULES_VERSION) {
    return false;
  }
  state.backfill = { ...emptySyncState().backfill };
  state.slaRulesVersion = SLA_RULES_VERSION;
  return true;
}

/** A stored state merged over the defaults, so a missing or older-shaped value still reads. */
export function normalizeSyncState(raw: unknown): CaseSyncState {
  const base = emptySyncState();
  if (!raw || typeof raw !== "object") {
    return base;
  }
  const value = raw as Partial<CaseSyncState>;
  return {
    backfill: { ...base.backfill, ...(value.backfill ?? {}) },
    incremental: { ...base.incremental, ...(value.incremental ?? {}) },
    lastError: value.lastError ?? null,
    lastTick: value.lastTick ?? null,
    retry: Array.isArray(value.retry) ? value.retry : [],
    ...(typeof value.slaRulesVersion === "number" ? { slaRulesVersion: value.slaRulesVersion } : {}),
  };
}

export async function loadSyncState(db: SqlExecutor): Promise<CaseSyncState> {
  const rows = await db.query<{ value: unknown }>(sql("sync_state.get", "SELECT value FROM sync_state WHERE key = $1", [SYNC_STATE_KEY]));
  const value = rows[0]?.value;
  /* jsonb arrives parsed from the driver; tolerate a string too. */
  return normalizeSyncState(typeof value === "string" ? (JSON.parse(value) as unknown) : value);
}

export async function saveSyncState(db: SqlExecutor, state: CaseSyncState): Promise<void> {
  await db.query(
    sql(
      "sync_state.put",
      `INSERT INTO sync_state (key, value, updated_at) VALUES ($1, $2::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [SYNC_STATE_KEY, JSON.stringify(state)],
    ),
  );
}

/* ------------------------------------------------------------ Jira reads */

/** Every comment on an issue, oldest first, paginated, with entity properties (for sd.public.comment). */
export async function fetchAllComments(client: ReadOnlyJiraClient, key: string): Promise<RawComment[]> {
  const all: RawComment[] = [];
  for (let startAt = 0; startAt < MAX_COMMENTS; ) {
    const page = await client.get<{ comments?: RawComment[]; total?: number }>(`/rest/api/3/issue/${key}/comment`, {
      expand: "properties",
      maxResults: COMMENT_PAGE_SIZE,
      orderBy: "created",
      startAt,
    });
    const comments = page?.comments ?? [];
    all.push(...comments);
    startAt += comments.length;
    if (comments.length === 0 || (typeof page?.total === "number" && startAt >= page.total)) {
      break;
    }
  }
  return all;
}

/* The changelog endpoint returns author, id, fromString/toString as well; sweep's ChangelogPage just doesn't name them. */
async function fetchHistories(client: ReadOnlyJiraClient, key: string): Promise<JiraHistory[]> {
  return (await fullChangelog(client, key)) as JiraHistory[];
}

/* --------------------------------------------------------------- the tick */

/** SET NX EX over Redis - injectable so the tick is tested in memory. */
export interface SyncLockStore {
  del(key: string): Promise<void>;
  /* true only for the call that created the key. */
  setIfAbsent(key: string, ttlSeconds: number): Promise<boolean>;
}

export interface CaseSyncDeps {
  calendar?: BusinessCalendar;
  db: SqlExecutor;
  jira: ReadOnlyJiraClient;
  locks: SyncLockStore;
  now: () => number;
}

export interface SyncTickOptions {
  budgetMs?: number;
  /* Manual runs skip the 2-minute throttle (they have their own) but still take the lock. */
  force?: boolean;
  maxIssues?: number;
  trigger?: SyncTickSummary["trigger"];
}

function errorText(error: unknown): string {
  return redactDbError(error);
}

function redisLockStore(): SyncLockStore {
  const redis = getRedis();
  return {
    del: async (key) => {
      await redis.del(key);
    },
    setIfAbsent: async (key, ttlSeconds) => (await redis.set(key, new Date().toISOString(), { ex: ttlSeconds, nx: true })) === "OK",
  };
}

type DepsOrSkip = { deps: CaseSyncDeps } | { skipped: NonNullable<SyncTickResult["skipped"]> };

function defaultDeps(): DepsOrSkip {
  const db = getDb();
  if (!db) {
    return { skipped: "db_unconfigured" };
  }
  if (!isRedisConfigured()) {
    return { skipped: "redis_unconfigured" };
  }
  let jira: ReadOnlyJiraClient;
  try {
    jira = createReadOnlyJiraClient(readOnlyJiraConfigFromEnv());
  } catch {
    return { skipped: "jira_unconfigured" };
  }
  return { deps: { db, jira, locks: redisLockStore(), now: Date.now } };
}

interface TickContext {
  deadlineMs: number;
  deps: CaseSyncDeps;
  errors: string[];
  processed: number;
  quota: number;
  skippedUnchanged: number;
  state: CaseSyncState;
}

function noteError(ctx: TickContext, message: string): void {
  if (ctx.errors.length < MAX_TICK_ERRORS) {
    ctx.errors.push(message);
  }
}

function canStartMore(ctx: TickContext): boolean {
  return ctx.processed < ctx.quota && ctx.deps.now() < ctx.deadlineMs - PER_ISSUE_RESERVE_MS;
}

/** Reads one issue's comments and changelog and writes its bundle. Returns an error message, or null on success. */
async function syncOneIssue(ctx: TickContext, issue: RawCaseIssue): Promise<string | null> {
  try {
    if (!isInCasePod(issue)) {
      /* The JQL matched on the option value; a mismatch here means the option was renamed or re-pointed. */
      return `${issue.key}: Pod is not ${CASE_POD.name} (${CASE_POD.id}); skipped`;
    }
    const [comments, histories] = await Promise.all([fetchAllComments(ctx.deps.jira, issue.key), fetchHistories(ctx.deps.jira, issue.key)]);
    const bundle = buildCaseBundle({ calendar: ctx.deps.calendar, comments, histories, issue, nowMs: ctx.deps.now() });
    await ctx.deps.db.transaction(caseWriteStatements(bundle));
    return null;
  } catch (error) {
    return `${issue.key}: ${errorText(error)}`;
  }
}

function rememberFailure(state: CaseSyncState, key: string, message: string): void {
  const existing = state.retry.find((entry) => entry.key === key);
  if (existing) {
    existing.lastError = message;
    return;
  }
  if (state.retry.length < MAX_RETRY_KEYS) {
    state.retry.push({ attempts: 0, key, lastError: message });
  }
}

/**
 * Syncs `issues` in order, a few at a time, until the quota or the time
 * budget runs out. `onHandled` is called for every issue that was handled
 * (synced, or failed and queued for retry), in order, so the caller can
 * advance its cursor over exactly that prefix.
 */
async function syncInOrder(ctx: TickContext, issues: RawCaseIssue[], onHandled: (issue: RawCaseIssue, error: string | null) => void): Promise<number> {
  let handled = 0;
  while (handled < issues.length && canStartMore(ctx)) {
    const room = Math.min(ISSUE_CONCURRENCY, ctx.quota - ctx.processed);
    const batch = issues.slice(handled, handled + room);
    const results = await mapLimit(batch, ISSUE_CONCURRENCY, (issue) => syncOneIssue(ctx, issue));
    batch.forEach((issue, index) => {
      const error = results[index] ?? null;
      if (error) {
        noteError(ctx, error);
      }
      onHandled(issue, error);
    });
    ctx.processed += batch.length;
    handled += batch.length;
  }
  return handled;
}

async function retryPhase(ctx: TickContext): Promise<void> {
  const keys = ctx.state.retry.map((entry) => entry.key);
  if (keys.length === 0) {
    return;
  }
  const issues = await searchByKeys<RawCaseIssue>(ctx.deps.jira, keys, CASE_FIELDS);
  const found = new Set(issues.map((issue) => issue.key));
  /* A key Jira no longer returns (deleted, moved, no longer visible) can't be retried. */
  ctx.state.retry = ctx.state.retry.filter((entry) => found.has(entry.key));
  issues.sort((a, b) => (a.key < b.key ? -1 : 1));
  await syncInOrder(ctx, issues, (issue, error) => {
    const entry = ctx.state.retry.find((candidate) => candidate.key === issue.key);
    if (!entry) {
      return;
    }
    if (!error) {
      ctx.state.retry = ctx.state.retry.filter((candidate) => candidate.key !== issue.key);
      return;
    }
    entry.attempts += 1;
    entry.lastError = error;
    if (entry.attempts >= MAX_RETRY_ATTEMPTS) {
      noteError(ctx, `${issue.key}: gave up after ${entry.attempts} retries; it syncs again on its next Jira update`);
      ctx.state.retry = ctx.state.retry.filter((candidate) => candidate.key !== issue.key);
    }
  });
}

/** JQL for the next backfill page: key order, after the saved cursor. Exported for tests. */
export function backfillJql(afterKey: string | null): string {
  return `${BACKFILL_WHERE}${afterKey ? ` AND key > ${afterKey}` : ""} ORDER BY key ASC`;
}

/**
 * JQL for the incremental window. Relative minutes rather than a date
 * literal: JQL reads "yyyy/MM/dd HH:mm" in the service account's own
 * timezone, which we don't control; "-Nm" is unambiguous.
 */
export function incrementalJql(cursorIso: string, nowMs: number): string {
  const minutes = Math.max(1, Math.ceil((nowMs - Date.parse(cursorIso) + OVERLAP_MS) / 60_000));
  return `${CASE_SCOPE_JQL} AND updated >= -${minutes}m ORDER BY updated ASC, key ASC`;
}

async function backfillPhase(ctx: TickContext): Promise<boolean> {
  const backfill = ctx.state.backfill;
  backfill.startedAt ??= new Date(ctx.deps.now()).toISOString();
  const pageSize = ctx.quota - ctx.processed;
  if (pageSize <= 0 || !canStartMore(ctx)) {
    return false;
  }
  const issues = await ctx.deps.jira.searchJql<RawCaseIssue>(backfillJql(backfill.afterKey), CASE_FIELDS, { maxTotal: pageSize });
  const handled = await syncInOrder(ctx, issues, (issue, error) => {
    backfill.afterKey = issue.key;
    backfill.processed += 1;
    if (error) {
      rememberFailure(ctx.state, issue.key, error);
    }
  });
  if (handled === issues.length && issues.length < pageSize) {
    /* Exhausted. Incremental picks up from when the backfill began, so anything updated during it is re-read. */
    backfill.done = true;
    backfill.completedAt = new Date(ctx.deps.now()).toISOString();
    ctx.state.incremental.cursor ??= backfill.startedAt;
    return true;
  }
  return false;
}

/** Jira `updated` already stored per key - an issue whose `updated` hasn't moved is skipped. */
async function storedUpdated(db: SqlExecutor, keys: string[]): Promise<Map<string, number>> {
  if (keys.length === 0) {
    return new Map();
  }
  const rows = await db.query<{ jira_key: string; jira_updated: unknown }>(
    sql(
      "cases.jira_updated_for_keys",
      "SELECT jira_key, jira_updated FROM cases WHERE jira_key IN (SELECT jsonb_array_elements_text($1::jsonb))",
      [JSON.stringify(keys)],
    ),
  );
  const out = new Map<string, number>();
  for (const row of rows) {
    const ms = row.jira_updated instanceof Date ? row.jira_updated.getTime() : Date.parse(String(row.jira_updated));
    if (!Number.isNaN(ms)) {
      out.set(row.jira_key, ms);
    }
  }
  return out;
}

function laterIso(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(b) > Date.parse(a) ? b : a;
}

async function incrementalPhase(ctx: TickContext): Promise<void> {
  const incremental = ctx.state.incremental;
  if (!incremental.cursor || !canStartMore(ctx)) {
    return;
  }
  const searchStartedMs = ctx.deps.now();
  const window = await ctx.deps.jira.searchJql<RawCaseIssue>(incrementalJql(incremental.cursor, searchStartedMs), CASE_FIELDS, {
    maxTotal: INCREMENTAL_WINDOW,
  });
  const stored = await storedUpdated(ctx.deps.db, window.map((issue) => issue.key));

  let cursor = incremental.cursor;
  let complete = true;
  let pending: RawCaseIssue[] = [];

  /* Walk in `updated` order; unchanged issues just move the cursor, changed ones are synced in small ordered batches. */
  const flush = async (): Promise<boolean> => {
    if (pending.length === 0) {
      return true;
    }
    const batch = pending;
    pending = [];
    const handled = await syncInOrder(ctx, batch, (issue, error) => {
      cursor = laterIso(cursor, isoOrNull(issue.fields.updated)) ?? cursor;
      incremental.processed += 1;
      if (error) {
        rememberFailure(ctx.state, issue.key, error);
      }
    });
    return handled === batch.length;
  };

  for (const issue of window) {
    const updatedMs = Date.parse(issue.fields.updated ?? "");
    if (!Number.isNaN(updatedMs) && stored.get(issue.key) === updatedMs) {
      if (!(await flush())) {
        complete = false;
        break;
      }
      ctx.skippedUnchanged += 1;
      cursor = laterIso(cursor, new Date(updatedMs).toISOString()) ?? cursor;
      continue;
    }
    pending.push(issue);
    if (pending.length >= ISSUE_CONCURRENCY && !(await flush())) {
      complete = false;
      break;
    }
  }
  if (complete && !(await flush())) {
    complete = false;
  }

  if (complete && window.length < INCREMENTAL_WINDOW) {
    /* Every issue updated since the cursor was handled, as of when the search ran (the overlap covers index lag). */
    cursor = laterIso(cursor, new Date(searchStartedMs).toISOString()) ?? cursor;
  }
  incremental.cursor = cursor;
}

/**
 * One bounded step of the Jira -> case store sync (see the module comment).
 * Throttled to once every 2 minutes (unless `force`), guarded by a Redis
 * lock, and stops starting new issues near `budgetMs`. Never throws: the
 * outcome, including errors, is returned and kept in sync_state.
 */
export async function syncTick(opts: SyncTickOptions = {}, injected?: CaseSyncDeps): Promise<SyncTickResult> {
  const resolved: DepsOrSkip = injected ? { deps: injected } : defaultDeps();
  if ("skipped" in resolved) {
    return { ok: false, skipped: resolved.skipped };
  }
  const { deps } = resolved;
  const startedMs = deps.now();

  try {
    /* Taken even when forced, so a manual run also holds off the poll's next tick. */
    const throttleFree = await deps.locks.setIfAbsent(THROTTLE_KEY, THROTTLE_SECONDS);
    if (!opts.force && !throttleFree) {
      return { ok: true, skipped: "throttled" };
    }
    if (!(await deps.locks.setIfAbsent(LOCK_KEY, LOCK_SECONDS))) {
      return { ok: true, skipped: "already_running" };
    }
  } catch (error) {
    const message = `Sync lock unavailable: ${errorText(error)}`;
    console.warn(`Case sync: ${message}`);
    return { error: message, ok: false };
  }

  let state = emptySyncState();
  const ctx: TickContext = {
    deadlineMs: startedMs + (opts.budgetMs ?? DEFAULT_BUDGET_MS),
    deps,
    errors: [],
    processed: 0,
    quota: opts.maxIssues ?? DEFAULT_MAX_ISSUES,
    skippedUnchanged: 0,
    state,
  };
  let phase: SyncTickSummary["phase"] = "idle";
  let fatal: string | null = null;
  /* Until the saved state is read, there is nothing safe to write back - saving the defaults would reset every cursor. */
  let loaded = false;

  try {
    state = await loadSyncState(deps.db);
    ctx.state = state;
    loaded = true;
    rewalkIfSlaRulesChanged(state);

    const retrying = state.retry.length > 0;
    await retryPhase(ctx);
    if (retrying) {
      phase = "retry";
    }

    if (!state.backfill.done) {
      phase = "backfill";
      const finished = await backfillPhase(ctx);
      if (finished && canStartMore(ctx)) {
        phase = "backfill+incremental";
        await incrementalPhase(ctx);
      }
    } else if (canStartMore(ctx)) {
      phase = "incremental";
      await incrementalPhase(ctx);
    }
  } catch (error) {
    fatal = errorText(error);
    noteError(ctx, fatal);
    console.warn("Case sync: tick failed; the next one resumes from the saved cursors.", fatal);
  }

  const summary: SyncTickSummary = {
    at: new Date(startedMs).toISOString(),
    durationMs: deps.now() - startedMs,
    errors: ctx.errors,
    phase,
    processed: ctx.processed,
    skippedUnchanged: ctx.skippedUnchanged,
    trigger: opts.trigger ?? "poll",
  };
  ctx.state.lastTick = summary;
  if (ctx.errors.length > 0) {
    ctx.state.lastError = { at: summary.at, message: ctx.errors[0] ?? "" };
  }

  try {
    if (loaded) {
      await saveSyncState(deps.db, ctx.state);
    }
  } catch (error) {
    /* Cursors not saved means the next tick redoes this one's work - idempotent, just slower. */
    fatal ??= `Could not save sync progress: ${errorText(error)}`;
    console.warn("Case sync: saving progress failed.", errorText(error));
  } finally {
    await deps.locks.del(LOCK_KEY).catch(() => undefined);
  }

  return fatal ? { error: fatal, ok: false, summary } : { ok: true, summary };
}

/** Records a dashboard-side operation in audit_log. Never throws. */
export async function recordAudit(
  db: SqlExecutor,
  entry: { actorAccountId: string | null; actorName: string | null; args?: unknown; caseKey?: string | null; operation: string; result?: unknown },
): Promise<void> {
  try {
    await db.query(
      sql(
        "audit_log.insert",
        `INSERT INTO audit_log (case_id, actor_account_id, actor_name, operation, args, result)
         VALUES ((SELECT id FROM cases WHERE jira_key = $1), $2, $3, $4, $5::jsonb, $6::jsonb)`,
        [entry.caseKey ?? null, entry.actorAccountId, entry.actorName, entry.operation, JSON.stringify(entry.args ?? {}), JSON.stringify(entry.result ?? null)],
      ),
    );
  } catch (error) {
    console.warn("Case store: audit write failed.", errorText(error));
  }
}

/**
 * The "Sync now" button: at most once every 30 seconds across all browsers,
 * then a forced tick (skips the 2-minute throttle, still takes the lock).
 * Audited. Never throws.
 */
export async function runManualSync(actor: { accountId: string; displayName: string }, injected?: CaseSyncDeps): Promise<SyncTickResult> {
  const resolved: DepsOrSkip = injected ? { deps: injected } : defaultDeps();
  if ("skipped" in resolved) {
    return { ok: false, skipped: resolved.skipped };
  }
  try {
    if (!(await resolved.deps.locks.setIfAbsent(MANUAL_KEY, MANUAL_THROTTLE_SECONDS))) {
      return { ok: true, skipped: "throttled" };
    }
  } catch (error) {
    return { error: `Sync lock unavailable: ${errorText(error)}`, ok: false };
  }
  const result = await syncTick({ force: true, trigger: "manual" }, resolved.deps);
  await recordAudit(resolved.deps.db, {
    actorAccountId: actor.accountId,
    actorName: actor.displayName,
    operation: "cases.sync",
    result: { error: result.error ?? null, processed: result.summary?.processed ?? 0, skipped: result.skipped ?? null },
  });
  return result;
}
