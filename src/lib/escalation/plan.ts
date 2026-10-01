import { businessMsBetween, isWithinBusinessHours as calendarIsWithinBusinessHours } from "@/lib/escalation/businessHours";
import {
  compareIssueKeys,
  isVerifiedSlackUserId,
  renderBacklogDigest,
  renderFixReady,
  renderLevel,
  renderParent,
} from "@/lib/escalation/messages";

import type { NextLevel } from "@/lib/escalation/messages";
import type { EscalationPolicy, LadderThresholds } from "@/lib/escalation/policy";
import type {
  BusinessCalendar,
  EscalationGroup,
  EscalationLevel,
  PersonRef,
  PlannedEscalation,
  PlannedMessage,
  PlanResult,
  Priority,
  RoutingRow,
  TsSnapshot,
} from "@/lib/escalation/types";

/**
 * Planning step of the engineering-escalation pilot: turns classified
 * escalation groups into what WOULD be posted - levels, timings, mentions
 * and rendered text - without posting anything. This phase has no stored
 * state, so every group is planned as a "first sight": a new parent plus at
 * most the single highest level that is already due.
 *
 * The ladder runs on its own business-hours timer from Waiting for product
 * entry, because JSM's Time to Resolution is paused in that status on every
 * ticket. The frozen TTR remaining is only a priority-bump input; no
 * deadline is ever derived from it.
 */

export interface PlanContext {
  /* Injectable for tests; defaults to the calendar implementation in businessHours.ts. */
  businessMs?: (startMs: number, endMs: number, calendar: BusinessCalendar) => number;
  /* When set, anything already waiting before go-live is a backlog escalation timed from go-live. */
  goLiveAt?: string;
  isWithinBusinessHours?: (ms: number, calendar: BusinessCalendar) => boolean;
  newParentsPostedToday?: number;
  now: string;
  policy: EscalationPolicy;
}

export const NO_WFP_ENTRY_REASON = "no WfP entry time - timer starts now";

const MS_PER_HOUR = 3_600_000;
const PRIORITY_ORDER: Priority[] = ["Low", "Medium", "High", "Critical"];
/* A ticket with no priority is treated as the JSM default rather than dropped. */
const DEFAULT_PRIORITY: Priority = "Medium";
/* Bump reasons name the tickets involved; past this many the parent gets unreadable. */
const MAX_KEYS_PER_REASON = 5;

interface Draft {
  backlog: boolean;
  basePriority: Priority;
  bumpReasons: string[];
  effectivePriority: Priority;
  engineeringWaitBh: number;
  group: EscalationGroup;
  levelDue: EscalationLevel;
  nextLevel: NextLevel | null;
  notes: string[];
  thresholds: LadderThresholds;
  ticketWaitBh: Map<string, number | null>;
  waitT0Ms: number;
}

export function planEscalations(groups: EscalationGroup[], ctx: PlanContext): PlanResult {
  const nowMs = parseInstant(ctx.now, "now");
  const goLiveMs = ctx.goLiveAt === undefined ? null : parseInstant(ctx.goLiveAt, "goLiveAt");
  const businessMs = ctx.businessMs ?? businessMsBetween;
  const isWithinBusinessHours = ctx.isWithinBusinessHours ?? calendarIsWithinBusinessHours;
  const { policy } = ctx;

  /* Clamped: a WfP entry or go-live after `now` has simply not started waiting yet. */
  const waitedBh = (startMs: number): number => Math.max(0, businessMs(startMs, nowMs, policy.calendar)) / MS_PER_HOUR;

  const drafts = oneGroupPerCp(groups)
    .map((group) => draftEscalation(group, nowMs, goLiveMs, policy, waitedBh))
    .sort(compareDrafts);

  /* Every group is a new parent in this phase, so the caps apply in priority
     order: the most urgent CPs post first, the rest wait for a later run. */
  const remainingToday = Math.max(0, policy.maxNewParentsPerDay - Math.max(0, ctx.newParentsPostedToday ?? 0));
  const allowed = Math.max(0, Math.min(policy.maxNewParentsPerRun, remainingToday));
  const rateLimited = new Set(drafts.slice(allowed).map((draft) => draft.group.cp.key));

  const planned = drafts.map((draft) =>
    toPlanned(draft, rateLimited.has(draft.group.cp.key) ? [] : buildMessages(draft, policy)),
  );

  if (goLiveMs !== null && ctx.goLiveAt !== undefined) {
    attachBacklogDigest(planned, drafts, ctx.goLiveAt);
  }

  /* Quiet hours hold delivery, not planning: the plan stays visible and the
     sender posts it at the next business-hours run. Critical never waits. */
  const heldForQuietHours: string[] = [];
  const withMessages = planned.filter((escalation) => escalation.messages.length > 0);

  if (withMessages.some((escalation) => escalation.effectivePriority !== "Critical") && !isWithinBusinessHours(nowMs, policy.calendar)) {
    for (const escalation of withMessages) {
      if (escalation.effectivePriority !== "Critical") {
        heldForQuietHours.push(escalation.cpKey);
      }
    }
  }

  return {
    heldForQuietHours,
    planned,
    rateLimited: drafts.filter((draft) => rateLimited.has(draft.group.cp.key)).map((draft) => draft.group.cp.key),
  };
}

/* ------------------------------------------------------------------ drafts */

/**
 * The contract is one escalation per CP key, and classify.ts builds it that
 * way. The planner still enforces it: a repeated key (say, two classifier
 * runs concatenated) would otherwise post two parents under one dedupe key,
 * or list the key twice in rateLimited. Repeats of the same CP are merged
 * and their tickets unioned by TS key (also collapsing a TS key repeated
 * inside one group, which would inflate the attached-ticket bump). Repeats
 * that DISAGREE on the CP snapshot, outcome, routing or a shared TS ticket
 * throw instead: picking one would let input order decide who gets paged,
 * where, and on which ladder.
 */
function oneGroupPerCp(groups: EscalationGroup[]): EscalationGroup[] {
  const byCpKey = new Map<string, EscalationGroup>();

  for (const group of groups) {
    const cpKey = group.cp.key;
    const existing = byCpKey.get(cpKey);

    if (
      existing &&
      (existing.outcome !== group.outcome ||
        canonicalJson(existing.cp) !== canonicalJson(group.cp) ||
        canonicalJson(existing.routing) !== canonicalJson(group.routing))
    ) {
      throw new Error(`planEscalations: conflicting escalation groups for ${cpKey} (CP snapshot, outcome or routing differ)`);
    }

    byCpKey.set(cpKey, { ...group, tickets: unionTickets(cpKey, existing?.tickets ?? [], group.tickets) });
  }

  return [...byCpKey.values()];
}

function unionTickets(cpKey: string, current: TsSnapshot[], incoming: TsSnapshot[]): TsSnapshot[] {
  const byTsKey = new Map(current.map((ticket) => [ticket.key, ticket]));

  for (const ticket of incoming) {
    const existing = byTsKey.get(ticket.key);

    if (existing === undefined) {
      byTsKey.set(ticket.key, ticket);
    } else if (canonicalJson(existing) !== canonicalJson(ticket)) {
      throw new Error(`planEscalations: conflicting copies of ${ticket.key} under ${cpKey}`);
    }
  }

  return [...byTsKey.values()];
}

function draftEscalation(
  group: EscalationGroup,
  nowMs: number,
  goLiveMs: number | null,
  policy: EscalationPolicy,
  waitedBh: (startMs: number) => number,
): Draft {
  const notes: string[] = [];
  const ticketWaitBh = new Map<string, number | null>();
  const entries: number[] = [];

  for (const ticket of group.tickets) {
    const enteredMs = parseOptionalInstant(ticket.enteredWfpAt);
    ticketWaitBh.set(ticket.key, enteredMs === null ? null : waitedBh(enteredMs));

    if (enteredMs !== null) {
      entries.push(enteredMs);
    }
  }

  /* Still planned with no entry time at all: dropping it would hide a CP
     that is genuinely waiting. The note makes the guessed start visible. */
  let waitT0Ms = entries.length > 0 ? Math.min(...entries) : nowMs;

  if (entries.length === 0) {
    notes.push(NO_WFP_ENTRY_REASON);
  }

  const backlog = goLiveMs !== null && waitT0Ms < goLiveMs;

  if (backlog) {
    waitT0Ms = goLiveMs;
  }

  const basePriority = highestPriority(group.tickets);
  const bumpReasons = priorityBumpReasons(group.tickets, policy);
  const effectivePriority = bumpReasons.length > 0 ? stepUp(basePriority) : basePriority;
  const thresholds = policy.ladder[effectivePriority];
  const engineeringWaitBh = waitedBh(waitT0Ms);

  /* Fix ready stops the ladder: engineering has done its part. */
  const levelDue = group.outcome === "fix_ready" ? 0 : levelFor(engineeringWaitBh, thresholds);
  const nextLevel = group.outcome === "fix_ready" || levelDue === 3 ? null : nextLevelFor(levelDue, engineeringWaitBh, thresholds);

  return {
    backlog,
    basePriority,
    bumpReasons,
    effectivePriority,
    engineeringWaitBh,
    group,
    levelDue,
    nextLevel,
    notes,
    thresholds,
    ticketWaitBh,
    waitT0Ms,
  };
}

function highestPriority(tickets: TsSnapshot[]): Priority {
  if (tickets.length === 0) {
    return DEFAULT_PRIORITY;
  }

  return tickets.reduce<Priority>((best, ticket) => {
    const priority = ticket.priority ?? DEFAULT_PRIORITY;
    return rank(priority) > rank(best) ? priority : best;
  }, "Low");
}

/* Several reasons can apply at once; the caller still bumps only one step. */
function priorityBumpReasons(tickets: TsSnapshot[], policy: EscalationPolicy): string[] {
  const reasons: string[] = [];

  if (tickets.length >= policy.priorityBumpAttachedTickets) {
    reasons.push(`${tickets.length} TS tickets waiting on this CP`);
  }

  /* Uses the FROZEN remaining on paused cycles on purpose: it says how close
     the ticket already was when it entered Waiting for product. */
  const breached = tickets.filter((ticket) => ticket.ttr.breached);
  const nearlyBreached = tickets.filter((ticket) => {
    const { breached: isBreached, goalMs, remainingMs } = ticket.ttr;
    return (
      !isBreached &&
      goalMs !== null &&
      goalMs > 0 &&
      remainingMs !== null &&
      remainingMs <= policy.priorityBumpTtrRemainingFraction * goalMs
    );
  });
  const majorIncidents = tickets.filter((ticket) => ticket.majorIncident);

  if (breached.length > 0) {
    reasons.push(`TTR breached on ${listKeys(breached)}`);
  }

  if (nearlyBreached.length > 0) {
    const percent = Math.round(policy.priorityBumpTtrRemainingFraction * 100);
    reasons.push(`TTR at or under ${percent}% remaining on ${listKeys(nearlyBreached)}`);
  }

  if (majorIncidents.length > 0) {
    reasons.push(`major incident on ${listKeys(majorIncidents)}`);
  }

  return reasons;
}

function levelFor(waitBh: number, thresholds: LadderThresholds): EscalationLevel {
  if (waitBh >= thresholds.l3Bh) return 3;
  if (waitBh >= thresholds.l2Bh) return 2;
  if (waitBh >= thresholds.l1Bh) return 1;
  return 0;
}

function nextLevelFor(levelDue: 0 | 1 | 2, waitBh: number, thresholds: LadderThresholds): NextLevel {
  const level = (levelDue + 1) as 1 | 2 | 3;
  const thresholdBh = thresholdFor(level, thresholds);

  return { dueInBh: Math.max(0, thresholdBh - waitBh), level };
}

function thresholdFor(level: 1 | 2 | 3, thresholds: LadderThresholds): number {
  return level === 1 ? thresholds.l1Bh : level === 2 ? thresholds.l2Bh : thresholds.l3Bh;
}

/* ---------------------------------------------------------------- messages */

function buildMessages(draft: Draft, policy: EscalationPolicy): PlannedMessage[] {
  const { group } = draft;
  const cpKey = group.cp.key;
  const { owners } = group.routing;
  const assigneeMention = verifiedAssignee(group);
  const ccMentions = uniquePeople([owners.em, owners.pm]);

  const parent: PlannedMessage = {
    broadcast: false,
    dedupeKey: `${cpKey}:e1:parent`,
    kind: "parent",
    mentions: uniquePeople([assigneeMention ?? undefined, ...ccMentions]),
    text: renderParent(group, {
      ackDueBh: group.outcome === "fix_ready" ? null : policy.ackDueBh[draft.effectivePriority],
      assigneeMention,
      backlogGoLiveAt: draft.backlog ? new Date(draft.waitT0Ms).toISOString() : null,
      basePriority: draft.basePriority,
      bumpReasons: draft.bumpReasons,
      ccMentions,
      effectivePriority: draft.effectivePriority,
      engineeringWaitBh: draft.engineeringWaitBh,
      levelDue: draft.levelDue,
      nextLevel: draft.nextLevel,
      notes: draft.notes,
      state: group.outcome,
      ticketWaitBh: draft.ticketWaitBh,
      waitT0: new Date(draft.waitT0Ms).toISOString(),
    }),
  };

  /* Checked before the backlog rule: a fix-ready note is not a ladder level,
     so a fix that was already waiting to ship at go-live still says so. */
  if (group.outcome === "fix_ready") {
    return [
      parent,
      { broadcast: false, dedupeKey: `${cpKey}:e1:fix_ready`, kind: "fix_ready", mentions: [], text: renderFixReady(group) },
    ];
  }

  /* Backlog escalations only announce themselves at go-live: their timers
     start there, and a backlog of old waits must not fire a burst of levels. */
  if (draft.backlog || draft.levelDue === 0) {
    return [parent];
  }

  /* Only the highest due level: replaying L1 and L2 on first sight of an L3
     would just be three pings for one fact. */
  const level = draft.levelDue;
  const mentions = levelMentions(level, group.routing);

  return [
    parent,
    {
      broadcast: level >= 2,
      dedupeKey: `${cpKey}:e1:L${level}`,
      kind: `L${level}`,
      mentions,
      text: renderLevel(level, group, {
        effectivePriority: draft.effectivePriority,
        engineeringWaitBh: draft.engineeringWaitBh,
        l3Configured: owners.l3 !== undefined,
        mentions,
        nextLevel: draft.nextLevel,
        thresholdBh: thresholdFor(level, draft.thresholds),
      }),
    },
  ];
}

/* Each level re-tags everyone below it and adds one more owner. An unset
   L3 owner tags nobody extra - never a guessed substitute. */
function levelMentions(level: 1 | 2 | 3, routing: RoutingRow): PersonRef[] {
  const { em, l3, pm, pmManager } = routing.owners;

  if (level === 1) return uniquePeople([em, pm]);
  if (level === 2) return uniquePeople([em, pm, pmManager]);
  return uniquePeople([em, pm, pmManager, l3]);
}

/* The CP snapshot has no Slack id, so the assignee is only mentioned when a
   routing row already holds a VERIFIED Slack id for that same Jira account. */
function verifiedAssignee(group: EscalationGroup): PersonRef | null {
  const accountId = group.cp.assigneeAccountId;

  if (!accountId) {
    return null;
  }

  const { owners, extraAckers } = group.routing;
  const known = [owners.em, owners.pm, owners.pmManager, owners.l3, owners.supportOwner, ...extraAckers];
  const match = known.find((person) => person?.jiraAccountId === accountId && isVerifiedSlackUserId(person.slackUserId));

  return match ?? null;
}

function attachBacklogDigest(planned: PlannedEscalation[], drafts: Draft[], goLiveAt: string): void {
  const backlogKeys = drafts.filter((draft) => draft.backlog).map((draft) => draft.group.cp.key);

  if (backlogKeys.length === 0) {
    return;
  }

  /* Rides on the first backlog escalation that actually posts this run. If
     the caps hold back every backlog parent, the digest waits with them -
     its dedupe key keeps it to one post whenever it does go out. */
  const host = planned.find((escalation) => backlogKeys.includes(escalation.cpKey) && escalation.messages.length > 0);

  if (!host) {
    return;
  }

  host.messages.unshift({
    broadcast: false,
    dedupeKey: `backlog_digest:${goLiveAt}`,
    kind: "backlog_digest",
    mentions: [],
    text: renderBacklogDigest(backlogKeys, goLiveAt),
  });
}

/* ----------------------------------------------------------------- helpers */

function toPlanned(draft: Draft, messages: PlannedMessage[]): PlannedEscalation {
  const { group } = draft;

  return {
    channelId: postingChannel(group.routing),
    cpKey: group.cp.key,
    effectivePriority: draft.effectivePriority,
    engineeringWaitBh: draft.engineeringWaitBh,
    levelDue: draft.levelDue,
    messages,
    nextLevel: draft.nextLevel,
    podName: group.routing.podName,
    priorityBumpReasons: [...draft.bumpReasons, ...draft.notes],
    state: group.outcome,
    tsKeys: group.tickets.map((ticket) => ticket.key).sort(compareIssueKeys),
    waitT0: new Date(draft.waitT0Ms).toISOString(),
  };
}

/* A non-null channel means "posting there is allowed under this pod's
   mode": shadow posts to the shadow channel, observe posts nowhere. */
function postingChannel(routing: RoutingRow): string | null {
  if (routing.mode === "live") return routing.channelId ?? null;
  if (routing.mode === "shadow") return routing.shadowChannelId ?? null;
  return null;
}

function compareDrafts(a: Draft, b: Draft): number {
  return (
    rank(b.effectivePriority) - rank(a.effectivePriority) ||
    b.engineeringWaitBh - a.engineeringWaitBh ||
    compareIssueKeys(a.group.cp.key, b.group.cp.key)
  );
}

function rank(priority: Priority): number {
  return PRIORITY_ORDER.indexOf(priority);
}

function stepUp(priority: Priority): Priority {
  return PRIORITY_ORDER[Math.min(rank(priority) + 1, PRIORITY_ORDER.length - 1)] ?? priority;
}

function listKeys(tickets: TsSnapshot[]): string {
  const keys = tickets.map((ticket) => ticket.key).sort(compareIssueKeys);
  const shown = keys.slice(0, MAX_KEYS_PER_REASON).join(", ");

  return keys.length > MAX_KEYS_PER_REASON ? `${shown} +${keys.length - MAX_KEYS_PER_REASON} more` : shown;
}

/* mentions[] is what a sender will tag, so it must agree with the text: a
   Slack id the renderer refused (e.g. "U123|<!here>") is dropped here too,
   leaving that person a name-only, unverified mention. */
function uniquePeople(candidates: Array<PersonRef | undefined>): PersonRef[] {
  const seen = new Set<string>();
  const unique: PersonRef[] = [];

  for (const candidate of candidates) {
    if (!candidate) continue;

    const { slackUserId, ...unverified } = candidate;
    const person: PersonRef = isVerifiedSlackUserId(slackUserId) ? candidate : unverified;
    const identity = person.slackUserId ?? person.jiraAccountId ?? person.displayName.trim().toLowerCase();

    if (!seen.has(identity)) {
      seen.add(identity);
      unique.push(person);
    }
  }

  return unique;
}

/* Key order differs between snapshot builders; content is what has to match. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, nested: unknown) =>
    nested !== null && typeof nested === "object" && !Array.isArray(nested)
      ? Object.fromEntries(Object.entries(nested).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : nested,
  );
}

function parseInstant(iso: string, label: string): number {
  const ms = Date.parse(iso);

  if (Number.isNaN(ms)) {
    throw new Error(`planEscalations: ${label} is not a valid instant (${iso})`);
  }

  return ms;
}

/* A malformed changelog timestamp is treated like a missing one, not a crash. */
function parseOptionalInstant(iso: string | null): number | null {
  if (iso === null) {
    return null;
  }

  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}
