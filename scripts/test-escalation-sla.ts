import { findSla, parseJsmSla } from "@/lib/escalation/slaParser";
import type { ParsedSla } from "@/lib/escalation/types";

/* Plain JSON.stringify renders NaN/Infinity as null and drops undefined, so a
   parser leaking NaN into goalMs/remainingMs would still "equal" an expected
   null. Tag those values so they can never collide with a real null. */
function stableJson(value: unknown): string | undefined {
  return JSON.stringify(value, (_key, member: unknown) => {
    if (typeof member === "number" && !Number.isFinite(member)) return `<number ${String(member)}>`;
    if (member === undefined) return "<undefined>";
    return member;
  });
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (stableJson(actual) !== stableJson(expected)) {
    throw new Error(`${label} failed: expected ${stableJson(expected)}, got ${stableJson(actual)}`);
  }
}

function assert(condition: boolean, label: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${label}`);
  }
}

/* Same key order as the parser builds, so assertEqual's JSON comparison is exact. */
function sla(overrides: Partial<ParsedSla>): ParsedSla {
  return { breached: false, goalMs: null, remainingMs: null, state: "none", withinCalendarHours: null, ...overrides };
}

const NONE = sla({});
const HOUR_MS = 3_600_000;
const GOAL_MS = 40 * HOUR_MS;

/* Fixed instants - nothing here depends on the real clock. */
const CYCLE_START = Date.parse("2026-09-28T13:00:00.000Z");
const BREACH_PAST = Date.parse("2026-09-01T13:00:00.000Z");
const BREACH_FUTURE = Date.parse("2026-10-09T13:00:00.000Z");

function instant(epochMillis: number): { epochMillis: number; friendly: string; iso8601: string; jira: string } {
  const iso = new Date(epochMillis).toISOString();
  return { epochMillis, friendly: "Today 9:00 AM", iso8601: iso, jira: iso };
}

/* `friendly` deliberately disagrees with `millis` so a parser that read it would be caught. */
function duration(millis: number): { friendly: string; millis: number } {
  return { friendly: "999h", millis };
}

function ongoingCycle(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    breachTime: instant(BREACH_FUTURE),
    breached: false,
    elapsedTime: duration(10 * HOUR_MS),
    goalDuration: duration(GOAL_MS),
    paused: false,
    remainingTime: duration(30 * HOUR_MS),
    startTime: instant(CYCLE_START),
    withinCalendarHours: true,
    ...overrides,
  };
}

function completedCycle(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    breachTime: instant(BREACH_FUTURE),
    breached: false,
    elapsedTime: duration(12 * HOUR_MS),
    goalDuration: duration(GOAL_MS),
    remainingTime: duration(28 * HOUR_MS),
    startTime: instant(CYCLE_START),
    stopTime: instant(CYCLE_START + 2 * 86_400_000),
    ...overrides,
  };
}

/* Issue-field shape of customfield_10650. */
function fieldSla(body: Record<string, unknown>): Record<string, unknown> {
  return {
    _links: { self: "https://certifyos.atlassian.net/rest/servicedeskapi/request/40001/sla/62" },
    completedCycles: [],
    id: "62",
    name: "Time to Resolution",
    ...body,
  };
}

/* One entry of /rest/servicedeskapi/request/{key}/sla values[]. */
function serviceDeskSla(body: Record<string, unknown>): Record<string, unknown> {
  return {
    _links: { self: "https://certifyos.atlassian.net/rest/servicedeskapi/request/40001/sla/62" },
    completedCycles: [],
    id: "62",
    name: "Time to Resolution",
    slaDisplayFormat: "NEW_SLA_FORMAT",
    ...body,
  };
}

/* The issue field may carry only the spec'd numeric members - no friendly text at all. */
function withoutFriendly<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (key, member: unknown) => (key === "friendly" ? undefined : member))) as T;
}

// --- helper self-check ---

function testAssertEqualSeesNonFinite(): void {
  console.log("\n--- Test: assertEqual tells NaN/Infinity/undefined apart from null ---");

  /* Guards the helper itself: if it ever falls back to plain JSON, every
     "expected null" check above becomes unable to catch a NaN leak. */
  const collisions: Array<[string, unknown, unknown]> = [
    ["NaN vs null", NaN, null],
    ["Infinity vs null", Infinity, null],
    ["-Infinity vs null", -Infinity, null],
    ["undefined vs null", undefined, null],
    ["nested NaN vs null", sla({ remainingMs: NaN }), sla({})],
    ["nested Infinity vs null", sla({ goalMs: Infinity }), sla({})],
  ];
  for (const [label, actual, expected] of collisions) {
    let threw = false;
    try {
      assertEqual(actual, expected, label);
    } catch {
      threw = true;
    }
    assert(threw, `assertEqual must reject ${label}`);
  }
  assertEqual(NaN, NaN, "NaN still equals NaN");

  console.log("PASS: non-finite and undefined values never pass as null.");
}

// --- ongoing cycle ---

function testRunningCycle(): void {
  console.log("\n--- Test: a running ongoing cycle is read from millis, not friendly ---");

  const parsed = parseJsmSla(fieldSla({ ongoingCycle: ongoingCycle() }));
  assertEqual(
    parsed,
    sla({ goalMs: GOAL_MS, remainingMs: 30 * HOUR_MS, state: "running", withinCalendarHours: true }),
    "running cycle",
  );

  const outside = parseJsmSla(fieldSla({ ongoingCycle: ongoingCycle({ withinCalendarHours: false }) }));
  assertEqual(outside.withinCalendarHours, false, "withinCalendarHours false is kept, not nulled");

  console.log("PASS: running cycle -> state running with goal/remaining from millis.");
}

function testPausedCycleIgnoresBreachTime(): void {
  console.log("\n--- Test: a paused cycle never reads breachTime ---");

  let breachTimeReads = 0;
  const cycle = ongoingCycle({ paused: true, withinCalendarHours: false });
  /* A paused cycle's breachTime moves forward on every read; any access at all is a bug. */
  Object.defineProperty(cycle, "breachTime", {
    enumerable: true,
    get() {
      breachTimeReads += 1;
      return instant(BREACH_PAST);
    },
  });

  const parsed = parseJsmSla(fieldSla({ ongoingCycle: cycle }));
  assertEqual(
    parsed,
    sla({ goalMs: GOAL_MS, remainingMs: 30 * HOUR_MS, state: "paused", withinCalendarHours: false }),
    "paused cycle",
  );
  assertEqual(breachTimeReads, 0, "breachTime must never be read");

  /* Same cycle, breachTime drifted (and already in the past): the result must not move. */
  const pausedAt = (breachAt: number): ParsedSla =>
    parseJsmSla(fieldSla({ ongoingCycle: ongoingCycle({ breachTime: instant(breachAt), paused: true }) }));
  const drifted = pausedAt(BREACH_PAST);
  const later = pausedAt(BREACH_FUTURE);
  assertEqual(drifted, later, "a moved breachTime does not change the parse");
  assertEqual(drifted.breached, false, "a past breachTime does not imply breached");

  console.log("PASS: paused cycle -> state paused, frozen remaining kept, breachTime untouched.");
}

function testBreachedRunningKeepsNegativeRemaining(): void {
  console.log("\n--- Test: a breached running cycle keeps its negative remaining time ---");

  const parsed = parseJsmSla(
    fieldSla({ ongoingCycle: ongoingCycle({ breached: true, remainingTime: duration(-5 * HOUR_MS) }) }),
  );
  assertEqual(
    parsed,
    sla({ breached: true, goalMs: GOAL_MS, remainingMs: -5 * HOUR_MS, state: "running", withinCalendarHours: true }),
    "breached running cycle",
  );

  console.log("PASS: breached -> breached true and remainingMs stays negative (the overrun).");
}

function testOngoingWinsOverCompleted(): void {
  console.log("\n--- Test: an ongoing cycle wins over earlier completed cycles ---");

  const parsed = parseJsmSla(
    fieldSla({ completedCycles: [completedCycle({ breached: true })], ongoingCycle: ongoingCycle({ paused: true }) }),
  );
  assertEqual(parsed.state, "paused", "state comes from the ongoing cycle");
  assertEqual(parsed.breached, false, "an earlier breached round does not mark the current cycle breached");

  console.log("PASS: completed history never overrides the live cycle.");
}

function testServiceDeskShape(): void {
  console.log("\n--- Test: a servicedeskapi values[] entry parses the same as the issue field ---");

  const body = { completedCycles: [completedCycle()], ongoingCycle: ongoingCycle({ paused: true }) };
  const fromServiceDesk = parseJsmSla(serviceDeskSla(body));
  assertEqual(fromServiceDesk, parseJsmSla(withoutFriendly(fieldSla(body))), "both shapes agree");
  assertEqual(
    fromServiceDesk,
    sla({ goalMs: GOAL_MS, remainingMs: 30 * HOUR_MS, state: "paused", withinCalendarHours: true }),
    "servicedeskapi entry",
  );

  console.log("PASS: issue-field and servicedeskapi shapes are interchangeable.");
}

// --- completed only ---

function testCompletedOnly(): void {
  console.log("\n--- Test: no ongoing cycle -> completed_only from the LAST completed cycle ---");

  const breached = parseJsmSla(
    fieldSla({ completedCycles: [completedCycle(), completedCycle({ breached: true, goalDuration: duration(9 * HOUR_MS) })] }),
  );
  assertEqual(breached, sla({ breached: true, goalMs: 9 * HOUR_MS, state: "completed_only" }), "last cycle breached");

  const recovered = parseJsmSla(fieldSla({ completedCycles: [completedCycle({ breached: true }), completedCycle()] }));
  assertEqual(recovered, sla({ goalMs: GOAL_MS, state: "completed_only" }), "earlier breach, last cycle met");

  const viaNull = parseJsmSla(fieldSla({ completedCycles: [completedCycle()], ongoingCycle: null }));
  assertEqual(viaNull.state, "completed_only", "ongoingCycle: null is treated as absent");

  console.log("PASS: completed_only takes breached/goal from the last cycle; remaining and calendar stay null.");
}

// --- none / malformed ---

function testNoneForEmptyInput(): void {
  console.log("\n--- Test: missing or non-object input -> none ---");

  const inputs: Array<[string, unknown]> = [
    ["null", null],
    ["undefined", undefined],
    ["{}", {}],
    ["string", "Time to Resolution"],
    ["array", [ongoingCycle()]],
    ["number", 62],
    ["boolean", true],
    ["no cycles", fieldSla({ completedCycles: [] })],
    ["errorMessage field", { errorMessage: "SLA not available" }],
  ];
  for (const [label, input] of inputs) {
    assertEqual(parseJsmSla(input), NONE, `${label} -> none`);
  }

  console.log("PASS: nothing usable -> state none, breached false, nulls.");
}

function testFriendlyOnlyFieldsIgnored(): void {
  console.log("\n--- Test: friendly-only durations are never parsed ---");

  const parsed = parseJsmSla(
    serviceDeskSla({
      ongoingCycle: ongoingCycle({ goalDuration: { friendly: "40h" }, paused: true, remainingTime: { friendly: "-2h 30m" } }),
    }),
  );
  assertEqual(parsed, sla({ state: "paused", withinCalendarHours: true }), "friendly-only -> null durations");

  const completed = parseJsmSla(serviceDeskSla({ completedCycles: [completedCycle({ goalDuration: { friendly: "40h" } })] }));
  assertEqual(completed.goalMs, null, "completed friendly-only goal -> null");

  console.log("PASS: friendly strings never become numbers.");
}

function testMalformedNestedTypes(): void {
  console.log("\n--- Test: malformed nested types degrade to nulls / none without throwing ---");

  const stringMillis = parseJsmSla(
    fieldSla({ ongoingCycle: ongoingCycle({ goalDuration: "40h", remainingTime: { millis: "3600000" } }) }),
  );
  assertEqual(stringMillis, sla({ state: "running", withinCalendarHours: true }), "string millis -> null");

  /* Identity checks, not JSON: a NaN remainingMs would silently fail every
     priority-bump comparison downstream. */
  const nonFinite = parseJsmSla(
    fieldSla({ ongoingCycle: ongoingCycle({ goalDuration: { millis: Infinity }, remainingTime: { millis: NaN } }) }),
  );
  assert(nonFinite.goalMs === null, "Infinity -> null");
  assert(nonFinite.remainingMs === null, "NaN -> null");
  assertEqual(nonFinite, sla({ state: "running", withinCalendarHours: true }), "non-finite millis -> whole parse");

  const negInfinity = parseJsmSla(fieldSla({ ongoingCycle: ongoingCycle({ remainingTime: { millis: -Infinity } }) }));
  assert(negInfinity.remainingMs === null, "-Infinity -> null (not a huge overrun)");

  const completedNaN = parseJsmSla(fieldSla({ completedCycles: [completedCycle({ goalDuration: { millis: NaN } })] }));
  assert(completedNaN.goalMs === null, "completed NaN goal -> null");

  const stringFlags = parseJsmSla(fieldSla({ ongoingCycle: ongoingCycle({ breached: "true", withinCalendarHours: "true" }) }));
  assertEqual(stringFlags.breached, false, "string breached is not true");
  assertEqual(stringFlags.withinCalendarHours, null, "string withinCalendarHours -> null");

  /* Without a readable paused flag we can't tell live from frozen remaining. */
  assertEqual(parseJsmSla(fieldSla({ ongoingCycle: ongoingCycle({ paused: "false" }) })), NONE, "string paused -> none");
  assertEqual(parseJsmSla(fieldSla({ ongoingCycle: {} })), NONE, "empty ongoing cycle -> none");

  /* A present-but-garbled ongoing cycle must not fall back to stale completed history. */
  assertEqual(
    parseJsmSla(fieldSla({ completedCycles: [completedCycle({ breached: true })], ongoingCycle: "yes" })),
    NONE,
    "non-object ongoingCycle -> none",
  );

  assertEqual(parseJsmSla(fieldSla({ completedCycles: "lots" })), NONE, "non-array completedCycles -> none");
  assertEqual(parseJsmSla(fieldSla({ completedCycles: [null, "x", 5, []] })), NONE, "all-junk completedCycles -> none");
  assertEqual(
    parseJsmSla(fieldSla({ completedCycles: [completedCycle({ breached: true }), "junk"] })).breached,
    true,
    "junk after the real last cycle is skipped",
  );

  console.log("PASS: wrong types never throw and never get coerced.");
}

function testResultsAreIndependent(): void {
  console.log("\n--- Test: each none result is a fresh object ---");

  const first = parseJsmSla(null);
  first.breached = true;
  assertEqual(parseJsmSla(null).breached, false, "mutating one result does not leak into the next");

  console.log("PASS: callers can safely mutate what they get back.");
}

// --- findSla ---

function testFindSla(): void {
  console.log("\n--- Test: findSla picks metric 62 by id first, else exact name ---");

  const ttfr = serviceDeskSla({ id: "61", name: "Time to first response", ongoingCycle: ongoingCycle() });
  const ttr = serviceDeskSla({ id: "62", name: "Time to Resolution", ongoingCycle: ongoingCycle({ paused: true }) });
  const values: unknown[] = [null, "junk", ttfr, ttr];

  assert(findSla(values, { id: "62" }) === ttr, "by id");
  assert(findSla(values, { name: "Time to Resolution" }) === ttr, "by exact name");
  assert(findSla(values, { id: "62", name: "Time to first response" }) === ttr, "id wins over a conflicting name");
  assert(findSla(values, { id: "999", name: "Time to Resolution" }) === ttr, "unknown id falls back to name");
  assert(findSla([{ id: 62, name: "x" }], { id: "62" }) !== undefined, "numeric id still matches");

  assertEqual(findSla(values, { name: "time to resolution" }), undefined, "name match is exact (case-sensitive)");
  assertEqual(findSla(values, { id: "999" }), undefined, "no match -> undefined");
  assertEqual(findSla(values, {}), undefined, "no criteria -> undefined");
  assertEqual(findSla(null, { id: "62" }), undefined, "null values -> undefined");
  assertEqual(findSla({ values }, { id: "62" }), undefined, "non-array values -> undefined");

  assertEqual(parseJsmSla(findSla(values, { id: "62" })).state, "paused", "found entry feeds parseJsmSla");
  assertEqual(parseJsmSla(findSla(values, { id: "999" })), NONE, "missing metric parses to none");

  console.log("PASS: findSla matches id, then exact name, and misses cleanly.");
}

function main(): void {
  try {
    testAssertEqualSeesNonFinite();
    testRunningCycle();
    testPausedCycleIgnoresBreachTime();
    testBreachedRunningKeepsNegativeRemaining();
    testOngoingWinsOverCompleted();
    testServiceDeskShape();
    testCompletedOnly();
    testNoneForEmptyInput();
    testFriendlyOnlyFieldsIgnored();
    testMalformedNestedTypes();
    testResultsAreIndependent();
    testFindSla();
    console.log("\nAll escalation SLA-parser tests passed.");
    process.exit(0);
  } catch (error) {
    console.error("\nEscalation SLA-parser test failed:", error);
    process.exit(1);
  }
}

main();
