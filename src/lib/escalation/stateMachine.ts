import type { CpOutcome, CpSnapshot, EscalationLevel, StatusCategory } from "@/lib/escalation/types";

/**
 * Pure reconcile step for one engineering escalation (one per CP key). The
 * poller runs it every 10 minutes for each tracked CP: stored state + what
 * Jira shows now -> the next stored state, the events worth telling Slack
 * about, and which episodes' queued (unsent) notifications to cancel. No I/O
 * and no clock reads - ctx.now is the only time source - so every transition
 * can be replayed from fixtures.
 *
 * An episode is one run of the ladder in one Slack thread. A reopen starts a
 * new episode (fresh ack, level 0, new thread) instead of reviving the old
 * one, so dedupe keys like "CP-123:e1:L2" never collide across reopens.
 */

/*
 * open / acked: engineering owes a fix and the ladder runs. "acked" is set by
 *   the Slack Acknowledge handler, never here; reconcile only preserves it.
 * fix_ready: Ready for Release - the ladder stops but the thread stays live.
 * suppressed: someone pressed "Wrong pod" - silent until the CP's pod changes
 *   or the escalation resolves.
 * handed_back / resolved / frozen_pod_changed: the episode is over; only a
 *   reopen starts the ladder again.
 */
export type EscalationState =
  | "open"
  | "acked"
  | "fix_ready"
  | "handed_back"
  | "resolved"
  | "frozen_pod_changed"
  | "suppressed";

/* "wrong_pod" is written by the Wrong-pod button alongside "suppressed"; reconcile never produces it. */
export type ResolutionReason = "shipped" | "rejected" | "ts_done" | "wrong_pod";

export interface StoredEscalation {
  ackedAt?: string;
  ackedBySlackId?: string;
  cpKey: string;
  episode: number;
  /* Highest ladder level actually sent this episode - written by the sender, reset only on reopen. */
  levelSent: EscalationLevel;
  /* First time a shipped/rejected outcome was seen, for the resolve grace period. */
  pendingResolveSince?: string;
  /* The CP's own Pod as of the last readable poll - the routing key, never the TS ticket's Pod. */
  podOptionId: string;
  /* TS tickets in WfP as of the last readable poll. tsKeys alone can't tell "just left WfP" from
     "left weeks ago", so ts_left needs this. Optional so hand-built records still type-check;
     when absent, tsKeys stands in. */
  qualifyingTsKeys?: string[];
  resolutionReason?: ResolutionReason;
  state: EscalationState;
  /* Every TS ticket ever attached, across polls and episodes (union, first-seen order). */
  tsKeys: string[];
}

export interface CurrentObservation {
  /* Every TS ever attached (prev.tsKeys plus this poll's qualifying keys), read by key. A key
     missing here counts as "not known to be done", so it can never resolve the escalation. */
  attachedTsStates: Record<string, { inWfp: boolean; statusCategory: StatusCategory }>;
  /* Null = the CP could not be read this poll. */
  cp: CpSnapshot | null;
  cpKey: string;
  /* Null alongside a null cp (or when no outcome could be derived) - treated as unreadable. */
  outcome: CpOutcome | null;
  /* Attached TS tickets currently in Waiting for product - authoritative for WfP membership. */
  qualifyingTsKeys: string[];
}

/* ts_added / ts_left are only emitted while the episode runs and isn't
   suppressed (open, acked, fix_ready). A suppressed record still reports what
   can end its suppression: pod_changed and the resolve_pending -> resolved path. */
export type ReconcileEvent =
  | { type: "opened" }
  | { type: "ts_added"; tsKey: string }
  | { type: "ts_left"; tsKey: string }
  | { type: "fix_ready" }
  | { type: "resolve_pending"; reason: "shipped" | "rejected" }
  | { type: "resolved"; reason: ResolutionReason }
  | { type: "handed_back" }
  | { type: "pod_changed"; from: string; to: string }
  | { type: "reopened"; episode: number }
  | { type: "unreadable" };

export interface ReconcileResult {
  /* Episodes whose queued (unsent) notifications must be cancelled. */
  cancelQueuedForEpisodes: number[];
  events: ReconcileEvent[];
  /* Null only when there was no stored escalation and nothing qualifies to open one. */
  next: StoredEscalation | null;
}

export interface ReconcileContext {
  /* Minutes a CP must stay shipped/rejected before resolving (policy.resolveGraceMinutes). */
  graceMinutes: number;
  now: string;
  pilotPodOptionId: string;
}

type PendingOutcome = Extract<CpOutcome, "open" | "fix_ready">;

/* A Record (not a list) so adding a state to the union without listing it here fails to compile. */
const STATE_NAMES: Record<EscalationState, true> = {
  acked: true,
  fix_ready: true,
  frozen_pod_changed: true,
  handed_back: true,
  open: true,
  resolved: true,
  suppressed: true,
};
const KNOWN_STATES: ReadonlySet<string> = new Set(Object.keys(STATE_NAMES));

const LIVE_STATES: ReadonlySet<EscalationState> = new Set<EscalationState>(["open", "acked", "fix_ready", "suppressed"]);

/** Whether the escalation's current episode is still running (its Slack thread is live). */
export function isLiveState(state: EscalationState): boolean {
  return LIVE_STATES.has(state);
}

function isPending(outcome: CpOutcome): outcome is PendingOutcome {
  return outcome === "open" || outcome === "fix_ready";
}

/* Set keeps insertion order, so unions stay in first-seen order and the output is deterministic. */
function union(...lists: ReadonlyArray<readonly string[]>): string[] {
  return [...new Set(lists.flat())];
}

/* Fresh arrays so nothing the caller does to `next` can reach back into `prev`. */
function copyEscalation(escalation: StoredEscalation): StoredEscalation {
  const copy: StoredEscalation = { ...escalation, tsKeys: [...escalation.tsKeys] };
  if (escalation.qualifyingTsKeys) {
    copy.qualifyingTsKeys = [...escalation.qualifyingTsKeys];
  }
  return copy;
}

function everyAttachedTsDone(tsKeys: readonly string[], states: CurrentObservation["attachedTsStates"]): boolean {
  return tsKeys.length > 0 && tsKeys.every((tsKey) => states[tsKey]?.statusCategory === "done");
}

function startEpisode(args: {
  cpKey: string;
  episode: number;
  outcome: PendingOutcome;
  podOptionId: string;
  qualifying: string[];
  tsKeys: string[];
}): StoredEscalation {
  return {
    cpKey: args.cpKey,
    episode: args.episode,
    levelSent: 0,
    podOptionId: args.podOptionId,
    qualifyingTsKeys: [...args.qualifying],
    state: args.outcome === "fix_ready" ? "fix_ready" : "open",
    tsKeys: [...args.tsKeys],
  };
}

/*
 * Bad config or a corrupt stored record fails loudly instead of being read
 * as a transition. Each check guards a specific silent failure:
 * - graceMinutes NaN/negative makes the grace comparison false, so the first
 *   shipped sighting would resolve and cancel at once (no flap guard);
 * - an empty pilot id makes every CP look off-pilot, freezing every live
 *   escalation;
 * - a snapshot for another CP would apply its outcome and pod to this one;
 * - an unknown state (legacy "acknowledged", say) isn't live, so the next
 *   ordinary poll would "reopen" it: new thread, ack wiped, old queue
 *   cancelled; a non-integer episode would corrupt dedupe keys the same way.
 * Returns ctx.now as epoch ms.
 */
function validateInputs(prev: StoredEscalation | null, obs: CurrentObservation, ctx: ReconcileContext): number {
  const nowMs = Date.parse(ctx.now);
  if (Number.isNaN(nowMs)) {
    throw new Error(`reconcile: ctx.now is not a valid instant: ${ctx.now}`);
  }
  if (typeof ctx.graceMinutes !== "number" || !Number.isFinite(ctx.graceMinutes) || ctx.graceMinutes < 0) {
    throw new Error(`reconcile: ctx.graceMinutes must be a finite number >= 0, got ${String(ctx.graceMinutes)}`);
  }
  if (typeof ctx.pilotPodOptionId !== "string" || ctx.pilotPodOptionId === "") {
    throw new Error(`reconcile: ctx.pilotPodOptionId must be a non-empty option id, got ${String(ctx.pilotPodOptionId)}`);
  }
  if (obs.cp !== null && obs.cp.key !== obs.cpKey) {
    throw new Error(`reconcile: observation for ${obs.cpKey} carries a snapshot of ${obs.cp.key}`);
  }
  if (prev === null) {
    return nowMs;
  }
  if (prev.cpKey !== obs.cpKey) {
    throw new Error(`reconcile: observation for ${obs.cpKey} applied to stored escalation ${prev.cpKey}`);
  }
  if (!KNOWN_STATES.has(prev.state)) {
    throw new Error(`reconcile: stored escalation ${prev.cpKey} has unknown state ${String(prev.state)}`);
  }
  if (!Number.isInteger(prev.episode) || prev.episode < 1) {
    throw new Error(`reconcile: stored escalation ${prev.cpKey} has invalid episode ${String(prev.episode)}`);
  }
  return nowMs;
}

export function reconcile(
  prev: StoredEscalation | null,
  obs: CurrentObservation,
  ctx: ReconcileContext,
): ReconcileResult {
  const nowMs = validateInputs(prev, obs, ctx);

  /* Missing data never resolves or cancels anything: a CP we couldn't read
     (permissions blip, 5xx, rate limit) keeps exactly the state we had. */
  if (obs.cp === null || obs.outcome === null) {
    return { cancelQueuedForEpisodes: [], events: [{ type: "unreadable" }], next: prev ? copyEscalation(prev) : null };
  }

  const outcome = obs.outcome;
  const qualifying = union(obs.qualifyingTsKeys);
  const pilot = ctx.pilotPodOptionId;

  if (prev === null) {
    if (obs.cp.podOptionId !== pilot || qualifying.length === 0 || !isPending(outcome)) {
      return { cancelQueuedForEpisodes: [], events: [], next: null };
    }
    const events: ReconcileEvent[] = [{ type: "opened" }];
    if (outcome === "fix_ready") {
      events.push({ type: "fix_ready" });
    }
    const next = startEpisode({ cpKey: obs.cpKey, episode: 1, outcome, podOptionId: pilot, qualifying, tsKeys: qualifying });
    return { cancelQueuedForEpisodes: [], events, next };
  }

  const events: ReconcileEvent[] = [];
  const next = copyEscalation(prev);
  next.tsKeys = union(prev.tsKeys, qualifying);
  next.qualifyingTsKeys = qualifying;

  /* A cleared Pod field is missing data, not a move: the classifier raises
     cp_pod_missing for a human, and we keep routing on the last pod we saw. */
  const observedPod = obs.cp.podOptionId ?? prev.podOptionId;
  if (observedPod !== prev.podOptionId) {
    events.push({ from: prev.podOptionId, to: observedPod, type: "pod_changed" });
    next.podOptionId = observedPod;
  }

  if (!isLiveState(prev.state)) {
    /* The episode is over. A hand-back that re-enters WfP, a resolved CP
       that comes back to an open status, or a CP moved back onto the pilot
       pod all start a new episode - never revive the old thread. */
    if (observedPod === pilot && qualifying.length > 0 && isPending(outcome)) {
      const reopened = startEpisode({
        cpKey: prev.cpKey,
        episode: prev.episode + 1,
        outcome,
        podOptionId: observedPod,
        qualifying,
        tsKeys: next.tsKeys,
      });
      events.push({ episode: reopened.episode, type: "reopened" });
      if (outcome === "fix_ready") {
        events.push({ type: "fix_ready" });
      }
      return { cancelQueuedForEpisodes: [prev.episode], events, next: reopened };
    }
    return { cancelQueuedForEpisodes: [], events, next };
  }

  /* Membership changes only mean something while the episode runs; a reopen
     announces its whole ticket set via the new parent instead. A suppressed
     ("Wrong pod") thread stays silent too: the baseline above still moves,
     but nothing is posted into a thread someone marked as not theirs.
     Suppression only ends in a non-live state, so the next live episode is a
     reopen that lists every ticket anyway. */
  if (prev.state !== "suppressed") {
    const previouslyQualifying = union(prev.qualifyingTsKeys ?? prev.tsKeys);
    for (const tsKey of qualifying) {
      if (!previouslyQualifying.includes(tsKey)) {
        events.push({ tsKey, type: "ts_added" });
      }
    }
    for (const tsKey of previouslyQualifying) {
      if (!qualifying.includes(tsKey)) {
        events.push({ tsKey, type: "ts_left" });
      }
    }
  }

  const stopLadder = (): ReconcileResult => ({ cancelQueuedForEpisodes: [prev.episode], events, next });
  const keepGoing = (): ReconcileResult => ({ cancelQueuedForEpisodes: [], events, next });

  /* Moved to a pod outside the pilot: freeze at once, no grace - that pod's
     owners aren't in this channel, so nothing further should ping here. */
  if (observedPod !== pilot) {
    next.state = "frozen_pod_changed";
    delete next.pendingResolveSince;
    return stopLadder();
  }

  if (!isPending(outcome)) {
    /* The open-PR guard can bounce Released -> Blocked minutes after a
       release, so a shipped/rejected CP only resolves once it has held for
       the whole grace window. An unparseable stored timestamp restarts the
       window rather than resolving early. */
    const storedSinceMs = prev.pendingResolveSince === undefined ? Number.NaN : Date.parse(prev.pendingResolveSince);
    let sinceMs = storedSinceMs;
    if (Number.isNaN(sinceMs)) {
      sinceMs = nowMs;
      next.pendingResolveSince = ctx.now;
      events.push({ reason: outcome, type: "resolve_pending" });
    }
    if (nowMs - sinceMs < ctx.graceMinutes * 60_000) {
      return keepGoing();
    }
    next.state = "resolved";
    next.resolutionReason = outcome;
    delete next.pendingResolveSince;
    events.push({ reason: outcome, type: "resolved" });
    return stopLadder();
  }

  /* Back to open/fix_ready inside the grace window is the guard flapping,
     not a reopen: drop the timer and carry on in the same episode. */
  delete next.pendingResolveSince;

  if (everyAttachedTsDone(next.tsKeys, obs.attachedTsStates)) {
    next.state = "resolved";
    next.resolutionReason = "ts_done";
    events.push({ reason: "ts_done", type: "resolved" });
    return stopLadder();
  }

  /* "Wrong pod" holds until a pod change or a resolution (both handled
     above) - a hand-back or a CP status move doesn't lift it. */
  if (prev.state === "suppressed") {
    return keepGoing();
  }

  if (qualifying.length === 0) {
    next.state = "handed_back";
    events.push({ type: "handed_back" });
    return stopLadder();
  }

  if (outcome === "fix_ready") {
    if (prev.state === "fix_ready") {
      return keepGoing();
    }
    next.state = "fix_ready";
    events.push({ type: "fix_ready" });
    return stopLadder();
  }

  /* Rolled Back / Testing Failed after Ready for Release: back to the
     ladder-running state in the same episode. An earlier Acknowledge still
     stands - "ack only cleared on reopen" - so an acked CP returns to acked,
     not open: an "open" record carrying ackedAt would read as unacknowledged
     to anything keyed on state and re-run ack reminders (up to L3) for an
     ack engineering already gave. The engineering-wait ladder runs in both. */
  if (prev.state === "fix_ready") {
    next.state = prev.ackedAt ? "acked" : "open";
  }
  return keepGoing();
}
