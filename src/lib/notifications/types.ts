/**
 * The dashboard's notification center: one feed of what changed on the
 * tickets a teammate owns.
 *
 * Sources:
 * - Jira: comments, customer replies, status moves and assignment on their TS tickets
 * - CPs: engineering activity on the CPs those tickets wait on
 * - Slack: replies and reactions in threads the dashboard started (SLA-breach
 *   alerts, escalation threads), plus ticket-key mentions in channels the bot is in
 *
 * Notifications are personal: each one names the registered dashboard users
 * it is for (`audience`, Jira accountIds), so the badge only counts what
 * matters to the person looking. TS sees ~700 ticket updates a day, so a
 * team-wide unread count would just be noise. The Team tab still shows
 * everyone's feed, without unread state.
 */

export type NotificationSource = "escalation" | "jira" | "slack";

export type NotificationKind =
  | "cp_assigned"
  | "cp_comment"
  | "cp_status"
  | "escalation_ack"
  | "escalation_opened"
  | "escalation_update"
  | "jira_assigned"
  | "jira_comment"
  | "jira_customer_reply"
  | "jira_link"
  | "jira_priority"
  | "jira_status"
  | "slack_mention"
  | "slack_reaction"
  | "slack_reply";

export interface AppNotification {
  /* Who did it, as displayed ("Jane Doe"). */
  actor?: string;
  /* When it happened (ISO). */
  at: string;
  /* Registered dashboard users (Jira accountIds) this is for. Never includes the actor themself. */
  audience: string[];
  cpKey?: string;
  /* One short line: "Waiting for Client → In Progress", or a comment / reply snippet. */
  detail?: string;
  /* Deterministic, so seeing the same Jira history item or Slack message twice never duplicates it. */
  id: string;
  /* Customer replies, assignments to you, escalation levels, fixes shipping: drawn with an accent and always toasted. */
  important: boolean;
  kind: NotificationKind;
  source: NotificationSource;
  /* The TS ticket this is about (or the CP, for CP-only items). */
  ticketKey?: string;
  title: string;
  /* Jira issue/comment link or Slack permalink. */
  url?: string;
}

/** What the browser gets: no audience list, plus read state and feed position. */
export interface NotificationView extends Omit<AppNotification, "audience"> {
  read: boolean;
  /* When the dashboard learned about it (ISO) - can be later than `at` for Jira items found by the sync. */
  receivedAt: string;
  /* Feed position (ms, fractional within one batch) - the pagination cursor. */
  score: number;
}

export interface NotificationPage {
  hasMore: boolean;
  items: NotificationView[];
  /* Unread count of the reader's own feed (the badge), whatever scope was listed. */
  unreadCount: number;
  /* Changes whenever the listed feed or the reader's read state changes - lets polls skip unchanged work. */
  version: string;
}
