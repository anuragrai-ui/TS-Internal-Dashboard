/**
 * Shared contract for the support workspace - phase 1 of turning the
 * escalation tracker into the place TS works from (docs: README "Support
 * workspace"). Jira and Slack stay the systems of record for now; this phase
 * adds, on top of what the dashboard already has:
 *
 * - On-call: who is firefighter right now (Asia/Europe + US), read from the
 *   rotation's Google Calendar through the Google Calendar API (a one-time
 *   Google sign-in, src/lib/google/oauth.ts) or, failing that, its secret
 *   iCal address (ONCALL_CALENDAR_ICAL_URL), plus a live feed of the
 *   #firefighters Slack channel.
 *     src/lib/oncall/*          getOnCall(), getCurrentOnCallShifts()
 *     src/lib/firefighters/*    getFirefighterFeed()
 * - Write-back actions: everything a person does to a ticket from the
 *   tracker (reply / internal note, status, assignee, priority, link a CP,
 *   reply in a linked Slack thread, escalate to the firefighters) goes
 *   through one pipeline with validation, idempotency, a version check and
 *   an audit trail. Jira writes use the acting person's own registered Jira
 *   token, so Jira's permissions and attribution apply; Slack writes go out
 *   as the dashboard bot, attributed to the person, and respect Slack test
 *   mode (SLACK_TEST_CHANNEL).
 *     src/lib/actions/*         createProposal(), executeAction(), ...
 * - Assist agent: a quick summary (fast model) and a tool-using
 *   investigation (agent model) per ticket. The agent only ever READS and
 *   PROPOSES; every write is a proposal a person approves (or edits, then
 *   approves) in the UI. An agent-supplied "approved" never counts.
 *     src/lib/assist/*
 * - WebMCP: the same operations exposed as browser page tools
 *   (document.modelContext.registerTool) when the browser supports it; they
 *   call the same API routes as the UI and never send anything on their own.
 *     src/lib/webmcp/*, src/components/webmcp/*
 *
 * This file is types and constants only, so client and server code can both
 * import it.
 */

import type { TrackerPriority } from "@/lib/tracker/types";

/* ================================================================ on-call */

export interface OnCallPerson {
  /* As written in the calendar (attendee name, or parsed from the event title). */
  name: string;
  email?: string;
  /* Resolved through the Slack user directory when the name or email matches one person. */
  slackUserId?: string;
}

export interface OnCallShift {
  /* Stable per occurrence: `${eventUid}:${startIso}`. */
  id: string;
  /* "Asia/Europe", "US", or "On call" when the event names no region. */
  region: string;
  people: OnCallPerson[];
  /* ISO, UTC. An all-day event runs midnight to midnight in the calendar's time zone. */
  start: string;
  end: string;
  allDay: boolean;
  /* The calendar event's title, verbatim (clipped to 200 chars). */
  title: string;
}

export interface OnCallResponse {
  /* False until a source is set up: the Google Calendar connection plus ONCALL_GOOGLE_CALENDAR_ID, or ONCALL_CALENDAR_ICAL_URL. */
  configured: boolean;
  /* Where the schedule came from: the Google Calendar API (preferred) or the secret iCal address. */
  source?: "google" | "ical";
  /* The moment `now`/`next` are computed for (ISO). */
  at: string;
  /* Shifts covering `at` - usually one per region. */
  now: OnCallShift[];
  /* For each region, the first shift starting after `at`. */
  next: OnCallShift[];
  /* Every shift from 1 day before `at` to 14 days after, ordered by start. */
  upcoming: OnCallShift[];
  /* When the calendar was last downloaded (ISO); null if never. */
  fetchedAt: string | null;
  calendarName?: string;
  timeZone?: string;
  /* Why the schedule couldn't be read (a stale copy may still be shown). */
  error?: string;
}

/* ========================================================== #firefighters */

export interface FirefighterMessage {
  ts: string;
  at: string;
  authorName: string;
  isBot: boolean;
  /* Plain text, mentions resolved, clipped (~600 chars). Untrusted. */
  text: string;
  /* TS-/CP- keys the message names (text, links, attachments). */
  ticketKeys: string[];
  replyCount: number;
  lastReplyAt?: string;
  permalink?: string;
}

export interface FirefighterFeedResponse {
  channel: string;
  channelName: string;
  /* Top-level messages, newest first. */
  messages: FirefighterMessage[];
  fetchedAt: string;
  /* "not_in_channel" etc. - the UI says to invite the bot. */
  error?: string;
  rateLimited?: boolean;
}

/* ================================================================ actions */

export type ActionOperation =
  | "email_reply"
  | "firefighter_escalation"
  | "jira_assign"
  | "jira_comment"
  | "jira_link_cp"
  | "jira_priority"
  | "jira_transition"
  | "slack_thread_reply";

/* Exactly what will be written. Editing any field of an AI proposal makes it a new decision by the person who edits it. */
export type ActionArgs =
  /* "public" = visible to the customer on the JSM portal; "internal" = internal note (sd.public.comment internal). */
  | { body: string; operation: "jira_comment"; visibility: "internal" | "public" }
  | { operation: "jira_transition"; transitionId: string; transitionName: string }
  /* accountId null = unassign. */
  | { accountId: string | null; displayName?: string; operation: "jira_assign" }
  | { operation: "jira_priority"; priority: TrackerPriority }
  | { cpKey: string; operation: "jira_link_cp" }
  /* Only into a Slack conversation the tracker has linked to this ticket (or one of its CPs). */
  | { body: string; channel: string; operation: "slack_thread_reply"; threadTs: string }
  /* A new message in #firefighters about this ticket; mentionOnCall tags whoever is on call now. */
  | { body: string; mentionOnCall: boolean; operation: "firefighter_escalation" }
  /*
   * A reply from the support mailbox to the customer on an email case (src/lib/email/reply.ts), in the
   * Gmail thread of the customer's latest message. Customer-visible, so it gets the strict leak check.
   * The action's ticketKey is the case's own key (see emailCaseKey): its Jira key once the case is
   * linked to a TS ticket, otherwise "EM-" plus the first 10 hex digits of the case uuid (EM-1A2B3C4D5E).
   * caseId is the uuid itself, and must belong to that key - so an audit line always names the case.
   */
  | { body: string; caseId: string; operation: "email_reply" };

export interface ActionDraft {
  args: ActionArgs;
  /* Why (shown on the review card). */
  rationale?: string;
  ticketKey: string;
}

export interface ActionActor {
  accountId: string;
  displayName: string;
}

/* Who suggested an action. A person's own click needs no proposal - it is executed directly. */
export type ProposalSource = { runId: string; type: "assist" } | { type: "browser_agent" };

export type ProposalStatus = "approved" | "expired" | "pending" | "rejected";

export interface ActionProposal {
  args: ActionArgs;
  createdAt: string;
  /* The person whose session created it (the one who started the investigation / ran the browser agent). */
  createdBy: string;
  decidedAt?: string;
  decidedBy?: string;
  executionId?: string;
  /* Proposals expire after 24h; an expired one can't be approved. */
  expiresAt: string;
  /* The ticket's Jira `updated` when proposed; approving after it changed asks to confirm. */
  expectedVersion: string | null;
  id: string;
  rationale?: string;
  source: ProposalSource;
  status: ProposalStatus;
  ticketKey: string;
}

/*
 * succeeded  - the write happened (externalId/externalUrl say where)
 * failed     - it definitely did not happen (validation, permission, 4xx)
 * uncertain  - the request timed out or the connection dropped after sending:
 *              it may have happened. Never retried automatically - check Jira/Slack.
 * conflict   - the ticket changed since it was proposed/loaded; resend with force to proceed
 * duplicate  - the same idempotency key already ran; `externalId` is the earlier result
 */
export type ExecutionStatus = "conflict" | "duplicate" | "failed" | "succeeded" | "uncertain";

export interface ActionExecution {
  actorAccountId: string;
  actorName: string;
  args: ActionArgs;
  at: string;
  error?: string;
  externalId?: string;
  externalUrl?: string;
  id: string;
  idempotencyKey: string;
  proposalId?: string;
  /* Slack test mode sent it to the test channel instead (mentions defused); for email_reply, EMAIL_TEST_RECIPIENT got it instead of the customer. */
  redirectedToTestChannel?: boolean;
  status: ExecutionStatus;
  ticketKey: string;
}

/* POST /api/actions - a person's own action (their click is the approval). */
export interface ExecuteActionRequest {
  args: ActionArgs;
  /* The ticket's Jira `updated` the person was looking at; a mismatch returns status "conflict" unless force. */
  expectedVersion?: string | null;
  force?: boolean;
  /* Client-generated per intended write (crypto.randomUUID()); resending the same key never writes twice. */
  idempotencyKey: string;
  ticketKey: string;
}

export interface ExecuteActionResponse {
  execution: ActionExecution;
}

/* GET /api/actions?ticket=KEY */
export interface TicketActionsResponse {
  executions: ActionExecution[];
  /* Pending first, then recently decided. */
  proposals: ActionProposal[];
}

/* POST /api/actions/proposals - from the browser agent (WebMCP). Assist runs create theirs server-side. */
export interface CreateProposalRequest {
  draft: ActionDraft;
}

/* POST /api/actions/proposals/[id]/approve */
export interface ApproveProposalRequest {
  /* Edited args; must keep the same operation. Omitted = approve as proposed. */
  args?: ActionArgs;
  force?: boolean;
  idempotencyKey: string;
}

export interface ProposalDecisionResponse {
  execution?: ActionExecution;
  proposal: ActionProposal;
}

/* GET /api/tracker/[key]/jira-options - what the action bar can offer, read with the person's own token. */
export interface JiraOptionsResponse {
  assignees: Array<{ accountId: string; displayName: string }>;
  priorities: TrackerPriority[];
  transitions: Array<{ id: string; name: string; toStatus: string }>;
  /* The ticket's Jira `updated` - send back as expectedVersion. */
  version: string | null;
}

/* ================================================================= assist */

export type AssistRunStatus = "failed" | "queued" | "running" | "succeeded";

export interface AssistSource {
  at?: string;
  kind: "confluence" | "cp" | "jira_comment" | "jira_field" | "jira_search" | "oncall" | "slack_message";
  /* "TS-123 comment by Jane, 2 Oct", "#technical-support thread", "CP-55 status". */
  label: string;
  url?: string;
}

export interface AssistFact {
  sources: AssistSource[];
  text: string;
}

export interface InvestigationResult {
  /* Verified facts only - each backed by at least one source. */
  facts: AssistFact[];
  /* Plausible explanations, clearly not facts. */
  hypotheses: string[];
  /* What we'd need to know and don't. */
  missing: string[];
  nextStep: string;
  /* A customer-safe reply the person can use (never sent by the agent). */
  customerDraft?: string;
  /* Each became an ActionProposal awaiting approval (proposalId), or was dropped as invalid. */
  proposedActions: Array<ActionDraft & { proposalId?: string }>;
  summary: string;
}

export interface AssistRun {
  createdAt: string;
  error?: string;
  finishedAt?: string;
  id: string;
  kind: "investigation";
  model: string;
  result?: InvestigationResult;
  startedAt?: string;
  startedBy: string;
  status: AssistRunStatus;
  ticketKey: string;
  toolCalls: number;
}

/* GET /api/assist/[key]/summary */
export interface AssistSummary {
  /* The ticket's Jira `updated` this summary was made from. */
  basedOnUpdated: string | null;
  generatedAt: string;
  model: string;
  text: string;
  ticketKey: string;
}

/* POST/GET /api/assist/[key]/investigations, GET /api/assist/runs/[id] */
export interface AssistRunResponse {
  run: AssistRun;
}

export interface AssistRunListResponse {
  runs: AssistRun[];
}

/* Defaults - override with ANTHROPIC_AGENT_MODEL / ANTHROPIC_FAST_MODEL. */
export const DEFAULT_AGENT_MODEL = "claude-sonnet-5-5";
export const DEFAULT_FAST_MODEL = "claude-haiku-4-5-20251001";

/* ============================================================== UI bridge */

/*
 * Window CustomEvents that let page tools (WebMCP) and the Assist panel drive
 * the React UI without importing it. The UI acts on them exactly as if the
 * person had clicked: open a ticket, or put text in the composer (never send).
 */
export const UI_EVENTS = {
  openCase: "ts:open-case",
  prepareReply: "ts:prepare-reply",
  proposalsChanged: "ts:proposals-changed",
} as const;

export interface OpenCaseDetail {
  key: string;
}

export interface PrepareReplyDetail {
  body: string;
  /* For target "slack": which linked conversation. */
  channel?: string;
  target: "internal" | "public" | "slack";
  threadTs?: string;
  ticketKey: string;
}

export interface ProposalsChangedDetail {
  ticketKey: string;
}

/* ====================================================== Google connection */

/*
 * One stored Google sign-in per purpose (src/lib/google/oauth.ts): "calendar" reads the on-call rotation,
 * "mailbox" reads and replies from the support Gmail mailbox. Only the refresh token is kept, encrypted.
 */
export type GooglePurpose = "calendar" | "mailbox";

/*
 * unconfigured  - GOOGLE_OAUTH_CLIENT_ID / _SECRET (or the purpose's own env) missing on the server
 * not_connected - nobody has signed in yet (or it was disconnected)
 * connected     - a refresh token is stored
 * broken        - Google refused the stored token (revoked, password reset, admin action): sign in again
 */
export type GoogleConnectionState = "broken" | "connected" | "not_connected" | "unconfigured";

export interface GoogleConnectionStatus {
  brokenAt?: string;
  brokenReason?: string;
  connectedAt?: string;
  /* Display name of the dashboard user who signed in. */
  connectedBy?: string;
  /* The Google account that was signed in. */
  connectedEmail?: string;
  /* Env vars the server still needs for this purpose. */
  missingEnv: string[];
  purpose: GooglePurpose;
  state: GoogleConnectionState;
}

/* ========================================================== email intake */

export type EmailInboxFilter = "all" | "linked" | "open" | "unlinked";

export interface EmailAddress {
  email: string;
  name: string | null;
}

export interface EmailAttachmentMeta {
  mime: string;
  name: string;
  size: number;
}

/* One email case (or Jira case with email on it) in the inbox list. */
export interface EmailCaseListItem {
  accountSuggestion: string | null;
  caseId: string;
  /* The latest customer sender; null when only the mailbox has written. */
  from: EmailAddress | null;
  jiraKey: string | null;
  /* The action key: the Jira key when linked, else EM-<10 hex> (see email_reply). */
  key: string;
  lastActivityAt: string;
  messageCount: number;
  /* The latest message's new content, plain text, clipped. */
  snippet: string;
  source: "email" | "jira";
  statusCategory: "done" | "indeterminate" | "new";
  statusName: string;
  subject: string;
}

export interface EmailCaseMessage {
  attachments: EmailAttachmentMeta[];
  /* Plain text only - an email's HTML is converted on the way in and never rendered. Quoted history is cut. */
  bodyText: string;
  cc: EmailAddress[];
  createdAt: string;
  direction: "inbound" | "outbound";
  from: EmailAddress | null;
  id: string;
  /* Who sent an outbound reply from the dashboard. */
  sentBy?: string;
  source: "dashboard" | "email" | "jira_comment" | "slack";
  subject: string | null;
  to: EmailAddress[];
}

export interface EmailCaseDetail {
  item: EmailCaseListItem;
  messages: EmailCaseMessage[];
}

export interface EmailSyncStatus {
  initialSyncAt: string | null;
  lastError: { at: string; message: string } | null;
  lastTick: { at: string; durationMs: number; errors: string[]; processed: number; skipped: number; trigger: "manual" | "poll" } | null;
  pending: number;
}

/* GET /api/email/list */
export interface EmailInboxResponse {
  items: EmailCaseListItem[];
  /* Env vars still missing for intake (DATABASE_URL, SUPPORT_MAILBOX_ADDRESS, ...). */
  missingEnv: string[];
  mailbox: GoogleConnectionStatus;
  sendEnabled: boolean;
  supportAddress: string | null;
  sync: EmailSyncStatus | null;
  testRecipient: string | null;
  error?: string;
}

/* The Slack channel id of #firefighters (override with FIREFIGHTER_SLACK_CHANNEL). */
export const DEFAULT_FIREFIGHTER_CHANNEL = "C06LMNLJY82";
