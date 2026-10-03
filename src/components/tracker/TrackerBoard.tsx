"use client";

import { Icon } from "@/components/Icon";
import { AttentionChips, Avatar, PriorityText, SlackIndicator, SlaChipView, WhoseMoveRing } from "@/components/tracker/TrackerBits";
import { tabbableRowKey, trackerRowId } from "@/components/tracker/TrackerList";
import { readState, WHOSE_MOVE_LABEL, WHOSE_MOVE_ORDER } from "@/lib/tracker/views";

import type { AttentionReason } from "@/lib/tracker/attention";
import type { TicketGroup } from "@/lib/tracker/views";

interface TrackerBoardProps {
  cursorKey: string | null;
  groups: TicketGroup[];
  onOpen: (key: string) => void;
  openKey: string | null;
  /* The keys of the cards actually on screen, in board order. */
  renderedKeys: readonly string[];
  /* Reasons per ticket key - passed only in the Needs attention view. */
  reasons?: ReadonlyMap<string, readonly AttentionReason[]>;
  seen: Readonly<Record<string, string>>;
}

/*
 * One column per whose-move state. Unlike the list, empty columns stay so the
 * board keeps its shape; Closed only appears when the view has closed tickets.
 */
export function TrackerBoard({ cursorKey, groups, onOpen, openKey, reasons, renderedKeys, seen }: TrackerBoardProps): React.ReactElement {
  const columns = WHOSE_MOVE_ORDER.filter((move) => move !== "closed" || groups.some((group) => group.whoseMove === "closed"));
  const tabbableKey = tabbableRowKey(renderedKeys, cursorKey, openKey);

  return (
    <div className="trk-board">
      {columns.map((move) => {
        const tickets = groups.find((group) => group.whoseMove === move)?.tickets ?? [];
        const headingId = `trk-col-${move}`;
        return (
          <section className="trk-board-col" key={move}>
            <h2 className="trk-board-head" id={headingId}>
              <WhoseMoveRing whoseMove={move} />
              {WHOSE_MOVE_LABEL[move]}
              <span className="trk-band-count">{tickets.length}</span>
            </h2>
            <div aria-labelledby={headingId} className="trk-board-cards" role="listbox">
              {tickets.length === 0 ? <div className="trk-board-empty">Nothing here</div> : null}
              {tickets.map((ticket) => (
                <div
                  aria-selected={ticket.key === openKey}
                  className="trk-card"
                  data-cursor={ticket.key === cursorKey}
                  data-read={readState(ticket, seen)}
                  id={trackerRowId(ticket.key)}
                  key={ticket.key}
                  onClick={() => onOpen(ticket.key)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onOpen(ticket.key);
                    }
                  }}
                  role="option"
                  tabIndex={ticket.key === tabbableKey ? 0 : -1}
                >
                  <div className="trk-card-top">
                    <span className="trk-card-key">{ticket.key}</span>
                    <PriorityText priority={ticket.priority} />
                  </div>
                  <div className="trk-card-summary">{ticket.summary}</div>
                  {ticket.account ? <div className="trk-account">{ticket.account}</div> : null}
                  <AttentionChips max={1} reasons={reasons?.get(ticket.key) ?? []} />
                  <div className="trk-card-foot">
                    <Avatar name={ticket.assignee?.name ?? null} size="sm" />
                    <SlaChipView label="Time to resolution" sla={ticket.ttr} />
                    <span className="trk-card-icons">
                      <SlackIndicator ticket={ticket} />
                      {ticket.cps.length > 0 ? (
                        <span aria-label={`${ticket.cps.length} linked CP${ticket.cps.length === 1 ? "" : "s"}`} className="trk-card-cps" role="img">
                          <Icon name="wrench" size={12} />
                          {ticket.cps.length}
                        </span>
                      ) : null}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
