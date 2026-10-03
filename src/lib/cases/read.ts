import { getDb, isoOrNull, numberOrNull, sql, textOrNull, withDb } from "@/lib/db/client";
import { loadSyncState } from "@/lib/cases/jiraSync";
import { parityMismatch } from "@/lib/cases/sla";

import type {
  CaseDetail,
  CaseEvent,
  CaseLink,
  CaseListItem,
  CaseMessage,
  CaseRecord,
  ParityMismatch,
  SlaClock,
  SlaClockState,
  SyncStatus,
} from "@/lib/cases/types";
import type { DbResult, SqlExecutor } from "@/lib/db/client";
import type { StatusCategory } from "@/lib/escalation/types";

/**
 * Read side of the case store, for the /api/cases routes and the /cases
 * page. Every function returns a DbResult and never throws; with no
 * DATABASE_URL they report "not configured" instead of failing.
 */

type Row = Record<string, unknown>;

const MAX_PARITY_EXAMPLES = 10;
const CASE_KEY = /^[A-Z][A-Z0-9]*-\d+$/;

/** Whether `key` looks like a Jira issue key (TS-123). */
export function isCaseKey(key: string): boolean {
  return CASE_KEY.test(key);
}

function text(value: unknown): string {
  return textOrNull(value) ?? "";
}

function category(value: unknown): StatusCategory {
  return value === "done" || value === "indeterminate" ? value : "new";
}

function clockState(value: unknown): SlaClockState {
  return value === "running" || value === "paused" || value === "met" || value === "breached" ? value : "none";
}

/* ------------------------------------------------------------- mappers */

export function toCaseRecord(row: Row): CaseRecord {
  return {
    accountName: textOrNull(row.account_name),
    assigneeAccountId: textOrNull(row.assignee_account_id),
    assigneeName: textOrNull(row.assignee_name),
    createdAt: isoOrNull(row.created_at) ?? "",
    descriptionText: text(row.description_text),
    id: text(row.id),
    jiraKey: text(row.jira_key),
    jiraUpdated: isoOrNull(row.jira_updated) ?? "",
    lastSyncedAt: isoOrNull(row.last_synced_at) ?? "",
    pod: textOrNull(row.pod),
    priority: textOrNull(row.priority),
    reporterEmail: textOrNull(row.reporter_email),
    reporterName: textOrNull(row.reporter_name),
    resolvedAt: isoOrNull(row.resolved_at),
    statusCategory: category(row.status_category),
    statusId: text(row.status_id),
    statusName: text(row.status_name),
    summary: text(row.summary),
    updatedAt: isoOrNull(row.updated_at) ?? "",
    version: numberOrNull(row.version) ?? 1,
  };
}

function toMessage(row: Row): CaseMessage {
  return {
    authorAccountId: textOrNull(row.author_account_id),
    authorName: textOrNull(row.author_name),
    bodyText: text(row.body_text),
    createdAt: isoOrNull(row.created_at) ?? "",
    editedAt: isoOrNull(row.edited_at),
    externalId: text(row.external_id),
    source: row.source === "slack" || row.source === "dashboard" ? row.source : "jira_comment",
    visibility: row.visibility === "internal" ? "internal" : "public",
  };
}

function toEvent(row: Row): CaseEvent {
  return {
    actorAccountId: textOrNull(row.actor_account_id),
    actorName: textOrNull(row.actor_name),
    at: isoOrNull(row.at) ?? "",
    externalId: text(row.external_id),
    fromId: textOrNull(row.from_id),
    fromValue: textOrNull(row.from_value),
    kind: text(row.kind) as CaseEvent["kind"],
    toId: textOrNull(row.to_id),
    toValue: textOrNull(row.to_value),
  };
}

function toLink(row: Row): CaseLink {
  return { direction: row.direction === "inward" ? "inward" : "outward", linkType: text(row.link_type), linkedKey: text(row.linked_key) };
}

export function toSlaClock(row: Row): SlaClock {
  return {
    breachedAt: isoOrNull(row.breached_at),
    computedAt: isoOrNull(row.computed_at) ?? "",
    elapsedBusinessMs: numberOrNull(row.elapsed_business_ms) ?? 0,
    goalMs: numberOrNull(row.goal_ms),
    jira: {
      breached: row.jira_breached === true,
      goalMs: numberOrNull(row.jira_goal_ms),
      remainingMs: numberOrNull(row.jira_remaining_ms),
      state: textOrNull(row.jira_state) ?? "none",
    },
    metric: row.metric === "first_response" ? "first_response" : "resolution",
    remainingMs: numberOrNull(row.remaining_ms),
    state: clockState(row.state),
    stoppedAt: isoOrNull(row.stopped_at),
  };
}

/* --------------------------------------------------------------- reads */

const CASE_SELECT = `SELECT c.*, a.name AS account_name, ct.name AS reporter_name, ct.email AS reporter_email
  FROM cases c
  LEFT JOIN accounts a ON a.id = c.account_id
  LEFT JOIN contacts ct ON ct.id = c.reporter_contact_id`;

/** One case with its messages, events, links and SLA clocks; null value when the key isn't in the store. */
export async function getCaseByKey(key: string, db: SqlExecutor | null = getDb()): Promise<DbResult<CaseDetail | null>> {
  if (!isCaseKey(key)) {
    return { ok: true, value: null };
  }
  return withDb(
    `read ${key}`,
    async (conn) => {
      const [cases, messages, events, links, clocks] = await Promise.all([
        conn.query<Row>(sql("cases.by_key", `${CASE_SELECT} WHERE c.jira_key = $1`, [key])),
        conn.query<Row>(
          sql(
            "case_messages.by_key",
            "SELECT m.* FROM case_messages m JOIN cases c ON c.id = m.case_id WHERE c.jira_key = $1 ORDER BY m.created_at, m.id",
            [key],
          ),
        ),
        conn.query<Row>(
          sql("case_events.by_key", "SELECT e.* FROM case_events e JOIN cases c ON c.id = e.case_id WHERE c.jira_key = $1 ORDER BY e.at, e.id", [key]),
        ),
        conn.query<Row>(
          sql(
            "case_links.by_key",
            "SELECT l.* FROM case_links l JOIN cases c ON c.id = l.case_id WHERE c.jira_key = $1 ORDER BY l.linked_key, l.link_type",
            [key],
          ),
        ),
        conn.query<Row>(
          sql("sla_clocks.by_key", "SELECT s.* FROM sla_clocks s JOIN cases c ON c.id = s.case_id WHERE c.jira_key = $1 ORDER BY s.metric", [key]),
        ),
      ]);
      const row = cases[0];
      if (!row) {
        return null;
      }
      return {
        case: toCaseRecord(row),
        events: events.map(toEvent),
        links: links.map(toLink),
        messages: messages.map(toMessage),
        sla: clocks.map(toSlaClock),
      };
    },
    db,
  );
}

/** Cases for the /cases list: open ones first, then most recently updated in Jira. */
export async function listCases(limit = 200, db: SqlExecutor | null = getDb()): Promise<DbResult<CaseListItem[]>> {
  const capped = Math.max(1, Math.min(500, Math.floor(limit)));
  return withDb(
    "list cases",
    async (conn) => {
      const rows = await conn.query<Row>(
        sql(
          "cases.list",
          `SELECT c.jira_key, c.summary, c.priority, c.status_name, c.status_category, c.assignee_name, c.jira_updated,
             a.name AS account_name, s.state AS ttr_state, s.goal_ms AS ttr_goal_ms, s.remaining_ms AS ttr_remaining_ms
           FROM cases c
           LEFT JOIN accounts a ON a.id = c.account_id
           LEFT JOIN sla_clocks s ON s.case_id = c.id AND s.metric = 'resolution'
           WHERE c.jira_key IS NOT NULL
           ORDER BY (c.status_category = 'done'), c.jira_updated DESC
           LIMIT $1`,
          [capped],
        ),
      );
      return rows.map((row) => ({
        accountName: textOrNull(row.account_name),
        assigneeName: textOrNull(row.assignee_name),
        jiraKey: text(row.jira_key),
        jiraUpdated: isoOrNull(row.jira_updated) ?? "",
        priority: textOrNull(row.priority),
        resolution:
          row.ttr_state === null || row.ttr_state === undefined
            ? null
            : { goalMs: numberOrNull(row.ttr_goal_ms), remainingMs: numberOrNull(row.ttr_remaining_ms), state: clockState(row.ttr_state) },
        statusCategory: category(row.status_category),
        statusName: text(row.status_name),
        summary: text(row.summary),
      }));
    },
    db,
  );
}

/** Our clocks against Jira's: how many agree, and the first few that don't. Pure. */
export function summarizeParity(rows: Array<{ clock: SlaClock; jiraKey: string }>): SyncStatus["parity"] {
  const mismatches: ParityMismatch[] = [];
  let compared = 0;
  for (const { clock, jiraKey } of rows) {
    compared += 1;
    const reason = parityMismatch(clock, clock.jira);
    if (reason) {
      mismatches.push({
        jira: { breached: clock.jira.breached, remainingMs: clock.jira.remainingMs, state: clock.jira.state },
        jiraKey,
        metric: clock.metric,
        ours: { breached: clock.state === "breached", remainingMs: clock.remainingMs, state: clock.state },
        reason,
      });
    }
  }
  return { compared, examples: mismatches.slice(0, MAX_PARITY_EXAMPLES), matched: compared - mismatches.length, mismatched: mismatches.length };
}

/** Counts, sync cursors / last tick / last error, and SLA parity with examples. */
export async function getSyncStatus(db: SqlExecutor | null = getDb()): Promise<DbResult<SyncStatus>> {
  return withDb(
    "sync status",
    async (conn) => {
      const [countRows, state, clockRows] = await Promise.all([
        conn.query<Row>(
          sql(
            "status.counts",
            `SELECT
               (SELECT count(*) FROM cases WHERE jira_key IS NOT NULL) AS cases,
               (SELECT count(*) FROM cases WHERE jira_key IS NOT NULL AND status_category <> 'done') AS open_cases,
               (SELECT count(*) FROM case_messages) AS messages,
               (SELECT count(*) FROM case_events) AS events,
               (SELECT count(*) FROM accounts) AS accounts,
               (SELECT count(*) FROM contacts) AS contacts,
               (SELECT count(*) FROM sla_clocks) AS sla_clocks`,
          ),
        ),
        loadSyncState(conn),
        /* Newest first, so the examples shown are the freshest disagreements. */
        conn.query<Row>(
          sql("status.parity", "SELECT c.jira_key, s.* FROM sla_clocks s JOIN cases c ON c.id = s.case_id ORDER BY c.jira_updated DESC, s.metric"),
        ),
      ]);
      const counts = countRows[0] ?? {};
      const n = (value: unknown): number => numberOrNull(value) ?? 0;
      return {
        counts: {
          accounts: n(counts.accounts),
          cases: n(counts.cases),
          contacts: n(counts.contacts),
          events: n(counts.events),
          messages: n(counts.messages),
          openCases: n(counts.open_cases),
          slaClocks: n(counts.sla_clocks),
        },
        parity: summarizeParity(clockRows.map((row) => ({ clock: toSlaClock(row), jiraKey: text(row.jira_key) }))),
        state,
      };
    },
    db,
  );
}
