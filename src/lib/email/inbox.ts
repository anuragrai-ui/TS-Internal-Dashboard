import { getDb, isDatabaseConfigured, isoOrNull, numberOrNull, sql, textOrNull, withDb } from "@/lib/db/client";
import { emailCaseKey } from "@/lib/email/keys";
import { postgresEmailStore } from "@/lib/email/store";
import { createReadOnlyJiraClient, ReadOnlyJiraError, readOnlyJiraConfigFromEnv } from "@/lib/escalation/readOnlyJira";
import { defaultGoogleDeps, getGoogleConnectionStatus, supportMailboxAddress } from "@/lib/google/oauth";

import type { DbResult, SqlExecutor } from "@/lib/db/client";
import type { EmailStore } from "@/lib/email/store";
import type {
  EmailAddress,
  EmailAttachmentMeta,
  EmailCaseDetail,
  EmailCaseListItem,
  EmailCaseMessage,
  EmailInboxFilter,
  EmailInboxResponse,
  EmailSyncStatus,
} from "@/lib/workspace/types";

/**
 * The support inbox's read layer, plus "link to a Jira ticket": every case
 * with email on it (email cases and Jira cases that received mail), newest
 * activity first, and one case's email thread. Message text is plain text
 * (mime.ts never returns HTML). Reads return DbResult and never throw.
 */

const LIST_LIMIT = 200;
const SNIPPET_CHARS = 180;
const DETAIL_MESSAGES = 200;
export const INBOX_FILTERS: readonly EmailInboxFilter[] = ["all", "unlinked", "linked", "open"];
const CASE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const JIRA_TS_KEY = /^TS-\d{1,7}$/;

export function isInboxFilter(value: unknown): value is EmailInboxFilter {
  return typeof value === "string" && (INBOX_FILTERS as readonly string[]).includes(value);
}

export function isCaseId(value: unknown): value is string {
  return typeof value === "string" && CASE_ID_PATTERN.test(value);
}

type Row = Record<string, unknown>;

function json<T>(value: unknown): T | null {
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }
  return (value ?? null) as T | null;
}

function address(value: unknown): EmailAddress | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as { email?: unknown; name?: unknown };
  return typeof record.email === "string" ? { email: record.email, name: typeof record.name === "string" ? record.name : null } : null;
}

function addresses(value: unknown): EmailAddress[] {
  return Array.isArray(value) ? value.map(address).filter((item): item is EmailAddress => item !== null) : [];
}

function attachments(value: unknown): EmailAttachmentMeta[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is { mime?: unknown; name?: unknown; size?: unknown } => Boolean(item) && typeof item === "object")
    .map((item) => ({ mime: typeof item.mime === "string" ? item.mime : "application/octet-stream", name: typeof item.name === "string" ? item.name : "attachment", size: numberOrNull(item.size) ?? 0 }));
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** A list row -> EmailCaseListItem. Pure. */
export function toListItem(row: Row): EmailCaseListItem {
  const id = String(row.id);
  const jiraKey = textOrNull(row.jira_key);
  const inbound = json<{ from?: unknown }>(row.inbound_meta);
  const category = textOrNull(row.status_category);
  return {
    accountSuggestion: textOrNull(row.account_suggestion),
    caseId: id,
    from: address(inbound?.from),
    jiraKey,
    key: emailCaseKey(id, jiraKey),
    lastActivityAt: isoOrNull(row.last_at) ?? new Date(0).toISOString(),
    messageCount: numberOrNull(row.message_count) ?? 0,
    snippet: clip(textOrNull(row.last_body) ?? "", SNIPPET_CHARS),
    source: textOrNull(row.source) === "email" ? "email" : "jira",
    statusCategory: category === "done" || category === "indeterminate" ? category : "new",
    statusName: textOrNull(row.status_name) ?? "",
    subject: textOrNull(row.summary) || "(no subject)",
  };
}

/** A case_messages row -> EmailCaseMessage. Pure. */
export function toMessage(row: Row): EmailCaseMessage {
  const meta = json<Record<string, unknown>>(row.metadata) ?? {};
  const source = textOrNull(row.source);
  return {
    attachments: attachments(meta.attachments),
    bodyText: textOrNull(row.body_text) ?? "",
    cc: addresses(meta.cc),
    createdAt: isoOrNull(row.created_at) ?? new Date(0).toISOString(),
    direction: meta.direction === "outbound" ? "outbound" : "inbound",
    from: address(meta.from) ?? (textOrNull(row.author_name) ? { email: "", name: textOrNull(row.author_name) } : null),
    id: String(row.id),
    ...(typeof meta.sent_by === "string" ? { sentBy: meta.sent_by } : {}),
    source: source === "jira_comment" || source === "slack" || source === "dashboard" ? source : "email",
    subject: typeof meta.subject === "string" ? meta.subject : null,
    to: addresses(meta.to),
  };
}

const LIST_SQL = `
  SELECT c.id, c.jira_key, c.summary, c.source, c.status_category, c.status_name, c.account_suggestion,
         lm.body_text AS last_body, lm.created_at AS last_at, li.metadata AS inbound_meta, cnt.n AS message_count
  FROM cases c
  JOIN LATERAL (
    SELECT m.body_text, m.created_at FROM case_messages m
    WHERE m.case_id = c.id AND m.source = 'email' ORDER BY m.created_at DESC, m.id DESC LIMIT 1
  ) lm ON true
  LEFT JOIN LATERAL (
    SELECT m.metadata FROM case_messages m
    WHERE m.case_id = c.id AND m.source = 'email' AND m.metadata->>'direction' = 'inbound'
    ORDER BY m.created_at DESC, m.id DESC LIMIT 1
  ) li ON true
  JOIN LATERAL (SELECT count(*) AS n FROM case_messages m WHERE m.case_id = c.id AND m.source = 'email') cnt ON true
  WHERE c.id IN (SELECT case_id FROM case_messages WHERE source = 'email')
    AND ($1 = 'all'
      OR ($1 = 'unlinked' AND c.jira_key IS NULL)
      OR ($1 = 'linked' AND c.jira_key IS NOT NULL)
      OR ($1 = 'open' AND c.status_category <> 'done'))
    AND ($3::uuid IS NULL OR c.id = $3::uuid)
  ORDER BY lm.created_at DESC, c.id
  LIMIT $2`;

/** Cases with email on them, newest activity first. Never throws. */
export async function listEmailCases(filter: EmailInboxFilter, db: SqlExecutor | null = getDb()): Promise<DbResult<EmailCaseListItem[]>> {
  return withDb(
    "email inbox list",
    async (conn) => (await conn.query<Row>(sql("email.inbox.list", LIST_SQL, [filter, LIST_LIMIT, null]))).map(toListItem),
    db,
  );
}

/** One case's list row and its email thread, oldest first; null when no such case has email. Never throws. */
export async function getEmailCaseDetail(caseId: string, db: SqlExecutor | null = getDb()): Promise<DbResult<EmailCaseDetail | null>> {
  if (!isCaseId(caseId)) {
    return { ok: true, value: null };
  }
  return withDb(
    "email inbox case",
    async (conn) => {
      const [items, messages] = await Promise.all([
        conn.query<Row>(sql("email.inbox.list", LIST_SQL, ["all", 1, caseId])),
        conn.query<Row>(
          sql(
            "email.inbox.messages",
            `SELECT id, source, author_name, body_text, created_at, metadata FROM case_messages
             WHERE case_id = $1::uuid AND source = 'email' ORDER BY created_at, id LIMIT $2`,
            [caseId, DETAIL_MESSAGES],
          ),
        ),
      ]);
      const item = items[0];
      return item ? { item: toListItem(item), messages: messages.map(toMessage) } : null;
    },
    db,
  );
}

/* ---------------------------------------------------------------- link */

export type JiraLookup = (key: string) => Promise<"exists" | "missing" | { error: string }>;

export interface LinkDeps {
  jiraLookup: JiraLookup;
  store: EmailStore;
}

export type LinkResult = { caseId: string; key: string; merged: boolean; ok: true } | { error: string; ok: false; status: number };

/**
 * Links an email case to a TS ticket that really exists in Jira (checked
 * with the read-only client). Merges into the Jira case when the store
 * already has it. Never throws.
 */
export async function linkEmailCaseWith(deps: LinkDeps, caseId: string, rawKey: unknown, actor: { accountId: string; displayName: string }): Promise<LinkResult> {
  if (!isCaseId(caseId)) {
    return { error: "Not an email case id.", ok: false, status: 400 };
  }
  const key = typeof rawKey === "string" ? rawKey.trim().toUpperCase() : "";
  if (!JIRA_TS_KEY.test(key)) {
    return { error: "Enter a TS ticket key like TS-123.", ok: false, status: 400 };
  }
  const found = await deps.jiraLookup(key);
  if (found === "missing") {
    return { error: `${key} doesn't exist in Jira, or the dashboard's Jira account can't see it.`, ok: false, status: 404 };
  }
  if (typeof found === "object") {
    return { error: `Couldn't check ${key} in Jira (${found.error}) - nothing was linked.`, ok: false, status: 502 };
  }
  try {
    const linked = await deps.store.linkCase(caseId, key, actor);
    if (!linked.ok) {
      return { error: linked.error, ok: false, status: 409 };
    }
    return { caseId: linked.caseId, key, merged: linked.merged, ok: true };
  } catch (error) {
    console.warn("Email inbox: link failed.", error instanceof Error ? error.name : "unknown");
    return { error: "Couldn't save the link right now - try again in a moment.", ok: false, status: 503 };
  }
}

/** The read-only Jira client's "does this issue exist". */
export function defaultJiraLookup(): JiraLookup {
  return async (key) => {
    try {
      const client = createReadOnlyJiraClient(readOnlyJiraConfigFromEnv());
      await client.get(`/rest/api/3/issue/${key}`, { fields: "summary" });
      return "exists";
    } catch (error) {
      if (error instanceof ReadOnlyJiraError && (error.status === 404 || error.status === 403)) {
        return "missing";
      }
      return { error: error instanceof ReadOnlyJiraError ? (error.status ? `HTTP ${error.status}` : "no answer") : "Jira isn't configured" };
    }
  };
}

/** linkEmailCaseWith over the real store and Jira. Never throws. */
export async function linkEmailCase(caseId: string, key: unknown, actor: { accountId: string; displayName: string }): Promise<LinkResult> {
  const db = getDb();
  if (!db) {
    return { error: "The case store database is not configured (DATABASE_URL is unset).", ok: false, status: 503 };
  }
  return linkEmailCaseWith({ jiraLookup: defaultJiraLookup(), store: postgresEmailStore(db) }, caseId, key, actor);
}

/* ------------------------------------------------------------- overview */

/** Everything the inbox page needs at once: setup state, sync status and the list. Never throws. */
export async function getInboxOverview(filter: EmailInboxFilter): Promise<EmailInboxResponse> {
  const supportAddress = supportMailboxAddress();
  const mailbox = await getGoogleConnectionStatus(defaultGoogleDeps(), "mailbox");
  const missingEnv = [...new Set([...(isDatabaseConfigured() ? [] : ["DATABASE_URL"]), ...mailbox.missingEnv])];
  const base: EmailInboxResponse = {
    items: [],
    mailbox,
    missingEnv,
    sendEnabled: process.env.EMAIL_SEND_ENABLED?.trim() === "true",
    supportAddress,
    sync: null,
    testRecipient: process.env.EMAIL_TEST_RECIPIENT?.trim() || null,
  };
  const db = getDb();
  if (!db) {
    return base;
  }
  const [list, state] = await Promise.all([listEmailCases(filter, db), withDb("email sync status", (conn) => postgresEmailStore(conn).loadState(), db)]);
  const sync: EmailSyncStatus | null = state.ok
    ? { initialSyncAt: state.value.initialSyncAt, lastError: state.value.lastError, lastTick: state.value.lastTick, pending: state.value.pending.length }
    : null;
  return { ...base, items: list.ok ? list.value : [], sync, ...(list.ok ? {} : { error: list.error }) };
}
