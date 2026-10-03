/**
 * Shared contract for the escalation tracker: one place that keeps track of
 * every High/Critical TS Support Ticket (plus anything waiting on
 * engineering), how it got escalated - by the bot or by people - every
 * Slack conversation about it, its SLA and its linked CPs. Modelled on
 * Pylon's issue workspace (views + list + detail with a merged timeline and
 * a properties sidebar), but strictly read-only: Jira is only ever read and
 * Slack is never written to from here.
 *
 * Modules:
 * - snapshot.ts   builds/caches the ticket list from Jira (+ signals, CPs, SLA)
 * - slackIndex.ts Slack conversation index (live events, Jira permalinks, manual links, history drip)
 * - audience.ts   who to notify about a ticket (registered assignee + followers)
 * - follow.ts     per-person "follow this ticket"
 * - detail.ts     one ticket's live timeline for the detail panel
 */

export type TrackerPriority = "Critical" | "High" | "Medium" | "Low";

/* Pylon-style "whose move is it", derived from the Jira status and linked CPs. */
export type WhoseMove = "new" | "on_ts" | "on_customer" | "on_engineering" | "on_operations" | "closed";

export type SignalKind =
  | "bot_thread"
  | "escalation_comment"
  | "first_response_breached"
  | "negative_sentiment"
  | "open_cp"
  | "priority_raised"
  | "slack_conversation"
  | "slack_permalink"
  | "ttr_at_risk"
  | "ttr_breached"
  | "waiting_for_product";

/* 1 = escalated to engineering (WfP, open CP, bot thread, TTR breached); 2 = a person escalated it
   (priority raised, "escalat*" comment, Slack discussion, SLA at risk); 3 = context badge only. */
export type SignalTier = 1 | 2 | 3;

export interface TrackerSignal {
  at?: string;
  detail?: string;
  kind: SignalKind;
  label: string;
  tier: SignalTier;
}

export interface TrackerSla {
  breached: boolean;
  goalMs: number | null;
  /* Frozen while paused. */
  remainingMs: number | null;
  state: "completed_only" | "none" | "paused" | "running";
}

export type CpOutcomeLabel = "fix_ready" | "open" | "rejected" | "shipped";

export interface TrackerCp {
  assigneeName: string | null;
  /* An Epic CP is a container, not a fix someone is working on: it never counts as "waiting on engineering". */
  isEpic?: boolean;
  key: string;
  outcome: CpOutcomeLabel;
  podName: string | null;
  statusName: string;
  summary: string | null;
}

export type SlackConversationSource = "backfill" | "bot" | "event" | "jira_link" | "manual";

/** A pointer to one Slack conversation (a thread root) about one or more tickets. Pointers + counts only - message text is read live. */
export interface SlackConversationRef {
  channel: string;
  channelName?: string;
  /* A TS-group mention, priority words ("ASAP", "urgent", "blocker"...) or engineers tagged with a CP key. */
  escalationHint: boolean;
  firstSeenAt: string;
  /* `${channel}:${rootTs}` */
  id: string;
  lastActivityAt: string;
  participants: number;
  permalink?: string;
  replyCount: number;
  rootTs: string;
  /* At most ~140 chars of the root message, for the list/sidebar. */
  snippet?: string;
  source: SlackConversationSource;
  startedByName?: string;
  ticketKeys: string[];
}

export interface TrackerTicket {
  /* Jira Organization name, else the first label (client tags), else null. */
  account: string | null;
  assignee: { accountId: string; name: string } | null;
  botEscalation: { cpKey: string; levelSent: number; permalink?: string; state: string } | null;
  cps: TrackerCp[];
  created: string;
  /* Any tier 1 or tier 2 signal. */
  escalated: boolean;
  firstResponse: TrackerSla;
  key: string;
  /* Latest of Jira `updated` and Slack activity. */
  lastActivityAt: string;
  pod: string | null;
  priority: TrackerPriority;
  reporterName: string | null;
  resolvedAt: string | null;
  signals: TrackerSignal[];
  slack: { activeConversations: number; conversations: number; lastActivityAt: string | null };
  statusCategory: "done" | "indeterminate" | "new";
  statusId: string;
  statusName: string;
  /* Clipped to ~160 chars. */
  summary: string;
  ttr: TrackerSla;
  updated: string;
  whoseMove: WhoseMove;
}

export interface TrackerSnapshot {
  builtAt: string;
  /* Non-fatal problems while building (one search failed, Slack index unavailable...). */
  errors: string[];
  scopeJql: string;
  tickets: TrackerTicket[];
}

export type TimelineKind =
  | "bot_escalation"
  | "cp_comment"
  | "cp_status"
  | "jira_assignee"
  | "jira_comment"
  | "jira_internal_note"
  | "jira_link"
  | "jira_priority"
  | "jira_status"
  | "notification"
  | "slack_conversation"
  | "slack_message"
  | "system";

export interface TimelineItem {
  actor?: string;
  at: string;
  /* Plain text, clipped (~1000 chars). */
  body?: string;
  id: string;
  /* Internal (not customer-visible): internal notes, Slack, CP activity, bot. Drawn on the cream background. */
  internal: boolean;
  kind: TimelineKind;
  source: "bot" | "cp" | "jira" | "slack" | "system";
  /* Right-aligned source label: "TS-123", "CP-55", "#technical-support". */
  sourceLabel: string;
  /* Groups items into Pylon-style tabs: "all" always; plus a conversation id or a CP key. */
  thread?: string;
  title: string;
  url?: string;
}

export interface TrackerDetail {
  conversations: SlackConversationRef[];
  errors: string[];
  following: boolean;
  ticket: TrackerTicket;
  timeline: TimelineItem[];
}

export interface TrackerListResponse {
  builtAt: string | null;
  errors: string[];
  following: string[];
  jiraBaseUrl: string;
  me: string;
  tickets: TrackerTicket[];
}

export interface SlackThreadMessage {
  at: string;
  isBot: boolean;
  text: string;
  ts: string;
  userName: string;
}

export interface SlackThreadResponse {
  error?: string;
  messages: SlackThreadMessage[];
  permalink?: string;
  /* Slack throttled the read (the Vercel-managed app may be limited to 1 history call a minute). */
  rateLimited?: boolean;
  /* The thread has more messages than were read (the oldest 50 are shown). */
  truncated?: boolean;
}
