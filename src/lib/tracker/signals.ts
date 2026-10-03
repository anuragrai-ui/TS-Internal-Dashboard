import type { ParsedSla } from "@/lib/escalation/types";
import type { AppNotification } from "@/lib/notifications/types";
import type {
  CpOutcomeLabel,
  SignalKind,
  SignalTier,
  SlackConversationRef,
  TrackerCp,
  TrackerSignal,
  TrackerSla,
  TrackerTicket,
  WhoseMove,
} from "@/lib/tracker/types";

/**
 * Pure half of the escalation tracker: given what the snapshot read from
 * Jira, Slack and the bot's own records, say whose move it is, which
 * escalation signals a ticket carries, and which SLA changes between two
 * snapshots are worth a notification. No I/O and no clock (callers pass
 * `nowMs`), so every rule is pinned down by fixtures in scripts/test-tracker.ts.
 */

export const WAITING_FOR_PRODUCT = "10633";
const WAITING_FOR_CLIENT = "10045";
const BLOCKED_CLIENT = "10263";
const WAITING_FOR_OPERATIONS = "10634";
const TO_DO = "1";
const TRIAGING = "10173";

const HOUR_MS = 3_600_000;
/* A running resolution clock with less than this left is "at risk" (tier 2): someone should act today. */
export const TTR_AT_RISK_MS = 8 * HOUR_MS;
/* Crossing under this is worth a push notification to the ticket's audience. */
export const TTR_DUE_SOON_MS = 2 * HOUR_MS;

/* Display order inside one tier: the strongest evidence of an engineering escalation first. */
const KIND_ORDER: SignalKind[] = [
  "waiting_for_product",
  "open_cp",
  "bot_thread",
  "ttr_breached",
  "priority_raised",
  "escalation_comment",
  "slack_conversation",
  "slack_permalink",
  "ttr_at_risk",
  "first_response_breached",
  "negative_sentiment",
];

/* ------------------------------------------------------------ whose move */

/* A CP that still needs engineering: "fix_ready" is built but not shipped, so engineering still owns it. */
export function isPendingCp(outcome: CpOutcomeLabel): boolean {
  return outcome === "open" || outcome === "fix_ready";
}

/**
 * Pylon's "whose move is it". A done ticket is closed whatever its CPs say;
 * otherwise an engineering dependency (WfP, or any CP still pending) wins over
 * the TS status, because a ticket can sit "In Progress" while really waiting
 * on a CP someone linked by hand.
 */
export function whoseMove(statusId: string, statusCategory: TrackerTicket["statusCategory"], cpOutcomes: CpOutcomeLabel[]): WhoseMove {
  if (statusCategory === "done") return "closed";
  if (statusId === WAITING_FOR_PRODUCT || cpOutcomes.some(isPendingCp)) return "on_engineering";
  if (statusId === WAITING_FOR_CLIENT || statusId === BLOCKED_CLIENT) return "on_customer";
  if (statusId === WAITING_FOR_OPERATIONS) return "on_operations";
  if (statusId === TO_DO || statusId === TRIAGING) return "new";
  /* In Progress, Reopened, Waiting for TS review, Blocked Other/Provider, and any status added later. */
  return "on_ts";
}

/* ------------------------------------------------------------------- SLA */

/* The tracker's view of a JSM SLA drops withinCalendarHours, which nothing here reads. */
export function toTrackerSla(parsed: ParsedSla): TrackerSla {
  return { breached: parsed.breached, goalMs: parsed.goalMs, remainingMs: parsed.remainingMs, state: parsed.state };
}

function isOngoing(sla: TrackerSla): boolean {
  return sla.state === "running" || sla.state === "paused";
}

function isAtRisk(sla: TrackerSla, limitMs: number): boolean {
  return sla.state === "running" && !sla.breached && sla.remainingMs !== null && sla.remainingMs >= 0 && sla.remainingMs < limitMs;
}

function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/* --------------------------------------------------------------- signals */

export interface SignalInput {
  botEscalation: TrackerTicket["botEscalation"];
  cps: TrackerCp[];
  /* A comment on the ticket says "escalat*" (last 30 days). */
  escalationComment: boolean;
  firstResponse: TrackerSla;
  /* Priority went up from Medium/Low in the last 30 days. */
  priorityRaised: boolean;
  /* Jira Sentiment (customfield_10251) name: Negative / Neutral / Positive. */
  sentiment: string | null;
  /* Most recent activity first, as slackIndex returns them. */
  slackConversations: SlackConversationRef[];
  /* A Slack permalink was pasted into a Jira comment. */
  slackPermalink: boolean;
  statusId: string;
  ttr: TrackerSla;
}

const TIERS: Record<SignalKind, SignalTier> = {
  bot_thread: 1,
  escalation_comment: 2,
  first_response_breached: 3,
  negative_sentiment: 3,
  open_cp: 1,
  priority_raised: 2,
  slack_conversation: 2,
  slack_permalink: 2,
  ttr_at_risk: 2,
  ttr_breached: 1,
  waiting_for_product: 1,
};

function signal(kind: SignalKind, label: string, extra: { at?: string; detail?: string } = {}): TrackerSignal {
  return { ...extra, kind, label, tier: TIERS[kind] };
}

function listKeys(keys: string[], max = 3): string {
  return `${keys.slice(0, max).join(", ")}${keys.length > max ? ` +${keys.length - max}` : ""}`;
}

/** Every signal a ticket carries, strongest first (tier, then KIND_ORDER). */
export function deriveSignals(input: SignalInput): TrackerSignal[] {
  const out: TrackerSignal[] = [];

  if (input.statusId === WAITING_FOR_PRODUCT) {
    out.push(signal("waiting_for_product", "Waiting for product"));
  }

  const pending = input.cps.filter((cp) => !cp.isEpic && isPendingCp(cp.outcome));
  if (pending.length > 0) {
    const fixReady = pending.filter((cp) => cp.outcome === "fix_ready").map((cp) => cp.key);
    out.push(
      signal("open_cp", `Open ${listKeys(pending.map((cp) => cp.key))}`, {
        detail: fixReady.length > 0 ? `Fix ready: ${fixReady.join(", ")}` : undefined,
      }),
    );
  }

  if (input.botEscalation) {
    const { cpKey, levelSent, state } = input.botEscalation;
    out.push(signal("bot_thread", levelSent > 0 ? `Bot escalation L${levelSent}` : "Bot escalation thread", { detail: `${cpKey} · ${state}` }));
  }

  if (input.ttr.breached && input.ttr.state !== "none") {
    out.push(
      signal("ttr_breached", "Resolution SLA breached", {
        detail: input.ttr.remainingMs !== null && input.ttr.remainingMs < 0 ? `${formatDuration(-input.ttr.remainingMs)} over` : undefined,
      }),
    );
  }

  if (input.priorityRaised) {
    out.push(signal("priority_raised", "Priority raised", { detail: "From Medium/Low in the last 30 days" }));
  }

  if (input.escalationComment) {
    out.push(signal("escalation_comment", "Escalation mentioned in comments", { detail: "A comment says “escalat…” (last 30 days)" }));
  }

  const [latest] = input.slackConversations;
  if (latest) {
    const count = input.slackConversations.length;
    out.push(
      signal("slack_conversation", `Discussed in #${latest.channelName ?? latest.channel}`, {
        at: latest.lastActivityAt,
        detail: count > 1 ? `${count} Slack conversations` : undefined,
      }),
    );
  }

  if (input.slackPermalink) {
    out.push(signal("slack_permalink", "Slack thread linked in Jira"));
  }

  if (isAtRisk(input.ttr, TTR_AT_RISK_MS) && input.ttr.remainingMs !== null) {
    out.push(signal("ttr_at_risk", `Resolution SLA due in ${formatDuration(input.ttr.remainingMs)}`));
  }

  if (input.firstResponse.breached && input.firstResponse.state !== "none") {
    out.push(signal("first_response_breached", "First response SLA breached"));
  }

  if (input.sentiment?.toLowerCase() === "negative") {
    out.push(signal("negative_sentiment", "Negative sentiment"));
  }

  return out.sort((a, b) => a.tier - b.tier || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
}

/** Escalated = someone (bot or person) pushed it: any tier 1 or tier 2 signal. */
export function isEscalated(signals: TrackerSignal[]): boolean {
  return signals.some((item) => item.tier <= 2);
}

/** The latest of some ISO instants; missing or unparseable ones are skipped ("" when none parse). */
export function latestIso(...values: Array<string | null | undefined>): string {
  let best = "";
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    const ms = value ? Date.parse(value) : Number.NaN;
    if (value && !Number.isNaN(ms) && ms > bestMs) {
      best = value;
      bestMs = ms;
    }
  }
  return best;
}

/* ------------------------------------------------------ SLA notifications */

/* Calendar day in New York - the support team's day, so "due within 2h" re-arms once per ET day. */
export function etDay(nowMs: number): string {
  return new Intl.DateTimeFormat("en-CA", { day: "2-digit", month: "2-digit", timeZone: "America/New_York", year: "numeric" }).format(new Date(nowMs));
}

export interface SlaDiffInput {
  /* Registered dashboard users to tell about each ticket (assignee + followers). Missing key = nobody. */
  audienceByKey: ReadonlyMap<string, string[]>;
  baseUrl: string;
  current: TrackerTicket[];
  nowMs: number;
  /* The snapshot this refresh replaces; null on the very first build. */
  previous: TrackerTicket[] | null;
}

/**
 * Resolution-SLA changes between two snapshots, as notifications:
 * - a ticket whose ongoing TTR cycle has just breached (id per ticket, so
 *   the feed's write-once ids make it "once ever", not once per refresh)
 * - a running clock that has just crossed under 2h left (id per ticket per
 *   ET day, so a clock that pauses and comes back tomorrow warns again)
 * Only tickets that were already in the previous snapshot count: a ticket
 * entering the scope already breached (priority raised on an old ticket)
 * is history, not news. The first snapshot after a deploy has no previous
 * one, so it says nothing rather than flooding everyone's bell.
 */
export function slaNotifications(input: SlaDiffInput): AppNotification[] {
  if (!input.previous) {
    return [];
  }

  const before = new Map(input.previous.map((ticket) => [ticket.key, ticket]));
  const at = new Date(input.nowMs).toISOString();
  const base = input.baseUrl.replace(/\/+$/, "");
  const out: AppNotification[] = [];

  for (const ticket of input.current) {
    const prev = before.get(ticket.key);
    if (!prev || ticket.statusCategory === "done") {
      continue;
    }

    const shared = {
      at,
      audience: input.audienceByKey.get(ticket.key) ?? [],
      detail: `${ticket.priority} · ${ticket.summary}`,
      important: true,
      kind: "tracker_sla" as const,
      source: "jira" as const,
      ticketKey: ticket.key,
      url: `${base}/browse/${ticket.key}`,
    };

    if (ticket.ttr.breached && isOngoing(ticket.ttr) && !prev.ttr.breached) {
      out.push({ ...shared, id: `tracker:${ticket.key}:ttr_breached`, title: `${ticket.key} breached its resolution SLA` });
    } else if (isAtRisk(ticket.ttr, TTR_DUE_SOON_MS) && !isAtRisk(prev.ttr, TTR_DUE_SOON_MS) && !prev.ttr.breached) {
      out.push({
        ...shared,
        id: `tracker:${ticket.key}:ttr_due_2h:${etDay(input.nowMs)}`,
        title: `${ticket.key} resolution SLA due in ${formatDuration(ticket.ttr.remainingMs ?? 0)}`,
      });
    }
  }

  return out;
}

/* -------------------------------------------------------------- audience */

/**
 * Who to tell about each ticket: its assignee when they use the dashboard,
 * plus its registered followers. A key missing from `assigneeByKey` (not in
 * the snapshot) gets followers only, so a caller that knows the assignee some
 * other way can add them. Keys with nobody to tell are left out of the map.
 */
export function mergeAudience(args: {
  assigneeByKey: ReadonlyMap<string, string | null>;
  followersByKey: ReadonlyMap<string, string[]>;
  keys: string[];
  registered: ReadonlySet<string>;
}): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const key of new Set(args.keys)) {
    const assignee = args.assigneeByKey.get(key);
    const audience = new Set<string>();
    if (assignee && args.registered.has(assignee)) {
      audience.add(assignee);
    }
    for (const follower of args.followersByKey.get(key) ?? []) {
      if (args.registered.has(follower)) {
        audience.add(follower);
      }
    }
    if (audience.size > 0) {
      out.set(key, [...audience]);
    }
  }
  return out;
}
