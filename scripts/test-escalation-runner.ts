import { isAckReaction } from "@/lib/escalation/acknowledge";
import { cpOutcome } from "@/lib/escalation/classify";
import { planEscalations } from "@/lib/escalation/plan";
import { DEFAULT_ESCALATION_POLICY } from "@/lib/escalation/policy";
import { applyEffect, decideThreadUpdates, stepEscalation } from "@/lib/escalation/threadUpdates";

import type { EscalationRecord } from "@/lib/escalation/runnerStore";
import type { CurrentObservation } from "@/lib/escalation/stateMachine";
import type { Outbound } from "@/lib/escalation/threadUpdates";
import type { CpSnapshot, EscalationGroup, ParsedSla, RoutingRow, TsSnapshot } from "@/lib/escalation/types";

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} failed: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assert(condition: boolean, label: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${label}`);
  }
}

/* ------------------------------------------------------------------ fixtures */

const T0 = Date.parse("2026-10-05T14:00:00.000Z");
const HOUR = 3_600_000;
const at = (hours: number): string => new Date(T0 + hours * HOUR).toISOString();
/* Every policy cap off, like the runner (it applies the caps itself). */
const POLICY = { ...DEFAULT_ESCALATION_POLICY, maxNewParentsPerDay: Number.MAX_SAFE_INTEGER, maxNewParentsPerRun: Number.MAX_SAFE_INTEGER };

const TTR: ParsedSla = { breached: false, goalMs: 200 * HOUR, remainingMs: 150 * HOUR, state: "paused", withinCalendarHours: true };

const ROUTING: RoutingRow = {
  channelId: "C08CUMU0F6G",
  extraAckers: [],
  mode: "shadow",
  owners: { em: { displayName: "Saro Deravanesian" }, pm: { displayName: "Prashanth Venkataraman" }, pmManager: { displayName: "Simon Hayhurst" } },
  podName: "Credentialing",
  podOptionId: "12448",
  shadowChannelId: "C0TEST",
};

function ts(key: string, enteredWfpAt: string, overrides: Partial<TsSnapshot> = {}): TsSnapshot {
  return {
    assigneeAccountId: "acc-agent",
    assigneeName: "Agent",
    enteredWfpAt,
    issueTypeId: "10844",
    key,
    links: [{ cpKey: "CP-7", direction: "outward", linkTypeId: "10003", linkTypeName: "Relates" }],
    majorIncident: false,
    podOptionId: "12448",
    priority: "Medium",
    statusCategory: "indeterminate",
    statusId: "10633",
    statusName: "Waiting for product",
    ttr: TTR,
    url: `https://example.atlassian.net/browse/${key}`,
    ...overrides,
  };
}

function cp(statusId: string, statusName: string, overrides: Partial<CpSnapshot> = {}): CpSnapshot {
  return {
    assigneeAccountId: "acc-dev",
    assigneeName: "Dana Developer",
    issueTypeId: "10004",
    issueTypeName: "Bug",
    key: "CP-7",
    podName: "Credentialing",
    podOptionId: "12448",
    priorityName: "High",
    resolutionId: null,
    resolutionName: null,
    statusCategory: statusId === "10131" || statusId === "10571" ? "done" : "indeterminate",
    statusId,
    statusName,
    url: "https://example.atlassian.net/browse/CP-7",
    ...overrides,
  };
}

const OPEN = (): CpSnapshot => cp("3", "In Progress");
const READY = (): CpSnapshot => cp("10131", "Ready for Release");
const RELEASED = (): CpSnapshot => cp("10571", "Released");

/* ------------------------------------------------------------ run simulator */

interface Sim {
  failNext?: string;
  ledger: Map<string, { channel: string; ts: string }>;
  posts: Outbound[];
  record: EscalationRecord | null;
  ts: number;
}

function newSim(): Sim {
  return { ledger: new Map(), posts: [], record: null, ts: 1000 };
}

/* The runner's per-CP loop with Slack and Redis replaced by the ledger: what posted this run. */
function run(
  sim: Sim,
  now: string,
  snapshot: CpSnapshot | null,
  waiting: TsSnapshot[],
  opts: { attached?: CurrentObservation["attachedTsStates"]; episodeFloor?: number; goLiveAt?: string } = {},
): Outbound[] {
  const outcome = snapshot ? cpOutcome(snapshot) : null;
  const group: EscalationGroup | null =
    snapshot && waiting.length > 0 && (outcome === "open" || outcome === "fix_ready") ? { cp: snapshot, outcome, routing: ROUTING, tickets: waiting } : null;
  const planned = group
    ? (planEscalations([group], {
        businessMs: (start, end) => Math.max(0, end - start),
        goLiveAt: opts.goLiveAt,
        isWithinBusinessHours: () => true,
        now,
        policy: POLICY,
      }).planned[0] ?? null)
    : null;
  const attached: CurrentObservation["attachedTsStates"] = {
    ...Object.fromEntries(waiting.map((ticket) => [ticket.key, { inWfp: true, statusCategory: ticket.statusCategory }])),
    ...opts.attached,
  };

  const step = stepEscalation({
    attachedTsStates: attached,
    cp: snapshot,
    cpKey: "CP-7",
    episodeFloor: opts.episodeFloor,
    group,
    now,
    planned,
    policy: POLICY,
    previous: sim.record,
    ticketUrl: (key) => `https://example.atlassian.net/browse/${key}`,
    waitingTsKeys: waiting.map((ticket) => ticket.key),
  });
  if (!step) {
    return [];
  }

  let record = step.record;
  const posted: Outbound[] = [];
  for (const message of step.outbound) {
    if (message.text === null) {
      record = applyEffect(record, message, null, now);
      continue;
    }
    if (message.placement === "thread" && !record.threadTs) {
      break;
    }
    let ref = sim.ledger.get(message.dedupeKey);
    if (!ref) {
      if (sim.failNext === message.dedupeKey) {
        sim.failNext = undefined;
        break;
      }
      sim.ts += 1;
      ref = { channel: "C0TEST", ts: `${sim.ts}.000100` };
      sim.ledger.set(message.dedupeKey, ref);
      posted.push(message);
      sim.posts.push(message);
    }
    record = applyEffect(record, message, ref, now);
  }
  sim.record = record;
  return posted;
}

const kinds = (posted: Outbound[]): string[] => posted.map((message) => `${message.kind}:${message.dedupeKey.split(":").slice(1).join(":")}`);

/* --------------------------------------------------------------------- tests */

function testFullLifecycle(): void {
  console.log("\n--- Test: one thread per CP, from first sight to resolved, each change posted once ---");
  const sim = newSim();
  const ts1 = ts("TS-1", at(-10));
  const ts2 = ts("TS-2", at(30));

  assertEqual(kinds(run(sim, at(0), OPEN(), [ts1])), ["parent:e1:parent"], "first sight opens the thread, nothing due yet (Medium L1 at 45h)");
  assertEqual(sim.record?.threadTs, "1001.000100", "thread remembered");
  assertEqual(sim.record?.announcedTsKeys, ["TS-1"], "the parent announced its tickets");
  assertEqual(kinds(run(sim, at(0.2), OPEN(), [ts1])), [], "a second run says nothing new");

  assertEqual(kinds(run(sim, at(36), OPEN(), [ts1])), ["level:e1:L1"], "L1 once 45h have passed");
  assertEqual(kinds(run(sim, at(36.2), OPEN(), [ts1])), [], "L1 never repeats");

  assertEqual(kinds(run(sim, at(37), OPEN(), [ts1, ts2])), ["tickets:e1:s1:tickets"], "a second ticket joining is announced");
  const joined = sim.posts.at(-1)?.text ?? "";
  assert(joined.includes("TS-2") && joined.includes("2 TS tickets waiting in total"), `joined text: ${joined}`);

  assertEqual(kinds(run(sim, at(38), READY(), [ts1, ts2])), ["state:e1:s2:fix_ready"], "Ready for Release is announced");
  assertEqual(kinds(run(sim, at(70), READY(), [ts1, ts2])), [], "no ladder while the fix waits to ship");

  assertEqual(kinds(run(sim, at(71), OPEN(), [ts1, ts2])), ["state:e1:s3:open"], "rolled back - the ladder resumes, once");
  assert((sim.posts.at(-1)?.text ?? "").includes("moved back to"), "resume text");
  assertEqual(kinds(run(sim, at(72), READY(), [ts1, ts2])), ["state:e1:s4:fix_ready"], "a second fix-ready gets its own key, so it's posted again");

  assertEqual(kinds(run(sim, at(73), RELEASED(), [ts1, ts2])), [], "Released starts the resolve grace silently");
  assertEqual(kinds(run(sim, at(73.2), RELEASED(), [ts1, ts2])), [], "still inside the 30-minute grace");
  assertEqual(kinds(run(sim, at(73.6), RELEASED(), [ts1, ts2])), ["state:e1:s5:resolved"], "resolved after the grace");
  assert((sim.posts.at(-1)?.text ?? "").includes("Released"), "resolved text names the status");
  assertEqual(kinds(run(sim, at(80), RELEASED(), [ts1, ts2])), [], "nothing after resolution");
  assertEqual(sim.record?.state, "resolved", "record ends resolved");
  console.log("PASS");
}

function testFirstSightWithLevelDue(): void {
  console.log("\n--- Test: a CP first seen when L2 is already due posts the parent and only L2 ---");
  const sim = newSim();
  const posted = run(sim, at(0), OPEN(), [ts("TS-1", at(-95))]);
  assertEqual(kinds(posted), ["parent:e1:parent", "level:e1:L2"], "parent + highest due level");
  assertEqual(posted[1]?.placement, "thread", "the level is a thread reply");
  assertEqual(sim.record?.levelSent, 2, "levelSent recorded");
  assertEqual(kinds(run(sim, at(1), OPEN(), [ts("TS-1", at(-95))])), [], "no repeat");
  assertEqual(kinds(run(sim, at(41), OPEN(), [ts("TS-1", at(-95))])), ["level:e1:L3"], "then L3 at 135h");
  console.log("PASS");
}

function testBacklogTimedFromGoLive(): void {
  console.log("\n--- Test: CPs already waiting at go-live are timed from go-live, and their levels still come later ---");
  const sim = newSim();
  const old = ts("TS-1", at(-300));
  assertEqual(kinds(run(sim, at(0), OPEN(), [old], { goLiveAt: at(0) })), ["parent:e1:parent"], "parent only, no burst of levels");
  assert((sim.posts[0]?.text ?? "").includes("since go-live"), "parent says it's timed from go-live");
  assertEqual(kinds(run(sim, at(44), OPEN(), [old], { goLiveAt: at(0) })), [], "not yet 45h since go-live");
  assertEqual(kinds(run(sim, at(46), OPEN(), [old], { goLiveAt: at(0) })), ["level:e1:L1"], "L1 45h after go-live");
  console.log("PASS");
}

function testFixReadyAtFirstSight(): void {
  console.log("\n--- Test: a CP first seen as Ready for Release posts the parent and the fix-ready note ---");
  const sim = newSim();
  assertEqual(kinds(run(sim, at(0), READY(), [ts("TS-1", at(-100))])), ["parent:e1:parent", "state:e1:fix_ready"], "parent + note");
  assertEqual(sim.record?.announcedState, "fix_ready", "fix-ready counted as announced");
  assertEqual(kinds(run(sim, at(1), READY(), [ts("TS-1", at(-100))])), [], "and not announced again");
  console.log("PASS");
}

function testHandBackAndReopen(): void {
  console.log("\n--- Test: tickets leaving ends the thread; coming back opens a new episode and thread ---");
  const sim = newSim();
  const ticket = ts("TS-1", at(-5));
  run(sim, at(0), OPEN(), [ticket]);
  const firstThread = sim.record?.threadTs;

  const left = run(sim, at(2), OPEN(), [], { attached: { "TS-1": { inWfp: false, statusCategory: "indeterminate" } } });
  assertEqual(kinds(left), ["state:e1:s1:handed_back"], "handed back, said once");
  assertEqual(kinds(run(sim, at(3), OPEN(), [], { attached: { "TS-1": { inWfp: false, statusCategory: "indeterminate" } } })), [], "silent after");

  const back = run(sim, at(5), OPEN(), [ts("TS-1", at(4.5))]);
  assertEqual(kinds(back), ["parent:e2:parent"], "a reopen posts a fresh parent under episode 2");
  assert(sim.record?.threadTs !== firstThread, "in a new thread");
  assertEqual(sim.record?.episode, 2, "episode 2");
  console.log("PASS");
}

function testReturnAfterRecordDropped(): void {
  console.log("\n--- Test: a CP back after its finished record was dropped gets a new thread, not a silent replay ---");
  const sim = newSim();
  const ticket = ts("TS-1", at(-10));
  run(sim, at(0), OPEN(), [ticket]);
  run(sim, at(1), RELEASED(), [ticket]);
  run(sim, at(2), RELEASED(), [ticket]);
  assertEqual(sim.record?.state, "resolved", "first episode resolved");

  /* A month later the record is dropped; the 180-day sent ledger still holds CP-7:e1:*. */
  sim.record = null;
  const back = run(sim, at(800), OPEN(), [ts("TS-1", at(799))], { episodeFloor: 1 });
  assertEqual(kinds(back), ["parent:e2:parent"], "numbering continues at episode 2, so the parent really posts");
  /* run() replaced sim.record; TS still narrows it to the null assigned above. */
  assertEqual((sim.record as EscalationRecord | null)?.episode, 2, "episode 2");
  console.log("PASS");
}

function testAckedKeepsLadder(): void {
  console.log("\n--- Test: an acknowledged escalation keeps its ladder and posts nothing for the ack itself ---");
  const sim = newSim();
  const ticket = ts("TS-1", at(-10));
  run(sim, at(0), OPEN(), [ticket]);
  /* What the runner folds in from esc:ack (the ✅ handler already replied in the thread). */
  sim.record = { ...(sim.record as EscalationRecord), ackedAt: at(0.5), ackedBySlackId: "U1", announcedState: "acked", state: "acked" };
  assertEqual(kinds(run(sim, at(1), OPEN(), [ticket])), [], "no message for the ack");
  assertEqual(kinds(run(sim, at(36), OPEN(), [ticket])), ["level:e1:L1"], "L1 still comes");
  assertEqual(sim.record?.state, "acked", "still acked");
  console.log("PASS");
}

function testUnreadableAndRetry(): void {
  console.log("\n--- Test: an unreadable CP changes nothing; a failed post is retried exactly once ---");
  const sim = newSim();
  const ticket = ts("TS-1", at(-10));
  run(sim, at(0), OPEN(), [ticket]);
  const before = JSON.stringify(sim.record);
  assertEqual(kinds(run(sim, at(40), null, [ticket])), [], "nothing posted while Jira can't read the CP");
  const after = { ...(sim.record as EscalationRecord), lastPlan: undefined, updatedAt: undefined };
  const original = { ...(JSON.parse(before) as EscalationRecord), lastPlan: undefined, updatedAt: undefined };
  assertEqual(after, original, "state untouched");

  sim.failNext = "CP-7:e1:L1";
  assertEqual(kinds(run(sim, at(40), OPEN(), [ticket])), [], "Slack refused the L1");
  assertEqual(sim.record?.levelSent, 0, "so it isn't recorded as sent");
  assertEqual(kinds(run(sim, at(40.2), OPEN(), [ticket])), ["level:e1:L1"], "the next run posts it");
  assertEqual(kinds(run(sim, at(40.4), OPEN(), [ticket])), [], "and only once");
  console.log("PASS");
}

function testDecideGuards(): void {
  console.log("\n--- Test: nothing to say without a readable CP or without a plan for a new thread ---");
  const record: EscalationRecord = { cpKey: "CP-7", episode: 1, levelSent: 0, podOptionId: "12448", state: "open", tsKeys: ["TS-1"] };
  const base = { group: null, planned: null, policy: POLICY, record, ticketUrl: (key: string) => key };
  assertEqual(decideThreadUpdates({ ...base, cp: null }), [], "unreadable CP");
  assertEqual(decideThreadUpdates({ ...base, cp: OPEN() }), [], "live but no plan and no thread");
  console.log("PASS");
}

function testAckReactions(): void {
  console.log("\n--- Test: which reactions acknowledge ---");
  assert(isAckReaction("white_check_mark"), "✅");
  assert(isAckReaction("heavy_check_mark"), "✔️");
  assert(isAckReaction("ballot_box_with_check"), "☑️");
  assert(!isAckReaction("+1"), "👍 is not an ack");
  assert(!isAckReaction(undefined), "no reaction");
  console.log("PASS");
}

try {
  testFullLifecycle();
  testFirstSightWithLevelDue();
  testBacklogTimedFromGoLive();
  testFixReadyAtFirstSight();
  testHandBackAndReopen();
  testReturnAfterRecordDropped();
  testAckedKeepsLadder();
  testUnreadableAndRetry();
  testDecideGuards();
  testAckReactions();
  console.log("\nAll escalation runner tests passed.");
  process.exit(0);
} catch (error) {
  console.error("\nEscalation runner test failed:", error);
  process.exit(1);
}
