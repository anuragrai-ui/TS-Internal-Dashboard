import {
  CLOSED_STATUS_ID,
  EPIC_ISSUE_TYPE,
  ESCALATION_CP_ISSUE_TYPES,
  FIX_READY_STATUS_IDS,
  REJECTED_RESOLUTION_IDS,
  REJECTED_STATUS_IDS,
  SHIPPED_STATUS_IDS,
  SUPPORT_TICKET_ISSUE_TYPE_ID,
  WAITING_FOR_PRODUCT_STATUS_ID,
} from "@/lib/escalation/policy";

import type {
  ClassificationResult,
  CpOutcome,
  CpSnapshot,
  EscalationException,
  EscalationGroup,
  ExceptionTier,
  PersonRef,
  RoutingRow,
  TsLink,
  TsSnapshot,
} from "@/lib/escalation/types";

/**
 * Classification step of the engineering-escalation pilot: turns the TS
 * tickets waiting on product plus their linked CP snapshots into one
 * escalation group per CP key, and everything that can't be escalated
 * cleanly into typed exceptions. Pure - the caller supplies every snapshot
 * and the routing table, so the dry run and the tests see identical logic.
 */

/**
 * What a linked CP means for the escalation. Order matters: status sets win
 * over status category, because Jira files Ready for Release (10131) under
 * "done" even though nothing has shipped, and files HF-Ready for Release
 * (12665) under "indeterminate" - both mean "fix built, waiting to ship".
 */
export function cpOutcome(cp: CpSnapshot): CpOutcome {
  if (FIX_READY_STATUS_IDS.has(cp.statusId)) return "fix_ready";
  if (REJECTED_STATUS_IDS.has(cp.statusId)) return "rejected";
  if (SHIPPED_STATUS_IDS.has(cp.statusId)) return "shipped";

  /* Closed (6) and any other done-category status: only the resolution says
     whether a fix went out. No resolution is read as shipped, matching how
     the CP board closes released work. */
  if (cp.statusId === CLOSED_STATUS_ID || cp.statusCategory === "done") {
    return cp.resolutionId !== null && REJECTED_RESOLUTION_IDS.has(cp.resolutionId) ? "rejected" : "shipped";
  }

  return "open";
}

/**
 * The result depends only on the content of the inputs, never on their order
 * (ticket pages, map insertion, routing rows, links): duplicates of a ticket,
 * a CP or a routing row are each resolved by content.
 *
 * Known gap, pending a contract change: a ticket whose only pending CPs have
 * an issue type outside ESCALATION_CP_ISSUE_TYPES that is not Epic (say a
 * new "Spike" type) produces nothing. It gets no group and no exception, and
 * it is neither epic-only nor stale. It never becomes a Closure Candidate
 * (its CP is pending), but nothing lists it either. Every CP issue type seen
 * live is in the set today. Surfacing a new one needs an ExceptionKind or a
 * result field in types.ts.
 */
export function classify(
  tickets: TsSnapshot[],
  cps: Map<string, CpSnapshot>,
  routing: RoutingRow[],
): ClassificationResult {
  const routingByPod = indexRouting(routing);
  const isActivePod = (podOptionId: string | null): boolean => {
    if (podOptionId === null) return false;
    const pod = routingByPod.get(podOptionId);
    if (pod === undefined) return false;
    /* A conflicted pod counts as active if any of its rows is. The conflict
       is raised as actionable anyway, and a quieter tier would hide it. */
    return pod.conflict ? pod.rows.some((row) => row.mode !== "off") : pod.row.mode !== "off";
  };

  const exceptions: EscalationException[] = [];
  const groups = new Map<string, EscalationGroup>();
  const epicOnlyTsKeys = new Set<string>();
  /* Many TS tickets share one CP (up to 53 seen live), so an out-of-scope CP
     is counted once per CP key, not once per ticket waiting on it. */
  const outOfScopeCpKeys = new Set<string>();
  const outOfScopeCounts = new Map<string, number>();

  /* Key order, so the first ticket to reach a CP (which creates its group)
     does not depend on page order either. */
  for (const ticket of qualifyingTickets(tickets)) {
    /* The TS ticket's own Pod is never a routing key, but it is the best
       signal of whether a broken link is ours (the pilot pod) to chase. */
    const ticketTier: ExceptionTier = isActivePod(ticket.podOptionId) ? "actionable" : "info";
    const cpKeys = uniqueCpKeys(ticket.links);

    if (cpKeys.length === 0) {
      exceptions.push({
        detail: `${ticket.key} is Waiting for product with no linked CP`,
        kind: "no_open_cp",
        tier: ticketTier,
        tsKey: ticket.key,
      });
      continue;
    }

    const doneCps: Array<{ cp: CpSnapshot; outcome: CpOutcome }> = [];
    let unreadableCount = 0;
    let pendingCount = 0;
    let pendingEpicCount = 0;
    let joinedGroups = 0;
    /* Snapshot keys, not link keys: two link keys can resolve to one CP. */
    const handledCpKeys = new Set<string>();

    for (const cpKey of cpKeys) {
      const linked = cps.get(cpKey);
      if (linked === undefined) {
        unreadableCount += 1;
        exceptions.push({
          cpKey,
          detail: `${cpKey} is linked from ${ticket.key} but its snapshot could not be read`,
          kind: "cp_unreadable",
          tier: ticketTier,
          tsKey: ticket.key,
        });
        continue;
      }

      /* A moved or renamed CP can sit in the map under its old key and its
         new one. Prefer the copy stored under its own key, so every ticket
         sees one snapshot per CP, and handle that CP once per ticket.
         Otherwise the ticket is attached twice, which inflates the count
         that drives the priority bump. */
      const cp = cps.get(linked.key) ?? linked;
      if (handledCpKeys.has(cp.key)) continue;
      handledCpKeys.add(cp.key);

      const outcome = cpOutcome(cp);
      if (outcome !== "open" && outcome !== "fix_ready") {
        doneCps.push({ cp, outcome });
        continue;
      }

      pendingCount += 1;
      /* Issue type before any Pod check: work that can never escalate must
         not raise Pod exceptions or count as out of scope. */
      if (cp.issueTypeName === EPIC_ISSUE_TYPE) {
        pendingEpicCount += 1;
        continue;
      }
      /* Dropped silently - see "Known gap" on classify(). */
      if (!ESCALATION_CP_ISSUE_TYPES.has(cp.issueTypeName)) continue;

      if (cp.podOptionId === null) {
        exceptions.push({
          cpKey: cp.key,
          detail: `${cp.key} has no Pod set, so ${ticket.key} cannot be routed`,
          kind: "cp_pod_missing",
          tier: ticketTier,
          tsKey: ticket.key,
        });
        continue;
      }

      const pod = routingByPod.get(cp.podOptionId);
      const podLabel = cp.podName ? `${cp.podName} (${cp.podOptionId})` : cp.podOptionId;
      if (pod === undefined) {
        /* A Pod option nobody has mapped is always ours to fix: until it is,
           every CP filed under it silently escapes escalation. */
        exceptions.push({
          cpKey: cp.key,
          detail: `${cp.key} is on Pod ${podLabel}, which has no routing row`,
          kind: "cp_pod_unmapped",
          tier: "actionable",
          tsKey: ticket.key,
        });
        continue;
      }
      if (pod.conflict) {
        /* Same fix as an unmapped pod: the routing table must give this pod
           exactly one row. Until then it routes nowhere. */
        exceptions.push({
          cpKey: cp.key,
          detail: `${cp.key} is on Pod ${podLabel}, which has ${pod.rows.length} conflicting routing rows (modes: ${pod.rows.map((row) => row.mode).join(", ")}) - it cannot route until the pod has exactly one row`,
          kind: "cp_pod_unmapped",
          tier: "actionable",
          tsKey: ticket.key,
        });
        continue;
      }

      const { row } = pod;
      if (row.mode === "off") {
        if (!outOfScopeCpKeys.has(cp.key)) {
          outOfScopeCpKeys.add(cp.key);
          outOfScopeCounts.set(row.podName, (outOfScopeCounts.get(row.podName) ?? 0) + 1);
        }
        continue;
      }

      let group = groups.get(cp.key);
      if (group === undefined) {
        group = { cp, outcome, routing: row, tickets: [] };
        groups.set(cp.key, group);
      }
      group.tickets.push(ticket);
      joinedGroups += 1;
    }

    /* Stale only when every link was read and none is pending: an unreadable
       CP might still be open, and a ticket must never be suggested for
       closure while a linked CP could be open. */
    if (pendingCount === 0 && unreadableCount === 0) {
      const anyActiveCpPod = doneCps.some(({ cp }) => isActivePod(cp.podOptionId));
      const summary = doneCps.map(({ cp, outcome }) => `${cp.key} ${outcome}`).join(", ");
      exceptions.push({
        detail: `${ticket.key} is still Waiting for product but every linked CP is done (${summary}) - belongs in Closure Candidates, not the pod channel`,
        kind: "all_cps_done_stale",
        tier: anyActiveCpPod ? "actionable" : "info",
        tsKey: ticket.key,
      });
    }

    if (pendingCount > 0 && pendingEpicCount === pendingCount && unreadableCount === 0) {
      epicOnlyTsKeys.add(ticket.key);
    }

    if (ticket.ttr.state === "none" && joinedGroups > 0) {
      exceptions.push({
        detail: `${ticket.key} has no Time to Resolution cycle - the ladder still runs from WfP entry, but the TTR priority bump cannot apply`,
        kind: "no_ttr_cycle",
        tier: "info",
        tsKey: ticket.key,
      });
    }
  }

  const escalations = [...groups.values()].sort((a, b) => compareIssueKeys(a.cp.key, b.cp.key));
  const groupsByPod = new Map<string, EscalationGroup[]>();
  for (const group of escalations) {
    group.tickets.sort((a, b) => compareIssueKeys(a.key, b.key));
    groupsByPod.set(group.routing.podOptionId, [...(groupsByPod.get(group.routing.podOptionId) ?? []), group]);
  }
  for (const podGroups of groupsByPod.values()) {
    exceptions.push(...ownerExceptions(podGroups));
  }

  const outOfScopeByPod: Record<string, number> = {};
  for (const podName of [...outOfScopeCounts.keys()].sort(compareStrings)) {
    outOfScopeByPod[podName] = outOfScopeCounts.get(podName) ?? 0;
  }

  return {
    epicOnlyTsKeys: [...epicOnlyTsKeys].sort(compareIssueKeys),
    escalations,
    exceptions: sortExceptions(dedupeExceptions(exceptions)),
    outOfScopeByPod,
  };
}

/* One link per CP: the same CP is often linked twice (e.g. "relates to" plus
   "is blocked by"), which must not double-attach the ticket. Sorted so
   exception details don't change when Jira returns links in another order. */
function uniqueCpKeys(links: TsLink[]): string[] {
  return [...new Set(links.map((link) => link.cpKey))].sort(compareIssueKeys);
}

/**
 * Support Tickets in Waiting for product, one per key, in key order. Paged
 * JQL can return a ticket twice, and if the ticket is edited mid-run the
 * copies differ. Their links are merged: a link in either copy may be the
 * open CP the ticket waits on, and dropping it could make the ticket a false
 * Closure Candidate. All other fields come from one copy, chosen by content
 * rather than position, so page order never changes the result.
 */
function qualifyingTickets(tickets: TsSnapshot[]): TsSnapshot[] {
  const copiesByKey = new Map<string, TsSnapshot[]>();
  for (const ticket of tickets) {
    if (ticket.issueTypeId !== SUPPORT_TICKET_ISSUE_TYPE_ID || ticket.statusId !== WAITING_FOR_PRODUCT_STATUS_ID) {
      continue;
    }
    const copies = copiesByKey.get(ticket.key);
    if (copies === undefined) copiesByKey.set(ticket.key, [ticket]);
    else copies.push(ticket);
  }

  return [...copiesByKey.entries()]
    .sort(([a], [b]) => compareIssueKeys(a, b))
    .flatMap(([, copies]) => mergeCopies(copies) ?? []);
}

function mergeCopies(copies: TsSnapshot[]): TsSnapshot | undefined {
  if (copies.length <= 1) return copies[0];

  let base: TsSnapshot | undefined;
  let baseJson = "";
  const links = new Map<string, TsLink>();
  for (const copy of copies) {
    const json = canonicalJson(copy);
    if (base === undefined || compareStrings(json, baseJson) < 0) {
      base = copy;
      baseJson = json;
    }
    for (const link of copy.links) links.set(canonicalJson(link), link);
  }
  if (base === undefined) return undefined;

  const mergedLinks = [...links.entries()].sort(([a], [b]) => compareStrings(a, b)).map(([, link]) => link);
  return { ...base, links: mergedLinks };
}

/* A conflicted pod keeps every distinct row, so the exception can say what
   disagrees and the tier check can see whether any of them is active. */
type PodRouting = { conflict: false; row: RoutingRow } | { conflict: true; rows: RoutingRow[] };

/**
 * Routing rows by Pod option id. The routing page is edited by hand, so two
 * rows can claim the same pod. Keeping either one would let row order decide
 * whether a pod is live or off. So distinct rows for one pod are a conflict
 * that blocks routing until the table is fixed. Exact copies are harmless
 * and collapse into one row.
 */
function indexRouting(routing: RoutingRow[]): Map<string, PodRouting> {
  const distinctByPod = new Map<string, Map<string, RoutingRow>>();
  for (const row of routing) {
    const distinct = distinctByPod.get(row.podOptionId) ?? new Map<string, RoutingRow>();
    const fingerprint = canonicalJson(row);
    if (!distinct.has(fingerprint)) distinct.set(fingerprint, row);
    distinctByPod.set(row.podOptionId, distinct);
  }

  const index = new Map<string, PodRouting>();
  for (const [podOptionId, distinct] of distinctByPod) {
    const rows = [...distinct.entries()].sort(([a], [b]) => compareStrings(a, b)).map(([, row]) => row);
    const [only] = rows;
    if (rows.length === 1 && only !== undefined) index.set(podOptionId, { conflict: false, row: only });
    else index.set(podOptionId, { conflict: true, rows });
  }
  return index;
}

/* JSON with object keys sorted and undefined fields dropped. Two snapshots
   or rows with the same content then compare equal, whatever order their
   fields were built in. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) => {
    if (inner === null || typeof inner !== "object" || Array.isArray(inner)) return inner;
    return Object.fromEntries(
      Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => compareStrings(a, b)),
    );
  });
}

/**
 * Routing gaps on a pod that is about to post. Raised ONCE PER POD, not per
 * escalation: the fix is one routing-row edit, and 24 copies of "no L3
 * owner" buried the handful of real data problems in the first live dry run.
 * The detail says how many escalations the gap affects.
 */
function ownerExceptions(podGroups: EscalationGroup[]): EscalationException[] {
  const routing = podGroups[0]!.routing;
  const cpKeys = podGroups.map((group) => group.cp.key);
  const affects = `affects ${cpKeys.length} escalation${cpKeys.length === 1 ? "" : "s"} (${cpKeys.slice(0, 5).join(", ")}${cpKeys.length > 5 ? `, +${cpKeys.length - 5} more` : ""})`;
  const found: EscalationException[] = [];

  if (routing.owners.l3 === undefined) {
    found.push({
      detail: `${routing.podName} has no L3 owner configured - the top escalation level has nobody to reach; ${affects}`,
      kind: "l3_unconfigured",
      podName: routing.podName,
      tier: "actionable",
    });
  }

  if (routing.owners.supportOwner === undefined) {
    found.push({
      detail: `${routing.podName} has no support owner - support-side breaches after hand-back have nobody to tag; ${affects}`,
      kind: "support_owner_unconfigured",
      podName: routing.podName,
      tier: "info",
    });
  }

  const unmapped = [describeUnmapped("EM", routing.owners.em), describeUnmapped("PM", routing.owners.pm)].filter(
    (who): who is string => who !== null,
  );
  if (unmapped.length > 0) {
    /* Observe mode never mentions anyone, so a missing Slack id only blocks
       real pings once the pod is in shadow or live. */
    found.push({
      detail: `${routing.podName} ${unmapped.join(" and ")} cannot be @-mentioned (no verified Slack id); ${affects}`,
      kind: "person_unmapped",
      podName: routing.podName,
      tier: routing.mode === "observe" ? "info" : "actionable",
    });
  }

  return found;
}

function describeUnmapped(role: string, person: PersonRef | undefined): string | null {
  if (person === undefined) return `${role} (not configured)`;
  return person.slackUserId ? null : `${role} ${person.displayName}`;
}

/* Same (kind, ticket, CP) twice says nothing new; keep the louder tier if
   two paths ever disagree. */
function dedupeExceptions(exceptions: EscalationException[]): EscalationException[] {
  const byKey = new Map<string, EscalationException>();
  for (const exception of exceptions) {
    const key = JSON.stringify([exception.kind, exception.podName ?? "", exception.tsKey ?? "", exception.cpKey ?? ""]);
    const existing = byKey.get(key);
    if (existing === undefined || (existing.tier === "info" && exception.tier === "actionable")) {
      byKey.set(key, exception);
    }
  }
  return [...byKey.values()];
}

function sortExceptions(exceptions: EscalationException[]): EscalationException[] {
  const tierRank = (tier: ExceptionTier): number => (tier === "actionable" ? 0 : 1);
  return [...exceptions].sort(
    (a, b) =>
      tierRank(a.tier) - tierRank(b.tier) ||
      compareStrings(a.kind, b.kind) ||
      compareStrings(a.podName ?? "", b.podName ?? "") ||
      compareIssueKeys(a.cpKey ?? "", b.cpKey ?? "") ||
      compareIssueKeys(a.tsKey ?? "", b.tsKey ?? ""),
  );
}

/* Code-unit comparison, not localeCompare: output must not depend on the
   runtime's locale. */
function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Jira keys in numeric order (CP-99 before CP-100), so reports read the way
 * people scan a board. Non-key strings sort by their whole text with number
 * -1, which keeps this a total order (and puts "" first).
 */
function compareIssueKeys(a: string, b: string): number {
  const pa = parseIssueKey(a);
  const pb = parseIssueKey(b);
  return compareStrings(pa.project, pb.project) || pa.number - pb.number || compareStrings(a, b);
}

function parseIssueKey(key: string): { number: number; project: string } {
  const match = /^([A-Z][A-Z0-9_]*)-(\d+)$/.exec(key);
  if (match?.[1] === undefined || match[2] === undefined) return { number: -1, project: key };
  return { number: Number(match[2]), project: match[1] };
}
