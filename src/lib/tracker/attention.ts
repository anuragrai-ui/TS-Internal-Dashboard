import type { TrackerTicket } from "@/lib/tracker/types";

/**
 * "Needs attention": why an open ticket is waiting on a person right now.
 *
 * The other views answer "what is this ticket" (Critical, in engineering,
 * discussed in Slack); this one answers "what should someone touch next".
 * It is a set of explicit, explainable rules - every ticket that matches
 * carries the reasons that put it there, shown as chips in the list and as
 * a "Why" block in the detail panel - not a hidden score.
 *
 * Pure and client-safe (no I/O, no React), driven by the snapshot row and
 * `now` only, so the views, counts, sort and detail panel all agree.
 * Fixture tests: scripts/test-tracker-attention.ts.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/* "Due in 3h" becomes a reason below this - the same one-working-day warning the SLA chip uses. */
export const ATTENTION_SLA_WARNING_MS = 8 * HOUR_MS;

/* A Slack conversation this recently active on a ticket someone owns counts as live. */
export const SLACK_LIVE_MS = DAY_MS;

/* A hand-back or a missing CP only needs attention once nobody has touched the ticket for this long. */
const HANDBACK_QUIET_MS = DAY_MS;

/* Waiting on someone else: only nudge about a quiet ticket after this much working time without any activity. */
const QUIET_NEW_MS: Record<"Critical" | "High", number> = { Critical: 4 * HOUR_MS, High: 8 * HOUR_MS };
const QUIET_ON_TS_MS: Record<"Critical" | "High", number> = { Critical: DAY_MS, High: 2 * DAY_MS };
const QUIET_ON_ENGINEERING_MS: Record<"Critical" | "High", number> = { Critical: 3 * DAY_MS, High: 5 * DAY_MS };

/* Jira's "Waiting for product" status id - the manual escalation to engineering. */
const WAITING_FOR_PRODUCT_STATUS_ID = "10633";

export type AttentionKind =
  | "cp_done"
  | "escalated_on_ts"
  | "fix_ready"
  | "no_first_response"
  | "quiet_engineering"
  | "quiet_new"
  | "quiet_on_ts"
  | "slack_live"
  | "sla_at_risk"
  | "sla_breached"
  | "unassigned"
  | "wfp_no_cp";

export type AttentionTone = "accent" | "danger" | "warning";

export interface AttentionReason {
  /* One sentence on what to do or why - for the tooltip and the detail panel. */
  detail: string;
  kind: AttentionKind;
  /* Short chip text. */
  label: string;
  /* Lower is more urgent; orders tickets and decides which reasons a row shows first. */
  rank: number;
  tone: AttentionTone;
}

/* Fixed order of urgency, one place: breaching clocks, then work nobody has started or owns, then hand-backs, then chatter. */
const RANK: Record<AttentionKind, number> = {
  sla_breached: 0,
  sla_at_risk: 1,
  quiet_new: 2,
  unassigned: 3,
  escalated_on_ts: 4,
  fix_ready: 5,
  cp_done: 6,
  wfp_no_cp: 7,
  slack_live: 8,
  quiet_on_ts: 9,
  no_first_response: 10,
  quiet_engineering: 11,
};

export const ATTENTION_KIND_LABEL: Record<AttentionKind, string> = {
  cp_done: "Engineering finished",
  escalated_on_ts: "Escalated, still on TS",
  fix_ready: "Fix ready",
  no_first_response: "No first response",
  quiet_engineering: "Engineering quiet",
  quiet_new: "Not picked up",
  quiet_on_ts: "Quiet on TS",
  slack_live: "Slack is active",
  sla_at_risk: "SLA at risk",
  sla_breached: "SLA breached",
  unassigned: "Unassigned",
  wfp_no_cp: "No CP linked",
};

/* ------------------------------------------------------------------ time */

/* New York is UTC-5 in winter, -4 in summer; one hour of error is irrelevant for "quiet for days". */
const WEEKEND_OFFSET_MS = 5 * HOUR_MS;
/* Walk back at most this many days - nothing here is older, and it keeps the loop bounded. */
const MAX_WALK_DAYS = 400;

/**
 * Elapsed time between two instants without Saturdays and Sundays: a ticket
 * last touched Friday evening is not "quiet for two days" on Sunday night.
 * (Overnight hours still count - this is about days of silence, not the
 * business-hours ladder the escalation bot uses.)
 */
export function workingElapsedMs(fromMs: number, toMs: number): number {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
    return 0;
  }
  const from = Math.max(fromMs, toMs - MAX_WALK_DAYS * DAY_MS);
  let weekend = 0;
  const firstDay = Math.floor((from - WEEKEND_OFFSET_MS) / DAY_MS);
  const lastDay = Math.floor((toMs - WEEKEND_OFFSET_MS) / DAY_MS);
  for (let day = firstDay; day <= lastDay; day += 1) {
    /* 1970-01-01 was a Thursday; 0 = Sunday, 6 = Saturday. */
    const weekday = (((day + 4) % 7) + 7) % 7;
    if (weekday === 0 || weekday === 6) {
      const start = day * DAY_MS + WEEKEND_OFFSET_MS;
      weekend += Math.max(0, Math.min(toMs, start + DAY_MS) - Math.max(from, start));
    }
  }
  return toMs - from - weekend;
}

function span(ms: number): string {
  const abs = Math.abs(ms);
  if (abs < HOUR_MS) return `${Math.max(1, Math.floor(abs / MINUTE_MS))}m`;
  if (abs < DAY_MS) return `${Math.floor(abs / HOUR_MS)}h`;
  return `${Math.floor(abs / DAY_MS)}d`;
}

function timeOf(iso: string | null | undefined): number {
  const parsed = iso ? Date.parse(iso) : Number.NaN;
  return Number.isNaN(parsed) ? Number.NaN : parsed;
}

/* ----------------------------------------------------------------- rules */

function reason(kind: AttentionKind, tone: AttentionTone, label: string, detail: string): AttentionReason {
  return { detail, kind, label, rank: RANK[kind], tone };
}

function hasSignal(ticket: TrackerTicket, kind: TrackerTicket["signals"][number]["kind"]): boolean {
  return ticket.signals.some((signal) => signal.kind === kind);
}

/**
 * Every reason this ticket needs a person's attention, most urgent first.
 * Closed tickets never do. Medium tickets (they are only tracked because
 * they sit in Waiting for product) surface only when their clock has
 * breached or is about to; High and Critical get the full set.
 *
 * Several reasons describe someone else's move that the ticket's own
 * people should have noticed by now (engineering handed it back, a CP is
 * missing): those only count after a working day without any activity, so
 * a ticket somebody touched this morning isn't flagged for what they are
 * visibly already doing.
 */
export function attentionReasons(ticket: TrackerTicket, now: number): AttentionReason[] {
  if (ticket.statusCategory === "done") {
    return [];
  }

  const out: AttentionReason[] = [];
  const urgent = ticket.priority === "Critical" || ticket.priority === "High";
  const tier = ticket.priority === "Critical" ? "Critical" : "High";
  const onTs = ticket.whoseMove === "new" || ticket.whoseMove === "on_ts";
  const quietFor = (): number => {
    const last = timeOf(ticket.lastActivityAt);
    return Number.isNaN(last) ? 0 : workingElapsedMs(last, now);
  };

  /* A clock. Breached wins even while paused in Waiting for product - the overrun already happened. */
  if (ticket.ttr.breached || hasSignal(ticket, "ttr_breached")) {
    const over = ticket.ttr.remainingMs !== null && ticket.ttr.remainingMs < 0 ? ` by ${span(ticket.ttr.remainingMs)}` : "";
    out.push(reason("sla_breached", "danger", `SLA breached${over}`, "The time to resolution target has passed."));
  } else if (hasSignal(ticket, "ttr_at_risk") && ticket.ttr.remainingMs !== null && ticket.ttr.remainingMs > 0) {
    out.push(reason("sla_at_risk", "warning", `SLA due in ${span(ticket.ttr.remainingMs)}`, "Under 8 working hours left on the time to resolution."));
  }

  if (urgent && ticket.whoseMove === "new") {
    const quiet = quietFor();
    if (quiet >= QUIET_NEW_MS[tier]) {
      out.push(reason("quiet_new", tier === "Critical" ? "danger" : "warning", `Not picked up ${span(quiet)}`, `Still in ${ticket.statusName} with no activity.`));
    }
  }

  if (urgent && !ticket.assignee) {
    out.push(reason("unassigned", "warning", "Unassigned", "Nobody owns this ticket."));
  }

  const manuallyEscalated = hasSignal(ticket, "priority_raised") || hasSignal(ticket, "escalation_comment");
  if (urgent && onTs && manuallyEscalated) {
    out.push(
      reason(
        "escalated_on_ts",
        "warning",
        "Escalated, still on TS",
        "Someone raised the priority or asked to escalate, but it has no open CP and isn't in Waiting for product.",
      ),
    );
  }

  /* Engineering's side of the hand-off. Epics are containers for planned work, not a fix to follow. */
  const realCps = ticket.cps.filter((cp) => !cp.isEpic);
  const fixReady = realCps.filter((cp) => cp.outcome === "fix_ready");
  const handBackQuiet = urgent && quietFor() >= HANDBACK_QUIET_MS;
  if (handBackQuiet && fixReady.length > 0) {
    const names = fixReady.map((cp) => cp.key).join(", ");
    out.push(reason("fix_ready", "accent", `Fix ready · ${names}`, "Engineering built the fix - verify it and update the customer."));
  }

  if (handBackQuiet && ticket.statusId === WAITING_FOR_PRODUCT_STATUS_ID) {
    const pending = realCps.some((cp) => cp.outcome === "open" || cp.outcome === "fix_ready");
    if (realCps.length === 0) {
      out.push(reason("wfp_no_cp", "warning", "No CP linked", "Waiting for product, but no CP is linked, so engineering has nothing to pick up."));
    } else if (!pending) {
      const shipped = realCps.some((cp) => cp.outcome === "shipped");
      out.push(
        reason(
          "cp_done",
          "accent",
          shipped ? "CP shipped" : "CP rejected",
          shipped ? "Every linked CP shipped, but the ticket is still Waiting for product." : "Every linked CP was rejected, but the ticket is still Waiting for product.",
        ),
      );
    }
  }

  if (urgent && ticket.whoseMove !== "on_customer" && ticket.slack.conversations > 0) {
    const slackAt = timeOf(ticket.slack.lastActivityAt);
    if (!Number.isNaN(slackAt) && now - slackAt <= SLACK_LIVE_MS) {
      out.push(reason("slack_live", "accent", "Slack is active", `A Slack conversation about this was active ${span(now - slackAt)} ago.`));
    }
  }

  if (urgent && ticket.whoseMove === "on_ts") {
    const quiet = quietFor();
    if (quiet >= QUIET_ON_TS_MS[tier]) {
      out.push(reason("quiet_on_ts", "warning", `Quiet ${span(quiet)}`, "It's TS's move and nothing has happened for a while."));
    }
  }

  if (urgent && ticket.whoseMove === "new" && ticket.firstResponse.breached) {
    out.push(reason("no_first_response", "danger", "No first response", "The first-response target passed and the ticket is still new."));
  }

  if (urgent && ticket.whoseMove === "on_engineering") {
    const quiet = quietFor();
    if (quiet >= QUIET_ON_ENGINEERING_MS[tier]) {
      out.push(reason("quiet_engineering", "warning", `Engineering quiet ${span(quiet)}`, "Waiting on engineering with no activity on the ticket or in Slack - worth a nudge."));
    }
  }

  return out.sort((a, b) => a.rank - b.rank);
}

/** The most urgent rank among a ticket's reasons; Infinity when it needs nothing. */
export function attentionRank(ticket: TrackerTicket, now: number): number {
  return attentionReasons(ticket, now)[0]?.rank ?? Number.POSITIVE_INFINITY;
}

export function needsAttention(ticket: TrackerTicket, now: number): boolean {
  return attentionReasons(ticket, now).length > 0;
}
