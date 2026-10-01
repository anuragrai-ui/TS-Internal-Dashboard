/**
 * Shared contract for the Jira -> Slack engineering-escalation pilot.
 *
 * Everything under src/lib/escalation/ is pure logic over these shapes
 * (no network, no Redis, no clock reads except where a `now` is passed in),
 * so it can be unit-tested with fixtures and run in a read-only dry run
 * against live Jira before any Slack app, database, or scheduler exists.
 * The only module that talks to Jira is readOnlyJira.ts, and it physically
 * cannot write.
 */

export type Priority = "Critical" | "High" | "Medium" | "Low";

export type StatusCategory = "new" | "indeterminate" | "done";

/* ---------------------------------------------------------------- calendar */

/** A JSM working-hours calendar (e.g. calendar 30 "Certify Support"). */
export interface BusinessCalendar {
  holidays: Array<{
    /* "YYYY-MM-DD" in the calendar's own timezone. */
    isoDate: string;
    /* Jira's "recurring": the same month/day every year. */
    recurring: boolean;
    name?: string;
  }>;
  id: string;
  name: string;
  /* IANA zone, e.g. "America/New_York". */
  timezone: string;
  workingTimes: Array<{
    /* Milliseconds after local midnight; end is exclusive. */
    endMs: number;
    startMs: number;
    /* 0 = Sunday ... 6 = Saturday. */
    weekday: number;
  }>;
}

/* --------------------------------------------------------------------- SLA */

export type SlaCycleState = "running" | "paused" | "completed_only" | "none";

/** A JSM SLA (e.g. Time to Resolution, cf[10650]) reduced to what the pilot may rely on. */
export interface ParsedSla {
  /* Ongoing cycle breached; for completed_only, whether the last completed cycle breached. */
  breached: boolean;
  goalMs: number | null;
  /* Ongoing cycle only. Frozen while paused - never derive a deadline from breachTime on a paused cycle. */
  remainingMs: number | null;
  state: SlaCycleState;
  withinCalendarHours: boolean | null;
}

/* --------------------------------------------------------------- snapshots */

export interface CpSnapshot {
  assigneeAccountId: string | null;
  assigneeName: string | null;
  issueTypeId: string;
  issueTypeName: string;
  key: string;
  podName: string | null;
  /* customfield_10165 option id on the CP itself - the routing key. */
  podOptionId: string | null;
  priorityName: string | null;
  resolutionId: string | null;
  resolutionName: string | null;
  statusCategory: StatusCategory;
  statusId: string;
  statusName: string;
  url: string;
}

export interface TsLink {
  cpKey: string;
  direction: "inward" | "outward";
  linkTypeId: string;
  linkTypeName: string;
}

export interface TsSnapshot {
  assigneeAccountId: string | null;
  assigneeName: string | null;
  /* Last transition INTO "Waiting for product" (10633), from the changelog. Null if never seen. */
  enteredWfpAt: string | null;
  issueTypeId: string;
  key: string;
  links: TsLink[];
  majorIncident: boolean;
  /* TS ticket's own Pod - an attribution HINT only (TS and CP pods disagree ~29% of the time), never a routing key. */
  podOptionId: string | null;
  priority: Priority | null;
  statusCategory: StatusCategory;
  statusId: string;
  statusName: string;
  /* JSM Time to Resolution (cf[10650]). */
  ttr: ParsedSla;
  url: string;
}

/* ----------------------------------------------------------------- routing */

export interface PersonRef {
  displayName: string;
  jiraAccountId?: string;
  /* Only ever a verified id - mentions are never built from guessed emails. */
  slackUserId?: string;
}

export type RoutingMode = "off" | "observe" | "shadow" | "live";

export interface RoutingRow {
  channelId?: string;
  /* People allowed to Acknowledge / press "Wrong pod", in addition to the owners below and the CP assignee. */
  extraAckers: PersonRef[];
  mode: RoutingMode;
  owners: {
    em?: PersonRef;
    /* "Highest owner" for L3. Unset -> l3_unconfigured exception, never a guess. */
    l3?: PersonRef;
    pm?: PersonRef;
    pmManager?: PersonRef;
    /* TS-side owner for support-side breaches after hand-back. */
    supportOwner?: PersonRef;
  };
  podName: string;
  podOptionId: string;
  shadowChannelId?: string;
}

/* -------------------------------------------------------------- outcomes */

/**
 * What a linked CP means for the escalation:
 * - open: engineering still owes a fix -> escalation ladder runs
 * - fix_ready: done-category but not shipped (Ready for Release) -> ladder stops, thread stays open
 * - shipped: fix released / closed as done -> resolve (support updates the customer)
 * - rejected: closed without a fix (Won't Do, Duplicate, HF-Rejected, ...) -> resolve, support decides next step
 */
export type CpOutcome = "open" | "fix_ready" | "shipped" | "rejected";

export type ExceptionKind =
  | "all_cps_done_stale"
  | "cp_pod_missing"
  | "cp_pod_unmapped"
  | "cp_unreadable"
  | "l3_unconfigured"
  | "no_open_cp"
  | "no_ttr_cycle"
  | "person_unmapped"
  | "support_owner_unconfigured";

export type ExceptionTier = "actionable" | "info";

export interface EscalationException {
  cpKey?: string;
  detail: string;
  kind: ExceptionKind;
  /* Set on per-pod configuration gaps (l3_unconfigured, support_owner_unconfigured, person_unmapped), which carry no cpKey/tsKey. */
  podName?: string;
  tier: ExceptionTier;
  tsKey?: string;
}

/** One escalation per CP key: every qualifying TS ticket waiting on that CP is attached to it. */
export interface EscalationGroup {
  cp: CpSnapshot;
  outcome: Extract<CpOutcome, "open" | "fix_ready">;
  routing: RoutingRow;
  tickets: TsSnapshot[];
}

export interface ClassificationResult {
  /* TS tickets whose only open CP links are Epics: they block closure but never escalate. */
  epicOnlyTsKeys: string[];
  escalations: EscalationGroup[];
  exceptions: EscalationException[];
  /* Qualifying CPs on known pods whose routing mode is "off": counted, never raised as exceptions. */
  outOfScopeByPod: Record<string, number>;
}

/* ---------------------------------------------------------------- planning */

export type EscalationLevel = 0 | 1 | 2 | 3;

export type PlannedMessageKind = "parent" | "L1" | "L2" | "L3" | "fix_ready" | "backlog_digest";

export interface PlannedMessage {
  /* Never @channel/@here; true only means "also send to channel" for a thread reply. */
  broadcast: boolean;
  /* Idempotency key, e.g. "CP-123:e1:parent", "CP-123:e1:L2". */
  dedupeKey: string;
  kind: PlannedMessageKind;
  mentions: PersonRef[];
  /* Slack mrkdwn. No TS/CP summaries, no customer names - keys, links, status, timings only. */
  text: string;
}

export interface PlannedEscalation {
  channelId: string | null;
  cpKey: string;
  effectivePriority: Priority;
  /* Business hours since waitT0 on the policy calendar. */
  engineeringWaitBh: number;
  /* Highest engineering-wait level already due (0 = none yet). */
  levelDue: EscalationLevel;
  messages: PlannedMessage[];
  /* Next level and how many business hours until it's due; null once L3 is due or the state stops the ladder. */
  nextLevel: { dueInBh: number; level: EscalationLevel } | null;
  podName: string;
  priorityBumpReasons: string[];
  state: "open" | "fix_ready";
  tsKeys: string[];
  /* Earliest WfP entry across attached tickets, or the go-live time for backlog escalations. */
  waitT0: string;
}

export interface PlanResult {
  /* Messages that would be due but are outside calendar hours (non-Critical) - sent at the next business-hours run. */
  heldForQuietHours: string[];
  planned: PlannedEscalation[];
  /* Parent messages held back by the per-run / per-day caps, in priority order. */
  rateLimited: string[];
}
