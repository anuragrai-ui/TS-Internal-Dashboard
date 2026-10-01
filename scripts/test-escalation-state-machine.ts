import { DEFAULT_ESCALATION_POLICY, PILOT_POD_OPTION_ID, POD_OPTIONS } from "@/lib/escalation/policy";
import { reconcile } from "@/lib/escalation/stateMachine";
import type {
  CurrentObservation,
  EscalationState,
  ReconcileContext,
  ReconcileEvent,
  ReconcileResult,
  StoredEscalation,
} from "@/lib/escalation/stateMachine";
import type { CpOutcome, CpSnapshot, StatusCategory } from "@/lib/escalation/types";

/* Key-sorted so deep equality doesn't depend on property insertion order. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : inner,
  );
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (canonical(actual) !== canonical(expected)) {
    throw new Error(`${label} failed: expected ${canonical(expected)}, got ${canonical(actual)}`);
  }
}

function assert(condition: boolean, label: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${label}`);
  }
}

function assertThrows(fn: () => unknown, label: string): void {
  try {
    fn();
  } catch {
    return;
  }
  throw new Error(`Assertion failed: ${label} (expected a throw)`);
}

/* ---------------------------------------------------------------- fixtures */

const PILOT = PILOT_POD_OPTION_ID; /* Credentialing 12448 */
const DATA_INTEGRATION = "10228";
const ROSTER = "12443";
const GRACE = DEFAULT_ESCALATION_POLICY.resolveGraceMinutes;

/* Fixed instant (Fri 2026-10-02 10:00 America/New_York) - nothing reads the real clock. */
const T0_MS = Date.parse("2026-10-02T14:00:00.000Z");

function at(minutes: number, extraMs = 0): string {
  return new Date(T0_MS + minutes * 60_000 + extraMs).toISOString();
}

function ctx(minutes = 0, overrides: Partial<ReconcileContext> = {}): ReconcileContext {
  return { graceMinutes: GRACE, now: at(minutes), pilotPodOptionId: PILOT, ...overrides };
}

type TsState = { inWfp: boolean; statusCategory: StatusCategory };
const WFP: TsState = { inWfp: true, statusCategory: "indeterminate" };
const WAITING_FOR_CLIENT: TsState = { inWfp: false, statusCategory: "indeterminate" };
const DONE: TsState = { inWfp: false, statusCategory: "done" };

/* Realistic CP fields per outcome; reconcile only reads podOptionId and the precomputed outcome. */
const CP_STATUS: Record<CpOutcome, Pick<CpSnapshot, "resolutionId" | "resolutionName" | "statusCategory" | "statusId" | "statusName">> = {
  fix_ready: { resolutionId: "10078", resolutionName: "Ready to Release", statusCategory: "done", statusId: "10131", statusName: "Ready for Release" },
  open: { resolutionId: null, resolutionName: null, statusCategory: "indeterminate", statusId: "3", statusName: "In Progress" },
  rejected: { resolutionId: "10009", resolutionName: "Won't Do", statusCategory: "done", statusId: "6", statusName: "Closed" },
  shipped: { resolutionId: "10045", resolutionName: "Fixed", statusCategory: "done", statusId: "10571", statusName: "Released" },
};

function makeCp(outcome: CpOutcome, podOptionId: string | null = PILOT): CpSnapshot {
  return {
    assigneeAccountId: null,
    assigneeName: null,
    issueTypeId: "10004",
    issueTypeName: "Bug",
    key: "CP-100",
    podName: POD_OPTIONS.find((option) => option.id === podOptionId)?.name ?? null,
    podOptionId,
    priorityName: "High",
    url: "https://certifyos.atlassian.net/browse/CP-100",
    ...CP_STATUS[outcome],
  };
}

/* qualifyingTsKeys is derived from the TS states, so fixtures can't disagree with themselves. */
function observe(opts: {
  outcome: CpOutcome;
  pod?: string | null;
  qualifying?: string[];
  ts: Record<string, TsState>;
}): CurrentObservation {
  return {
    attachedTsStates: opts.ts,
    cp: makeCp(opts.outcome, opts.pod === undefined ? PILOT : opts.pod),
    cpKey: "CP-100",
    outcome: opts.outcome,
    qualifyingTsKeys: opts.qualifying ?? Object.keys(opts.ts).filter((key) => opts.ts[key]?.inWfp),
  };
}

function unreadable(): CurrentObservation {
  return { attachedTsStates: {}, cp: null, cpKey: "CP-100", outcome: null, qualifyingTsKeys: [] };
}

function stored(overrides: Partial<StoredEscalation> = {}): StoredEscalation {
  return {
    cpKey: "CP-100",
    episode: 1,
    levelSent: 0,
    podOptionId: PILOT,
    qualifyingTsKeys: ["TS-1"],
    state: "open",
    tsKeys: ["TS-1"],
    ...overrides,
  };
}

const ACK = { ackedAt: at(-60), ackedBySlackId: "U0ACKER01" };

function nextOf(result: ReconcileResult): StoredEscalation {
  assert(result.next !== null, "expected a stored escalation");
  return result.next as StoredEscalation;
}

function noChange(result: ReconcileResult, prev: StoredEscalation, label: string): void {
  assertEqual(result.events, [] as ReconcileEvent[], `${label}: no events`);
  assertEqual(result.cancelQueuedForEpisodes, [], `${label}: nothing cancelled`);
  assertEqual(result.next, prev, `${label}: state unchanged`);
}

/* ------------------------------------------------------------------- opening */

function testOpensNewEscalation(): void {
  console.log("\n--- Test: a pilot-pod CP with a TS ticket in WfP opens episode 1 ---");

  const result = reconcile(null, observe({ outcome: "open", ts: { "TS-1": WFP } }), ctx());

  assertEqual(result.events, [{ type: "opened" }] as ReconcileEvent[], "events");
  assertEqual(result.cancelQueuedForEpisodes, [], "nothing to cancel on a fresh episode");
  assertEqual(
    result.next,
    { cpKey: "CP-100", episode: 1, levelSent: 0, podOptionId: PILOT, qualifyingTsKeys: ["TS-1"], state: "open", tsKeys: ["TS-1"] },
    "stored escalation",
  );

  const fixReady = reconcile(null, observe({ outcome: "fix_ready", ts: { "TS-1": WFP } }), ctx());
  assertEqual(fixReady.events, [{ type: "opened" }, { type: "fix_ready" }] as ReconcileEvent[], "fix_ready open events");
  assertEqual(nextOf(fixReady).state, "fix_ready", "opens straight into fix_ready");
  assertEqual(nextOf(fixReady).episode, 1, "still episode 1");

  console.log("PASS: opens as open (or fix_ready) with opened (+ fix_ready).");
}

function testDoesNotOpenWithoutAllConditions(): void {
  console.log("\n--- Test: nothing opens off-pilot, without a WfP ticket, or on a closed CP ---");

  const cases: Array<[string, CurrentObservation]> = [
    ["other pod", observe({ outcome: "open", pod: DATA_INTEGRATION, ts: { "TS-1": WFP } })],
    ["pod missing", observe({ outcome: "open", pod: null, ts: { "TS-1": WFP } })],
    ["no TS in WfP", observe({ outcome: "open", ts: { "TS-1": WAITING_FOR_CLIENT } })],
    ["CP shipped", observe({ outcome: "shipped", ts: { "TS-1": WFP } })],
    ["CP rejected", observe({ outcome: "rejected", ts: { "TS-1": WFP } })],
  ];
  for (const [label, obs] of cases) {
    const result = reconcile(null, obs, ctx());
    assertEqual(result, { cancelQueuedForEpisodes: [], events: [], next: null }, label);
  }

  console.log("PASS: all three open conditions are required.");
}

/* ---------------------------------------------------------------- unreadable */

function testUnreadableKeepsState(): void {
  console.log("\n--- Test: an unreadable CP keeps prev untouched - no resolve, no cancel ---");

  /* Shipped and already past grace: a readable poll would resolve this. */
  const prev = stored({ ...ACK, levelSent: 2, pendingResolveSince: at(0), state: "acked", tsKeys: ["TS-1", "TS-2"] });
  const result = reconcile(prev, unreadable(), ctx(GRACE * 4));

  assertEqual(result.events, [{ type: "unreadable" }] as ReconcileEvent[], "unreadable event");
  assertEqual(result.cancelQueuedForEpisodes, [], "never cancels on missing data");
  assertEqual(result.next, prev, "stored state carried over exactly");
  assert(result.next !== prev && result.next?.tsKeys !== prev.tsKeys, "returned a copy, not an alias of prev");

  const nullOutcome = reconcile(prev, { ...observe({ outcome: "shipped", ts: {} }), outcome: null }, ctx(GRACE * 4));
  assertEqual(nullOutcome.events, [{ type: "unreadable" }] as ReconcileEvent[], "null outcome counts as unreadable");
  assertEqual(nullOutcome.next, prev, "null outcome keeps state");

  const fresh = reconcile(null, unreadable(), ctx());
  assertEqual(fresh, { cancelQueuedForEpisodes: [], events: [{ type: "unreadable" }], next: null }, "no prev, unreadable");

  console.log("PASS: missing data changes nothing.");
}

/* ------------------------------------------------------------ grace / resolve */

function testShippedResolvesExactlyAtGrace(): void {
  console.log("\n--- Test: shipped -> resolve_pending, then resolved exactly at graceMinutes ---");

  const first = reconcile(stored(), observe({ outcome: "shipped", ts: { "TS-1": WFP } }), ctx(0));
  assertEqual(first.events, [{ reason: "shipped", type: "resolve_pending" }] as ReconcileEvent[], "first sighting");
  assertEqual(nextOf(first).pendingResolveSince, at(0), "grace starts now");
  assertEqual(nextOf(first).state, "open", "not resolved yet");
  assertEqual(first.cancelQueuedForEpisodes, [], "ladder untouched during grace");

  const oneMsShort = reconcile(nextOf(first), observe({ outcome: "shipped", ts: { "TS-1": WFP } }), {
    ...ctx(),
    now: at(GRACE, -1),
  });
  noChange(oneMsShort, nextOf(first), "1ms before grace");

  const atGrace = reconcile(nextOf(oneMsShort), observe({ outcome: "shipped", ts: { "TS-1": WFP } }), ctx(GRACE));
  assertEqual(atGrace.events, [{ reason: "shipped", type: "resolved" }] as ReconcileEvent[], "resolved at boundary");
  assertEqual(nextOf(atGrace).state, "resolved", "state");
  assertEqual(nextOf(atGrace).resolutionReason, "shipped", "reason");
  assertEqual(nextOf(atGrace).pendingResolveSince, undefined, "grace timer cleared");
  assertEqual(atGrace.cancelQueuedForEpisodes, [1], "queued notifications for the episode cancelled");

  console.log("PASS: grace is >= graceMinutes, measured from the first sighting.");
}

function testRejectedResolvesAfterGrace(): void {
  console.log("\n--- Test: rejected (Won't Do / HF-Rejected) resolves as rejected ---");

  const pending = reconcile(stored(), observe({ outcome: "rejected", ts: { "TS-1": WFP } }), ctx(0));
  assertEqual(pending.events, [{ reason: "rejected", type: "resolve_pending" }] as ReconcileEvent[], "pending");

  const resolved = reconcile(nextOf(pending), observe({ outcome: "rejected", ts: { "TS-1": WFP } }), ctx(GRACE + 10));
  assertEqual(resolved.events, [{ reason: "rejected", type: "resolved" }] as ReconcileEvent[], "resolved");
  assertEqual(nextOf(resolved).resolutionReason, "rejected", "reason");
  assertEqual(resolved.cancelQueuedForEpisodes, [1], "cancel");

  console.log("PASS: rejected follows the same grace path.");
}

function testFlapWithinGraceDoesNotReopen(): void {
  console.log("\n--- Test: Released -> Blocked inside grace clears the timer, no reopen, no new episode ---");

  const prev = stored({ ...ACK, levelSent: 1, state: "acked" });
  const shipped = reconcile(prev, observe({ outcome: "shipped", ts: { "TS-1": WFP } }), ctx(0));
  assertEqual(nextOf(shipped).pendingResolveSince, at(0), "timer started");

  /* Open-PR guard bounces the CP back to Blocked. */
  const blocked = reconcile(nextOf(shipped), observe({ outcome: "open", ts: { "TS-1": WFP } }), ctx(10));
  assertEqual(blocked.events, [] as ReconcileEvent[], "no reopen / resolve events");
  assertEqual(blocked.cancelQueuedForEpisodes, [], "nothing cancelled");
  assertEqual(blocked.next, prev, "back to exactly the pre-flap state (ack, level, episode 1)");

  /* Released again: the window restarts, so the original deadline no longer resolves it. */
  const shippedAgain = reconcile(nextOf(blocked), observe({ outcome: "shipped", ts: { "TS-1": WFP } }), ctx(20));
  assertEqual(shippedAgain.events, [{ reason: "shipped", type: "resolve_pending" }] as ReconcileEvent[], "pending again");
  assertEqual(nextOf(shippedAgain).pendingResolveSince, at(20), "fresh timer");

  const originalDeadline = reconcile(nextOf(shippedAgain), observe({ outcome: "shipped", ts: { "TS-1": WFP } }), ctx(GRACE));
  noChange(originalDeadline, nextOf(shippedAgain), "original deadline");

  const newDeadline = reconcile(nextOf(originalDeadline), observe({ outcome: "shipped", ts: { "TS-1": WFP } }), ctx(20 + GRACE));
  assertEqual(nextOf(newDeadline).state, "resolved", "resolves at the restarted deadline");
  assertEqual(nextOf(newDeadline).episode, 1, "never left episode 1");

  /* Flapping into fix_ready (Ready for Release) inside grace is the same: timer dropped, then fix_ready. */
  const toFixReady = reconcile(nextOf(shipped), observe({ outcome: "fix_ready", ts: { "TS-1": WFP } }), ctx(5));
  assertEqual(toFixReady.events, [{ type: "fix_ready" }] as ReconcileEvent[], "fix_ready, not reopened");
  assertEqual(nextOf(toFixReady).pendingResolveSince, undefined, "timer cleared");
  assertEqual(nextOf(toFixReady).episode, 1, "same episode");

  console.log("PASS: flapping inside grace is absorbed in the same episode.");
}

function testZeroGraceResolvesOnFirstSighting(): void {
  console.log("\n--- Test: graceMinutes 0 resolves on the first shipped poll ---");

  const result = reconcile(stored(), observe({ outcome: "shipped", ts: { "TS-1": WFP } }), ctx(0, { graceMinutes: 0 }));
  assertEqual(
    result.events,
    [{ reason: "shipped", type: "resolve_pending" }, { reason: "shipped", type: "resolved" }] as ReconcileEvent[],
    "both events in one poll",
  );
  assertEqual(nextOf(result).state, "resolved", "resolved");
  assertEqual(result.cancelQueuedForEpisodes, [1], "cancel");

  console.log("PASS: a zero grace window resolves immediately.");
}

/* ------------------------------------------------------------------ fix_ready */

function testFixReadyStopsLadder(): void {
  console.log("\n--- Test: fix_ready while open/acked stops the ladder; repeat polls are quiet ---");

  const fromOpen = reconcile(stored(), observe({ outcome: "fix_ready", ts: { "TS-1": WFP } }), ctx());
  assertEqual(fromOpen.events, [{ type: "fix_ready" }] as ReconcileEvent[], "event");
  assertEqual(nextOf(fromOpen).state, "fix_ready", "state");
  assertEqual(fromOpen.cancelQueuedForEpisodes, [1], "ladder stops");

  const again = reconcile(nextOf(fromOpen), observe({ outcome: "fix_ready", ts: { "TS-1": WFP } }), ctx(10));
  noChange(again, nextOf(fromOpen), "second fix_ready poll");

  const fromAcked = reconcile(
    stored({ ...ACK, levelSent: 2, state: "acked" }),
    observe({ outcome: "fix_ready", ts: { "TS-1": WFP } }),
    ctx(),
  );
  assertEqual(nextOf(fromAcked).state, "fix_ready", "acked -> fix_ready");
  assertEqual(nextOf(fromAcked).ackedAt, ACK.ackedAt, "ack kept");
  assertEqual(nextOf(fromAcked).ackedBySlackId, ACK.ackedBySlackId, "acker kept");
  assertEqual(nextOf(fromAcked).levelSent, 2, "levelSent kept");
  assertEqual(fromAcked.cancelQueuedForEpisodes, [1], "cancel");

  console.log("PASS: fix_ready stops the ladder once and holds.");
}

function testRolledBackReturnsToOpen(): void {
  console.log("\n--- Test: fix_ready -> open (Rolled Back) returns to open in the same episode ---");

  const prev = stored({ levelSent: 1, state: "fix_ready" });
  const rolledBack = reconcile(prev, observe({ outcome: "open", ts: { "TS-1": WFP } }), ctx());
  assertEqual(rolledBack.events, [] as ReconcileEvent[], "no events");
  assertEqual(rolledBack.cancelQueuedForEpisodes, [], "nothing to cancel - the ladder resumes");
  assertEqual(rolledBack.next, { ...prev, state: "open" }, "open, same episode and level");

  /* "Ack only cleared on reopen": a rollback is not a reopen, so an acked CP
     goes back to acked (ladder running, ack reminders not re-armed), never to
     an "open" record that still carries ackedAt. */
  const ackedPrev = stored({ ...ACK, state: "fix_ready" });
  const ackedRolledBack = reconcile(ackedPrev, observe({ outcome: "open", ts: { "TS-1": WFP } }), ctx());
  assertEqual(ackedRolledBack.next, { ...ackedPrev, state: "acked" }, "an earlier ack still stands");
  assertEqual(ackedRolledBack.events, [] as ReconcileEvent[], "no events");
  assertEqual(ackedRolledBack.cancelQueuedForEpisodes, [], "nothing cancelled - the ladder resumes");

  /* Chained through real transitions: acked -> Ready for Release -> Rolled Back -> Ready for Release. */
  const acked = stored({ ...ACK, levelSent: 2, state: "acked" });
  const toFixReady = nextOf(reconcile(acked, observe({ outcome: "fix_ready", ts: { "TS-1": WFP } }), ctx(0)));
  assertEqual(toFixReady.state, "fix_ready", "ladder stopped");
  const backFromFixReady = nextOf(reconcile(toFixReady, observe({ outcome: "open", ts: { "TS-1": WFP } }), ctx(10)));
  assertEqual(backFromFixReady, acked, "exactly the pre-release record: acked, same ack, level, episode");
  const fixReadyAgain = reconcile(backFromFixReady, observe({ outcome: "fix_ready", ts: { "TS-1": WFP } }), ctx(20));
  assertEqual(fixReadyAgain.events, [{ type: "fix_ready" }] as ReconcileEvent[], "a second release is announced again");
  assertEqual(fixReadyAgain.cancelQueuedForEpisodes, [1], "and stops the ladder again");

  console.log("PASS: rollback resumes the episode and preserves the ack.");
}

/* ---------------------------------------------------- ts_done / handed_back */

function testAllTsDoneResolvesTsDone(): void {
  console.log("\n--- Test: every attached TS ticket Done while the CP is pending -> resolved ts_done ---");

  const prev = stored({ qualifyingTsKeys: ["TS-1", "TS-2"], tsKeys: ["TS-1", "TS-2"] });
  const result = reconcile(prev, observe({ outcome: "open", ts: { "TS-1": DONE, "TS-2": DONE } }), ctx());
  assertEqual(
    result.events,
    [
      { tsKey: "TS-1", type: "ts_left" },
      { tsKey: "TS-2", type: "ts_left" },
      { reason: "ts_done", type: "resolved" },
    ] as ReconcileEvent[],
    "events",
  );
  assertEqual(nextOf(result).state, "resolved", "state");
  assertEqual(nextOf(result).resolutionReason, "ts_done", "reason");
  assertEqual(result.cancelQueuedForEpisodes, [1], "cancel");

  const fixReady = reconcile(stored({ state: "fix_ready" }), observe({ outcome: "fix_ready", ts: { "TS-1": DONE } }), ctx());
  assertEqual(nextOf(fixReady).resolutionReason, "ts_done", "fix_ready CP counts as pending too");

  /* TS-2's state couldn't be read: not known to be done, so this is a hand-back, not ts_done. */
  const partial = reconcile(prev, observe({ outcome: "open", ts: { "TS-1": DONE } }), ctx());
  assertEqual(nextOf(partial).state, "handed_back", "an unread TS ticket never resolves as ts_done");

  console.log("PASS: ts_done needs every attached ticket known Done.");
}

function testHandedBack(): void {
  console.log("\n--- Test: all TS tickets leave WfP, not all Done, CP pending -> handed_back ---");

  const prev = stored({ ...ACK, levelSent: 2, qualifyingTsKeys: ["TS-1", "TS-2"], state: "acked", tsKeys: ["TS-1", "TS-2"] });
  const result = reconcile(prev, observe({ outcome: "open", ts: { "TS-1": DONE, "TS-2": WAITING_FOR_CLIENT } }), ctx());
  assertEqual(
    result.events,
    [{ tsKey: "TS-1", type: "ts_left" }, { tsKey: "TS-2", type: "ts_left" }, { type: "handed_back" }] as ReconcileEvent[],
    "events",
  );
  assertEqual(nextOf(result).state, "handed_back", "state");
  assertEqual(result.cancelQueuedForEpisodes, [1], "cancel");
  assertEqual(nextOf(result).ackedAt, ACK.ackedAt, "ack kept until a reopen");

  const quiet = reconcile(nextOf(result), observe({ outcome: "open", ts: { "TS-1": DONE, "TS-2": WAITING_FOR_CLIENT } }), ctx(10));
  noChange(quiet, nextOf(result), "handed_back holds");

  console.log("PASS: hand-back stops the ladder and then stays quiet.");
}

/* -------------------------------------------------------------------- reopen */

function testReopenAfterHandBack(): void {
  console.log("\n--- Test: a TS ticket re-entering WfP after hand-back reopens as episode 2 ---");

  const prev = stored({
    ...ACK,
    levelSent: 2,
    qualifyingTsKeys: [],
    state: "handed_back",
    tsKeys: ["TS-1", "TS-2"],
  });
  const result = reconcile(prev, observe({ outcome: "open", ts: { "TS-1": DONE, "TS-2": WFP } }), ctx());

  assertEqual(result.events, [{ episode: 2, type: "reopened" }] as ReconcileEvent[], "reopened, no ts_added noise");
  assertEqual(result.cancelQueuedForEpisodes, [1], "old episode's queue cancelled");
  assertEqual(
    result.next,
    { cpKey: "CP-100", episode: 2, levelSent: 0, podOptionId: PILOT, qualifyingTsKeys: ["TS-2"], state: "open", tsKeys: ["TS-1", "TS-2"] },
    "fresh episode: ack cleared, level 0, tsKeys union kept",
  );

  const asFixReady = reconcile(prev, observe({ outcome: "fix_ready", ts: { "TS-2": WFP } }), ctx());
  assertEqual(asFixReady.events, [{ episode: 2, type: "reopened" }, { type: "fix_ready" }] as ReconcileEvent[], "fix_ready reopen");
  assertEqual(nextOf(asFixReady).state, "fix_ready", "reopens straight into fix_ready");

  console.log("PASS: hand-back reopen increments the episode and cancels the old one.");
}

function testReopenAfterResolved(): void {
  console.log("\n--- Test: resolved CP coming back to an open status (after grace) reopens ---");

  const prev = stored({ ...ACK, levelSent: 3, resolutionReason: "shipped", state: "resolved" });

  /* Still shipped while support hasn't moved the TS ticket yet: no reopen. */
  const stillShipped = reconcile(prev, observe({ outcome: "shipped", ts: { "TS-1": WFP } }), ctx());
  noChange(stillShipped, prev, "resolved + shipped + TS still in WfP");

  const reopened = reconcile(prev, observe({ outcome: "open", ts: { "TS-1": WFP, "TS-3": WFP } }), ctx(GRACE * 3));
  assertEqual(reopened.events, [{ episode: 2, type: "reopened" }] as ReconcileEvent[], "reopened");
  assertEqual(reopened.cancelQueuedForEpisodes, [1], "cancel old episode");
  const next = nextOf(reopened);
  assertEqual(next.episode, 2, "episode");
  assertEqual(next.state, "open", "state");
  assertEqual(next.resolutionReason, undefined, "resolution cleared");
  assertEqual(next.ackedAt, undefined, "ack cleared");
  assertEqual(next.ackedBySlackId, undefined, "acker cleared");
  assertEqual(next.levelSent, 0, "level reset");
  assertEqual(next.tsKeys, ["TS-1", "TS-3"], "late joiner added to the union");

  /* Episode 2 resolving and reopening again goes to 3 and cancels 2. */
  const third = reconcile({ ...next, state: "resolved", resolutionReason: "ts_done" }, observe({ outcome: "open", ts: { "TS-3": WFP } }), ctx());
  assertEqual(nextOf(third).episode, 3, "episode 3");
  assertEqual(third.cancelQueuedForEpisodes, [2], "cancels episode 2");

  console.log("PASS: reopen from resolved starts a fresh episode.");
}

/* ------------------------------------------------------------------ ack / shared CP */

function testAckPreservedAcrossPolls(): void {
  console.log("\n--- Test: acked survives ordinary polls and ticket churn ---");

  let current = stored({ ...ACK, levelSent: 1, state: "acked" });
  const polls: Array<Record<string, TsState>> = [
    { "TS-1": WFP },
    { "TS-1": WFP, "TS-2": WFP },
    { "TS-1": WAITING_FOR_CLIENT, "TS-2": WFP },
    { "TS-1": WFP, "TS-2": WFP },
  ];
  polls.forEach((ts, index) => {
    const result = reconcile(current, observe({ outcome: "open", ts }), ctx(10 * index));
    current = nextOf(result);
    assertEqual(current.state, "acked", `poll ${index}: still acked`);
    assertEqual(current.ackedAt, ACK.ackedAt, `poll ${index}: ackedAt`);
    assertEqual(current.ackedBySlackId, ACK.ackedBySlackId, `poll ${index}: acker`);
    assertEqual(current.levelSent, 1, `poll ${index}: levelSent untouched`);
    assertEqual(current.episode, 1, `poll ${index}: episode`);
    assertEqual(result.cancelQueuedForEpisodes, [], `poll ${index}: nothing cancelled`);
  });

  console.log("PASS: only a reopen clears an ack.");
}

function testSharedCpTicketsJoinAndLeave(): void {
  console.log("\n--- Test: shared CP - tickets join/leave one escalation, tsKeys keeps the union ---");

  const opened = nextOf(reconcile(null, observe({ outcome: "open", ts: { "TS-1": WFP } }), ctx(0)));

  /* Duplicate keys from the poller are collapsed. */
  const joined = reconcile(
    opened,
    observe({ outcome: "open", qualifying: ["TS-1", "TS-2", "TS-2", "TS-3"], ts: { "TS-1": WFP, "TS-2": WFP, "TS-3": WFP } }),
    ctx(10),
  );
  assertEqual(
    joined.events,
    [{ tsKey: "TS-2", type: "ts_added" }, { tsKey: "TS-3", type: "ts_added" }] as ReconcileEvent[],
    "two joined",
  );
  assertEqual(nextOf(joined).tsKeys, ["TS-1", "TS-2", "TS-3"], "union");
  assertEqual(nextOf(joined).qualifyingTsKeys, ["TS-1", "TS-2", "TS-3"], "deduped qualifying");

  const left = reconcile(nextOf(joined), observe({ outcome: "open", ts: { "TS-1": WAITING_FOR_CLIENT, "TS-2": WFP, "TS-3": WFP } }), ctx(20));
  assertEqual(left.events, [{ tsKey: "TS-1", type: "ts_left" }] as ReconcileEvent[], "TS-1 left");
  assertEqual(nextOf(left).tsKeys, ["TS-1", "TS-2", "TS-3"], "TS-1 stays in the union");
  assertEqual(nextOf(left).state, "open", "others still waiting - no hand-back");
  assertEqual(left.cancelQueuedForEpisodes, [], "nothing cancelled");

  const quiet = reconcile(nextOf(left), observe({ outcome: "open", ts: { "TS-1": WAITING_FOR_CLIENT, "TS-2": WFP, "TS-3": WFP } }), ctx(30));
  assertEqual(quiet.events, [] as ReconcileEvent[], "no repeated ts_left for a ticket that already left");

  const back = reconcile(nextOf(quiet), observe({ outcome: "open", ts: { "TS-1": WFP, "TS-2": WFP, "TS-3": WFP } }), ctx(40));
  assertEqual(back.events, [{ tsKey: "TS-1", type: "ts_added" }] as ReconcileEvent[], "re-entry mid-episode is ts_added");
  assertEqual(nextOf(back).episode, 1, "not a reopen while the episode runs");

  /* The busiest live CP has 53 TS tickets: still exactly one escalation. */
  const many: Record<string, TsState> = {};
  for (let i = 1; i <= 53; i += 1) {
    many[`TS-${i}`] = WFP;
  }
  const crowd = reconcile(opened, observe({ outcome: "open", ts: many }), ctx(50));
  assertEqual(crowd.events.length, 52, "52 newcomers announced");
  assertEqual(nextOf(crowd).tsKeys.length, 53, "53 tickets on one CP key");
  assertEqual(nextOf(crowd).episode, 1, "one escalation, one episode");

  /* Hand-built record without qualifyingTsKeys: tsKeys stands in for the diff. */
  const legacy = reconcile(
    { ...stored({ tsKeys: ["TS-1", "TS-2"] }), qualifyingTsKeys: undefined },
    observe({ outcome: "open", ts: { "TS-1": WFP, "TS-2": WAITING_FOR_CLIENT } }),
    ctx(),
  );
  assertEqual(legacy.events, [{ tsKey: "TS-2", type: "ts_left" }] as ReconcileEvent[], "legacy record diffs against tsKeys");

  console.log("PASS: membership churn is reported once per change on a single escalation.");
}

/* ------------------------------------------------------------------ pod changes */

function testPodChangedAwayFreezes(): void {
  console.log("\n--- Test: CP moved off the pilot pod -> frozen_pod_changed, immediately ---");

  const prev = stored({ ...ACK, pendingResolveSince: at(0), state: "acked" });
  const result = reconcile(prev, observe({ outcome: "shipped", pod: DATA_INTEGRATION, ts: { "TS-1": WFP } }), ctx(5));
  assertEqual(result.events, [{ from: PILOT, to: DATA_INTEGRATION, type: "pod_changed" }] as ReconcileEvent[], "event");
  assertEqual(nextOf(result).state, "frozen_pod_changed", "frozen, even mid-grace");
  assertEqual(nextOf(result).podOptionId, DATA_INTEGRATION, "new pod recorded");
  assertEqual(nextOf(result).pendingResolveSince, undefined, "grace timer dropped");
  assertEqual(result.cancelQueuedForEpisodes, [1], "cancel");

  const quiet = reconcile(nextOf(result), observe({ outcome: "open", pod: DATA_INTEGRATION, ts: { "TS-1": WFP } }), ctx(15));
  noChange(quiet, nextOf(result), "frozen holds while the pod stays away");

  const movedAgain = reconcile(nextOf(result), observe({ outcome: "open", pod: ROSTER, ts: { "TS-1": WFP } }), ctx(25));
  assertEqual(movedAgain.events, [{ from: DATA_INTEGRATION, to: ROSTER, type: "pod_changed" }] as ReconcileEvent[], "second move");
  assertEqual(nextOf(movedAgain).state, "frozen_pod_changed", "still frozen");
  assertEqual(movedAgain.cancelQueuedForEpisodes, [], "nothing more to cancel");

  /* Moved back onto the pilot with a ticket still waiting: new episode. */
  const back = reconcile(nextOf(movedAgain), observe({ outcome: "open", ts: { "TS-1": WFP } }), ctx(35));
  assertEqual(
    back.events,
    [{ from: ROSTER, to: PILOT, type: "pod_changed" }, { episode: 2, type: "reopened" }] as ReconcileEvent[],
    "back on the pilot",
  );
  assertEqual(nextOf(back).state, "open", "open again");
  assertEqual(nextOf(back).ackedAt, undefined, "ack from the frozen episode cleared");
  assertEqual(back.cancelQueuedForEpisodes, [1], "old episode cancelled");

  console.log("PASS: pod moves freeze, and a move back starts a new episode.");
}

function testPodChangedToPilot(): void {
  console.log("\n--- Test: CP moved onto the pilot pod opens (no prev) / reopens (non-pilot record) ---");

  /* Elsewhere last poll, so nothing was stored. */
  const elsewhere = reconcile(null, observe({ outcome: "open", pod: DATA_INTEGRATION, ts: { "TS-1": WFP } }), ctx(0));
  assertEqual(elsewhere.next, null, "untracked while off-pilot");
  const moved = reconcile(elsewhere.next, observe({ outcome: "open", ts: { "TS-1": WFP } }), ctx(10));
  assertEqual(moved.events, [{ type: "opened" }] as ReconcileEvent[], "opened");
  assertEqual(nextOf(moved).episode, 1, "episode 1");

  /* A resolved record whose CP drifted off-pilot must not reopen until it's back. */
  const resolved = stored({ resolutionReason: "ts_done", state: "resolved" });
  const offPilot = reconcile(resolved, observe({ outcome: "open", pod: DATA_INTEGRATION, ts: { "TS-1": WFP } }), ctx());
  assertEqual(offPilot.events, [{ from: PILOT, to: DATA_INTEGRATION, type: "pod_changed" }] as ReconcileEvent[], "move recorded");
  assertEqual(nextOf(offPilot).state, "resolved", "no reopen off-pilot");
  assertEqual(offPilot.cancelQueuedForEpisodes, [], "nothing cancelled");

  const onPilot = reconcile(nextOf(offPilot), observe({ outcome: "open", ts: { "TS-1": WFP } }), ctx(10));
  assertEqual(
    onPilot.events,
    [{ from: DATA_INTEGRATION, to: PILOT, type: "pod_changed" }, { episode: 2, type: "reopened" }] as ReconcileEvent[],
    "reopens once back on the pilot",
  );

  console.log("PASS: arriving on the pilot pod opens or reopens.");
}

function testClearedPodIsMissingData(): void {
  console.log("\n--- Test: a cleared CP Pod field doesn't freeze or cancel ---");

  const prev = stored({ ...ACK, state: "acked" });
  const result = reconcile(prev, observe({ outcome: "open", pod: null, ts: { "TS-1": WFP } }), ctx());
  noChange(result, prev, "pod null");

  console.log("PASS: a missing pod keeps routing on the last pod seen.");
}

/* -------------------------------------------------------------------- suppressed */

function testSuppressedStaysSuppressed(): void {
  console.log("\n--- Test: suppressed (wrong pod) holds until the pod changes or it resolves ---");

  const prev = stored({ resolutionReason: "wrong_pod", state: "suppressed" });

  const fixReady = reconcile(prev, observe({ outcome: "fix_ready", ts: { "TS-1": WFP } }), ctx());
  noChange(fixReady, prev, "fix_ready doesn't lift it");

  /* Silent: no handed_back and no ts_left posted into a wrong-pod thread. */
  const allLeft = reconcile(prev, observe({ outcome: "open", ts: { "TS-1": WAITING_FOR_CLIENT } }), ctx());
  assertEqual(allLeft.events, [] as ReconcileEvent[], "no handed_back, no ts_left");
  assertEqual(nextOf(allLeft).state, "suppressed", "still suppressed with nothing in WfP");
  assertEqual(nextOf(allLeft).qualifyingTsKeys, [], "WfP baseline still tracked while silent");
  assertEqual(allLeft.cancelQueuedForEpisodes, [], "nothing cancelled");

  /* TS-1 re-enters and a new TS-2 joins: no reopen, no ts_added, but the union grows. */
  const reentered = reconcile(nextOf(allLeft), observe({ outcome: "open", ts: { "TS-1": WFP, "TS-2": WFP } }), ctx(10));
  assertEqual(reentered.events, [] as ReconcileEvent[], "no reopen, no ts_added");
  assertEqual(nextOf(reentered).state, "suppressed", "still suppressed");
  assertEqual(nextOf(reentered).resolutionReason, "wrong_pod", "wrong_pod kept");
  assertEqual(nextOf(reentered).tsKeys, ["TS-1", "TS-2"], "silent joiner still recorded");
  assertEqual(nextOf(reentered).qualifyingTsKeys, ["TS-1", "TS-2"], "baseline caught up");
  assertEqual(reentered.cancelQueuedForEpisodes, [], "nothing cancelled");

  const shipped = reconcile(prev, observe({ outcome: "shipped", ts: { "TS-1": WFP } }), ctx(0));
  assertEqual(nextOf(shipped).state, "suppressed", "suppressed during grace");
  const resolved = reconcile(nextOf(shipped), observe({ outcome: "shipped", ts: { "TS-1": WFP } }), ctx(GRACE));
  assertEqual(nextOf(resolved).state, "resolved", "resolves after grace");
  assertEqual(nextOf(resolved).resolutionReason, "shipped", "reason replaced");
  assertEqual(resolved.cancelQueuedForEpisodes, [1], "cancel");

  const tsDone = reconcile(prev, observe({ outcome: "open", ts: { "TS-1": DONE } }), ctx());
  assertEqual(nextOf(tsDone).resolutionReason, "ts_done", "ts_done resolves it too");

  const podMoved = reconcile(prev, observe({ outcome: "open", pod: DATA_INTEGRATION, ts: { "TS-1": WFP } }), ctx());
  assertEqual(nextOf(podMoved).state, "frozen_pod_changed", "pod change lifts it");

  /* A pod move that also changes membership reports only the move, and the
     tickets that joined while silent are all on the reopened episode. */
  const movedWithChurn = reconcile(
    nextOf(reentered),
    observe({ outcome: "open", pod: DATA_INTEGRATION, ts: { "TS-1": WAITING_FOR_CLIENT, "TS-2": WFP, "TS-3": WFP } }),
    ctx(20),
  );
  assertEqual(
    movedWithChurn.events,
    [{ from: PILOT, to: DATA_INTEGRATION, type: "pod_changed" }] as ReconcileEvent[],
    "pod_changed only, no membership noise",
  );
  assertEqual(movedWithChurn.cancelQueuedForEpisodes, [1], "cancel");
  const backOnPilot = reconcile(nextOf(movedWithChurn), observe({ outcome: "open", ts: { "TS-2": WFP, "TS-3": WFP } }), ctx(30));
  assertEqual(nextOf(backOnPilot).episode, 2, "reopened");
  assertEqual(nextOf(backOnPilot).qualifyingTsKeys, ["TS-2", "TS-3"], "reopen carries the whole waiting set");
  assertEqual(nextOf(backOnPilot).tsKeys, ["TS-1", "TS-2", "TS-3"], "union kept");

  console.log("PASS: wrong-pod suppression is silent and only ends by pod change or resolution.");
}

/* ----------------------------------------------------------------- purity */

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value as Record<string, unknown>).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function testPureAndDeterministic(): void {
  console.log("\n--- Test: reconcile never mutates prev and is deterministic ---");

  /* ESM is strict mode, so any write to a frozen prev throws. */
  const scenarios: Array<[StoredEscalation, CurrentObservation, ReconcileContext]> = [
    [stored(), observe({ outcome: "fix_ready", ts: { "TS-1": WFP } }), ctx()],
    [stored({ state: "fix_ready" }), observe({ outcome: "open", ts: { "TS-1": WFP } }), ctx()],
    [stored(), observe({ outcome: "shipped", ts: { "TS-1": WFP } }), ctx()],
    [stored({ pendingResolveSince: at(0) }), observe({ outcome: "shipped", ts: { "TS-1": WFP } }), ctx(GRACE)],
    [stored({ pendingResolveSince: at(0) }), observe({ outcome: "open", ts: { "TS-1": WFP } }), ctx(5)],
    [stored(), observe({ outcome: "open", ts: { "TS-1": DONE } }), ctx()],
    [stored(), observe({ outcome: "open", ts: { "TS-1": WAITING_FOR_CLIENT, "TS-2": WFP } }), ctx()],
    [stored({ ...ACK, state: "handed_back" }), observe({ outcome: "open", ts: { "TS-1": WFP } }), ctx()],
    [stored(), observe({ outcome: "open", pod: DATA_INTEGRATION, ts: { "TS-1": WFP } }), ctx()],
    [stored(), unreadable(), ctx()],
  ];
  for (const [prev, obs, context] of scenarios) {
    const before = canonical(prev);
    const first = reconcile(deepFreeze(prev), deepFreeze(obs), deepFreeze(context));
    const second = reconcile(prev, obs, context);
    assertEqual(canonical(prev), before, `prev unchanged (${prev.state} / ${obs.outcome})`);
    assertEqual(first, second, `same inputs, same result (${prev.state} / ${obs.outcome})`);
    assert(first.next !== prev, "next is never prev itself");
    /* Mutating the result must not leak back into the (frozen) prev. */
    first.next?.tsKeys.push("TS-999");
    first.next?.qualifyingTsKeys?.push("TS-999");
  }

  console.log("PASS: pure, copy-on-write, deterministic.");
}

function testRejectsBadInput(): void {
  console.log("\n--- Test: bad config, mismatched CP keys, or a corrupt record throw instead of guessing ---");

  const openObs = observe({ outcome: "open", ts: { "TS-1": WFP } });
  const shippedObs = observe({ outcome: "shipped", ts: { "TS-1": WFP } });

  assertThrows(() => reconcile(stored({ cpKey: "CP-999" }), openObs, ctx()), "mismatched stored cpKey");
  assertThrows(() => reconcile(stored(), openObs, { ...ctx(), now: "not-a-date" }), "invalid ctx.now");

  /* A bad grace value must not silently disable the flap guard (NaN/negative
     would resolve and cancel on the first shipped sighting). */
  const badGraces: unknown[] = [Number.NaN, -1, -0.5, Number.POSITIVE_INFINITY, undefined, "30"];
  for (const graceMinutes of badGraces) {
    assertThrows(
      () => reconcile(stored(), shippedObs, ctx(0, { graceMinutes: graceMinutes as number })),
      `graceMinutes ${String(graceMinutes)}`,
    );
  }

  /* An unset pilot id would make every CP look off-pilot and freeze them all. */
  for (const pilotPodOptionId of ["", undefined]) {
    assertThrows(
      () => reconcile(stored(), openObs, ctx(0, { pilotPodOptionId: pilotPodOptionId as string })),
      `pilotPodOptionId ${String(pilotPodOptionId)}`,
    );
  }

  /* The snapshot itself must be for the observed CP, or another CP's outcome and pod land here. */
  const foreignSnapshot: CurrentObservation = { ...shippedObs, cp: { ...makeCp("shipped"), key: "CP-999" } };
  assertThrows(() => reconcile(stored(), foreignSnapshot, ctx(GRACE * 2)), "snapshot key differs from obs.cpKey");
  assertThrows(() => reconcile(null, { ...openObs, cp: { ...makeCp("open"), key: "CP-999" } }, ctx()), "same check with no prev");

  /* A corrupt or legacy state must not be read as "episode over" and reopened
     (new thread, ack wiped, episode 1 cancelled) - not even on an unreadable poll. */
  const legacy = stored({ ...ACK, state: "acknowledged" as unknown as EscalationState });
  assertThrows(() => reconcile(legacy, openObs, ctx()), "unknown stored state");
  assertThrows(() => reconcile(legacy, unreadable(), ctx()), "unknown stored state, unreadable poll");

  /* Episode numbers feed dedupe keys ("CP-100:e1:L2"); a bad one would collide or garble them. */
  const badEpisodes: unknown[] = [0, -1, 1.5, Number.NaN, "1"];
  for (const episode of badEpisodes) {
    assertThrows(
      () => reconcile(stored({ episode: episode as number, state: "handed_back" }), openObs, ctx()),
      `episode ${String(episode)}`,
    );
  }

  /* Valid edges still pass: zero grace, and every known state. */
  reconcile(stored(), shippedObs, ctx(0, { graceMinutes: 0 }));
  const states: EscalationState[] = ["open", "acked", "fix_ready", "handed_back", "resolved", "frozen_pod_changed", "suppressed"];
  for (const state of states) {
    reconcile(stored({ state }), openObs, ctx());
  }

  /* A corrupt stored grace timestamp restarts the window instead of resolving. */
  const corrupt = reconcile(stored({ pendingResolveSince: "garbage" }), observe({ outcome: "shipped", ts: { "TS-1": WFP } }), ctx(GRACE * 2));
  assertEqual(corrupt.events, [{ reason: "shipped", type: "resolve_pending" }] as ReconcileEvent[], "restarted");
  assertEqual(nextOf(corrupt).pendingResolveSince, at(GRACE * 2), "timer reset to now");

  console.log("PASS: bad input fails loudly or conservatively.");
}

function main(): void {
  try {
    testOpensNewEscalation();
    testDoesNotOpenWithoutAllConditions();
    testUnreadableKeepsState();
    testShippedResolvesExactlyAtGrace();
    testRejectedResolvesAfterGrace();
    testFlapWithinGraceDoesNotReopen();
    testZeroGraceResolvesOnFirstSighting();
    testFixReadyStopsLadder();
    testRolledBackReturnsToOpen();
    testAllTsDoneResolvesTsDone();
    testHandedBack();
    testReopenAfterHandBack();
    testReopenAfterResolved();
    testAckPreservedAcrossPolls();
    testSharedCpTicketsJoinAndLeave();
    testPodChangedAwayFreezes();
    testPodChangedToPilot();
    testClearedPodIsMissingData();
    testSuppressedStaysSuppressed();
    testPureAndDeterministic();
    testRejectsBadInput();
    console.log("\nAll escalation state-machine tests passed.");
    process.exit(0);
  } catch (error) {
    console.error("\nEscalation state-machine test failed:", error);
    process.exit(1);
  }
}

main();
