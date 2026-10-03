import { Icon } from "@/components/Icon";
import { initials, slaChip, WHOSE_MOVE_LABEL } from "@/lib/tracker/views";

import type { AttentionReason } from "@/lib/tracker/attention";
import type { CpOutcomeLabel, TrackerCp, TrackerPriority, TrackerSla, TrackerTicket, WhoseMove } from "@/lib/tracker/types";

/*
 * Small presentational pieces shared by the list, board and detail panel.
 * No hooks, so they render the same on the server and the client.
 */

export function PriorityText({ priority }: { priority: TrackerPriority }): React.ReactElement {
  return (
    <span className="trk-priority" data-priority={priority.toLowerCase()}>
      {priority}
    </span>
  );
}

/* How much of the ring is filled says how far along the ticket is; the colour says whose move it is. */
const RING_FILL: Record<WhoseMove, number> = {
  closed: 1,
  new: 0,
  on_customer: 0.75,
  on_engineering: 0.5,
  on_operations: 0.5,
  on_ts: 0.25,
};

function pieSlice(fraction: number): string {
  const angle = fraction * 2 * Math.PI;
  const x = 8 + 4 * Math.sin(angle);
  const y = 8 - 4 * Math.cos(angle);
  return `M8 8 L8 4 A4 4 0 ${fraction > 0.5 ? 1 : 0} 1 ${x.toFixed(3)} ${y.toFixed(3)} Z`;
}

export function WhoseMoveRing({ size = 14, whoseMove }: { size?: number; whoseMove: WhoseMove }): React.ReactElement {
  const fill = RING_FILL[whoseMove];
  return (
    <svg aria-hidden="true" className="trk-ring" data-move={whoseMove} height={size} viewBox="0 0 16 16" width={size}>
      <circle cx="8" cy="8" fill="none" r="6.5" stroke="currentColor" strokeDasharray={whoseMove === "new" ? "2 2.1" : undefined} strokeWidth="1.5" />
      {fill >= 1 ? <circle cx="8" cy="8" fill="currentColor" r="4" /> : fill > 0 ? <path d={pieSlice(fill)} fill="currentColor" /> : null}
    </svg>
  );
}

export function WhoseMoveLabel({ whoseMove }: { whoseMove: WhoseMove }): React.ReactElement {
  return (
    <span className="trk-move">
      <WhoseMoveRing whoseMove={whoseMove} />
      {WHOSE_MOVE_LABEL[whoseMove]}
    </span>
  );
}

export function SlaChipView({ label, sla }: { label?: string; sla: TrackerSla }): React.ReactElement {
  const chip = slaChip(sla);
  return (
    <span className="trk-sla" data-tone={chip.tone} title={label ? `${label}: ${chip.text}` : chip.text}>
      {chip.paused ? <Icon filled name="pause" size={9} /> : null}
      {chip.text}
    </span>
  );
}

const OUTCOME_LABEL: Record<CpOutcomeLabel, string> = {
  fix_ready: "Fix ready",
  open: "Open",
  rejected: "Rejected",
  shipped: "Shipped",
};

export function CpOutcomeDot({ outcome }: { outcome: CpOutcomeLabel }): React.ReactElement {
  return <span aria-label={OUTCOME_LABEL[outcome]} className="trk-outcome-dot" data-outcome={outcome} role="img" />;
}

export function cpOutcomeLabel(outcome: CpOutcomeLabel): string {
  return OUTCOME_LABEL[outcome];
}

export function CpChip({ cp }: { cp: TrackerCp }): React.ReactElement {
  return (
    <span className="trk-cp-chip" title={`${cp.key} · ${cp.statusName} · ${OUTCOME_LABEL[cp.outcome]}`}>
      <CpOutcomeDot outcome={cp.outcome} />
      {cp.key}
    </span>
  );
}

/* Up to two CP chips, then "+3" - a row has room for little more. */
export function CpChips({ cps, max = 2 }: { cps: TrackerCp[]; max?: number }): React.ReactElement | null {
  if (cps.length === 0) {
    return null;
  }
  return (
    <span className="trk-cp-chips">
      {cps.slice(0, max).map((cp) => (
        <CpChip cp={cp} key={cp.key} />
      ))}
      {cps.length > max ? <span className="trk-more">+{cps.length - max}</span> : null}
    </span>
  );
}

export function Avatar({ name, size = "md" }: { name: string | null; size?: "md" | "sm" }): React.ReactElement {
  if (!name) {
    return (
      <span aria-label="Unassigned" className="trk-avatar trk-avatar-empty" data-size={size} role="img" title="Unassigned">
        <Icon name="user" size={size === "sm" ? 10 : 12} />
      </span>
    );
  }
  return (
    <span aria-label={name} className="trk-avatar" data-size={size} role="img" title={name}>
      {initials(name) || "?"}
    </span>
  );
}

export function SlackIndicator({ ticket }: { ticket: TrackerTicket }): React.ReactElement | null {
  const { activeConversations, conversations } = ticket.slack;
  if (conversations === 0) {
    return null;
  }
  const label = `${conversations} Slack conversation${conversations === 1 ? "" : "s"}${activeConversations > 0 ? `, ${activeConversations} active` : ""}`;
  return (
    <span aria-label={label} className="trk-slack" data-active={activeConversations > 0} role="img" title={label}>
      <Icon name="message" size={13} />
      {conversations}
      {activeConversations > 0 ? <span aria-hidden="true" className="trk-slack-dot" /> : null}
    </span>
  );
}

/* Why a ticket needs attention: the most urgent reasons as chips, the rest folded into "+N" (all of them in the tooltip). */
export function AttentionChips({ max = 2, reasons }: { max?: number; reasons: readonly AttentionReason[] }): React.ReactElement | null {
  if (reasons.length === 0) {
    return null;
  }
  const shown = reasons.slice(0, max);
  const hidden = reasons.slice(max);
  return (
    <span className="trk-reasons">
      {shown.map((reason) => (
        <span className="trk-reason" data-tone={reason.tone} key={reason.kind} title={reason.detail}>
          {reason.label}
        </span>
      ))}
      {hidden.length > 0 ? (
        <span className="trk-reason" data-tone="more" title={hidden.map((reason) => `${reason.label}: ${reason.detail}`).join("\n")}>
          +{hidden.length}
        </span>
      ) : null}
    </span>
  );
}
