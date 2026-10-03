import { randomUUID } from "node:crypto";

import { sql, textOrNull } from "@/lib/db/client";

import type { SqlExecutor } from "@/lib/db/client";
import type { ParsedEmail } from "@/lib/email/mime";
import type { CaseRef, IntakePlan } from "@/lib/email/rules";
import type { EmailAddress, EmailAttachmentMeta } from "@/lib/workspace/types";

/**
 * Where email intake reads and writes the case store - an interface, so
 * gmailSync.ts and the link flow run against an in-memory fake in
 * scripts/test-email.ts, plus the Postgres implementation. The methods
 * THROW on a database failure; the sync turns that into a retry.
 *
 * An email message is a case_messages row with source 'email', keyed by the
 * Gmail message id (UNIQUE (source, external_id)), so storing the same
 * message twice is a no-op. Its headers live in `metadata`:
 *   { gmail_id, thread_id, direction, message_id, from, to, cc, subject,
 *     in_reply_to, references, attachments: [{ name, size, mime }], date,
 *     sent_by? }
 */

export const EMAIL_SYNC_STATE_KEY = "gmail_intake";
const BODY_MAX_CHARS = 20_000;
/* An email case never came from Jira; the epoch makes any later Jira sync of its linked key look newer. */
const NEVER_SYNCED = "1970-01-01T00:00:00.000Z";

export interface EmailMessageMetadata {
  attachments: EmailAttachmentMeta[];
  cc: EmailAddress[];
  date: string;
  direction: "inbound" | "outbound";
  from: EmailAddress | null;
  gmail_id: string;
  in_reply_to: string | null;
  message_id: string | null;
  references: string[];
  /* The dashboard user who sent an outbound reply. */
  sent_by?: string;
  subject: string;
  thread_id: string;
  to: EmailAddress[];
}

/** One email as it is written to case_messages. */
export interface EmailMessageRecord {
  authorName: string;
  bodyText: string;
  createdAt: string;
  gmailId: string;
  metadata: EmailMessageMetadata;
}

/** A parsed email -> the row it becomes. `supportAddress` decides the direction. Pure. */
export function emailMessageRecord(email: ParsedEmail, supportAddress: string): EmailMessageRecord {
  const outbound = email.from?.email === supportAddress.toLowerCase();
  return {
    authorName: email.from?.name ?? email.from?.email ?? "Unknown sender",
    bodyText: email.newContent.slice(0, BODY_MAX_CHARS),
    createdAt: email.date,
    gmailId: email.gmailId,
    metadata: {
      attachments: email.attachments.slice(0, 50),
      cc: email.cc.slice(0, 50),
      date: email.date,
      direction: outbound ? "outbound" : "inbound",
      from: email.from,
      gmail_id: email.gmailId,
      in_reply_to: email.inReplyTo,
      message_id: email.messageId,
      references: email.references,
      subject: email.subject.slice(0, 1_000),
      thread_id: email.threadId,
      to: email.to.slice(0, 50),
    },
  };
}

export interface EmailSyncState {
  /* Gmail's history id up to which every change has been listed; null until the first (or after an expired) sync. */
  historyId: string | null;
  initialSyncAt: string | null;
  lastError: { at: string; message: string } | null;
  lastTick: { at: string; durationMs: number; errors: string[]; processed: number; skipped: number; trigger: "manual" | "poll" } | null;
  /* Message ids seen but not yet stored (budget ran out, or a failure being retried). */
  pending: Array<{ attempts: number; id: string }>;
  processed: number;
}

export function emptyEmailSyncState(): EmailSyncState {
  return { historyId: null, initialSyncAt: null, lastError: null, lastTick: null, pending: [], processed: 0 };
}

/** A stored state over the defaults, so an older or partial value still reads. Pure. */
export function normalizeEmailSyncState(raw: unknown): EmailSyncState {
  const base = emptyEmailSyncState();
  if (!raw || typeof raw !== "object") {
    return base;
  }
  const value = raw as Partial<EmailSyncState>;
  return {
    historyId: typeof value.historyId === "string" ? value.historyId : null,
    initialSyncAt: typeof value.initialSyncAt === "string" ? value.initialSyncAt : null,
    lastError: value.lastError ?? null,
    lastTick: value.lastTick ?? null,
    pending: Array.isArray(value.pending) ? value.pending.filter((entry) => entry && typeof entry.id === "string") : [],
    processed: typeof value.processed === "number" ? value.processed : 0,
  };
}

export type LinkOutcome =
  | { caseId: string; merged: boolean; ok: true }
  | { error: string; ok: false };

export interface EmailStore {
  /* Store one email per the plan (a new case, or appended to one). Returns the case it landed on. */
  applyIntake(plan: IntakePlan, record: EmailMessageRecord, contact: EmailAddress | null): Promise<{ caseId: string }>;
  findCaseByJiraKey(jiraKey: string): Promise<CaseRef | null>;
  findCaseByThread(threadId: string): Promise<CaseRef | null>;
  hasMessage(gmailId: string): Promise<boolean>;
  /*
   * Gives a case without a TS ticket the key `jiraKey`. If the store already
   * has that Jira case, the email case is merged into it: its messages move,
   * the empty shell goes. Refuses a case already linked to another key.
   */
  linkCase(caseId: string, jiraKey: string, actor: { accountId: string | null; displayName: string } | null): Promise<LinkOutcome>;
  loadState(): Promise<EmailSyncState>;
  saveState(state: EmailSyncState): Promise<void>;
}

/* --------------------------------------------------------------- postgres */

function caseRef(row: Record<string, unknown> | undefined): CaseRef | null {
  return row ? { id: String(row.id), jiraKey: textOrNull(row.jira_key) } : null;
}

function contactStatement(contact: EmailAddress | null) {
  /* contacts has no unique email (Jira contacts may share one), so "insert unless that address exists" rather than ON CONFLICT. */
  return contact
    ? [
        sql(
          "email.contacts.ensure",
          `INSERT INTO contacts (name, email)
           SELECT $1, $2 WHERE NOT EXISTS (SELECT 1 FROM contacts WHERE lower(email) = lower($2))`,
          [(contact.name ?? contact.email).slice(0, 200), contact.email],
        ),
      ]
    : [];
}

function messageInsert(caseIdSql: string, caseParam: string, record: EmailMessageRecord) {
  return sql(
    "email.case_messages.insert",
    `INSERT INTO case_messages (case_id, source, external_id, author_name, author_account_id, visibility, body_text, created_at, metadata)
     VALUES (${caseIdSql}, 'email', $2, $3, NULL, 'public', $4, $5::timestamptz, $6::jsonb)
     ON CONFLICT (source, external_id) DO NOTHING`,
    [caseParam, record.gmailId, record.authorName.slice(0, 200), record.bodyText, record.createdAt, JSON.stringify(record.metadata)],
  );
}

/** The case store as an EmailStore. */
export function postgresEmailStore(db: SqlExecutor): EmailStore {
  return {
    async applyIntake(plan, record, contact) {
      if (plan.kind === "create") {
        const id = randomUUID();
        await db.transaction([
          ...contactStatement(contact),
          sql(
            "email.cases.create",
            `INSERT INTO cases (id, jira_key, source, email_thread_id, priority, status_id, status_name, status_category,
               summary, description_text, content_hash, created_at, jira_updated, account_suggestion, reporter_contact_id)
             VALUES ($1::uuid, $2, 'email', $3, 'Medium', 'email:new', 'New', 'new', $4, $5, '', $6::timestamptz, $7::timestamptz, $8,
               (SELECT id FROM contacts WHERE lower(email) = lower($9) ORDER BY id LIMIT 1))
             ON CONFLICT (email_thread_id) DO NOTHING`,
            [id, plan.jiraKey, record.metadata.thread_id, plan.summary, record.bodyText, record.createdAt, NEVER_SYNCED, plan.accountSuggestion, contact?.email ?? null],
          ),
          /* By thread, not by the new id: a concurrent create for the same thread won the insert above. */
          messageInsert("(SELECT id FROM cases WHERE email_thread_id = $1)", record.metadata.thread_id, record),
        ]);
        const rows = await db.query<{ id: string }>(sql("email.cases.by_thread_id", "SELECT id FROM cases WHERE email_thread_id = $1", [record.metadata.thread_id]));
        return { caseId: String(rows[0]?.id ?? id) };
      }
      await db.transaction([...contactStatement(contact), messageInsert("$1::uuid", plan.caseId, record)]);
      return { caseId: plan.caseId };
    },

    async findCaseByJiraKey(jiraKey) {
      const rows = await db.query(sql("email.cases.by_jira_key", "SELECT id, jira_key FROM cases WHERE jira_key = $1", [jiraKey]));
      return caseRef(rows[0]);
    },

    async findCaseByThread(threadId) {
      const rows = await db.query(
        sql(
          "email.cases.by_thread",
          `SELECT id, jira_key FROM (
             SELECT c.id, c.jira_key, 0 AS rank FROM cases c WHERE c.email_thread_id = $1
             UNION ALL
             SELECT c.id, c.jira_key, 1 AS rank FROM case_messages m JOIN cases c ON c.id = m.case_id
             WHERE m.source = 'email' AND m.metadata->>'thread_id' = $1
           ) found ORDER BY rank LIMIT 1`,
          [threadId],
        ),
      );
      return caseRef(rows[0]);
    },

    async hasMessage(gmailId) {
      const rows = await db.query(sql("email.case_messages.exists", "SELECT 1 AS found FROM case_messages WHERE source = 'email' AND external_id = $1", [gmailId]));
      return rows.length > 0;
    },

    async linkCase(caseId, jiraKey, actor) {
      const rows = await db.query(
        sql("email.cases.for_link", "SELECT id, jira_key, source, email_thread_id, account_suggestion FROM cases WHERE id = $1::uuid", [caseId]),
      );
      const current = rows[0];
      if (!current) {
        return { error: "That email case doesn't exist (any more).", ok: false };
      }
      const currentKey = textOrNull(current.jira_key);
      if (currentKey === jiraKey) {
        return { caseId, merged: false, ok: true };
      }
      if (currentKey) {
        return { error: `This case is already linked to ${currentKey}.`, ok: false };
      }
      const audit = sql(
        "email.audit.link",
        `INSERT INTO audit_log (case_id, actor_account_id, actor_name, operation, args, result)
         VALUES ((SELECT id FROM cases WHERE jira_key = $1), $2, $3, 'email.link', $4::jsonb, $5::jsonb)`,
        [jiraKey, actor?.accountId ?? null, actor?.displayName ?? "email intake", JSON.stringify({ caseId, jiraKey }), JSON.stringify({ ok: true })],
      );

      const target = caseRef((await db.query(sql("email.cases.by_jira_key", "SELECT id, jira_key FROM cases WHERE jira_key = $1", [jiraKey])))[0]);
      if (!target) {
        await db.transaction([sql("email.cases.set_jira_key", "UPDATE cases SET jira_key = $2, updated_at = now() WHERE id = $1::uuid AND jira_key IS NULL", [caseId, jiraKey]), audit]);
        return { caseId, merged: false, ok: true };
      }

      /* The Jira case already exists: one case per ticket, so the email case's messages move there and its empty row goes. */
      await db.transaction([
        sql("email.case_messages.move", "UPDATE case_messages SET case_id = $2::uuid WHERE case_id = $1::uuid", [caseId, target.id]),
        sql("email.cases.delete_merged", "DELETE FROM cases WHERE id = $1::uuid AND jira_key IS NULL AND source = 'email'", [caseId]),
        /* After the delete: email_thread_id is unique, and the shell held it until a statement ago. */
        sql(
          "email.cases.adopt_thread",
          "UPDATE cases SET email_thread_id = COALESCE(email_thread_id, $2), account_suggestion = COALESCE(account_suggestion, $3) WHERE id = $1::uuid",
          [target.id, textOrNull(current.email_thread_id), textOrNull(current.account_suggestion)],
        ),
        audit,
      ]);
      return { caseId: target.id, merged: true, ok: true };
    },

    async loadState() {
      const rows = await db.query<{ value: unknown }>(sql("sync_state.get", "SELECT value FROM sync_state WHERE key = $1", [EMAIL_SYNC_STATE_KEY]));
      const value = rows[0]?.value;
      return normalizeEmailSyncState(typeof value === "string" ? (JSON.parse(value) as unknown) : value);
    },

    async saveState(state) {
      await db.query(
        sql(
          "sync_state.put",
          `INSERT INTO sync_state (key, value, updated_at) VALUES ($1, $2::jsonb, now())
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
          [EMAIL_SYNC_STATE_KEY, JSON.stringify(state)],
        ),
      );
    },
  };
}
