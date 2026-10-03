import { ATTENTION_KIND_LABEL, attentionRank, attentionReasons, needsAttention, workingElapsedMs } from "@/lib/tracker/attention";
import {
  applyFilters,
  defaultSortFor,
  EMPTY_FILTERS,
  facetOptions,
  getView,
  selectTickets,
  sortTickets,
  toggleFilterValue,
  viewCounts,
} from "@/lib/tracker/views";

import type { AttentionKind } from "@/lib/tracker/attention";
import type { TrackerCp, TrackerSignal, TrackerSla, TrackerTicket } from "@/lib/tracker/types";
import type { ViewContext } from "@/lib/tracker/views";

/**
 * Tests for the tracker's "Needs attention" view: which open tickets are
 * waiting on a person and why, the working-day clock behind "quiet for",
 * and how the view, its default sort and its Attention filter use them.
 * Pure functions over fixtures - nothing is fetched.
 *
 *   npx tsx scripts/test-tracker-attention.ts
 */

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

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/* A Wednesday afternoon (2026-10-03 is a Saturday), so "N days quiet" never straddles a weekend unless a test says so. */
const NOW = Date.parse("2026-10-07T15:00:00Z");

function ago(ms: number): string {
  return new Date(NOW - ms).toISOString();
}

const NO_SLA: TrackerSla = { breached: false, goalMs: null, remainingMs: null, state: "none" };

function running(remainingMs: number): TrackerSla {
  return { breached: remainingMs < 0, goalMs: 3 * DAY, remainingMs, state: "running" };
}

function signal(kind: TrackerSignal["kind"], tier: TrackerSignal["tier"] = 2): TrackerSignal {
  return { kind, label: kind.replace(/_/g, " "), tier };
}

function cp(key: string, outcome: TrackerCp["outcome"], overrides: Partial<TrackerCp> = {}): TrackerCp {
  return { assigneeName: "Eng One", key, outcome, podName: "Alpha", statusName: outcome, summary: null, ...overrides };
}

function ticket(key: string, overrides: Partial<TrackerTicket> = {}): TrackerTicket {
  return {
    account: "Acme Health",
    assignee: { accountId: "acc-me", name: "Anurag Rai" },
    botEscalation: null,
    cps: [],
    created: ago(20 * DAY),
    escalated: false,
    firstResponse: NO_SLA,
    key,
    lastActivityAt: ago(2 * HOUR),
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
    updated: ago(2 * HOUR),
    whoseMove: "on_ts",
    ...overrides,
  };
}

function kinds(t: TrackerTicket): AttentionKind[] {
  return attentionReasons(t, NOW).map((reason) => reason.kind);
}

/* ------------------------------------------------------------------ tests */

function testWorkingElapsed(): void {
  console.log("\n--- Test: working time skips weekends ---");
  const fri = Date.parse("2026-10-02T15:00:00Z");
  const mon = Date.parse("2026-10-05T15:00:00Z");
  assertEqual(workingElapsedMs(fri, mon), 24 * HOUR, "Friday afternoon to Monday afternoon is one working day, not three");
  assertEqual(workingElapsedMs(Date.parse("2026-10-07T12:00:00Z"), NOW), 3 * HOUR, "within one weekday it is plain elapsed time");
  assertEqual(workingElapsedMs(Date.parse("2026-10-03T14:00:00Z"), Date.parse("2026-10-04T14:00:00Z")), 0, "a span entirely inside a weekend is nothing");
  assertEqual(workingElapsedMs(Date.parse("2026-10-05T15:00:00Z"), Date.parse("2026-10-12T15:00:00Z")), 5 * DAY, "a full week is five working days");
  assertEqual(workingElapsedMs(NOW, NOW - HOUR), 0, "backwards is nothing");
  assertEqual(workingElapsedMs(Number.NaN, NOW), 0, "garbage is nothing");
  assertEqual(workingElapsedMs(NOW - 5000 * DAY, NOW) > 0, true, "an absurd age stays bounded and finite");
  console.log("PASS");
}

function testClocks(): void {
  console.log("\n--- Test: a breached or closing SLA clock ---");
  const breached = ticket("TS-1", { priority: "Critical", signals: [signal("ttr_breached", 1)], ttr: running(-3 * HOUR) });
  assertEqual(kinds(breached), ["sla_breached"], "breached");
  assertEqual(attentionReasons(breached, NOW)[0]?.label, "SLA breached by 3h", "says by how much");
  assertEqual(attentionReasons(breached, NOW)[0]?.tone, "danger", "danger tone");

  const pausedBreach = ticket("TS-2", { signals: [signal("ttr_breached", 1)], ttr: { breached: true, goalMs: 3 * DAY, remainingMs: -2 * DAY, state: "paused" } });
  assertEqual(kinds(pausedBreach), ["sla_breached"], "a breach still counts while the clock is paused in Waiting for product");

  const atRisk = ticket("TS-3", { signals: [signal("ttr_at_risk")], ttr: running(5 * HOUR) });
  assertEqual(attentionReasons(atRisk, NOW)[0]?.label, "SLA due in 5h", "at risk says when");
  assertEqual(kinds(atRisk), ["sla_at_risk"], "at risk");
  assertEqual(kinds(ticket("TS-4", { signals: [signal("ttr_at_risk")], ttr: running(0) })), [], "an at-risk flag with no time left on the row is not shown twice");

  const medium = ticket("TS-5", { priority: "Medium", signals: [signal("ttr_breached", 1)], ttr: running(-HOUR) });
  assertEqual(kinds(medium), ["sla_breached"], "a Medium ticket still surfaces for a breached clock");
  console.log("PASS");
}

function testOwnershipAndPickup(): void {
  console.log("\n--- Test: nobody owns it, nobody picked it up, it was escalated but stayed with TS ---");
  assertEqual(kinds(ticket("TS-1", { assignee: null })), ["unassigned"], "an unassigned High");
  assertEqual(kinds(ticket("TS-2", { assignee: null, priority: "Medium" })), [], "an unassigned Medium is not urgent");

  const quietCritical = ticket("TS-3", { lastActivityAt: ago(5 * HOUR), priority: "Critical", statusId: "1", statusName: "To-do", whoseMove: "new" });
  assertEqual(kinds(quietCritical), ["quiet_new"], "a Critical ticket left in To-do for 5 working hours");
  assertEqual(attentionReasons(quietCritical, NOW)[0]?.label, "Not picked up 5h", "with how long");
  assertEqual(kinds(ticket("TS-4", { lastActivityAt: ago(3 * HOUR), priority: "Critical", whoseMove: "new" })), [], "but not after 3 hours");
  assertEqual(kinds(ticket("TS-5", { lastActivityAt: ago(7 * HOUR), priority: "High", whoseMove: "new" })), [], "a High gets 8 hours");
  assertEqual(kinds(ticket("TS-6", { lastActivityAt: ago(9 * HOUR), priority: "High", whoseMove: "new" })), ["quiet_new"], "and then shows");

  const escalated = ticket("TS-7", { signals: [signal("priority_raised")] });
  assertEqual(kinds(escalated), ["escalated_on_ts"], "priority raised, still on TS");
  assertEqual(kinds(ticket("TS-8", { signals: [signal("escalation_comment")] })), ["escalated_on_ts"], "a comment asking to escalate, still on TS");
  assertEqual(kinds(ticket("TS-9", { signals: [signal("priority_raised")], whoseMove: "on_engineering" })), [], "once engineering has it, nothing to do about the escalation");
  assertEqual(kinds(ticket("TS-10", { signals: [signal("slack_conversation")] })), [], "a Slack discussion alone isn't an escalation request");
  console.log("PASS");
}

function testEngineeringHandBack(): void {
  console.log("\n--- Test: engineering's side of the hand-off ---");
  const quiet = ago(2 * DAY);
  const fixReady = ticket("TS-1", { cps: [cp("CP-9", "fix_ready"), cp("CP-10", "open")], lastActivityAt: quiet, whoseMove: "on_engineering" });
  assertEqual(attentionReasons(fixReady, NOW).map((r) => r.label), ["Fix ready · CP-9"], "names the CP whose fix is ready");
  assertEqual(kinds(ticket("TS-2", { cps: [cp("CP-9", "fix_ready")], lastActivityAt: ago(3 * HOUR), whoseMove: "on_engineering" })), [], "not when somebody touched the ticket today");
  assertEqual(kinds(ticket("TS-3", { cps: [cp("CP-9", "fix_ready")], lastActivityAt: quiet, priority: "Medium", whoseMove: "on_engineering" })), [], "not for Medium");

  const wfp = { lastActivityAt: quiet, statusId: "10633", statusName: "Waiting for product", whoseMove: "on_engineering" as const };
  assertEqual(attentionReasons(ticket("TS-4", { ...wfp, cps: [cp("CP-9", "shipped")] }), NOW).map((r) => r.label), ["CP shipped"], "every CP shipped but still Waiting for product");
  assertEqual(attentionReasons(ticket("TS-5", { ...wfp, cps: [cp("CP-9", "rejected"), cp("CP-10", "shipped")] }), NOW).map((r) => r.label), ["CP shipped"], "shipped beats rejected in the label");
  assertEqual(attentionReasons(ticket("TS-6", { ...wfp, cps: [cp("CP-9", "rejected")] }), NOW).map((r) => r.label), ["CP rejected"], "every CP rejected");
  assertEqual(kinds(ticket("TS-7", { ...wfp, cps: [cp("CP-9", "shipped"), cp("CP-10", "open")] })), [], "one CP is still open: engineering has work");
  assertEqual(kinds(ticket("TS-8", { ...wfp, cps: [] })), ["wfp_no_cp"], "Waiting for product with no CP at all");
  assertEqual(kinds(ticket("TS-9", { ...wfp, cps: [{ ...cp("CP-9", "open"), isEpic: true }] })), ["wfp_no_cp"], "an Epic isn't a CP engineering is working");
  assertEqual(kinds(ticket("TS-10", { ...wfp, cps: [cp("CP-9", "shipped")], lastActivityAt: ago(2 * HOUR) })), [], "hand-backs wait a working day");
  console.log("PASS");
}

function testQuietAndSlack(): void {
  console.log("\n--- Test: quiet tickets and live Slack threads ---");
  assertEqual(kinds(ticket("TS-1", { lastActivityAt: ago(2 * DAY + 2 * HOUR) })), ["quiet_on_ts"], "a High on TS quiet for 2+ days");
  assertEqual(kinds(ticket("TS-2", { lastActivityAt: ago(1 * DAY + 2 * HOUR) })), [], "a High gets two days");
  assertEqual(kinds(ticket("TS-3", { lastActivityAt: ago(1 * DAY + 2 * HOUR), priority: "Critical" })), ["quiet_on_ts"], "a Critical gets one");

  /* Last touched Friday afternoon; Monday afternoon it has been quiet one working day, not three. */
  const monday = Date.parse("2026-10-05T15:00:00Z");
  const fridayTouched = ticket("TS-4", { lastActivityAt: "2026-10-02T15:00:00.000Z", priority: "High" });
  assertEqual(attentionReasons(fridayTouched, monday).map((r) => r.kind), [], "the weekend doesn't count as quiet time");

  /* Six calendar days back from Wednesday spans a weekend: four working days. */
  assertEqual(kinds(ticket("TS-5", { lastActivityAt: ago(6 * DAY), whoseMove: "on_engineering" })), [], "a High in engineering gets five working days");
  assertEqual(attentionReasons(ticket("TS-6", { lastActivityAt: ago(8 * DAY), whoseMove: "on_engineering" }), NOW).map((r) => r.label), ["Engineering quiet 6d"], "then it's worth a nudge");
  assertEqual(kinds(ticket("TS-7", { lastActivityAt: ago(6 * DAY), priority: "Critical", whoseMove: "on_engineering" })), ["quiet_engineering"], "a Critical gets three");
  assertEqual(kinds(ticket("TS-8", { lastActivityAt: ago(30 * DAY), whoseMove: "on_customer" })), [], "waiting on the customer is nobody's to chase here");

  const live = { activeConversations: 1, conversations: 1, lastActivityAt: ago(3 * HOUR) };
  assertEqual(kinds(ticket("TS-9", { slack: live })), ["slack_live"], "a Slack thread active in the last day");
  assertEqual(kinds(ticket("TS-10", { slack: { ...live, lastActivityAt: ago(2 * DAY) } })), [], "not one from two days ago");
  assertEqual(kinds(ticket("TS-11", { slack: live, whoseMove: "on_customer" })), [], "not while waiting on the customer");
  assertEqual(kinds(ticket("TS-12", { slack: live, priority: "Medium" })), [], "not for Medium");

  assertEqual(kinds(ticket("TS-13", { firstResponse: { breached: true, goalMs: HOUR, remainingMs: -DAY, state: "running" }, lastActivityAt: ago(3 * HOUR), whoseMove: "new" })), ["no_first_response"], "still new with the first-response target gone");
  assertEqual(kinds(ticket("TS-14", { firstResponse: { breached: true, goalMs: HOUR, remainingMs: -DAY, state: "running" } })), [], "answered tickets don't repeat it");
  console.log("PASS");
}

function testNeverForClosed(): void {
  console.log("\n--- Test: closed tickets never need attention; reasons are ordered ---");
  const closed = ticket("TS-1", { assignee: null, signals: [signal("ttr_breached", 1)], statusCategory: "done", ttr: running(-DAY), whoseMove: "closed" });
  assertEqual(attentionReasons(closed, NOW), [], "closed");
  assertEqual(needsAttention(closed, NOW), false, "closed does not need attention");
  assertEqual(attentionRank(closed, NOW), Number.POSITIVE_INFINITY, "and ranks last");

  const pile = ticket("TS-2", {
    assignee: null,
    lastActivityAt: ago(3 * DAY),
    signals: [signal("ttr_breached", 1), signal("priority_raised")],
    ttr: running(-DAY),
  });
  assertEqual(kinds(pile), ["sla_breached", "unassigned", "escalated_on_ts", "quiet_on_ts"], "most urgent first");
  assertEqual(attentionRank(pile, NOW), 0, "its rank is its most urgent reason's");
  for (const kind of Object.keys(ATTENTION_KIND_LABEL) as AttentionKind[]) {
    assert(ATTENTION_KIND_LABEL[kind].length > 0, `${kind} has a filter label`);
  }
  console.log("PASS");
}

function testViewSortAndFilter(): void {
  console.log("\n--- Test: the view, its default sort and the Attention filter ---");
  const context: ViewContext = { following: new Set(), me: "acc-me", now: NOW };
  const tickets = [
    ticket("TS-1", { lastActivityAt: ago(2 * DAY + 4 * HOUR) }),
    ticket("TS-2", { priority: "Critical", signals: [signal("ttr_breached", 1)], ttr: running(-HOUR) }),
    ticket("TS-3"),
    ticket("TS-4", { assignee: null, priority: "Critical" }),
    ticket("TS-5", { signals: [signal("ttr_breached", 1)], ttr: running(-5 * DAY) }),
    ticket("TS-6", { assignee: null, statusCategory: "done", whoseMove: "closed" }),
  ];

  const view = getView("needs_attention");
  assertEqual(view.label, "Needs attention", "label");
  assertEqual(view.section, "Inbox", "lives in the Inbox section");
  assertEqual(tickets.filter((t) => view.matches(t, context)).map((t) => t.key), ["TS-1", "TS-2", "TS-4", "TS-5"], "matches the tickets with a reason, never the closed one");
  assertEqual(viewCounts(tickets, context).needs_attention, 4, "the nav count");

  assertEqual(defaultSortFor("needs_attention"), "attention", "the view reads by urgency");
  assertEqual(defaultSortFor("all_open"), "sla", "other views keep the SLA order");

  const ordered = selectTickets(tickets, { filters: EMPTY_FILTERS, search: "", sort: "attention", view: "needs_attention" }, context).map((t) => t.key);
  /* Breached first (Critical before High), then unassigned, then quiet. */
  assertEqual(ordered, ["TS-2", "TS-5", "TS-4", "TS-1"], "urgent reasons first, priority breaking ties");
  assertEqual(sortTickets(tickets, "attention", NOW).map((t) => t.key).slice(-2), ["TS-3", "TS-6"], "tickets with no reason sort last");

  const options = facetOptions(tickets, "reason", NOW);
  assertEqual(options.map((o) => `${o.label}:${o.count}`), ["SLA breached:2", "Quiet on TS:1", "Unassigned:1"], "the Attention filter offers each reason with its count");
  const breachedOnly = applyFilters(tickets, toggleFilterValue(EMPTY_FILTERS, "reason", "sla_breached"), NOW);
  assertEqual(breachedOnly.map((t) => t.key), ["TS-2", "TS-5"], "filtering by a reason");
  console.log("PASS");
}

testWorkingElapsed();
testClocks();
testOwnershipAndPickup();
testEngineeringHandBack();
testQuietAndSlack();
testNeverForClosed();
testViewSortAndFilter();
console.log("\nAll tracker attention tests passed.");
