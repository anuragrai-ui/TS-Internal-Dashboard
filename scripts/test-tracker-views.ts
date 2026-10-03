import {
  adjacentKey,
  applyFilters,
  EMPTY_FILTERS,
  facetOptions,
  formatDurationShort,
  getView,
  groupByWhoseMove,
  hasActiveFilters,
  initials,
  matchesSearch,
  navigableKeys,
  NONE_VALUE,
  readState,
  relativeTime,
  selectTickets,
  slaChip,
  slaProgress,
  sortTickets,
  toggleFilterValue,
  viewCounts,
} from "@/lib/tracker/views";

import type { TrackerSignal, TrackerSla, TrackerTicket, WhoseMove } from "@/lib/tracker/types";
import type { ViewContext } from "@/lib/tracker/views";

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

/* --------------------------------------------------------------- fixtures */

const NOW = Date.parse("2026-10-03T12:00:00Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function iso(offsetMs: number): string {
  return new Date(NOW + offsetMs).toISOString();
}

const NO_SLA: TrackerSla = { breached: false, goalMs: null, remainingMs: null, state: "none" };

function running(remainingMs: number, goalMs = 3 * DAY): TrackerSla {
  return { breached: remainingMs < 0, goalMs, remainingMs, state: "running" };
}

function signal(kind: TrackerSignal["kind"], tier: TrackerSignal["tier"] = 2): TrackerSignal {
  return { kind, label: kind.replace(/_/g, " "), tier };
}

function ticket(key: string, overrides: Partial<TrackerTicket> = {}): TrackerTicket {
  return {
    account: "Acme Health",
    assignee: { accountId: "acc-me", name: "Anurag Rai" },
    botEscalation: null,
    cps: [],
    created: iso(-5 * DAY),
    escalated: false,
    firstResponse: NO_SLA,
    key,
    lastActivityAt: iso(-1 * HOUR),
    pod: "Alpha",
    priority: "High",
    reporterName: "Client Person",
    resolvedAt: null,
    signals: [],
    slack: { activeConversations: 0, conversations: 0, lastActivityAt: null },
    statusCategory: "indeterminate",
    statusId: "3",
    statusName: "In Progress",
    summary: `Summary of ${key}`,
    ttr: NO_SLA,
    updated: iso(-1 * HOUR),
    whoseMove: "on_ts",
    ...overrides,
  };
}

const CONTEXT: ViewContext = { following: new Set(["TS-6"]), me: "acc-me", now: NOW };

const TICKETS: TrackerTicket[] = [
  ticket("TS-1", { priority: "Critical", ttr: running(-2 * HOUR), signals: [signal("ttr_breached", 1)] }),
  ticket("TS-2", { assignee: null, priority: "High", whoseMove: "new", statusCategory: "new", statusId: "1", statusName: "To-do" }),
  ticket("TS-3", {
    assignee: { accountId: "acc-other", name: "Bea Lee" },
    cps: [{ assigneeName: "Eng One", key: "CP-77", outcome: "open", podName: "Alpha", statusName: "In Dev", summary: null }],
    priority: "Medium",
    statusId: "10633",
    statusName: "Waiting for product",
    whoseMove: "on_engineering",
  }),
  ticket("TS-4", {
    assignee: { accountId: "acc-other", name: "Bea Lee" },
    pod: null,
    signals: [signal("priority_raised"), signal("slack_conversation"), signal("slack_conversation")],
    slack: { activeConversations: 2, conversations: 2, lastActivityAt: iso(-10 * MINUTE) },
  }),
  ticket("TS-5", { resolvedAt: iso(-2 * DAY), statusCategory: "done", statusName: "Closed", whoseMove: "closed" }),
  ticket("TS-6", { assignee: { accountId: "acc-other", name: "Bea Lee" }, account: null, whoseMove: "on_customer" }),
  ticket("TS-7", { resolvedAt: iso(-10 * DAY), statusCategory: "done", statusName: "Closed", whoseMove: "closed" }),
  ticket("TS-8", { priority: "Critical", signals: [signal("ttr_at_risk")], ttr: running(3 * HOUR) }),
];

/* ------------------------------------------------------------------ tests */

function testViews(): void {
  console.log("\n--- Test: view predicates and counts ---");
  const counts = viewCounts(TICKETS, CONTEXT);
  assertEqual(counts.all_open, 6, "all open excludes closed");
  assertEqual(counts.critical, 2, "critical");
  assertEqual(counts.high, 3, "high (TS-2, TS-4, TS-6)");
  assertEqual(counts.breaching, 2, "breaching = breached TS-1 + at-risk TS-8");
  assertEqual(counts.engineering, 1, "waiting on engineering");
  assertEqual(counts.slack_active, 1, "active in slack");
  assertEqual(counts.manual, 1, "manually escalated (tier 2 signals only)");
  assertEqual(counts.unassigned, 1, "unassigned");
  assertEqual(counts.following, 1, "following");
  assertEqual(counts.medium_wfp, 1, "medium in WfP");
  assertEqual(counts.closed_recent, 1, "closed in the last 7 days only");
  /* Assigned to me and open (TS-1, TS-8; TS-5/TS-7 are closed), plus TS-6 which I follow. */
  const mine = TICKETS.filter((t) => getView("mine").matches(t, CONTEXT)).map((t) => t.key);
  assertEqual(mine, ["TS-1", "TS-6", "TS-8"], "mine = assigned to me (open) or followed");
  assertEqual(getView("nonsense").id, "all_open", "unknown view falls back to all open");
  assertEqual(getView(null).id, "all_open", "missing view falls back to all open");
  console.log("PASS");
}

function testFilters(): void {
  console.log("\n--- Test: filters ---");
  assert(!hasActiveFilters(EMPTY_FILTERS), "empty filters are inactive");
  const critical = toggleFilterValue(EMPTY_FILTERS, "priority", "Critical");
  assert(hasActiveFilters(critical), "one chip makes filters active");
  assertEqual(applyFilters(TICKETS, critical).map((t) => t.key), ["TS-1", "TS-8"], "priority is critical");
  const criticalOrMedium = toggleFilterValue(critical, "priority", "Medium");
  assertEqual(applyFilters(TICKETS, criticalOrMedium).map((t) => t.key), ["TS-1", "TS-3", "TS-8"], "OR within a facet");
  const andBea = toggleFilterValue(criticalOrMedium, "assignee", "acc-other");
  assertEqual(applyFilters(TICKETS, andBea).map((t) => t.key), ["TS-3"], "AND across facets");
  assertEqual(toggleFilterValue(critical, "priority", "Critical").priority, [], "toggling again removes the chip");
  assertEqual(applyFilters(TICKETS, toggleFilterValue(EMPTY_FILTERS, "pod", NONE_VALUE)).map((t) => t.key), ["TS-4"], "no pod");
  assertEqual(applyFilters(TICKETS, toggleFilterValue(EMPTY_FILTERS, "assignee", NONE_VALUE)).map((t) => t.key), ["TS-2"], "unassigned");
  assertEqual(applyFilters(TICKETS, toggleFilterValue(EMPTY_FILTERS, "signal", "priority_raised")).map((t) => t.key), ["TS-4"], "signal");

  const priorities = facetOptions(TICKETS, "priority");
  assertEqual(priorities.map((o) => o.value), ["Critical", "High", "Medium"], "priority options in natural order");
  const signals = facetOptions(TICKETS, "signal");
  assertEqual(signals.find((o) => o.value === "slack_conversation")?.count, 1, "a repeated signal counts its ticket once");
  const assignees = facetOptions(TICKETS, "assignee");
  assertEqual(assignees[0], { count: 4, label: "Anurag Rai", value: "acc-me" }, "assignee options by count with names");
  assertEqual(assignees.find((o) => o.value === NONE_VALUE)?.label, "Unassigned", "unassigned option label");
  console.log("PASS");
}

function testSearch(): void {
  console.log("\n--- Test: text search ---");
  const t3 = TICKETS[2] as TrackerTicket;
  assert(matchesSearch(t3, ""), "empty search matches");
  assert(matchesSearch(t3, "ts-3"), "key, case-insensitive");
  assert(matchesSearch(t3, "cp-77"), "linked CP key");
  assert(matchesSearch(t3, "bea"), "assignee");
  assert(matchesSearch(t3, "acme summary"), "every word, any field");
  assert(!matchesSearch(t3, "acme nothing"), "all words must match");
  assert(!matchesSearch(t3, "cp-78"), "other CP");
  console.log("PASS");
}

function testGrouping(): void {
  console.log("\n--- Test: grouping order and keyboard walk ---");
  const groups = groupByWhoseMove(TICKETS);
  assertEqual(
    groups.map((g) => g.whoseMove),
    ["new", "on_ts", "on_engineering", "on_customer", "closed"] as WhoseMove[],
    "Pylon band order, empty bands dropped",
  );
  assertEqual(groups[0]?.label, "New", "band label");
  const keys = navigableKeys(groups, new Set<WhoseMove>(["on_ts"]));
  assertEqual(keys, ["TS-2", "TS-3", "TS-6", "TS-5", "TS-7"], "collapsed bands are skipped");
  assertEqual(adjacentKey(keys, null, 1), "TS-2", "j with nothing selected picks the first row");
  assertEqual(adjacentKey(keys, null, -1), "TS-7", "k with nothing selected picks the last row");
  assertEqual(adjacentKey(keys, "TS-3", 1), "TS-6", "next");
  assertEqual(adjacentKey(keys, "TS-2", -1), "TS-2", "clamped at the top");
  assertEqual(adjacentKey(keys, "TS-7", 1), "TS-7", "clamped at the bottom");
  assertEqual(adjacentKey([], "TS-1", 1), null, "empty list");
  console.log("PASS");
}

function testSorts(): void {
  console.log("\n--- Test: sort comparators ---");
  const sla = (key: string, ttr: TrackerSla, overrides: Partial<TrackerTicket> = {}): TrackerTicket => ticket(key, { ttr, ...overrides });
  const pool = [
    sla("TS-10", NO_SLA),
    sla("TS-11", { breached: false, goalMs: DAY, remainingMs: HOUR, state: "paused" }),
    sla("TS-12", running(5 * HOUR)),
    sla("TS-13", running(-1 * HOUR)),
    sla("TS-14", running(-9 * HOUR)),
    sla("TS-15", running(30 * MINUTE)),
    sla("TS-16", { breached: true, goalMs: DAY, remainingMs: -3 * HOUR, state: "paused" }),
    sla("TS-17", running(5 * HOUR), { priority: "Critical" }),
    sla("TS-18", running(5 * HOUR), { lastActivityAt: iso(-1 * MINUTE) }),
    sla("TS-19", { breached: false, goalMs: DAY, remainingMs: null, state: "completed_only" }),
  ];
  assertEqual(
    sortTickets(pool, "sla").map((t) => t.key),
    ["TS-14", "TS-16", "TS-13", "TS-15", "TS-17", "TS-18", "TS-12", "TS-11", "TS-10", "TS-19"],
    "SLA urgency: breached by most overdue, running by least left (ties: priority, then activity), paused, none",
  );
  const byPriority = sortTickets([ticket("TS-20", { priority: "Low" }), ticket("TS-21", { priority: "Critical" }), ticket("TS-22", { priority: "Medium" })], "priority");
  assertEqual(byPriority.map((t) => t.key), ["TS-21", "TS-22", "TS-20"], "priority");
  const byActivity = sortTickets(
    [ticket("TS-30", { lastActivityAt: iso(-3 * HOUR) }), ticket("TS-31", { lastActivityAt: iso(-1 * MINUTE) }), ticket("TS-32", { lastActivityAt: iso(-2 * DAY) })],
    "activity",
  );
  assertEqual(byActivity.map((t) => t.key), ["TS-31", "TS-30", "TS-32"], "last activity, newest first");
  const byCreated = sortTickets([ticket("TS-40", { created: iso(-9 * DAY) }), ticket("TS-41", { created: iso(-1 * DAY) })], "created");
  assertEqual(byCreated.map((t) => t.key), ["TS-41", "TS-40"], "created, newest first");
  const stable = sortTickets([ticket("TS-100"), ticket("TS-9")], "sla");
  assertEqual(stable.map((t) => t.key), ["TS-9", "TS-100"], "equal tickets fall back to numeric key order");

  const selected = selectTickets(TICKETS, { filters: EMPTY_FILTERS, search: "", sort: "sla", view: "critical" }, CONTEXT);
  assertEqual(selected.map((t) => t.key), ["TS-1", "TS-8"], "pipeline: view then sort");
  const searched = selectTickets(TICKETS, { filters: EMPTY_FILTERS, search: "bea", sort: "sla", view: "all_open" }, CONTEXT);
  assertEqual(searched.map((t) => t.key).sort(), ["TS-3", "TS-4", "TS-6"], "pipeline: search inside the view");
  console.log("PASS");
}

function testSlaText(): void {
  console.log("\n--- Test: SLA chip text ---");
  assertEqual(slaChip(running(-2 * HOUR)), { paused: false, text: "Breached 2h", tone: "danger" }, "breached 2h");
  assertEqual(slaChip(running(45 * MINUTE)), { paused: false, text: "Due in 45m", tone: "warning" }, "due in 45m");
  assertEqual(slaChip(running(3 * HOUR)), { paused: false, text: "Due in 3h", tone: "warning" }, "due in 3h (under 8h is amber)");
  assertEqual(slaChip(running(2 * DAY + 5 * HOUR)), { paused: false, text: "Due in 2d", tone: "muted" }, "due in 2d");
  assertEqual(slaChip(running(9 * HOUR)).tone, "muted", "8h+ is grey");
  assertEqual(slaChip({ breached: false, goalMs: DAY, remainingMs: HOUR, state: "paused" }), { paused: true, text: "Paused", tone: "muted" }, "paused");
  assertEqual(
    slaChip({ breached: true, goalMs: DAY, remainingMs: -3 * HOUR, state: "paused" }),
    { paused: true, text: "Breached 3h", tone: "danger" },
    "breached while paused still reads breached",
  );
  assertEqual(slaChip({ breached: false, goalMs: DAY, remainingMs: null, state: "completed_only" }).text, "Met", "met");
  assertEqual(slaChip({ breached: true, goalMs: DAY, remainingMs: null, state: "completed_only" }).text, "Breached", "completed but breached");
  assertEqual(slaChip(NO_SLA).text, "—", "no SLA");
  assertEqual(slaChip({ breached: false, goalMs: DAY, remainingMs: 0, state: "running" }).text, "Breached", "zero left reads breached");
  assertEqual(formatDurationShort(10_000), "1m", "never 0m");
  assertEqual(formatDurationShort(59 * MINUTE), "59m", "minutes");
  assertEqual(formatDurationShort(23 * HOUR + 59 * MINUTE), "23h", "hours floor");
  assertEqual(slaProgress(running(DAY, 4 * DAY)), 0.75, "progress used");
  assertEqual(slaProgress(running(-DAY, 4 * DAY)), 1, "progress clamps at 1");
  assertEqual(slaProgress(NO_SLA), null, "no goal, no bar");
  console.log("PASS");
}

function testRelativeTime(): void {
  console.log("\n--- Test: relative time and initials ---");
  assertEqual(relativeTime(iso(-20_000), NOW), "just now", "seconds");
  assertEqual(relativeTime(iso(30_000), NOW), "just now", "slight future skew");
  assertEqual(relativeTime(iso(-3 * MINUTE), NOW), "3m ago", "minutes");
  assertEqual(relativeTime(iso(-3 * MINUTE), NOW, true), "3m", "compact");
  assertEqual(relativeTime(iso(-5 * HOUR), NOW), "5h ago", "hours");
  assertEqual(relativeTime(iso(-2 * DAY), NOW), "2d ago", "days");
  assertEqual(relativeTime(iso(-65 * DAY), NOW), "2mo ago", "months");
  assertEqual(relativeTime(iso(-400 * DAY), NOW), "1y ago", "years");
  assertEqual(relativeTime(null, NOW), "—", "missing");
  assertEqual(relativeTime("garbage", NOW), "—", "unparseable");
  assertEqual(initials("Anurag Rai"), "AR", "two names");
  assertEqual(initials("anurag kumar rai"), "AR", "first and last");
  assertEqual(initials("Anurag"), "A", "one name");
  assertEqual(initials(null), "", "nobody");
  console.log("PASS");
}

function testReadState(): void {
  console.log("\n--- Test: read state ---");
  const t = ticket("TS-50", { lastActivityAt: iso(-1 * HOUR) });
  assertEqual(readState(t, {}), "unknown", "never opened here");
  assertEqual(readState(t, { "TS-50": iso(-1 * HOUR) }), "read", "seen the latest activity");
  assertEqual(readState(t, { "TS-50": iso(-2 * HOUR) }), "unread", "new activity since last seen");
  console.log("PASS");
}

function main(): void {
  testViews();
  testFilters();
  testSearch();
  testGrouping();
  testSorts();
  testSlaText();
  testRelativeTime();
  testReadState();
}

try {
  main();
  console.log("\nAll tracker view tests passed.");
  process.exit(0);
} catch (error: unknown) {
  console.error("\nTracker view test failed:", error);
  process.exit(1);
}
