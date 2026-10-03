import type { StatusCategory } from "@/lib/escalation/types";

/**
 * Shapes of the case store (the dashboard's own system of record, Postgres).
 *
 * During the pilot Jira stays authoritative: every row here is a copy kept
 * in sync from Jira (src/lib/cases/jiraSync.ts), plus our own SLA clock
 * computed next to Jira's so parity can be proven before any cutover.
 * Instants are ISO strings, durations are milliseconds.
 */

export type MessageSource = "jira_comment" | "slack" | "dashboard";
export type MessageVisibility = "public" | "internal";
export type CaseEventKind = "status" | "assignee" | "priority" | "link" | "created" | "resolved" | "comment" | "action";
export type SlaMetric = "first_response" | "resolution";
export type SlaClockState = "running" | "paused" | "met" | "breached" | "none";

/** A case's own fields as mapped from Jira (no ids - those belong to the database). */
export interface CaseFields {
  accountName: string | null;
  assigneeAccountId: string | null;
  assigneeName: string | null;
  createdAt: string;
  descriptionText: string;
  jiraKey: string;
  jiraUpdated: string;
  pod: string | null;
  priority: string | null;
  reporter: { accountId: string; email: string | null; isCustomer: boolean; name: string } | null;
  resolvedAt: string | null;
  statusCategory: StatusCategory;
  statusId: string;
  statusName: string;
  summary: string;
}

export interface CaseMessage {
  authorAccountId: string | null;
  authorName: string | null;
  bodyText: string;
  createdAt: string;
  editedAt: string | null;
  externalId: string;
  source: MessageSource;
  visibility: MessageVisibility;
}

export interface CaseEvent {
  actorAccountId: string | null;
  actorName: string | null;
  at: string;
  externalId: string;
  fromId: string | null;
  fromValue: string | null;
  kind: CaseEventKind;
  toId: string | null;
  toValue: string | null;
}

export interface CaseLink {
  direction: "inward" | "outward";
  linkType: string;
  linkedKey: string;
}

/** Our clock for one SLA metric, with Jira's own reading of the same metric beside it. */
export interface SlaClock {
  breachedAt: string | null;
  computedAt: string;
  elapsedBusinessMs: number;
  goalMs: number | null;
  jira: { breached: boolean; goalMs: number | null; remainingMs: number | null; state: string };
  metric: SlaMetric;
  remainingMs: number | null;
  state: SlaClockState;
  stoppedAt: string | null;
}

/** Everything one Jira issue maps to - what a sync writes for it in one transaction. */
export interface CaseBundle {
  case: CaseFields;
  /* sha256 of the case fields that count as a "real change" (see caseContentHash). */
  contentHash: string;
  events: CaseEvent[];
  links: CaseLink[];
  messages: CaseMessage[];
  sla: SlaClock[];
}

/** A stored case, as read back. */
export interface CaseRecord extends Omit<CaseFields, "reporter"> {
  id: string;
  lastSyncedAt: string;
  reporterEmail: string | null;
  reporterName: string | null;
  /* When our row last really changed (bumped together with `version`). */
  updatedAt: string;
  version: number;
}

export interface CaseDetail {
  case: CaseRecord;
  events: CaseEvent[];
  links: CaseLink[];
  messages: CaseMessage[];
  sla: SlaClock[];
}

export interface CaseListItem {
  accountName: string | null;
  assigneeName: string | null;
  jiraKey: string;
  jiraUpdated: string;
  priority: string | null;
  resolution: Pick<SlaClock, "goalMs" | "remainingMs" | "state"> | null;
  statusCategory: StatusCategory;
  statusName: string;
  summary: string;
}

/* ------------------------------------------------------------- sync state */

/** Persisted in sync_state under SYNC_STATE_KEY; every field is optional on read (older shapes). */
export interface CaseSyncState {
  backfill: {
    /* Last key fully processed, in key order; the next page starts after it. */
    afterKey: string | null;
    completedAt: string | null;
    done: boolean;
    processed: number;
    startedAt: string | null;
  };
  incremental: {
    /* Jira `updated` up to which every issue has been handled. */
    cursor: string | null;
    processed: number;
  };
  lastError: { at: string; message: string } | null;
  lastTick: SyncTickSummary | null;
  /* Issues that failed to sync, retried at the start of the next ticks. */
  retry: Array<{ attempts: number; key: string; lastError: string }>;
}

export interface SyncTickSummary {
  at: string;
  durationMs: number;
  errors: string[];
  phase: "backfill" | "incremental" | "backfill+incremental" | "retry" | "idle";
  processed: number;
  skippedUnchanged: number;
  trigger: "manual" | "poll";
}

export type SyncSkipReason = "already_running" | "db_unconfigured" | "jira_unconfigured" | "redis_unconfigured" | "throttled";

export interface SyncTickResult {
  error?: string;
  ok: boolean;
  skipped?: SyncSkipReason;
  summary?: SyncTickSummary;
}

/** One SLA where our clock and Jira's disagree. */
export interface ParityMismatch {
  jiraKey: string;
  metric: SlaMetric;
  ours: { breached: boolean; remainingMs: number | null; state: SlaClockState };
  jira: { breached: boolean; remainingMs: number | null; state: string };
  reason: string;
}

export interface SyncStatus {
  counts: { accounts: number; cases: number; contacts: number; events: number; messages: number; openCases: number; slaClocks: number };
  parity: { compared: number; examples: ParityMismatch[]; matched: number; mismatched: number };
  state: CaseSyncState;
}
