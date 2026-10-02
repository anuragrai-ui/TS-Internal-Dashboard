import {
  renderFixReadyFor,
  renderHandedBack,
  renderLadderResumed,
  renderPodChanged,
  renderResolved,
  renderTicketsChanged,
} from "@/lib/escalation/messages";
import { cpOutcome } from "@/lib/escalation/classify";
import { buildLevelMessage } from "@/lib/escalation/plan";
import { PILOT_POD_OPTION_ID } from "@/lib/escalation/policy";
import { isLiveState, reconcile } from "@/lib/escalation/stateMachine";

import type { CpRef } from "@/lib/escalation/messages";
import type { EscalationPolicy } from "@/lib/escalation/policy";
import type { EscalationRecord } from "@/lib/escalation/runnerStore";
import type { CurrentObservation, EscalationState, ReconcileEvent } from "@/lib/escalation/stateMachine";
import type { CpSnapshot, EscalationGroup, PlannedEscalation } from "@/lib/escalation/types";

/**
 * What one escalation's Slack thread should be told on this run - pure, so
 * every rule is tested with fixtures (scripts/test-escalation-runner.ts).
 *
 * The record says what the thread has already been told (announcedState,
 * announcedTsKeys, levelSent); anything that differs from the current state
 * is announced, then written back once the post succeeds. A failed post, or
 * a message held back by the caps, is just decided again next run, and the
 * dedupe keys make sure a retry never posts twice.
 *
 * - No thread yet (first sight, or a reopened episode): what the planner
 *   planned - the parent, plus the highest level already due or the
 *   fix-ready note, plus the one-off go-live digest.
 * - Thread exists: state transitions (fix ready, resolved, handed back, pod
 *   changed, back to open), tickets joining/leaving, and a newly due level.
 */

export type OutboundKind = "backlog_digest" | "level" | "parent" | "state" | "tickets";

export type OutboundEffect =
  | { type: "level"; level: 1 | 2 | 3 }
  | { type: "none" }
  | { type: "parent" }
  | { type: "state"; state: EscalationState }
  | { type: "tickets"; tsKeys: string[] };

export interface Outbound {
  dedupeKey: string;
  effect: OutboundEffect;
  kind: OutboundKind;
  /* Top-level in the channel (parent, digest) or a reply in the escalation's thread. */
  placement: "channel" | "thread";
  /* Null: nothing to post, just record the effect (silent transitions such as acked). */
  text: string | null;
}

export interface DecideInput {
  cp: CpSnapshot | null;
  /* This CP's group in the current classification (pilot pod, open or fix_ready) - null once it's done. */
  group: EscalationGroup | null;
  /* The planner's view of that group, uncapped. */
  planned: PlannedEscalation | null;
  policy: EscalationPolicy;
  /* State after reconcile, with the thread fields carried over. */
  record: EscalationRecord;
  ticketUrl: (key: string) => string;
}

export function decideThreadUpdates(input: DecideInput): Outbound[] {
  const { cp, group, planned, record } = input;
  const live = isLiveState(record.state);
  const prefix = `${record.cpKey}:e${record.episode}`;

  /* An unreadable CP keeps its state (reconcile) - there is nothing new to say. */
  if (cp === null) {
    return [];
  }

  if (!record.threadTs) {
    if (!live || planned === null || group === null) {
      return [];
    }
    /* The go-live digest isn't this CP's to post: the runner sends it once, whichever backlog parent opens first. */
    return planned.messages
      .filter((message) => message.kind !== "backlog_digest")
      .map((message): Outbound => {
        if (message.kind === "parent") {
          return { dedupeKey: `${prefix}:parent`, effect: { type: "parent" }, kind: "parent", placement: "channel", text: message.text };
        }
        if (message.kind === "fix_ready") {
          /* The parent already records the fix-ready state as announced; this is just its explanation. */
          return { dedupeKey: `${prefix}:fix_ready`, effect: { type: "none" }, kind: "state", placement: "thread", text: message.text };
        }
        const level = Number(message.kind.slice(1)) as 1 | 2 | 3;
        return { dedupeKey: `${prefix}:L${level}`, effect: { level, type: "level" }, kind: "level", placement: "thread", text: message.text };
      });
  }

  const out: Outbound[] = [];
  const cpRef: CpRef = { key: cp.key, statusName: cp.statusName, url: cp.url };
  let seq = record.announceSeq ?? 0;

  if (record.state !== record.announcedState) {
    seq += 1;
    out.push({
      dedupeKey: `${prefix}:s${seq}:${record.state}`,
      effect: { state: record.state, type: "state" },
      kind: "state",
      placement: "thread",
      text: stateText(record, cpRef, cp),
    });
  }

  if (live && record.state !== "suppressed") {
    const announced = record.announcedTsKeys ?? [];
    const waiting = record.qualifyingTsKeys ?? [];
    const joined = waiting.filter((key) => !announced.includes(key));
    const left = announced.filter((key) => !waiting.includes(key));
    if (joined.length > 0 || left.length > 0) {
      seq += 1;
      out.push({
        dedupeKey: `${prefix}:s${seq}:tickets`,
        effect: { tsKeys: [...waiting], type: "tickets" },
        kind: "tickets",
        placement: "thread",
        text: renderTicketsChanged(
          cpRef,
          joined.map((key) => ({ key, url: input.ticketUrl(key) })),
          left,
          waiting.length,
        ),
      });
    }
  }

  if ((record.state === "open" || record.state === "acked") && planned !== null && group !== null && planned.levelDue > record.levelSent) {
    const level = planned.levelDue as 1 | 2 | 3;
    out.push({
      dedupeKey: `${prefix}:L${level}`,
      effect: { level, type: "level" },
      kind: "level",
      placement: "thread",
      text: buildLevelMessage(level, group, planned, input.policy).text,
    });
  }

  return out;
}

/* What a state transition says in the thread; null for the ones that stay silent here. */
function stateText(record: EscalationRecord, cp: CpRef, snapshot: CpSnapshot): string | null {
  const waiting = (record.announcedTsKeys ?? record.qualifyingTsKeys ?? []).length;

  switch (record.state) {
    case "fix_ready":
      return renderFixReadyFor(cp, (record.qualifyingTsKeys ?? []).length || waiting);
    case "resolved":
      return renderResolved(cp, record.resolutionReason ?? "shipped", waiting);
    case "handed_back":
      return renderHandedBack(cp);
    case "frozen_pod_changed":
      return renderPodChanged(cp, snapshot.podName);
    case "open":
    case "acked":
      /* Back from Ready for Release (rolled back, testing failed). Open -> acked is the ✅ handler's own reply. */
      return record.announcedState === "fix_ready" ? renderLadderResumed(cp) : null;
    case "suppressed":
      return null;
  }
}

/** The record after a successful post (or a silent update) of `outbound`. */
export function applyEffect(record: EscalationRecord, outbound: Outbound, posted: { channel: string; ts: string } | null, nowIso: string): EscalationRecord {
  const next: EscalationRecord = { ...record };
  const effect = outbound.effect;

  if (effect.type === "parent" && posted) {
    next.channelId = posted.channel;
    next.threadTs = posted.ts;
    next.parentPostedAt = nowIso;
    /* The parent lists every waiting ticket and the current state, so that's all announced. */
    next.announcedState = record.state;
    next.announcedTsKeys = [...(record.qualifyingTsKeys ?? record.tsKeys)];
  } else if (effect.type === "level") {
    next.levelSent = Math.max(record.levelSent, effect.level) as EscalationRecord["levelSent"];
  } else if (effect.type === "state") {
    next.announcedState = effect.state;
    next.announceSeq = (record.announceSeq ?? 0) + 1;
  } else if (effect.type === "tickets") {
    next.announcedTsKeys = [...effect.tsKeys];
    next.announceSeq = (record.announceSeq ?? 0) + 1;
  }

  return next;
}

export interface StepInput {
  attachedTsStates: CurrentObservation["attachedTsStates"];
  cp: CpSnapshot | null;
  cpKey: string;
  group: EscalationGroup | null;
  now: string;
  planned: PlannedEscalation | null;
  policy: EscalationPolicy;
  /* The stored record, with any ✅ for its episode already folded in. */
  previous: EscalationRecord | null;
  ticketUrl: (key: string) => string;
  /* TS tickets in Waiting for product that link this CP, whatever the CP's outcome. */
  waitingTsKeys: string[];
}

/**
 * One CP on one run: reconcile what Jira shows against the stored record,
 * then decide what the thread should be told. Pure - the runner does the
 * posting and calls applyEffect for each message that went out.
 */
export function stepEscalation(input: StepInput): { events: ReconcileEvent[]; outbound: Outbound[]; record: EscalationRecord } | null {
  const { cp, planned, previous } = input;
  const result = reconcile(
    previous,
    {
      attachedTsStates: input.attachedTsStates,
      cp,
      cpKey: input.cpKey,
      outcome: cp ? cpOutcome(cp) : null,
      qualifyingTsKeys: input.waitingTsKeys,
    },
    { graceMinutes: input.policy.resolveGraceMinutes, now: input.now, pilotPodOptionId: PILOT_POD_OPTION_ID },
  );

  if (!result.next) {
    return null;
  }

  /* A reopen is a new episode with a new thread: none of the old thread's fields carry over. */
  const reopened = result.events.some((event) => event.type === "reopened");
  const record: EscalationRecord = {
    ...(reopened || previous === null ? {} : previous),
    ...result.next,
    cpStatusName: cp?.statusName ?? previous?.cpStatusName,
    lastPlan: planned
      ? {
          effectivePriority: planned.effectivePriority,
          engineeringWaitBh: planned.engineeringWaitBh,
          levelDue: planned.levelDue,
          nextLevel: planned.nextLevel,
        }
      : previous?.lastPlan,
    podName: cp?.podName ?? previous?.podName,
    updatedAt: input.now,
  };

  return {
    events: result.events,
    outbound: decideThreadUpdates({ cp, group: input.group, planned, policy: input.policy, record, ticketUrl: input.ticketUrl }),
    record,
  };
}
