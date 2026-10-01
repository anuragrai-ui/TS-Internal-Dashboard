import { DEFAULT_ESCALATION_POLICY } from "@/lib/escalation/policy";
import { NO_WFP_ENTRY_REASON, planEscalations } from "@/lib/escalation/plan";

import type { PlanContext } from "@/lib/escalation/plan";
import type { EscalationPolicy } from "@/lib/escalation/policy";
import type {
  CpSnapshot,
  EscalationGroup,
  ParsedSla,
  PersonRef,
  PlanResult,
  RoutingRow,
  TsSnapshot,
} from "@/lib/escalation/types";

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

/* Every test runs against this fixed instant - nothing reads the real clock. */
const NOW = "2026-10-02T16:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const HOUR_MS = 3_600_000;

function hoursBeforeNow(hours: number): string {
  return new Date(NOW_MS - hours * HOUR_MS).toISOString();
}

/* Deterministic stand-ins for businessHours.ts (implemented elsewhere):
   every wall-clock hour counts, and the clock is either inside or outside
   business hours as the test says. */
function allHoursBusinessMs(startMs: number, endMs: number): number {
  return Math.max(0, endMs - startMs);
}

function ctx(overrides: Partial<PlanContext> = {}): PlanContext {
  return {
    businessMs: allHoursBusinessMs,
    isWithinBusinessHours: () => true,
    now: NOW,
    policy: DEFAULT_ESCALATION_POLICY,
    ...overrides,
  };
}

function policyWith(overrides: Partial<EscalationPolicy>): EscalationPolicy {
  return { ...DEFAULT_ESCALATION_POLICY, ...overrides };
}

const PAUSED_TTR: ParsedSla = {
  breached: false,
  goalMs: 100 * HOUR_MS,
  remainingMs: 60 * HOUR_MS,
  state: "paused",
  withinCalendarHours: true,
};

function makeTs(key: string, overrides: Partial<TsSnapshot> = {}): TsSnapshot {
  return {
    assigneeAccountId: "acc-support-1",
    assigneeName: "Support Agent",
    enteredWfpAt: hoursBeforeNow(10),
    issueTypeId: "10844",
    key,
    links: [],
    majorIncident: false,
    podOptionId: "12448",
    priority: "Medium",
    statusCategory: "indeterminate",
    statusId: "10633",
    statusName: "Waiting for product",
    ttr: PAUSED_TTR,
    url: `https://certifyos.atlassian.net/browse/${key}`,
    ...overrides,
  };
}

function makeCp(key: string, overrides: Partial<CpSnapshot> = {}): CpSnapshot {
  return {
    assigneeAccountId: "acc-dev-1",
    assigneeName: "Dana Developer",
    issueTypeId: "10004",
    issueTypeName: "Bug",
    key,
    podName: "Credentialing",
    podOptionId: "12448",
    priorityName: "High",
    resolutionId: null,
    resolutionName: null,
    statusCategory: "indeterminate",
    statusId: "3",
    statusName: "In Progress",
    url: `https://certifyos.atlassian.net/browse/${key}`,
    ...overrides,
  };
}

const EM: PersonRef = { displayName: "Saro Deravanesian", slackUserId: "U0EM00001" };
const PM: PersonRef = { displayName: "Prashanth Venkataraman" };
const PM_MANAGER: PersonRef = { displayName: "Simon Hayhurst", slackUserId: "U0PMM0001" };
const L3_OWNER: PersonRef = { displayName: "Top Owner", slackUserId: "U0TOP0001" };

function makeRouting(overrides: Partial<RoutingRow> = {}): RoutingRow {
  return {
    channelId: "C08CUMU0F6G",
    extraAckers: [],
    mode: "live",
    owners: { em: EM, pm: PM, pmManager: PM_MANAGER },
    podName: "Credentialing",
    podOptionId: "12448",
    ...overrides,
  };
}

function makeGroup(cpKey: string, tickets: TsSnapshot[], overrides: Partial<EscalationGroup> = {}): EscalationGroup {
  return { cp: makeCp(cpKey), outcome: "open", routing: makeRouting(), tickets, ...overrides };
}

function only(result: PlanResult): PlanResult["planned"][number] {
  assertEqual(result.planned.length, 1, "exactly one planned escalation");
  const [escalation] = result.planned;
  if (!escalation) throw new Error("no planned escalation");
  return escalation;
}

function messageOf(escalation: PlanResult["planned"][number], kind: string): PlanResult["planned"][number]["messages"][number] {
  const message = escalation.messages.find((candidate) => candidate.kind === kind);
  if (!message) throw new Error(`${escalation.cpKey} has no ${kind} message`);
  return message;
}

function allText(result: PlanResult): string {
  return result.planned.flatMap((escalation) => escalation.messages.map((message) => message.text)).join("\n");
}

// --- priority ---

function testPriorityBumpIsSingleStepWithThreeReasons(): void {
  console.log("\n--- Test: three bump reasons still bump priority exactly one step ---");

  const breachedTtr: ParsedSla = { ...PAUSED_TTR, breached: true, remainingMs: -5 * HOUR_MS };
  const tickets = [
    makeTs("TS-1", { priority: "Medium", ttr: breachedTtr }),
    makeTs("TS-2", { majorIncident: true, priority: "Medium" }),
    makeTs("TS-3", { priority: "Low" }),
  ];

  const escalation = only(planEscalations([makeGroup("CP-100", tickets)], ctx()));

  assertEqual(escalation.effectivePriority, "High", "Medium + 3 reasons should be High, not Critical");
  assertEqual(escalation.priorityBumpReasons.length, 3, "all three reasons recorded");
  assert(escalation.priorityBumpReasons.some((reason) => reason.startsWith("3 TS tickets")), "ticket-count reason recorded");
  assert(escalation.priorityBumpReasons.some((reason) => reason.includes("TTR breached on TS-1")), "breach reason names TS-1");
  assert(escalation.priorityBumpReasons.some((reason) => reason.includes("major incident on TS-2")), "major-incident reason names TS-2");

  const parent = messageOf(escalation, "parent");
  assert(parent.text.includes("High (bumped from Medium:"), "parent shows the bump and its base priority");

  const critical = only(
    planEscalations([makeGroup("CP-101", [makeTs("TS-9", { majorIncident: true, priority: "Critical" })])], ctx()),
  );
  assertEqual(critical.effectivePriority, "Critical", "Critical is the ceiling");
  assertEqual(critical.priorityBumpReasons, ["major incident on TS-9"], "a capped bump still records its reason");

  /* The cap must not swallow the reason: it is why engineering should care. */
  const criticalParent = messageOf(critical, "parent");
  assert(
    criticalParent.text.includes("*Priority:* Critical (already the highest priority; also: major incident on TS-9)"),
    "parent shows the reason even when Critical can't be bumped",
  );
  assert(!criticalParent.text.includes("bumped from"), "a capped priority is not described as bumped");

  console.log("PASS: one step total, every reason recorded and shown, Critical caps the bump.");
}

function testFrozenTtrRemainingBumpsAtFraction(): void {
  console.log("\n--- Test: frozen (paused) TTR remaining bumps at <= 25% of goal, not above ---");

  const atFraction = makeTs("TS-1", { ttr: { ...PAUSED_TTR, remainingMs: 25 * HOUR_MS } });
  const aboveFraction = makeTs("TS-2", { ttr: { ...PAUSED_TTR, remainingMs: 26 * HOUR_MS } });
  const noGoal = makeTs("TS-3", { ttr: { ...PAUSED_TTR, goalMs: null, remainingMs: 0 } });

  const bumped = only(planEscalations([makeGroup("CP-1", [atFraction])], ctx()));
  assertEqual(bumped.effectivePriority, "High", "exactly 25% remaining (paused) bumps Medium to High");
  assert(bumped.priorityBumpReasons[0]?.includes("25% remaining on TS-1") === true, "reason names the ticket");

  const notBumped = only(planEscalations([makeGroup("CP-2", [aboveFraction])], ctx()));
  assertEqual(notBumped.effectivePriority, "Medium", "26% remaining does not bump");
  assertEqual(notBumped.priorityBumpReasons, [], "no reasons when nothing applies");

  const goalless = only(planEscalations([makeGroup("CP-3", [noGoal])], ctx()));
  assertEqual(goalless.effectivePriority, "Medium", "a cycle without a goal never bumps on remaining");

  console.log("PASS: the fraction rule uses the frozen remaining and is inclusive at the boundary.");
}

function testNullPrioritiesCountAsMedium(): void {
  console.log("\n--- Test: null ticket priorities count as Medium ---");

  const allNull = only(planEscalations([makeGroup("CP-1", [makeTs("TS-1", { priority: null })])], ctx()));
  assertEqual(allNull.effectivePriority, "Medium", "all-null is Medium");

  const nullAndLow = only(
    planEscalations([makeGroup("CP-2", [makeTs("TS-1", { priority: null }), makeTs("TS-2", { priority: "Low" })])], ctx()),
  );
  assertEqual(nullAndLow.effectivePriority, "Medium", "null outranks Low");

  const nullAndHigh = only(
    planEscalations([makeGroup("CP-3", [makeTs("TS-1", { priority: null }), makeTs("TS-2", { priority: "High" })])], ctx()),
  );
  assertEqual(nullAndHigh.effectivePriority, "High", "a real High still wins");

  console.log("PASS: missing priority is read as the JSM default, never dropped.");
}

// --- ladder ---

function testLadderLevelsAtExactThresholds(): void {
  console.log("\n--- Test: ladder levels flip exactly at their thresholds (>=) ---");

  /* Medium ladder: L1 45h, L2 90h, L3 135h. */
  const at = (hours: number) =>
    only(planEscalations([makeGroup("CP-1", [makeTs("TS-1", { enteredWfpAt: hoursBeforeNow(hours) })])], ctx()));

  const justBefore = planEscalations(
    [makeGroup("CP-1", [makeTs("TS-1", { enteredWfpAt: new Date(NOW_MS - 45 * HOUR_MS + 1).toISOString() })])],
    ctx(),
  ).planned[0];
  assertEqual(justBefore?.levelDue, 0, "1ms short of 45h is not L1 yet");
  assertEqual(justBefore?.nextLevel?.level, 1, "next is L1");

  const l1 = at(45);
  assertEqual(l1.engineeringWaitBh, 45, "wait is 45 business hours");
  assertEqual(l1.levelDue, 1, "45h is L1");
  assertEqual(l1.nextLevel, { dueInBh: 45, level: 2 }, "L2 due in 45h");

  const l2 = at(90);
  assertEqual(l2.levelDue, 2, "90h is L2");
  assertEqual(l2.nextLevel, { dueInBh: 45, level: 3 }, "L3 due in 45h");

  const l3 = at(135);
  assertEqual(l3.levelDue, 3, "135h is L3");
  assertEqual(l3.nextLevel, null, "nothing after L3");

  const fresh = at(0);
  assertEqual(fresh.levelDue, 0, "a fresh wait is level 0");
  assertEqual(fresh.nextLevel, { dueInBh: 45, level: 1 }, "L1 due in the full 45h");
  assertEqual(fresh.messages.map((message) => message.kind), ["parent"], "level 0 posts only the parent");

  console.log("PASS: thresholds are inclusive and nextLevel counts down to the next one.");
}

function testLadderUsesBumpedPriority(): void {
  console.log("\n--- Test: the ladder is read at the EFFECTIVE (bumped) priority, not the base ---");

  /* Same 30h wait on Medium tickets. Medium's L1 is 45h, High's is 27h, so
     only the bumped group may have L1 due. */
  const mediumAt30 = (key: string) => makeTs(key, { enteredWfpAt: hoursBeforeNow(30), priority: "Medium" });

  const bumped = only(planEscalations([makeGroup("CP-1", [mediumAt30("TS-1"), mediumAt30("TS-2"), mediumAt30("TS-3")])], ctx()));
  assertEqual(bumped.effectivePriority, "High", "3 attached Medium tickets bump to High");
  assertEqual(bumped.engineeringWaitBh, 30, "30 business hours waited");
  assertEqual(bumped.levelDue, 1, "High L1 (27h) is due at 30h");
  assertEqual(bumped.nextLevel, { dueInBh: 15, level: 2 }, "High L2 (45h) is 15h away");
  assertEqual(bumped.messages.map((message) => message.kind), ["parent", "L1"], "the bumped ladder posts L1");
  assert(messageOf(bumped, "L1").text.includes("(High L1 at 27h)"), "L1 text quotes the High threshold");

  const unbumped = only(planEscalations([makeGroup("CP-2", [mediumAt30("TS-1"), mediumAt30("TS-2")])], ctx()));
  assertEqual(unbumped.effectivePriority, "Medium", "2 tickets do not bump");
  assertEqual(unbumped.levelDue, 0, "Medium L1 (45h) is not due at 30h");
  assertEqual(unbumped.nextLevel, { dueInBh: 15, level: 1 }, "Medium L1 is 15h away");
  assertEqual(unbumped.messages.map((message) => message.kind), ["parent"], "no level message without the bump");

  console.log("PASS: a bump moves the CP onto the faster ladder.");
}

function testOnlyHighestDueLevelMessage(): void {
  console.log("\n--- Test: first sight posts the parent plus ONLY the highest due level ---");

  const at = (hours: number) =>
    only(planEscalations([makeGroup("CP-7", [makeTs("TS-1", { enteredWfpAt: hoursBeforeNow(hours) })])], ctx()));

  const l1 = at(50);
  assertEqual(l1.messages.map((message) => message.kind), ["parent", "L1"], "L1 case");
  assertEqual(l1.messages.map((message) => message.dedupeKey), ["CP-7:e1:parent", "CP-7:e1:L1"], "L1 dedupe keys");
  assertEqual(messageOf(l1, "L1").broadcast, false, "L1 is not broadcast");
  assertEqual(messageOf(l1, "parent").broadcast, false, "parent is never broadcast");

  const l2 = at(100);
  assertEqual(l2.messages.map((message) => message.kind), ["parent", "L2"], "L2 case skips L1");
  assertEqual(messageOf(l2, "L2").dedupeKey, "CP-7:e1:L2", "L2 dedupe key");
  assertEqual(messageOf(l2, "L2").broadcast, true, "L2 is broadcast");

  const l3 = at(500);
  assertEqual(l3.messages.map((message) => message.kind), ["parent", "L3"], "L3 case skips L1 and L2");
  assertEqual(messageOf(l3, "L3").dedupeKey, "CP-7:e1:L3", "L3 dedupe key");
  assertEqual(messageOf(l3, "L3").broadcast, true, "L3 is broadcast");

  console.log("PASS: one level message at most, broadcast only from L2 up.");
}

function testFixReadyHasNoLadder(): void {
  console.log("\n--- Test: fix_ready stops the ladder - parent + fix_ready only ---");

  const group = makeGroup("CP-55", [makeTs("TS-1", { enteredWfpAt: hoursBeforeNow(500) })], {
    cp: makeCp("CP-55", { statusCategory: "done", statusId: "10131", statusName: "Ready for Release" }),
    outcome: "fix_ready",
  });

  const escalation = only(planEscalations([group], ctx()));

  assertEqual(escalation.state, "fix_ready", "state carried through");
  assertEqual(escalation.levelDue, 0, "no level is due on a fix-ready CP");
  assertEqual(escalation.nextLevel, null, "no next level either");
  assertEqual(escalation.messages.map((message) => message.kind), ["parent", "fix_ready"], "parent + fix_ready");
  assertEqual(messageOf(escalation, "fix_ready").dedupeKey, "CP-55:e1:fix_ready", "fix_ready dedupe key");
  assert(messageOf(escalation, "fix_ready").text.includes("Ready for Release"), "fix_ready names the status");
  assert(!allText({ heldForQuietHours: [], planned: [escalation], rateLimited: [] }).includes("L1 ("), "no ladder text at all");

  console.log("PASS: a fix waiting to ship never climbs the ladder, however long it has waited.");
}

function testNoWfpEntryStartsTimerNow(): void {
  console.log("\n--- Test: no WfP entry on any ticket -> timer starts now, still planned, flagged ---");

  const escalation = only(planEscalations([makeGroup("CP-1", [makeTs("TS-1", { enteredWfpAt: null })])], ctx()));

  assertEqual(escalation.waitT0, NOW, "waitT0 falls back to now");
  assertEqual(escalation.engineeringWaitBh, 0, "nothing waited yet");
  assert(escalation.priorityBumpReasons.includes(NO_WFP_ENTRY_REASON), "flagged with the exact reason");
  assertEqual(NO_WFP_ENTRY_REASON, "no WfP entry time - timer starts now", "reason text is the agreed one");
  assertEqual(escalation.effectivePriority, "Medium", "the note is not itself a bump");
  assertEqual(escalation.messages.map((message) => message.kind), ["parent"], "still gets a parent");

  const mixed = only(
    planEscalations(
      [makeGroup("CP-2", [makeTs("TS-1", { enteredWfpAt: null }), makeTs("TS-2", { enteredWfpAt: hoursBeforeNow(5) })])],
      ctx(),
    ),
  );
  assertEqual(mixed.waitT0, hoursBeforeNow(5), "nulls are ignored when any ticket has an entry time");
  assertEqual(mixed.priorityBumpReasons, [], "no flag when an entry time exists");

  console.log("PASS: a missing changelog entry never hides a waiting CP.");
}

// --- backlog ---

function testBacklogDigestAndGoLiveTimers(): void {
  console.log("\n--- Test: go-live backlog - timers start at go-live, one digest, parents only ---");

  const goLiveAt = hoursBeforeNow(2);
  const groups = [
    makeGroup("CP-10", [makeTs("TS-1", { enteredWfpAt: hoursBeforeNow(300) })]),
    makeGroup("CP-20", [makeTs("TS-2", { enteredWfpAt: hoursBeforeNow(1), priority: "Critical" })]),
    makeGroup("CP-30", [makeTs("TS-3", { enteredWfpAt: hoursBeforeNow(400), priority: "High" })]),
  ];

  const result = planEscalations(groups, ctx({ goLiveAt, policy: policyWith({ maxNewParentsPerRun: 10 }) }));

  assertEqual(result.planned.map((escalation) => escalation.cpKey), ["CP-20", "CP-30", "CP-10"], "priority order");

  const [fresh, firstBacklog, secondBacklog] = result.planned;
  if (!fresh || !firstBacklog || !secondBacklog) throw new Error("expected three escalations");

  assertEqual(fresh.waitT0, hoursBeforeNow(1), "post-go-live CP keeps its own WfP entry");
  assertEqual(fresh.messages.map((message) => message.kind), ["parent"], "post-go-live CP: parent only (nothing due)");

  assertEqual(firstBacklog.waitT0, goLiveAt, "backlog timer starts at go-live");
  assertEqual(firstBacklog.engineeringWaitBh, 2, "backlog wait counts from go-live");
  assertEqual(firstBacklog.levelDue, 0, "400h of history does not make a backlog CP L3");
  assertEqual(firstBacklog.messages.map((message) => message.kind), ["backlog_digest", "parent"], "digest rides on the first backlog CP");

  const digest = messageOf(firstBacklog, "backlog_digest");
  assertEqual(digest.dedupeKey, `backlog_digest:${goLiveAt}`, "digest dedupe key");
  assert(digest.text.includes("CP-30") && digest.text.includes("CP-10"), "digest lists every backlog CP");
  assert(!digest.text.includes("CP-20"), "digest leaves out post-go-live CPs");

  assertEqual(secondBacklog.messages.map((message) => message.kind), ["parent"], "other backlog CPs: parent only");
  assert(messageOf(firstBacklog, "parent").text.includes("400h waited"), "each TS line still shows its real wait");
  assert(messageOf(firstBacklog, "parent").text.includes("since go-live"), "parent explains the go-live timer");

  /* Even a backlog CP whose go-live timer has already reached a level gets
     only its parent on first sight - no burst of level pings at go-live. */
  const lateGoLive = only(
    planEscalations(
      [makeGroup("CP-40", [makeTs("TS-4", { enteredWfpAt: hoursBeforeNow(100), priority: "Critical" })])],
      ctx({ goLiveAt: hoursBeforeNow(5) }),
    ),
  );
  assertEqual(lateGoLive.levelDue, 1, "Critical 5h after go-live is L1 due");
  assertEqual(lateGoLive.messages.map((message) => message.kind), ["backlog_digest", "parent"], "but backlog posts no level message");

  console.log("PASS: backlog CPs are timed from go-live and announced once.");
}

function testBacklogFixReadyStillPostsFixReady(): void {
  console.log("\n--- Test: a fix-ready CP from the backlog still gets its fix_ready message ---");

  const goLiveAt = hoursBeforeNow(2);
  const group = makeGroup("CP-60", [makeTs("TS-1", { enteredWfpAt: hoursBeforeNow(300) })], {
    cp: makeCp("CP-60", { statusCategory: "done", statusId: "10131", statusName: "Ready for Release" }),
    outcome: "fix_ready",
  });

  const escalation = only(planEscalations([group], ctx({ goLiveAt })));

  assertEqual(escalation.waitT0, goLiveAt, "still a backlog escalation timed from go-live");
  assertEqual(escalation.levelDue, 0, "no level on a fix-ready CP");
  assertEqual(escalation.nextLevel, null, "no next level");
  /* Backlog only suppresses ladder levels; fix_ready is not one. */
  assertEqual(
    escalation.messages.map((message) => message.kind),
    ["backlog_digest", "parent", "fix_ready"],
    "digest + parent + fix_ready",
  );
  assertEqual(messageOf(escalation, "fix_ready").dedupeKey, "CP-60:e1:fix_ready", "fix_ready dedupe key");

  console.log("PASS: go-live never hides that a fix is waiting to ship.");
}

function testBacklogDigestWaitsWhenAllBacklogParentsAreCapped(): void {
  console.log("\n--- Test: the digest never rides on a rate-limited (message-less) escalation ---");

  const goLiveAt = hoursBeforeNow(2);
  const groups = [
    makeGroup("CP-1", [makeTs("TS-1", { enteredWfpAt: hoursBeforeNow(1), priority: "Critical" })]),
    makeGroup("CP-2", [makeTs("TS-2", { enteredWfpAt: hoursBeforeNow(50), priority: "Low" })]),
  ];

  const result = planEscalations(groups, ctx({ goLiveAt, policy: policyWith({ maxNewParentsPerRun: 1 }) }));

  assertEqual(result.rateLimited, ["CP-2"], "the backlog CP is capped");
  assertEqual(
    result.planned.flatMap((escalation) => escalation.messages.map((message) => message.kind)),
    ["parent"],
    "no digest this run - it goes out with the first backlog parent",
  );

  console.log("PASS: the digest is deferred with the backlog it describes.");
}

// --- rate limits & quiet hours ---

function testRateLimitingByPriorityAndDailyRemaining(): void {
  console.log("\n--- Test: new parents are capped per run and per day, in priority order ---");

  const groups = [
    makeGroup("CP-1", [makeTs("TS-1", { priority: "Low" })]),
    makeGroup("CP-2", [makeTs("TS-2", { enteredWfpAt: hoursBeforeNow(5), priority: "High" })]),
    makeGroup("CP-3", [makeTs("TS-3", { priority: "Critical" })]),
    makeGroup("CP-4", [makeTs("TS-4", { enteredWfpAt: hoursBeforeNow(20), priority: "High" })]),
    makeGroup("CP-5", [makeTs("TS-5", { priority: "Medium" })]),
  ];

  const perRun = planEscalations(groups, ctx());
  assertEqual(perRun.planned.map((escalation) => escalation.cpKey), ["CP-3", "CP-4", "CP-2", "CP-5", "CP-1"], "priority, then wait");
  assertEqual(perRun.rateLimited, ["CP-5", "CP-1"], "maxNewParentsPerRun = 3 caps the rest");
  assertEqual(
    perRun.planned.map((escalation) => escalation.messages.length > 0),
    [true, true, true, false, false],
    "rate-limited escalations carry no messages",
  );

  const capped = perRun.planned.find((escalation) => escalation.cpKey === "CP-5");
  assertEqual(capped?.effectivePriority, "Medium", "capped escalations keep their computed fields");
  assertEqual(capped?.engineeringWaitBh, 10, "capped escalations keep their wait");

  const nearDailyCap = planEscalations(groups, ctx({ newParentsPostedToday: 9 }));
  assertEqual(nearDailyCap.rateLimited, ["CP-4", "CP-2", "CP-5", "CP-1"], "only one left today (10 - 9)");

  const overDailyCap = planEscalations(groups, ctx({ newParentsPostedToday: 12 }));
  assertEqual(overDailyCap.rateLimited.length, 5, "past the daily cap nothing new posts");
  assertEqual(overDailyCap.planned.flatMap((escalation) => escalation.messages), [], "no messages at all");

  console.log("PASS: caps take the most urgent CPs first and never go negative.");
}

function testQuietHoursHoldNonCriticalOnly(): void {
  console.log("\n--- Test: quiet hours hold non-Critical messages but never Critical ---");

  const groups = [
    makeGroup("CP-1", [makeTs("TS-1", { priority: "Critical" })]),
    makeGroup("CP-2", [makeTs("TS-2", { priority: "High" })]),
    makeGroup("CP-3", [makeTs("TS-3", { priority: "Low" })]),
    makeGroup("CP-4", [makeTs("TS-4", { priority: "Low" })]),
  ];

  const night = planEscalations(groups, ctx({ isWithinBusinessHours: () => false }));
  assertEqual(night.heldForQuietHours, ["CP-2", "CP-3"], "High and Low held; capped CP-4 has nothing to hold");
  assert(
    night.planned.slice(0, 3).every((escalation) => escalation.messages.length > 0),
    "held escalations still have their messages planned",
  );

  const day = planEscalations(groups, ctx({ isWithinBusinessHours: () => true }));
  assertEqual(day.heldForQuietHours, [], "nothing held inside business hours");

  console.log("PASS: quiet hours delay delivery, not planning, and Critical goes straight out.");
}

// --- mentions & text safety ---

function testMentionRules(): void {
  console.log("\n--- Test: mention ladder - parent EM+PM, L1 EM+PM, L2 +PM Manager, L3 +L3 owner if set ---");

  const at = (hours: number, routing: RoutingRow = makeRouting()) =>
    only(
      planEscalations(
        [makeGroup("CP-9", [makeTs("TS-1", { enteredWfpAt: hoursBeforeNow(hours) })], { routing })],
        ctx(),
      ),
    );
  const names = (people: PersonRef[]) => people.map((person) => person.displayName);

  const l1 = at(50);
  const parent = messageOf(l1, "parent");
  assertEqual(names(parent.mentions), [EM.displayName, PM.displayName], "parent mentions EM and PM");
  assert(parent.text.includes("*CP assignee:* Dana Developer"), "assignee shown as plain text");
  assert(!parent.text.includes("@Dana"), "assignee is not rendered as a mention");
  assert(parent.text.includes("<@U0EM00001>"), "verified EM is a real mention");
  assert(parent.text.includes("@Prashanth Venkataraman (unverified)"), "unverified PM is visibly plain text");
  assertEqual(names(messageOf(l1, "L1").mentions), [EM.displayName, PM.displayName], "L1 re-mentions EM+PM");

  const l2 = at(100);
  assertEqual(names(messageOf(l2, "L2").mentions), [EM.displayName, PM.displayName, PM_MANAGER.displayName], "L2 adds the PM Manager");
  assert(messageOf(l2, "L2").text.includes("<@U0PMM0001>"), "L2 text tags the PM Manager");

  const l3Unset = at(500);
  const unsetMessage = messageOf(l3Unset, "L3");
  assertEqual(names(unsetMessage.mentions), [EM.displayName, PM.displayName, PM_MANAGER.displayName], "unset L3 owner adds nobody");
  assert(!unsetMessage.text.includes("<@U0TOP0001>"), "no L3 mention when unset");
  assert(unsetMessage.text.includes("No L3 owner is configured"), "L3 text says the owner is missing");

  const l3Set = at(500, makeRouting({ owners: { em: EM, l3: L3_OWNER, pm: PM, pmManager: PM_MANAGER } }));
  assertEqual(
    names(messageOf(l3Set, "L3").mentions),
    [EM.displayName, PM.displayName, PM_MANAGER.displayName, L3_OWNER.displayName],
    "configured L3 owner is added",
  );

  /* The assignee only becomes a mention when routing data already holds a
     verified Slack id for that exact Jira account. */
  const verifiedAssignee: PersonRef = { displayName: "Dana Developer", jiraAccountId: "acc-dev-1", slackUserId: "U0DEV0001" };
  const withAssignee = at(1, makeRouting({ extraAckers: [verifiedAssignee] }));
  assertEqual(
    names(messageOf(withAssignee, "parent").mentions),
    ["Dana Developer", EM.displayName, PM.displayName],
    "verified assignee is mentioned on the parent",
  );
  assert(messageOf(withAssignee, "parent").text.includes("*CP assignee:* <@U0DEV0001>"), "and rendered as a mention");

  /* A Slack id the renderer refuses must not survive in mentions[] either,
     or a sender tagging from mentions[] would get the unsafe value back. */
  const unsafeEm: PersonRef = { displayName: "x", jiraAccountId: "acc-em-x", slackUserId: "U123|<!here>" };
  const unsafe = at(50, makeRouting({ owners: { em: unsafeEm, pm: PM, pmManager: PM_MANAGER } }));
  const unsafeParent = messageOf(unsafe, "parent");
  const unsafeL1 = messageOf(unsafe, "L1");
  assert(unsafeParent.text.includes("@x (unverified)"), "text renders the unsafe id as unverified");
  assertEqual(unsafeParent.mentions[0], { displayName: "x", jiraAccountId: "acc-em-x" }, "parent mention drops the unsafe id, keeps the rest");
  assertEqual(unsafeL1.mentions[0], { displayName: "x", jiraAccountId: "acc-em-x" }, "L1 mention drops it too");
  assertEqual(messageOf(l2, "L2").mentions[2], PM_MANAGER, "a verified id is kept as is");

  console.log("PASS: each level adds one owner, and only verified ids become real mentions.");
}

function testTextNeverLeaksOrPagesTheChannel(): void {
  console.log("\n--- Test: no @channel/@here and no summaries, descriptions, reporters or customers ---");

  /* Extra fields a careless snapshot builder might add - none may render. */
  const secrets = {
    customerName: "SECRET-CUSTOMER-ACME",
    description: "SECRET-DESCRIPTION-TEXT",
    reporterName: "SECRET-REPORTER-NAME",
    summary: "SECRET-SUMMARY-TEXT",
  };
  const leakyTs = Object.assign(makeTs("TS-1", { enteredWfpAt: hoursBeforeNow(400) }), secrets);
  const leakyCp = Object.assign(makeCp("CP-1", { statusName: "<!here> In Progress" }), secrets);
  const hostileRouting = makeRouting({
    owners: {
      em: { displayName: "here" },
      l3: { displayName: "channel", slackUserId: "!channel" },
      pm: { displayName: "<!channel>" },
      pmManager: { displayName: "everyone" },
    },
  });

  const result = planEscalations(
    [
      makeGroup("CP-1", [leakyTs], { cp: leakyCp, routing: hostileRouting }),
      makeGroup("CP-2", [makeTs("TS-2")], {
        cp: Object.assign(makeCp("CP-2", { statusId: "10131", statusName: "Ready for Release" }), secrets),
        outcome: "fix_ready",
      }),
      makeGroup("CP-3", [makeTs("TS-3", { enteredWfpAt: hoursBeforeNow(500) })]),
    ],
    ctx({ goLiveAt: hoursBeforeNow(450) }),
  );

  const text = allText(result);
  const kinds = result.planned.flatMap((escalation) => escalation.messages.map((message) => message.kind)).sort();
  assertEqual(kinds, ["L3", "backlog_digest", "fix_ready", "parent", "parent", "parent"], "every message kind is exercised");

  for (const forbidden of ["@channel", "@here", "@everyone", "<!channel>", "<!here>", "<!everyone>", "<@!channel>"]) {
    assert(!text.toLowerCase().includes(forbidden), `text must never contain ${forbidden}`);
  }

  for (const secret of Object.values(secrets)) {
    assert(!text.includes(secret), `text must never contain ${secret}`);
  }

  assert(text.includes("&lt;!here&gt; In Progress"), "Jira-sourced text is escaped, not interpreted");

  const mentionIds = result.planned.flatMap((escalation) =>
    escalation.messages.flatMap((message) => message.mentions.map((person) => person.slackUserId)),
  );
  assert(
    mentionIds.every((id) => id === undefined || /^[UW][A-Z0-9]{2,}$/.test(id)),
    `mentions[] only ever carry verified Slack ids (got ${JSON.stringify(mentionIds)})`,
  );

  console.log("PASS: hostile names and extra snapshot fields never reach Slack text or mentions.");
}

function testParentTruncatesTsKeysAtTen(): void {
  console.log("\n--- Test: parent lists at most 10 TS keys, then +N more ---");

  const tickets = Array.from({ length: 13 }, (_, index) =>
    makeTs(`TS-${index + 1}`, { enteredWfpAt: hoursBeforeNow(index + 1) }),
  );

  const escalation = only(planEscalations([makeGroup("CP-1", tickets)], ctx()));
  const parent = messageOf(escalation, "parent");
  const linkedKeys = parent.text.match(/<https:\/\/certifyos\.atlassian\.net\/browse\/TS-\d+\|TS-\d+>/g) ?? [];

  assertEqual(linkedKeys.length, 10, "exactly ten TS links");
  assert(parent.text.includes("• +3 more"), "remaining count shown");
  assert(parent.text.includes("|TS-13>") && !parent.text.includes("|TS-1>"), "longest waits are listed first");
  assert(parent.text.includes("*Waiting TS tickets (13)"), "header still counts every ticket");
  assert(parent.text.includes("TTR paused, 60h left"), "TTR chip shows the frozen remaining");
  assertEqual(escalation.tsKeys.length, 13, "the plan itself keeps every TS key");

  console.log("PASS: long ticket lists stay readable without losing the count.");
}

function testTtrChips(): void {
  console.log("\n--- Test: TTR chips - paused / breached / no SLA ---");

  const tickets = [
    makeTs("TS-1", { enteredWfpAt: hoursBeforeNow(3), ttr: { ...PAUSED_TTR, remainingMs: 4.5 * HOUR_MS } }),
    makeTs("TS-2", { enteredWfpAt: hoursBeforeNow(2), ttr: { ...PAUSED_TTR, breached: true, remainingMs: -HOUR_MS } }),
    makeTs("TS-3", {
      enteredWfpAt: hoursBeforeNow(1),
      ttr: { breached: false, goalMs: null, remainingMs: null, state: "none", withinCalendarHours: null },
    }),
  ];

  const parent = messageOf(only(planEscalations([makeGroup("CP-1", tickets)], ctx())), "parent");

  assert(parent.text.includes("|TS-1> - 3h waited - TTR paused, 4.5h left"), "paused chip");
  assert(parent.text.includes("|TS-2> - 2h waited - TTR breached"), "breached chip");
  assert(parent.text.includes("|TS-3> - 1h waited - no SLA"), "no-SLA chip");

  console.log("PASS: each TS line carries its own wait and TTR state.");
}

function testChannelFollowsRoutingMode(): void {
  console.log("\n--- Test: channelId is where posting is allowed under the routing mode ---");

  const channelFor = (routing: RoutingRow) =>
    only(planEscalations([makeGroup("CP-1", [makeTs("TS-1")], { routing })], ctx())).channelId;

  assertEqual(channelFor(makeRouting({ mode: "live" })), "C08CUMU0F6G", "live posts to the pod channel");
  assertEqual(channelFor(makeRouting({ mode: "shadow", shadowChannelId: "CSHADOW01" })), "CSHADOW01", "shadow posts to the shadow channel");
  assertEqual(channelFor(makeRouting({ mode: "observe" })), null, "observe posts nowhere");

  console.log("PASS: a non-null channel always means posting there is allowed.");
}

function expectThrow(fn: () => unknown, pattern: RegExp, label: string): void {
  try {
    fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert(pattern.test(message), `${label}: error "${message}" should match ${pattern}`);
    return;
  }
  throw new Error(`${label}: expected a throw`);
}

function testOneEscalationPerCpKey(): void {
  console.log("\n--- Test: repeated CP keys merge into one escalation; conflicting repeats throw ---");

  const ts = (key: string) => makeTs(key, { enteredWfpAt: hoursBeforeNow(10) });
  const groups = () => [
    makeGroup("CP-3", [ts("TS-1"), ts("TS-2")]),
    makeGroup("CP-4", [makeTs("TS-9", { priority: "Critical" })]),
    makeGroup("CP-3", [ts("TS-2"), ts("TS-3")]),
  ];

  /* Before the fix this produced rateLimited ["CP-3", "CP-3"]. */
  const capped = planEscalations(groups(), ctx({ policy: policyWith({ maxNewParentsPerRun: 1 }) }));
  assertEqual(capped.planned.map((escalation) => escalation.cpKey), ["CP-4", "CP-3"], "one escalation per CP key");
  assertEqual(capped.rateLimited, ["CP-3"], "a repeated key is rate-limited once");

  const merged = planEscalations(groups(), ctx({ policy: policyWith({ maxNewParentsPerRun: 10 }) }));
  const cp3 = merged.planned.find((escalation) => escalation.cpKey === "CP-3");
  assertEqual(cp3?.tsKeys, ["TS-1", "TS-2", "TS-3"], "tickets are unioned by TS key");
  assertEqual(cp3?.effectivePriority, "High", "the union (3 tickets) drives the attached-ticket bump");
  const dedupeKeys = merged.planned.flatMap((escalation) => escalation.messages.map((message) => message.dedupeKey));
  assertEqual(dedupeKeys.length, new Set(dedupeKeys).size, "no dedupe key is planned twice");
  assertEqual(JSON.stringify(planEscalations(groups().reverse(), ctx({ policy: policyWith({ maxNewParentsPerRun: 10 }) }))), JSON.stringify(merged), "merge is order-independent");

  /* A TS key repeated inside one group must not count twice toward the bump. */
  const repeatedTs = only(planEscalations([makeGroup("CP-5", [ts("TS-1"), ts("TS-1"), ts("TS-2")])], ctx()));
  assertEqual(repeatedTs.tsKeys, ["TS-1", "TS-2"], "a repeated TS key collapses");
  assertEqual(repeatedTs.effectivePriority, "Medium", "2 distinct tickets do not bump");

  /* Two different reads of the same CP: no safe way to pick one. */
  expectThrow(
    () =>
      planEscalations(
        [
          makeGroup("CP-3", [ts("TS-1")]),
          makeGroup("CP-3", [ts("TS-2")], {
            cp: makeCp("CP-3", { statusCategory: "done", statusId: "10131", statusName: "Ready for Release" }),
            outcome: "fix_ready",
          }),
        ],
        ctx(),
      ),
    /conflicting escalation groups for CP-3/,
    "conflicting CP snapshot/outcome",
  );
  expectThrow(
    () => planEscalations([makeGroup("CP-3", [ts("TS-1")]), makeGroup("CP-3", [ts("TS-2")], { routing: makeRouting({ channelId: "COTHER001" }) })], ctx()),
    /conflicting escalation groups for CP-3/,
    "conflicting routing",
  );
  expectThrow(
    () => planEscalations([makeGroup("CP-3", [ts("TS-1")]), makeGroup("CP-3", [makeTs("TS-1", { enteredWfpAt: hoursBeforeNow(99) })])], ctx()),
    /conflicting copies of TS-1 under CP-3/,
    "conflicting TS copies",
  );

  console.log("PASS: the planner enforces one escalation per CP key.");
}

function testDeterministicOrder(): void {
  console.log("\n--- Test: output is deterministic regardless of input order ---");

  const build = () => [
    makeGroup("CP-10", [makeTs("TS-1")]),
    makeGroup("CP-9", [makeTs("TS-2")]),
    makeGroup("CP-100", [makeTs("TS-3")]),
    makeGroup("CP-2", [makeTs("TS-5"), makeTs("TS-4")]),
  ];
  const policy = policyWith({ maxNewParentsPerRun: 10 });

  const forward = planEscalations(build(), ctx({ policy }));
  const reversed = planEscalations(build().reverse(), ctx({ policy }));

  assertEqual(forward.planned.map((escalation) => escalation.cpKey), ["CP-2", "CP-9", "CP-10", "CP-100"], "ties break on natural key order");
  assertEqual(JSON.stringify(reversed), JSON.stringify(forward), "same plan for shuffled input");
  assertEqual(forward.planned[0]?.tsKeys, ["TS-4", "TS-5"], "tsKeys are naturally sorted");

  console.log("PASS: same input, same plan, byte for byte.");
}

function main(): void {
  try {
    testPriorityBumpIsSingleStepWithThreeReasons();
    testFrozenTtrRemainingBumpsAtFraction();
    testNullPrioritiesCountAsMedium();
    testLadderLevelsAtExactThresholds();
    testLadderUsesBumpedPriority();
    testOnlyHighestDueLevelMessage();
    testFixReadyHasNoLadder();
    testNoWfpEntryStartsTimerNow();
    testBacklogDigestAndGoLiveTimers();
    testBacklogFixReadyStillPostsFixReady();
    testBacklogDigestWaitsWhenAllBacklogParentsAreCapped();
    testRateLimitingByPriorityAndDailyRemaining();
    testQuietHoursHoldNonCriticalOnly();
    testMentionRules();
    testTextNeverLeaksOrPagesTheChannel();
    testParentTruncatesTsKeysAtTen();
    testTtrChips();
    testChannelFollowsRoutingMode();
    testOneEscalationPerCpKey();
    testDeterministicOrder();
    console.log("\nAll escalation-plan tests passed.");
    process.exit(0);
  } catch (error) {
    console.error("\nEscalation-plan test failed:", error);
    process.exit(1);
  }
}

main();
