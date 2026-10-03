import { businessMsBetween } from "@/lib/escalation/businessHours";
import { WAITING_FOR_PRODUCT_STATUS_ID } from "@/lib/escalation/policy";

import type { SlaClock, SlaClockState } from "@/lib/cases/types";
import type { BusinessCalendar, ParsedSla } from "@/lib/escalation/types";

/**
 * Our own SLA clocks, computed from the same history Jira's JSM SLAs see,
 * so we can prove parity before Jira stops being the source of truth.
 * Pure: no I/O, no clock reads (`nowMs` is passed in).
 *
 * ASSUMPTIONS (each one is a guess at the JSM SLA config, to be confirmed
 * by the parity table on /cases - a systematic mismatch points at one):
 *
 * Calendar
 * - Business time is JSM calendar 30 "Certify Support": Mon-Fri 09:00-18:00
 *   America/New_York, wall-clock across DST, minus its holidays (the
 *   calendar object is passed in; see CERTIFY_SUPPORT_CALENDAR).
 *
 * Goals
 * - The goal is not ours to invent: it is Jira's own goalDuration for the
 *   metric (via slaParser). No Jira goal -> our state is "none".
 * - "Breached" means elapsed business time EXCEEDS the goal (JSM shows a
 *   negative remaining time); exactly at the goal is not yet breached.
 *   breachedAt is the instant remaining time reached zero.
 *
 * Time to resolution (cf[10650])
 * - Starts when the issue is created.
 * - Pauses while the ticket sits in Waiting for product (10633) or a
 *   waiting-for-customer/client status (matched by name - the ids differ
 *   per workflow and none are pinned in policy.ts).
 * - Stops when a resolution is set. If the changelog shows no resolution
 *   change at all but the issue is resolved, it stops at resolutiondate.
 * - A cleared resolution (a reopen) starts a NEW cycle from zero, the way a
 *   JSM SLA with "Resolution: Cleared" as a start condition does; Jira then
 *   reports the ongoing cycle, and so do we.
 *
 * Time to first response (cf[10059])
 * - Starts when the issue is created, never pauses, and stops at the first
 *   PUBLIC comment by an agent: not the reporter, not a JSM customer
 *   account, not an automation ("app") account. Internal notes do not count.
 */

/** Our clock before it is paired with Jira's reading. */
export type OurClock = Omit<SlaClock, "computedAt" | "jira" | "metric">;

/* Within this, our remaining time and Jira's count as the same reading. JSM
   recomputes remaining time when the issue is read and we compute at sync
   time; a few minutes also absorbs Jira rounding to the minute. */
export const PARITY_TOLERANCE_MS = 5 * 60_000;

const WAITING_ON_CUSTOMER = /^waiting\s+(?:for|on)\s+(?:the\s+)?(?:customer|client)s?$/i;

/** Whether the resolution clock pauses in this status. */
export function isPauseStatus(statusId: string | null | undefined, statusName: string | null | undefined): boolean {
  return statusId === WAITING_FOR_PRODUCT_STATUS_ID || (typeof statusName === "string" && WAITING_ON_CUSTOMER.test(statusName.trim()));
}

/* ----------------------------------------------------------------- core */

/** What happens to a clock at an instant. */
export interface ClockEvent {
  atMs: number;
  kind: "pause" | "restart" | "resume" | "stop";
}

/**
 * Runs one clock from `startMs` to `nowMs` through `events` (any order).
 * Pause/resume and stop/restart are independent: time counts only while
 * neither paused nor stopped. A restart while stopped begins a new cycle
 * from zero; a restart while running is ignored, as is a stop while stopped.
 * Throws RangeError on a non-finite instant or a malformed calendar.
 */
export function runClock(args: {
  calendar: BusinessCalendar;
  events: ClockEvent[];
  goalMs: number | null;
  initiallyPaused: boolean;
  nowMs: number;
  startMs: number;
}): OurClock {
  const { calendar, goalMs, nowMs, startMs } = args;
  /* Stable sort: same-instant events keep the order the caller listed them in. */
  const events = args.events
    .map((event, index) => ({ ...event, atMs: Math.max(event.atMs, startMs), index }))
    .filter((event) => event.atMs <= nowMs)
    .sort((a, b) => a.atMs - b.atMs || a.index - b.index);

  let paused = args.initiallyPaused;
  let stopped = false;
  let elapsed = 0;
  let breachedAtMs: number | null = null;
  let stoppedAtMs: number | null = null;
  let cursor = startMs;

  const accumulate = (toMs: number): void => {
    if (toMs <= cursor || paused || stopped) {
      return;
    }
    const span = businessMsBetween(cursor, toMs, calendar);
    if (goalMs !== null && breachedAtMs === null && elapsed + span > goalMs) {
      breachedAtMs = instantReaching(cursor, toMs, goalMs - elapsed, calendar);
    }
    elapsed += span;
  };

  for (const event of events) {
    accumulate(event.atMs);
    cursor = event.atMs;
    if (event.kind === "pause") {
      paused = true;
    } else if (event.kind === "resume") {
      paused = false;
    } else if (event.kind === "stop" && !stopped) {
      stopped = true;
      stoppedAtMs = event.atMs;
    } else if (event.kind === "restart" && stopped) {
      stopped = false;
      stoppedAtMs = null;
      elapsed = 0;
      breachedAtMs = null;
    }
  }
  accumulate(nowMs);

  const breached = goalMs !== null && elapsed > goalMs;
  let state: SlaClockState;
  if (goalMs === null) {
    state = "none";
  } else if (breached) {
    state = "breached";
  } else if (stopped) {
    state = "met";
  } else {
    state = paused ? "paused" : "running";
  }

  const finalBreachedAt: number | null = breached ? breachedAtMs : null;
  return {
    breachedAt: finalBreachedAt === null ? null : new Date(finalBreachedAt).toISOString(),
    elapsedBusinessMs: elapsed,
    goalMs,
    remainingMs: goalMs === null ? null : goalMs - elapsed,
    state,
    stoppedAt: stoppedAtMs === null ? null : new Date(stoppedAtMs).toISOString(),
  };
}

/**
 * The earliest instant t in (fromMs, toMs] with businessMsBetween(fromMs, t) >= needMs.
 * Binary search to the millisecond - business time is monotone in t.
 */
function instantReaching(fromMs: number, toMs: number, needMs: number, calendar: BusinessCalendar): number {
  let lo = fromMs;
  let hi = toMs;
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (businessMsBetween(fromMs, mid, calendar) >= needMs) {
      hi = mid;
    } else {
      lo = mid;
    }
  }
  return hi;
}

/* ----------------------------------------------------------- resolution */

export interface StatusChange {
  at: string;
  fromId: string | null;
  fromName: string | null;
  toId: string | null;
  toName: string | null;
}

export interface ResolutionChange {
  at: string;
  /* true = a resolution was set, false = it was cleared (reopened). */
  set: boolean;
}

export interface ResolutionTimeline {
  createdAt: string;
  currentStatus: { id: string; name: string };
  resolutionChanges: ResolutionChange[];
  resolvedAt: string | null;
  statusChanges: StatusChange[];
}

function parseInstant(iso: string, label: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    throw new RangeError(`sla: ${label} ${JSON.stringify(iso)} is not an instant`);
  }
  return ms;
}

/** Our Time to resolution clock. See the module comment for the rules. */
export function computeResolutionClock(timeline: ResolutionTimeline, goalMs: number | null, nowMs: number, calendar: BusinessCalendar): OurClock {
  const startMs = parseInstant(timeline.createdAt, "createdAt");
  const statusChanges = [...timeline.statusChanges].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const first = statusChanges[0];
  /* The status the ticket was created in is the "from" of its first transition; with no transitions it never left the current one. */
  const initial = first ? { id: first.fromId, name: first.fromName } : { id: timeline.currentStatus.id, name: timeline.currentStatus.name };

  const events: ClockEvent[] = [];
  for (const change of statusChanges) {
    events.push({ atMs: parseInstant(change.at, "status change"), kind: isPauseStatus(change.toId, change.toName) ? "pause" : "resume" });
  }
  for (const change of timeline.resolutionChanges) {
    events.push({ atMs: parseInstant(change.at, "resolution change"), kind: change.set ? "stop" : "restart" });
  }
  if (timeline.resolutionChanges.length === 0 && timeline.resolvedAt) {
    events.push({ atMs: parseInstant(timeline.resolvedAt, "resolvedAt"), kind: "stop" });
  }

  return runClock({ calendar, events, goalMs, initiallyPaused: isPauseStatus(initial.id, initial.name), nowMs, startMs });
}

/* -------------------------------------------------------- first response */

export interface ResponseCandidate {
  authorAccountId: string | null;
  authorType: string | null;
  createdAt: string;
  visibility: "public" | "internal";
}

/** When an agent first answered the customer publicly, or null. See the module comment. */
export function firstAgentResponseAt(comments: ResponseCandidate[], reporterAccountId: string | null): string | null {
  const times = comments
    .filter(
      (comment) =>
        comment.visibility === "public" &&
        comment.authorType !== "customer" &&
        comment.authorType !== "app" &&
        comment.authorAccountId !== null &&
        comment.authorAccountId !== reporterAccountId,
    )
    .map((comment) => Date.parse(comment.createdAt))
    .filter((ms) => !Number.isNaN(ms))
    .sort((a, b) => a - b);
  const earliest = times[0];
  return earliest === undefined ? null : new Date(earliest).toISOString();
}

/** Our Time to first response clock. */
export function computeFirstResponseClock(
  args: { createdAt: string; firstResponseAt: string | null },
  goalMs: number | null,
  nowMs: number,
  calendar: BusinessCalendar,
): OurClock {
  const startMs = parseInstant(args.createdAt, "createdAt");
  const events: ClockEvent[] = args.firstResponseAt ? [{ atMs: parseInstant(args.firstResponseAt, "firstResponseAt"), kind: "stop" }] : [];
  return runClock({ calendar, events, goalMs, initiallyPaused: false, nowMs, startMs });
}

/* --------------------------------------------------------------- parity */

/** Jira's reading of a metric in the shape sla_clocks stores it. */
export function jiraReading(parsed: ParsedSla): SlaClock["jira"] {
  return { breached: parsed.breached, goalMs: parsed.goalMs, remainingMs: parsed.remainingMs, state: parsed.state };
}

/**
 * Why our clock and Jira's disagree, or null when they agree. Compared:
 * goal, breached, whether the cycle is still open, paused vs running (only
 * while not breached - our state then says "breached" either way), and
 * remaining time within PARITY_TOLERANCE_MS while both cycles are open.
 */
export function parityMismatch(ours: Pick<SlaClock, "goalMs" | "remainingMs" | "state" | "stoppedAt">, jira: SlaClock["jira"]): string | null {
  if (jira.state === "none") {
    return ours.state === "none" ? null : `Jira has no SLA cycle; ours is ${ours.state}`;
  }
  if (ours.state === "none") {
    return `Jira's SLA is ${jira.state}; ours has no goal`;
  }
  if (jira.goalMs !== null && ours.goalMs !== jira.goalMs) {
    return `goal differs (ours ${ours.goalMs}ms, Jira ${jira.goalMs}ms)`;
  }
  const oursBreached = ours.state === "breached";
  if (oursBreached !== jira.breached) {
    return oursBreached ? "we say breached, Jira does not" : "Jira says breached, we do not";
  }
  const oursOpen = ours.stoppedAt === null;
  const jiraOpen = jira.state === "running" || jira.state === "paused";
  if (oursOpen !== jiraOpen) {
    return oursOpen ? "our cycle is open, Jira's has completed" : "Jira's cycle is open, ours has stopped";
  }
  if (oursOpen && !oursBreached && (ours.state === "paused") !== (jira.state === "paused")) {
    return `we are ${ours.state}, Jira is ${jira.state}`;
  }
  if (oursOpen && ours.remainingMs !== null && jira.remainingMs !== null && Math.abs(ours.remainingMs - jira.remainingMs) > PARITY_TOLERANCE_MS) {
    const minutes = Math.round((ours.remainingMs - jira.remainingMs) / 60_000);
    return `remaining time differs by ${minutes > 0 ? "+" : ""}${minutes} min`;
  }
  return null;
}
