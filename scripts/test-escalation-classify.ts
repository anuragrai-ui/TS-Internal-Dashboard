import { classify, cpOutcome } from "@/lib/escalation/classify";
import { seedRoutingRows } from "@/lib/escalation/policy";
import type {
  ClassificationResult,
  CpOutcome,
  CpSnapshot,
  EscalationException,
  ExceptionKind,
  ParsedSla,
  RoutingRow,
  TsLink,
  TsSnapshot,
} from "@/lib/escalation/types";

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} failed: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assert(condition: boolean, label: string): asserts condition {
  if (!condition) {
    throw new Error(`Assertion failed: ${label}`);
  }
}

/* Ids as read live on 2026-10-02 (see policy.ts). */
const CREDENTIALING = { id: "12448", name: "Credentialing" };
const PROVIDER_PORTAL = { id: "10361", name: "Provider Portal" };
const SUPPORT_TICKET = "10844";
/* Not the Support Ticket type - stands in for the TS project's Operations Ticket. */
const OPERATIONS_TICKET = "10845";
const WAITING_FOR_PRODUCT = "10633";

/* Every TTR on a WfP ticket is paused live; remainingMs is the frozen value. */
const PAUSED_TTR: ParsedSla = {
  breached: false,
  goalMs: 45 * 3_600_000,
  remainingMs: 30 * 3_600_000,
  state: "paused",
  withinCalendarHours: false,
};

const RELEASED: Partial<CpSnapshot> = {
  resolutionId: "10045",
  resolutionName: "Fixed",
  statusCategory: "done",
  statusId: "10571",
  statusName: "Released",
};
const OFF_POD: Partial<CpSnapshot> = { podName: PROVIDER_PORTAL.name, podOptionId: PROVIDER_PORTAL.id };
const NO_POD: Partial<CpSnapshot> = { podName: null, podOptionId: null };
const UNMAPPED_POD: Partial<CpSnapshot> = { podName: "Brand New Pod", podOptionId: "19999" };

function makeCp(key: string, overrides: Partial<CpSnapshot> = {}): CpSnapshot {
  return {
    assigneeAccountId: "712020:aaaa-bbbb",
    assigneeName: "Some Engineer",
    issueTypeId: "10004",
    issueTypeName: "Bug",
    key,
    podName: CREDENTIALING.name,
    podOptionId: CREDENTIALING.id,
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

function link(cpKey: string, overrides: Partial<TsLink> = {}): TsLink {
  return { cpKey, direction: "outward", linkTypeId: "10003", linkTypeName: "Relates", ...overrides };
}

function makeTs(key: string, cpKeys: string[], overrides: Partial<TsSnapshot> = {}): TsSnapshot {
  return {
    assigneeAccountId: "712020:cccc-dddd",
    assigneeName: "Support Agent",
    enteredWfpAt: "2026-09-28T14:00:00.000Z",
    issueTypeId: SUPPORT_TICKET,
    key,
    links: cpKeys.map((cpKey) => link(cpKey)),
    majorIncident: false,
    podOptionId: CREDENTIALING.id,
    priority: "Medium",
    statusCategory: "indeterminate",
    statusId: WAITING_FOR_PRODUCT,
    statusName: "Waiting for product",
    ttr: PAUSED_TTR,
    url: `https://certifyos.atlassian.net/browse/${key}`,
    ...overrides,
  };
}

function cpMap(...snapshots: CpSnapshot[]): Map<string, CpSnapshot> {
  return new Map(snapshots.map((cp) => [cp.key, cp]));
}

function exceptionsOf(result: ClassificationResult, kind: ExceptionKind): EscalationException[] {
  return result.exceptions.filter((exception) => exception.kind === kind);
}

/* A Credentialing row with every owner verified, so tests about routing don't
   also have to wade through owner exceptions. */
function configuredRouting(mode: RoutingRow["mode"] = "live"): RoutingRow[] {
  return seedRoutingRows("observe").map((row) =>
    row.podOptionId === CREDENTIALING.id
      ? {
          ...row,
          mode,
          owners: {
            em: { displayName: "Saro Deravanesian", slackUserId: "U0EM" },
            l3: { displayName: "Top Owner", slackUserId: "U0L3" },
            pm: { displayName: "Prashanth Venkataraman", slackUserId: "U0PM" },
            pmManager: { displayName: "Simon Hayhurst", slackUserId: "U0PMM" },
            supportOwner: { displayName: "Support Lead", slackUserId: "U0SUP" },
          },
        }
      : row,
  );
}

// --- cpOutcome ---

function testCpOutcomeCoversEveryCpStatus(): void {
  console.log("\n--- Test: cpOutcome maps every live CP / Hotfix / Epic status ---");

  const cases: Array<[string, CpSnapshot["statusCategory"], string | null, CpOutcome, string]> = [
    ["10000", "new", null, "open", "Backlog"],
    ["10534", "new", null, "open", "Selected For Sprint"],
    ["10007", "new", null, "open", "Blocked"],
    ["3", "indeterminate", null, "open", "In Progress"],
    ["10577", "indeterminate", null, "open", "In-Review"],
    ["10576", "indeterminate", null, "open", "Review-failed"],
    ["10667", "indeterminate", null, "open", "Ready for Testing"],
    ["10570", "indeterminate", null, "open", "In Testing"],
    ["10699", "indeterminate", null, "open", "Testing Failed"],
    ["10765", "indeterminate", null, "open", "Rolled Back"],
    ["12660", "new", null, "open", "HF-Submitted"],
    ["12661", "indeterminate", null, "open", "HF-Under Review"],
    ["12662", "indeterminate", null, "open", "HF-Approved"],
    ["12664", "indeterminate", null, "open", "HF-in Progress"],
    ["10131", "done", "10078", "fix_ready", "Ready for Release (done category)"],
    ["12665", "indeterminate", null, "fix_ready", "HF-Ready for Release (indeterminate category)"],
    ["10571", "done", "10045", "shipped", "Released"],
    ["12666", "done", "10000", "shipped", "HF-Released"],
    ["12912", "done", "10000", "shipped", "HF-Closed"],
    ["12663", "done", "10004", "rejected", "HF-Rejected"],
    ["10132", "done", "10009", "rejected", "Won't Do (Epic)"],
    ["10002", "done", "10000", "shipped", "Done (Epic)"],
    ["6", "done", "10000", "shipped", "Closed + Done"],
    ["6", "done", "10045", "shipped", "Closed + Fixed"],
    ["6", "done", "10078", "shipped", "Closed + Ready to Release"],
    ["6", "done", "10011", "shipped", "Closed + Software failure"],
    ["6", "done", null, "shipped", "Closed with no resolution"],
    ["6", "done", "10009", "rejected", "Closed + Won't Do"],
    ["6", "done", "10002", "rejected", "Closed + Duplicate"],
    ["6", "done", "10003", "rejected", "Closed + Cannot Reproduce"],
    ["6", "done", "10004", "rejected", "Closed + Declined"],
    ["6", "done", "10006", "rejected", "Closed + Known Issue"],
    ["6", "done", "10046", "rejected", "Closed + Working as Designed"],
  ];

  for (const [statusId, statusCategory, resolutionId, expected, label] of cases) {
    const outcome = cpOutcome(makeCp("CP-1", { resolutionId, statusCategory, statusId, statusName: label }));
    assertEqual(outcome, expected, `cpOutcome(${label})`);
  }

  console.log(`PASS: all ${cases.length} status/resolution combinations map as specified.`);
}

function testCpOutcomeStatusSetsWinOverResolution(): void {
  console.log("\n--- Test: status sets are checked before category and resolution ---");

  /* Ready for Release with a stray "Won't Do" resolution is still unshipped work. */
  assertEqual(
    cpOutcome(makeCp("CP-1", { resolutionId: "10009", statusCategory: "done", statusId: "10131" })),
    "fix_ready",
    "Ready for Release beats a rejected resolution",
  );
  assertEqual(
    cpOutcome(makeCp("CP-1", { resolutionId: "10002", statusCategory: "done", statusId: "12666" })),
    "shipped",
    "HF-Released beats a Duplicate resolution",
  );
  assertEqual(
    cpOutcome(makeCp("CP-1", { resolutionId: "10000", statusCategory: "done", statusId: "12663" })),
    "rejected",
    "HF-Rejected beats a Done resolution",
  );
  /* A done-category status nobody listed yet still resolves by its resolution. */
  assertEqual(
    cpOutcome(makeCp("CP-1", { resolutionId: "10046", statusCategory: "done", statusId: "99999" })),
    "rejected",
    "unknown done status + Working as Designed",
  );
  assertEqual(
    cpOutcome(makeCp("CP-1", { resolutionId: "10045", statusCategory: "done", statusId: "99999" })),
    "shipped",
    "unknown done status + Fixed",
  );
  /* A resolution on a non-done status (left over from a reopen) doesn't close it. */
  assertEqual(
    cpOutcome(makeCp("CP-1", { resolutionId: "10009", statusCategory: "indeterminate", statusId: "10765" })),
    "open",
    "Rolled Back with a stale Won't Do resolution",
  );

  console.log("PASS: fix_ready / rejected / shipped status sets take precedence, in that order.");
}

// --- classify: grouping ---

function testSharedCpIsOneGroup(): void {
  console.log("\n--- Test: a Credentialing CP shared by 3 TS tickets is ONE escalation with 3 tickets ---");

  const cps = cpMap(makeCp("CP-5001"));
  const tickets = [makeTs("TS-12", ["CP-5001"]), makeTs("TS-100", ["CP-5001"]), makeTs("TS-3", ["CP-5001"])];

  const result = classify(tickets, cps, configuredRouting());

  assertEqual(result.escalations.length, 1, "one group per CP key");
  const group = result.escalations[0];
  assertEqual(group?.cp.key, "CP-5001", "group is keyed on the CP");
  assertEqual(group?.outcome, "open", "In Progress CP is open");
  assertEqual(group?.routing.channelId, "C08CUMU0F6G", "routes to the Credentialing channel");
  assertEqual(
    group?.tickets.map((t) => t.key),
    ["TS-3", "TS-12", "TS-100"],
    "tickets sorted by key (numerically)",
  );
  assertEqual(result.exceptions, [], "fully configured pod raises nothing");
  assertEqual(result.outOfScopeByPod, {}, "nothing out of scope");

  console.log("PASS: three tickets collapse into a single escalation on the shared CP.");
}

function testReadyForReleaseIsFixReadyGroup(): void {
  console.log("\n--- Test: a Ready for Release CP still forms a group, with outcome fix_ready ---");

  const cps = cpMap(
    makeCp("CP-6001", { resolutionId: "10078", statusCategory: "done", statusId: "10131", statusName: "Ready for Release" }),
    makeCp("CP-6002", { issueTypeName: "Hotfix Request", statusId: "12665", statusName: "HF-Ready for Release" }),
  );
  const result = classify([makeTs("TS-1", ["CP-6001"]), makeTs("TS-2", ["CP-6002"])], cps, configuredRouting());

  assertEqual(
    result.escalations.map((g) => [g.cp.key, g.outcome]),
    [
      ["CP-6001", "fix_ready"],
      ["CP-6002", "fix_ready"],
    ],
    "both fix-ready statuses form fix_ready groups",
  );
  assertEqual(exceptionsOf(result, "all_cps_done_stale"), [], "fix-ready is still pending, never stale");

  console.log("PASS: Ready for Release (done) and HF-Ready for Release (indeterminate) both stay pending as fix_ready.");
}

function testRoutesByCpPodNotTicketPod(): void {
  console.log("\n--- Test: routing follows the CP's Pod, never the TS ticket's Pod ---");

  const cps = cpMap(
    makeCp("CP-7001"),
    makeCp("CP-7002", { podName: PROVIDER_PORTAL.name, podOptionId: PROVIDER_PORTAL.id }),
  );
  const tickets = [
    /* Ticket says Provider Portal, CP says Credentialing -> escalates. */
    makeTs("TS-1", ["CP-7001"], { podOptionId: PROVIDER_PORTAL.id }),
    /* Ticket says Credentialing, CP says Provider Portal (off) -> does not. */
    makeTs("TS-2", ["CP-7002"], { podOptionId: CREDENTIALING.id }),
  ];

  const result = classify(tickets, cps, configuredRouting());

  assertEqual(
    result.escalations.map((g) => g.cp.key),
    ["CP-7001"],
    "only the Credentialing CP escalates",
  );
  assertEqual(result.escalations[0]?.tickets.map((t) => t.key), ["TS-1"], "the Provider Portal-labelled ticket joins");
  assertEqual(result.outOfScopeByPod, { "Provider Portal": 1 }, "the other CP is out of scope");

  console.log("PASS: the TS Pod is ignored for routing in both directions.");
}

// --- classify: stale / epic / out of scope ---

function testReleasedCpIsStale(): void {
  console.log("\n--- Test: a Released CP makes the ticket all_cps_done_stale, tiered by the CP's pod ---");

  const cps = cpMap(
    makeCp("CP-8001", { resolutionId: "10045", statusCategory: "done", statusId: "10571", statusName: "Released" }),
    makeCp("CP-8002", {
      podName: PROVIDER_PORTAL.name,
      podOptionId: PROVIDER_PORTAL.id,
      resolutionId: "10045",
      statusCategory: "done",
      statusId: "10571",
      statusName: "Released",
    }),
  );
  /* TS-2's own pod is Credentialing, but its CP is on an off pod: the CP's pod decides. */
  const result = classify([makeTs("TS-1", ["CP-8001"]), makeTs("TS-2", ["CP-8002"])], cps, configuredRouting());

  assertEqual(result.escalations, [], "a shipped CP never escalates");
  const stale = exceptionsOf(result, "all_cps_done_stale");
  assertEqual(
    stale.map((e) => [e.tsKey, e.tier]),
    [
      ["TS-1", "actionable"],
      ["TS-2", "info"],
    ],
    "actionable only when a CP is on an active pod",
  );
  assert(stale[0]?.detail.includes("CP-8001 shipped") === true, "detail names the CP and its outcome");
  assertEqual(result.outOfScopeByPod, {}, "done CPs are not counted as out of scope");

  console.log("PASS: Released CPs surface as Closure Candidates, not escalations.");
}

function testClosedWontDoIsRejectedAndStale(): void {
  console.log("\n--- Test: Closed + Won't Do is rejected, so the ticket is stale ---");

  const closedWontDo = makeCp("CP-8101", {
    resolutionId: "10009",
    resolutionName: "Won't Do",
    statusCategory: "done",
    statusId: "6",
    statusName: "Closed",
  });
  assertEqual(cpOutcome(closedWontDo), "rejected", "Closed + Won't Do is rejected");

  const result = classify([makeTs("TS-1", ["CP-8101"])], cpMap(closedWontDo), configuredRouting());

  assertEqual(result.escalations, [], "no escalation");
  const stale = exceptionsOf(result, "all_cps_done_stale");
  assertEqual(stale.length, 1, "one stale exception");
  assert(stale[0]?.detail.includes("CP-8101 rejected") === true, "detail says rejected");

  console.log("PASS: a CP closed without a fix still hands the ticket back to support.");
}

function testEpicOnlyTicket(): void {
  console.log("\n--- Test: a ticket whose only pending CPs are Epics is epicOnly, with no exception ---");

  const cps = cpMap(
    makeCp("CP-9001", { issueTypeName: "Epic", statusCategory: "indeterminate", statusId: "3" }),
    makeCp("CP-9002", { issueTypeName: "Epic", statusCategory: "new", statusId: "10000" }),
    makeCp("CP-9003", { resolutionId: "10045", statusCategory: "done", statusId: "10571" }),
    makeCp("CP-9004", { issueTypeName: "Epic", resolutionId: "10000", statusCategory: "done", statusId: "10002" }),
  );
  const tickets = [
    makeTs("TS-1", ["CP-9001"]),
    /* Two open Epics plus a Released bug: the Epics are still the only pending CPs. */
    makeTs("TS-2", ["CP-9002", "CP-9003", "CP-9001"]),
    /* An Epic that is Done is not pending at all -> plain stale, not epicOnly. */
    makeTs("TS-3", ["CP-9004"]),
  ];

  const result = classify(tickets, cps, configuredRouting());

  assertEqual(result.escalations, [], "Epics never escalate");
  assertEqual(result.epicOnlyTsKeys, ["TS-1", "TS-2"], "epic-only tickets listed, sorted");
  assertEqual(
    result.exceptions.map((e) => [e.kind, e.tsKey]),
    [["all_cps_done_stale", "TS-3"]],
    "only the Done-Epic ticket raises anything",
  );
  assertEqual(result.outOfScopeByPod, {}, "Epics are never counted as out of scope");

  console.log("PASS: open Epics block closure without escalating or raising exceptions.");
}

function testOutOfScopeCountedOncePerCp(): void {
  console.log("\n--- Test: an out-of-scope CP shared by 2 tickets is counted once ---");

  const cps = cpMap(
    makeCp("CP-1101", { podName: PROVIDER_PORTAL.name, podOptionId: PROVIDER_PORTAL.id }),
    makeCp("CP-1102", { podName: PROVIDER_PORTAL.name, podOptionId: PROVIDER_PORTAL.id, statusId: "10131", statusCategory: "done" }),
    makeCp("CP-1103", { podName: "MDM", podOptionId: "12444" }),
  );
  const tickets = [
    makeTs("TS-1", ["CP-1101"], { podOptionId: PROVIDER_PORTAL.id }),
    makeTs("TS-2", ["CP-1101", "CP-1102"], { podOptionId: PROVIDER_PORTAL.id }),
    makeTs("TS-3", ["CP-1103"], { podOptionId: null }),
  ];

  const result = classify(tickets, cps, configuredRouting());

  assertEqual(result.escalations, [], "off pods never escalate");
  assertEqual(result.outOfScopeByPod, { MDM: 1, "Provider Portal": 2 }, "one per CP key, keys sorted by pod name");
  assertEqual(result.exceptions, [], "out-of-scope CPs raise no exceptions");

  console.log("PASS: out-of-scope work is counted per CP and stays silent.");
}

function testMixedTicket(): void {
  console.log("\n--- Test: one open Credentialing CP + one out-of-scope CP on the same ticket ---");

  const cps = cpMap(
    makeCp("CP-1201"),
    makeCp("CP-1202", { podName: PROVIDER_PORTAL.name, podOptionId: PROVIDER_PORTAL.id }),
  );
  const result = classify([makeTs("TS-1", ["CP-1202", "CP-1201"])], cps, configuredRouting());

  assertEqual(result.escalations.map((g) => g.cp.key), ["CP-1201"], "joins only the Credentialing group");
  assertEqual(result.outOfScopeByPod, { "Provider Portal": 1 }, "the other CP is counted");
  assertEqual(result.exceptions, [], "neither stale nor epic-only nor an exception");
  assertEqual(result.epicOnlyTsKeys, [], "not epic-only");

  console.log("PASS: a ticket can escalate on one CP while another CP is out of scope.");
}

function testTicketJoinsSeveralGroups(): void {
  console.log("\n--- Test: a ticket waiting on two Credentialing CPs joins both groups ---");

  const cps = cpMap(makeCp("CP-1301"), makeCp("CP-1302", { issueTypeName: "Story", statusId: "10007", statusCategory: "new" }));
  const result = classify(
    [makeTs("TS-1", ["CP-1302", "CP-1301"]), makeTs("TS-2", ["CP-1301"])],
    cps,
    configuredRouting(),
  );

  assertEqual(
    result.escalations.map((g) => [g.cp.key, g.tickets.map((t) => t.key)]),
    [
      ["CP-1301", ["TS-1", "TS-2"]],
      ["CP-1302", ["TS-1"]],
    ],
    "TS-1 appears in both groups",
  );

  console.log("PASS: groups are per CP; a ticket may belong to several.");
}

function testNonEscalationIssueTypeNeverEscalates(): void {
  console.log("\n--- Test: a pending CP of a non-escalation type (not Epic) never escalates ---");

  /* Pins the "Known gap" documented on classify(): the ticket produces nothing
     at all. If types.ts gains a way to surface it, this test should change. */
  const cps = cpMap(makeCp("CP-1401", { issueTypeName: "Spike" }));
  const result = classify([makeTs("TS-1", ["CP-1401"])], cps, configuredRouting());

  assertEqual(result.escalations, [], "no group");
  assertEqual(result.epicOnlyTsKeys, [], "not epic-only");
  assertEqual(result.exceptions, [], "still pending, so not stale either");
  assertEqual(result.outOfScopeByPod, {}, "not counted as out of scope");

  console.log("PASS: only ESCALATION_CP_ISSUE_TYPES escalate.");
}

function testNeverEscalatingTypesSkipPodChecks(): void {
  console.log("\n--- Test: pending Epics and non-escalation types skip every Pod check, on any pod ---");

  const cps = cpMap(
    makeCp("CP-2301", { ...OFF_POD, issueTypeName: "Epic" }),
    makeCp("CP-2302", { ...NO_POD, issueTypeName: "Epic" }),
    makeCp("CP-2303", { ...UNMAPPED_POD, issueTypeName: "Epic", statusCategory: "new", statusId: "10000" }),
    makeCp("CP-2311", { ...OFF_POD, issueTypeName: "Spike" }),
    makeCp("CP-2312", { ...NO_POD, issueTypeName: "Spike" }),
    makeCp("CP-2313", { ...UNMAPPED_POD, issueTypeName: "Spike" }),
  );
  /* Every ticket is on the active Credentialing pod, so a wrongly raised
     cp_pod_missing would come out actionable rather than slip by as info. */
  const tickets = [
    makeTs("TS-1", ["CP-2301"]),
    makeTs("TS-2", ["CP-2302"]),
    makeTs("TS-3", ["CP-2303"]),
    makeTs("TS-11", ["CP-2311"]),
    makeTs("TS-12", ["CP-2312"]),
    makeTs("TS-13", ["CP-2313"]),
  ];

  const result = classify(tickets, cps, configuredRouting());

  assertEqual(result.escalations, [], "nothing escalates");
  assertEqual(result.exceptions, [], "no cp_pod_missing / cp_pod_unmapped for work that can never escalate");
  assertEqual(result.outOfScopeByPod, {}, "an Epic or Spike on an off pod is not counted as out of scope");
  assertEqual(result.epicOnlyTsKeys, ["TS-1", "TS-2", "TS-3"], "the Epic tickets are epic-only whatever their pod");

  console.log("PASS: the issue-type check runs before any Pod check.");
}

function testStaleTierUsesAnyCpPod(): void {
  console.log("\n--- Test: all_cps_done_stale is actionable when ANY of the ticket's CPs is on an active pod ---");

  const cps = cpMap(
    makeCp("CP-2201", { ...RELEASED, ...OFF_POD }),
    /* The only active-pod CP sorts last, so a check of only the first CP, or
       an every() in place of some(), comes out info. */
    makeCp("CP-2202", RELEASED),
    makeCp("CP-2203", { ...RELEASED, ...OFF_POD }),
    makeCp("CP-2204", { ...RELEASED, ...UNMAPPED_POD }),
    makeCp("CP-2205", { ...RELEASED, ...NO_POD }),
  );
  const tickets = [
    /* The ticket's own pod is off, so only a CP pod can make this actionable. */
    makeTs("TS-1", ["CP-2201", "CP-2202"], { podOptionId: PROVIDER_PORTAL.id }),
    /* Off, unmapped and missing CP pods: none is active, even though the ticket's own pod is. */
    makeTs("TS-2", ["CP-2203", "CP-2204", "CP-2205"], { podOptionId: CREDENTIALING.id }),
  ];

  const result = classify(tickets, cps, configuredRouting());

  assertEqual(
    result.exceptions.map((e) => [e.kind, e.tier, e.tsKey]),
    [
      ["all_cps_done_stale", "actionable", "TS-1"],
      ["all_cps_done_stale", "info", "TS-2"],
    ],
    "one active CP pod is enough; done CPs raise no Pod exceptions",
  );

  console.log("PASS: the stale tier follows any active CP pod, not all of them, and never the ticket's pod.");
}

// --- classify: routing exceptions ---

function testUnknownPodIsUnmapped(): void {
  console.log("\n--- Test: a CP Pod option with no routing row -> cp_pod_unmapped (actionable) ---");

  const cps = cpMap(makeCp("CP-1501", { podName: "Brand New Pod", podOptionId: "19999" }));
  /* Even a ticket on an off pod: an unmapped option is always ours to fix. */
  const result = classify([makeTs("TS-1", ["CP-1501"], { podOptionId: PROVIDER_PORTAL.id })], cps, configuredRouting());

  assertEqual(result.escalations, [], "no group");
  assertEqual(
    result.exceptions.map((e) => [e.kind, e.tier, e.cpKey, e.tsKey]),
    [["cp_pod_unmapped", "actionable", "CP-1501", "TS-1"]],
    "one actionable cp_pod_unmapped",
  );
  assert(result.exceptions[0]?.detail.includes("19999") === true, "detail names the unmapped option id");

  console.log("PASS: unknown Pod options are flagged, never silently dropped.");
}

function testMissingPodTiering(): void {
  console.log("\n--- Test: a CP with no Pod -> cp_pod_missing, tiered by the TS ticket's own pod ---");

  const cps = cpMap(makeCp("CP-1601", { podName: null, podOptionId: null }));
  const tickets = [
    makeTs("TS-1", ["CP-1601"], { podOptionId: CREDENTIALING.id }),
    makeTs("TS-2", ["CP-1601"], { podOptionId: PROVIDER_PORTAL.id }),
    makeTs("TS-3", ["CP-1601"], { podOptionId: null }),
    makeTs("TS-4", ["CP-1601"], { podOptionId: "19999" }),
  ];

  const result = classify(tickets, cps, configuredRouting());

  assertEqual(result.escalations, [], "no group without a pod");
  assertEqual(
    result.exceptions.map((e) => [e.kind, e.tier, e.tsKey]),
    [
      ["cp_pod_missing", "actionable", "TS-1"],
      ["cp_pod_missing", "info", "TS-2"],
      ["cp_pod_missing", "info", "TS-3"],
      ["cp_pod_missing", "info", "TS-4"],
    ],
    "actionable only when the TS ticket is on an active pod",
  );

  console.log("PASS: missing CP pods are actionable for pilot-pod tickets, info otherwise.");
}

function testMissingSnapshotIsUnreadable(): void {
  console.log("\n--- Test: a link whose CP snapshot is missing -> cp_unreadable, and never stale ---");

  const cps = cpMap(makeCp("CP-1702", { resolutionId: "10045", statusCategory: "done", statusId: "10571" }));
  const tickets = [
    makeTs("TS-1", ["CP-1701"], { podOptionId: CREDENTIALING.id }),
    makeTs("TS-2", ["CP-1701"], { podOptionId: PROVIDER_PORTAL.id }),
    /* One Released + one unreadable: the unreadable one might be open, so not stale. */
    makeTs("TS-3", ["CP-1702", "CP-1703"]),
  ];

  const result = classify(tickets, cps, configuredRouting());

  assertEqual(
    result.exceptions.map((e) => [e.kind, e.tier, e.cpKey, e.tsKey]),
    [
      ["cp_unreadable", "actionable", "CP-1701", "TS-1"],
      ["cp_unreadable", "actionable", "CP-1703", "TS-3"],
      ["cp_unreadable", "info", "CP-1701", "TS-2"],
    ],
    "tiered by the ticket's pod; no stale for TS-3",
  );

  console.log("PASS: unreadable CPs are surfaced and block a stale verdict.");
}

function testNoLinksIsNoOpenCp(): void {
  console.log("\n--- Test: a WfP ticket with no CP links -> no_open_cp, tiered by its own pod ---");

  const result = classify(
    [makeTs("TS-1", []), makeTs("TS-2", [], { podOptionId: PROVIDER_PORTAL.id }), makeTs("TS-3", [], { podOptionId: null })],
    new Map(),
    configuredRouting(),
  );

  assertEqual(
    result.exceptions.map((e) => [e.kind, e.tier, e.tsKey]),
    [
      ["no_open_cp", "actionable", "TS-1"],
      ["no_open_cp", "info", "TS-2"],
      ["no_open_cp", "info", "TS-3"],
    ],
    "no_open_cp per ticket",
  );

  console.log("PASS: WfP without a CP is flagged for the pilot pod, info elsewhere.");
}

function testNoTtrCycle(): void {
  console.log("\n--- Test: ttr.state none -> no_ttr_cycle only when the ticket joined a group ---");

  const noTtr: ParsedSla = { breached: false, goalMs: null, remainingMs: null, state: "none", withinCalendarHours: null };
  const cps = cpMap(makeCp("CP-1801"), makeCp("CP-1802", { podName: PROVIDER_PORTAL.name, podOptionId: PROVIDER_PORTAL.id }));
  const result = classify(
    [makeTs("TS-1", ["CP-1801"], { ttr: noTtr }), makeTs("TS-2", ["CP-1802"], { ttr: noTtr })],
    cps,
    configuredRouting(),
  );

  assertEqual(result.escalations[0]?.tickets.map((t) => t.key), ["TS-1"], "TS-1 still escalates");
  assertEqual(
    result.exceptions.map((e) => [e.kind, e.tier, e.tsKey, e.cpKey]),
    [["no_ttr_cycle", "info", "TS-1", undefined]],
    "info exception for the escalating ticket only",
  );

  console.log("PASS: a missing TTR cycle is informational and never blocks escalation.");
}

// --- classify: owner exceptions ---

function testOwnerExceptionsWithSeedRows(): void {
  console.log("\n--- Test: seedRoutingRows(\"observe\") raises l3 / support owner / person_unmapped once per POD, not per escalation ---");

  const cps = cpMap(makeCp("CP-1901"), makeCp("CP-1902"));
  const tickets = [makeTs("TS-1", ["CP-1901"]), makeTs("TS-2", ["CP-1901"]), makeTs("TS-3", ["CP-1902"])];

  const observe = classify(tickets, cps, seedRoutingRows("observe"));

  assertEqual(observe.escalations.length, 2, "seed rows still route Credentialing");
  assertEqual(
    observe.exceptions.map((e) => [e.tier, e.kind, e.podName, e.cpKey, e.tsKey]),
    [
      ["actionable", "l3_unconfigured", "Credentialing", undefined, undefined],
      ["info", "person_unmapped", "Credentialing", undefined, undefined],
      ["info", "support_owner_unconfigured", "Credentialing", undefined, undefined],
    ],
    "one of each per pod, actionable first",
  );
  assert(
    exceptionsOf(observe, "l3_unconfigured")[0]?.detail.includes("affects 2 escalations (CP-1901, CP-1902)") === true,
    "the per-pod exception says which escalations it affects",
  );
  const unmapped = exceptionsOf(observe, "person_unmapped")[0];
  assert(unmapped?.detail.includes("EM Saro Deravanesian") === true, "names the EM");
  assert(unmapped?.detail.includes("PM Prashanth Venkataraman") === true, "names the PM");

  const shadow = classify(tickets, cps, seedRoutingRows("shadow"));
  assertEqual(
    exceptionsOf(shadow, "person_unmapped").map((e) => e.tier),
    ["actionable"],
    "person_unmapped is actionable once the pod can ping people",
  );

  /* Only the PM is missing a Slack id -> the detail names only the PM. */
  const pmOnly = configuredRouting("live").map((row) =>
    row.podOptionId === CREDENTIALING.id
      ? { ...row, owners: { ...row.owners, pm: { displayName: "Prashanth Venkataraman" } } }
      : row,
  );
  const pmResult = classify(tickets, cps, pmOnly);
  const pmException = exceptionsOf(pmResult, "person_unmapped")[0];
  assert(pmException?.detail.includes("PM Prashanth Venkataraman") === true, "names the PM");
  assert(pmException?.detail.includes("EM") === false, "does not name the verified EM");
  assertEqual(pmException?.tier, "actionable", "person_unmapped is actionable in live mode");
  assertEqual(pmResult.exceptions.length, 1, "only person_unmapped, one for the pod");

  /* No EM configured at all (not merely missing a Slack id) is just as unmentionable. */
  const noEm = configuredRouting("live").map((row) =>
    row.podOptionId === CREDENTIALING.id ? { ...row, owners: { ...row.owners, em: undefined } } : row,
  );
  const noEmResult = classify(tickets, cps, noEm);
  assertEqual(
    exceptionsOf(noEmResult, "person_unmapped").map((e) => [e.tier, e.podName]),
    [["actionable", "Credentialing"]],
    "a missing EM raises person_unmapped once for the pod, actionable in live",
  );
  const emException = exceptionsOf(noEmResult, "person_unmapped")[0];
  assert(emException?.detail.includes("EM (not configured)") === true, "names the missing EM");
  assert(emException?.detail.includes("PM") === false, "does not name the verified PM");
  assertEqual(noEmResult.exceptions.length, 1, "nothing but person_unmapped");

  console.log("PASS: owner gaps are raised once per pod, tiered by routing mode, naming who is unmapped.");
}

// --- classify: filtering, dedupe, determinism ---

function testIgnoresTicketsOutsideScope(): void {
  console.log("\n--- Test: tickets not in WfP, and non-Support-Ticket types, are ignored entirely ---");

  const cps = cpMap(makeCp("CP-2001"));
  const tickets = [
    makeTs("TS-1", ["CP-2001"], { statusCategory: "indeterminate", statusId: "10632", statusName: "In Progress" }),
    makeTs("TS-2", [], { statusId: "10632", statusName: "In Progress" }),
    makeTs("TS-3", ["CP-2001"], { issueTypeId: OPERATIONS_TICKET }),
    makeTs("TS-4", ["CP-2999"], { issueTypeId: OPERATIONS_TICKET }),
  ];

  const result = classify(tickets, cps, configuredRouting());

  assertEqual(
    result,
    { epicOnlyTsKeys: [], escalations: [], exceptions: [], outOfScopeByPod: {} },
    "nothing at all comes out",
  );

  console.log("PASS: out-of-scope tickets produce no groups and no exceptions.");
}

function testDuplicateLinksAndTicketsAreDeduped(): void {
  console.log("\n--- Test: the same CP linked twice, or the same ticket listed twice, attaches once ---");

  const cps = cpMap(makeCp("CP-2101"));
  const doubleLinked = makeTs("TS-1", [], {
    links: [link("CP-2101"), link("CP-2101", { direction: "inward", linkTypeId: "10000", linkTypeName: "Blocks" })],
  });
  const unreadableTwice = makeTs("TS-2", [], {
    links: [link("CP-2199"), link("CP-2199", { direction: "inward", linkTypeId: "10000", linkTypeName: "Blocks" })],
  });

  const result = classify([doubleLinked, doubleLinked, unreadableTwice], cps, configuredRouting());

  assertEqual(result.escalations[0]?.tickets.map((t) => t.key), ["TS-1"], "TS-1 attached once");
  assertEqual(
    result.exceptions.map((e) => [e.kind, e.cpKey, e.tsKey]),
    [["cp_unreadable", "CP-2199", "TS-2"]],
    "one cp_unreadable for the double link",
  );

  console.log("PASS: duplicate links and duplicate snapshots never double-count.");
}

function testMovedCpResolvesToOneSnapshot(): void {
  console.log("\n--- Test: two link keys that resolve to one CP snapshot attach the ticket once ---");

  /* CP-2401 was moved to CP-2402, and the reader stored the snapshot under both keys. */
  const moved = makeCp("CP-2402");
  const tickets = [makeTs("TS-1", ["CP-2401", "CP-2402"]), makeTs("TS-2", ["CP-2401"])];
  const result = classify(
    tickets,
    new Map([
      ["CP-2401", moved],
      ["CP-2402", moved],
    ]),
    configuredRouting(),
  );

  assertEqual(
    result.escalations.map((g) => [g.cp.key, g.tickets.map((t) => t.key)]),
    [["CP-2402", ["TS-1", "TS-2"]]],
    "one group under the snapshot's key, each ticket once",
  );
  assertEqual(result.exceptions, [], "nothing to report");

  /* The old key still holds a stale In Progress copy. The copy stored under
     the CP's own key is the current one, whichever link sorts first. */
  const staleOldKey = classify(
    tickets,
    new Map([
      ["CP-2401", makeCp("CP-2402")],
      ["CP-2402", makeCp("CP-2402", RELEASED)],
    ]),
    configuredRouting(),
  );
  assertEqual(staleOldKey.escalations, [], "the current snapshot says Released");
  const stale = exceptionsOf(staleOldKey, "all_cps_done_stale");
  assertEqual(stale.map((e) => e.tsKey), ["TS-1", "TS-2"], "both tickets go to Closure Candidates");
  assert(
    stale.every((e) => e.detail.includes("(CP-2402 shipped)")),
    "the CP is listed once, not once per link key",
  );

  console.log("PASS: CPs are handled once per ticket by snapshot key, not by link key.");
}

function testConflictingRoutingRowsBlockRouting(): void {
  console.log("\n--- Test: two different routing rows for one pod are a conflict, whatever their order ---");

  const rows = configuredRouting();
  const credentialing = rows.find((row) => row.podOptionId === CREDENTIALING.id);
  assert(credentialing !== undefined, "configured routing has a Credentialing row");
  /* A hand-edited duplicate on the routing page that would switch the pod off. */
  const dupOff: RoutingRow = { ...credentialing, mode: "off", podName: "Cred-dup" };
  const cps = cpMap(makeCp("CP-2501"));
  const tickets = [makeTs("TS-1", ["CP-2501"]), makeTs("TS-2", [])];

  const dupLast = classify(tickets, cps, [...rows, dupOff]);
  const dupFirst = classify(tickets, cps, [dupOff, ...rows]);

  assertEqual(dupFirst, dupLast, "row order does not decide the pod's mode");
  assertEqual(dupLast.escalations, [], "a conflicted pod routes nowhere");
  assertEqual(dupLast.outOfScopeByPod, {}, "and is not silently counted as off");
  assertEqual(
    dupLast.exceptions.map((e) => [e.tier, e.kind, e.cpKey, e.tsKey]),
    [
      ["actionable", "cp_pod_unmapped", "CP-2501", "TS-1"],
      ["actionable", "no_open_cp", undefined, "TS-2"],
    ],
    "the conflict is raised, and the pod still counts as active for ticket tiering",
  );
  assert(
    dupLast.exceptions[0]?.detail.includes("2 conflicting routing rows (modes: live, off)") === true,
    "detail says what conflicts",
  );

  /* An exact copy, even with fields in another order and an explicit
     undefined, is the same row and changes nothing. */
  const reorderedCopy = {
    ...(Object.fromEntries(Object.entries(credentialing).reverse()) as unknown as RoutingRow),
    shadowChannelId: undefined,
  };
  const exactCopy = classify(tickets, cps, [reorderedCopy, ...rows]);
  assertEqual(exactCopy.escalations.map((g) => g.cp.key), ["CP-2501"], "an identical duplicate row is harmless");
  assertEqual(
    exactCopy.exceptions.map((e) => [e.kind, e.tsKey]),
    [["no_open_cp", "TS-2"]],
    "no conflict for identical rows",
  );

  console.log("PASS: conflicting routing rows are surfaced and fail closed; identical copies collapse.");
}

function testDuplicateTicketCopiesMergeRegardlessOfOrder(): void {
  console.log("\n--- Test: differing copies of one ticket merge their links, whatever the page order ---");

  const cps = cpMap(makeCp("CP-2601"), makeCp("CP-2609"), makeCp("CP-2610", RELEASED));

  /* The same ticket read on two JQL pages around a mid-run edit. */
  const before = makeTs("TS-1", ["CP-2601"], { priority: "Medium" });
  const after = makeTs("TS-1", ["CP-2609"], { priority: "High" });
  const forward = classify([before, after], cps, configuredRouting());
  const reversed = classify([after, before], cps, configuredRouting());

  assertEqual(reversed, forward, "page order does not change the result, attached snapshot included");
  assertEqual(
    forward.escalations.map((g) => [g.cp.key, g.tickets.map((t) => t.key)]),
    [
      ["CP-2601", ["TS-1"]],
      ["CP-2609", ["TS-1"]],
    ],
    "a link from either copy is kept",
  );
  assertEqual(
    forward.escalations[0]?.tickets[0]?.links.map((l) => l.cpKey),
    ["CP-2601", "CP-2609"],
    "the attached snapshot carries the merged links",
  );

  /* One copy saw only the Released CP and the other only the open one. The
     ticket is still waiting on engineering, so it must never be reported
     as a Closure Candidate. */
  const staleCopy = makeTs("TS-2", ["CP-2610"]);
  const openCopy = makeTs("TS-2", ["CP-2601"]);
  for (const order of [
    [staleCopy, openCopy],
    [openCopy, staleCopy],
  ]) {
    const result = classify(order, cps, configuredRouting());
    assertEqual(exceptionsOf(result, "all_cps_done_stale"), [], "not stale while either copy links an open CP");
    assertEqual(
      result.escalations.map((g) => [g.cp.key, g.tickets.map((t) => t.key)]),
      [["CP-2601", ["TS-2"]]],
      "escalates on the open CP",
    );
  }

  /* Rule 1 applies per copy: a copy that already left Waiting for product
     does not qualify (classify cannot tell which copy is newer). */
  const leftWfp = makeTs("TS-3", ["CP-2609"], { statusId: "10632", statusName: "In Progress" });
  const stillWfp = makeTs("TS-3", ["CP-2601"]);
  const wfpLast = classify([leftWfp, stillWfp], cps, configuredRouting());
  assertEqual(classify([stillWfp, leftWfp], cps, configuredRouting()), wfpLast, "order-independent");
  assertEqual(
    wfpLast.escalations.map((g) => [g.cp.key, g.tickets.map((t) => t.key)]),
    [["CP-2601", ["TS-3"]]],
    "only the WfP copy's links count",
  );

  console.log("PASS: duplicate ticket copies resolve by content, keeping every link either copy saw.");
}

function testDeterministicOrdering(): void {
  console.log("\n--- Test: output is identical regardless of input order, and sorted as specified ---");

  const cps = cpMap(
    makeCp("CP-100"),
    makeCp("CP-99", { statusId: "10131", statusCategory: "done" }),
    makeCp("CP-7", { podName: null, podOptionId: null }),
    makeCp("CP-8", { podOptionId: "19999" }),
    makeCp("CP-9", { podName: PROVIDER_PORTAL.name, podOptionId: PROVIDER_PORTAL.id }),
    makeCp("CP-10", { issueTypeName: "Epic" }),
    makeCp("CP-11", { resolutionId: "10045", statusCategory: "done", statusId: "10571" }),
    makeCp("CP-12", { resolutionId: "10002", statusCategory: "done", statusId: "6" }),
  );
  const tickets = [
    makeTs("TS-20", ["CP-100", "CP-99"]),
    makeTs("TS-3", ["CP-100", "CP-7", "CP-8"]),
    makeTs("TS-110", ["CP-99", "CP-9"]),
    makeTs("TS-4", ["CP-10"]),
    makeTs("TS-5", ["CP-11"]),
    makeTs("TS-6", []),
    makeTs("TS-1", ["CP-404"]),
    makeTs("TS-7", ["CP-12", "CP-11"]),
    /* A second, differing copy of TS-20 from another JQL page: reversing the
       list must not change which copy's fields are attached. */
    makeTs("TS-20", ["CP-11"], { priority: "High" }),
  ];

  const forward = classify(tickets, cps, seedRoutingRows("observe"));
  const reversed = classify(
    [...tickets].reverse(),
    new Map([...cps.entries()].reverse()),
    [...seedRoutingRows("observe")].reverse(),
  );
  assertEqual(reversed, forward, "ticket / CP / routing order does not change the result");

  /* Reversed links change the attached snapshots themselves, so compare by key. */
  const byKeys = (result: ClassificationResult) => ({
    ...result,
    escalations: result.escalations.map((g) => [g.cp.key, g.tickets.map((t) => t.key)]),
  });
  const linksReversed = classify(
    tickets.map((t) => ({ ...t, links: [...t.links].reverse() })),
    cps,
    seedRoutingRows("observe"),
  );
  assertEqual(byKeys(linksReversed), byKeys(forward), "link order does not change the result");
  assert(
    exceptionsOf(forward, "all_cps_done_stale").some((e) => e.detail.includes("(CP-11 shipped, CP-12 rejected)")),
    "stale detail lists CPs in key order",
  );

  assertEqual(
    forward.escalations.map((g) => [g.cp.key, g.outcome, g.tickets.map((t) => t.key)]),
    [
      ["CP-99", "fix_ready", ["TS-20", "TS-110"]],
      ["CP-100", "open", ["TS-3", "TS-20"]],
    ],
    "escalations by CP key, tickets by TS key, both numeric",
  );
  assertEqual(
    forward.exceptions.map((e) => [e.tier, e.kind, e.cpKey ?? "", e.tsKey ?? ""]),
    [
      ["actionable", "all_cps_done_stale", "", "TS-5"],
      ["actionable", "all_cps_done_stale", "", "TS-7"],
      ["actionable", "cp_pod_missing", "CP-7", "TS-3"],
      ["actionable", "cp_pod_unmapped", "CP-8", "TS-3"],
      ["actionable", "cp_unreadable", "CP-404", "TS-1"],
      ["actionable", "l3_unconfigured", "", ""],
      ["actionable", "no_open_cp", "", "TS-6"],
      ["info", "person_unmapped", "", ""],
      ["info", "support_owner_unconfigured", "", ""],
    ],
    "exceptions by tier, kind, cpKey, tsKey",
  );
  assertEqual(forward.epicOnlyTsKeys, ["TS-4"], "epic-only");
  assertEqual(forward.outOfScopeByPod, { "Provider Portal": 1 }, "out of scope");

  console.log("PASS: classification is deterministic and ordered for stable diffs between runs.");
}

function main(): void {
  try {
    testCpOutcomeCoversEveryCpStatus();
    testCpOutcomeStatusSetsWinOverResolution();
    testSharedCpIsOneGroup();
    testReadyForReleaseIsFixReadyGroup();
    testRoutesByCpPodNotTicketPod();
    testReleasedCpIsStale();
    testClosedWontDoIsRejectedAndStale();
    testEpicOnlyTicket();
    testOutOfScopeCountedOncePerCp();
    testMixedTicket();
    testTicketJoinsSeveralGroups();
    testNonEscalationIssueTypeNeverEscalates();
    testNeverEscalatingTypesSkipPodChecks();
    testStaleTierUsesAnyCpPod();
    testUnknownPodIsUnmapped();
    testMissingPodTiering();
    testMissingSnapshotIsUnreadable();
    testNoLinksIsNoOpenCp();
    testNoTtrCycle();
    testOwnerExceptionsWithSeedRows();
    testIgnoresTicketsOutsideScope();
    testDuplicateLinksAndTicketsAreDeduped();
    testMovedCpResolvesToOneSnapshot();
    testConflictingRoutingRowsBlockRouting();
    testDuplicateTicketCopiesMergeRegardlessOfOrder();
    testDeterministicOrdering();
    console.log("\nAll escalation-classify tests passed.");
    process.exit(0);
  } catch (error) {
    console.error("\nEscalation-classify test failed:", error);
    process.exit(1);
  }
}

main();
