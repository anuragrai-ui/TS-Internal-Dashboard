"use client";

import { Icon } from "@/components/Icon";
import { AttentionChips, Avatar, CpChips, PriorityText, SlackIndicator, SlaChipView, WhoseMoveRing } from "@/components/tracker/TrackerBits";
import { readState, relativeTime } from "@/lib/tracker/views";

import type { AttentionReason } from "@/lib/tracker/attention";
import type { TrackerTicket, WhoseMove } from "@/lib/tracker/types";
import type { TicketGroup } from "@/lib/tracker/views";

const NO_REASONS: readonly AttentionReason[] = [];

export function trackerRowId(key: string): string {
  return `trk-row-${key}`;
}

/* The one row in the Tab order: the cursor, else the open ticket, but only while it is actually rendered (a filter can hide it). */
export function tabbableRowKey(renderedKeys: readonly string[], cursorKey: string | null, openKey: string | null): string | null {
  const preferred = [cursorKey, openKey].find((key) => key !== null && renderedKeys.includes(key));
  return preferred ?? renderedKeys[0] ?? null;
}

interface TrackerRowProps {
  cursor: boolean;
  now: number;
  onOpen: (key: string) => void;
  open: boolean;
  /* Why it is in the Needs attention view; empty elsewhere. */
  reasons: readonly AttentionReason[];
  seen: Readonly<Record<string, string>>;
  tabbable: boolean;
  ticket: TrackerTicket;
}

function TrackerRow({ cursor, now, onOpen, open, reasons, seen, tabbable, ticket }: TrackerRowProps): React.ReactElement {
  const read = readState(ticket, seen);
  return (
    <div
      aria-selected={open}
      className="trk-row"
      data-cursor={cursor}
      data-read={read}
      id={trackerRowId(ticket.key)}
      onClick={() => onOpen(ticket.key)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen(ticket.key);
        }
      }}
      role="option"
      tabIndex={tabbable ? 0 : -1}
    >
      {read === "unread" ? <span aria-label="New activity" className="trk-unread-dot" role="img" /> : null}
      <span className="trk-col-priority">
        <PriorityText priority={ticket.priority} />
      </span>
      <span className="trk-col-key">{ticket.key}</span>
      <span className="trk-col-summary">
        <span className="trk-summary">{ticket.summary}</span>
        <span className="trk-subline">
          <span className="trk-account">
            <span className="trk-key-inline">{ticket.key} · </span>
            {ticket.account ?? "No account"}
          </span>
          <AttentionChips reasons={reasons} />
        </span>
      </span>
      <span className="trk-col-status">
        <WhoseMoveRing whoseMove={ticket.whoseMove} />
        <span className="trk-status-text">{ticket.statusName}</span>
      </span>
      <span className="trk-col-sla">
        <SlaChipView label="Time to resolution" sla={ticket.ttr} />
      </span>
      <span className="trk-col-cps">
        <CpChips cps={ticket.cps} />
      </span>
      <span className="trk-col-slack">
        <SlackIndicator ticket={ticket} />
      </span>
      <span className="trk-col-assignee">
        <Avatar name={ticket.assignee?.name ?? null} />
      </span>
      <span className="trk-col-time" title={`Last activity ${new Date(ticket.lastActivityAt).toLocaleString()}`}>
        {relativeTime(ticket.lastActivityAt, now, true)}
      </span>
    </div>
  );
}

interface TrackerListProps {
  collapsed: ReadonlySet<WhoseMove>;
  cursorKey: string | null;
  groups: TicketGroup[];
  now: number;
  onOpen: (key: string) => void;
  onToggleGroup: (whoseMove: WhoseMove) => void;
  openKey: string | null;
  /* The keys of the rows actually on screen (collapsed bands and filtered-out tickets excluded). */
  renderedKeys: readonly string[];
  /* Reasons per ticket key - passed only in the Needs attention view. */
  reasons?: ReadonlyMap<string, readonly AttentionReason[]>;
  seen: Readonly<Record<string, string>>;
}

/* Bands per whose move (collapsible), each a listbox of ~44px rows; j/k and Enter are handled by the workspace. */
export function TrackerList({ collapsed, cursorKey, groups, now, onOpen, onToggleGroup, openKey, reasons, renderedKeys, seen }: TrackerListProps): React.ReactElement {
  const tabbableKey = tabbableRowKey(renderedKeys, cursorKey, openKey);

  return (
    <div className="trk-list">
      {groups.map((group) => {
        const isCollapsed = collapsed.has(group.whoseMove);
        const bandId = `trk-band-${group.whoseMove}`;
        return (
          <section className="trk-group" key={group.whoseMove}>
            <h2 className="trk-band">
              <button aria-controls={`${bandId}-rows`} aria-expanded={!isCollapsed} id={bandId} onClick={() => onToggleGroup(group.whoseMove)} type="button">
                <span className="trk-band-chevron" data-collapsed={isCollapsed}>
                  <Icon name="chevron-down" size={13} />
                </span>
                <WhoseMoveRing whoseMove={group.whoseMove} />
                <span className="trk-band-label">{group.label}</span>
                <span className="trk-band-count">{group.tickets.length}</span>
              </button>
            </h2>
            {isCollapsed ? null : (
              <div aria-labelledby={bandId} className="trk-rows" id={`${bandId}-rows`} role="listbox">
                {group.tickets.map((ticket) => (
                  <TrackerRow
                    cursor={ticket.key === cursorKey}
                    key={ticket.key}
                    now={now}
                    onOpen={onOpen}
                    open={ticket.key === openKey}
                    reasons={reasons?.get(ticket.key) ?? NO_REASONS}
                    seen={seen}
                    tabbable={ticket.key === tabbableKey}
                    ticket={ticket}
                  />
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

/* Grey placeholder rows while the first load is in flight. */
export function TrackerListSkeleton(): React.ReactElement {
  return (
    <div aria-busy="true" aria-label="Loading tickets" className="trk-list" role="status">
      {Array.from({ length: 9 }, (_, index) => (
        <div className="trk-row trk-row-skeleton" key={index}>
          <span className="trk-skel" style={{ inlineSize: "3.2rem" }} />
          <span className="trk-skel" style={{ inlineSize: "4.5rem" }} />
          <span className="trk-skel" style={{ flex: 1 }} />
          <span className="trk-skel" style={{ inlineSize: "5rem" }} />
          <span className="trk-skel trk-skel-round" />
        </div>
      ))}
    </div>
  );
}
