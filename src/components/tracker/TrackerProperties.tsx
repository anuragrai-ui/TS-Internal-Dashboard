"use client";

import { useState } from "react";

import { Icon } from "@/components/Icon";
import { Avatar, CpOutcomeDot, cpOutcomeLabel, PriorityText, SlaChipView, WhoseMoveLabel } from "@/components/tracker/TrackerBits";
import { postSlackLink } from "@/components/tracker/trackerApi";
import { attentionReasons } from "@/lib/tracker/attention";
import { formatDurationShort, relativeTime, SIGNAL_TIER_LABEL, slaProgress } from "@/lib/tracker/views";

import type { SlackConversationRef, TrackerSla, TrackerTicket } from "@/lib/tracker/types";

function Module({ children, title }: { children: React.ReactNode; title: string }): React.ReactElement {
  return (
    <details className="trk-module" open>
      <summary className="trk-module-head">
        <span className="trk-section-label">{title}</span>
        <Icon name="chevron-down" size={12} />
      </summary>
      <div className="trk-module-body">{children}</div>
    </details>
  );
}

function Prop({ children, label }: { children: React.ReactNode; label: string }): React.ReactElement {
  return (
    <div className="trk-prop">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function formatDate(iso: string | null): string {
  const parsed = iso ? Date.parse(iso) : Number.NaN;
  return Number.isNaN(parsed) ? "—" : new Date(parsed).toLocaleString("en-US", { day: "numeric", hour: "numeric", minute: "2-digit", month: "short" });
}

function slaDetail(sla: TrackerSla): string {
  if (sla.state === "none") {
    return "No SLA on this ticket.";
  }
  if (sla.state === "completed_only") {
    return sla.breached ? "The last cycle finished after the goal." : "The last cycle finished within the goal.";
  }
  const goal = sla.goalMs !== null ? ` of a ${formatDurationShort(sla.goalMs)} goal` : "";
  if (sla.remainingMs === null) {
    return sla.state === "paused" ? "Paused." : "Running.";
  }
  const left = sla.remainingMs < 0 ? `${formatDurationShort(sla.remainingMs)} over` : `${formatDurationShort(sla.remainingMs)} left`;
  /* JSM stops the TTR clock in Waiting for product/client, so a paused value is frozen, not shrinking. */
  return sla.state === "paused" ? `Paused with ${left}${goal} - the clock is stopped while it waits.` : `${left}${goal}, in business hours.`;
}

function SlaBlock({ label, sla }: { label: string; sla: TrackerSla }): React.ReactElement {
  const progress = slaProgress(sla);
  const chip = sla.breached ? "danger" : sla.state === "paused" ? "paused" : progress !== null && progress > 0.75 ? "warning" : "ok";
  return (
    <div className="trk-sla-block">
      <div className="trk-sla-block-head">
        <span>{label}</span>
        <SlaChipView sla={sla} />
      </div>
      {progress !== null ? (
        <div
          aria-label={`${label}: ${Math.round(progress * 100)}% of the goal used`}
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={Math.round(progress * 100)}
          className="trk-progress"
          data-tone={chip}
          role="progressbar"
        >
          <span style={{ inlineSize: `${progress * 100}%` }} />
        </div>
      ) : null}
      <p className="trk-muted-note">{slaDetail(sla)}</p>
    </div>
  );
}

function LinkSlackThread({ onLinked, ticketKey }: { onLinked: () => void; ticketKey: string }): React.ReactElement {
  const [value, setValue] = useState("");
  const [state, setState] = useState<{ message?: string; status: "error" | "idle" | "saving" | "saved" }>({ status: "idle" });

  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const permalink = value.trim();
    if (!permalink) {
      return;
    }
    setState({ status: "saving" });
    const result = await postSlackLink(ticketKey, permalink);
    if (!result.ok) {
      setState({ message: result.error, status: "error" });
      return;
    }
    setValue("");
    setState({ message: `Linked ${result.data.conversation.channelName ? `#${result.data.conversation.channelName}` : "the thread"}.`, status: "saved" });
    onLinked();
  };

  return (
    <form className="trk-link-form" onSubmit={(event) => void submit(event)}>
      <label className="trk-link-label" htmlFor={`trk-link-${ticketKey}`}>
        Link a Slack thread
      </label>
      <div className="trk-link-row">
        <input
          className="trk-input"
          id={`trk-link-${ticketKey}`}
          onChange={(event) => setValue(event.target.value)}
          placeholder="Paste a Slack message link"
          type="url"
          value={value}
        />
        <button className="trk-btn" disabled={state.status === "saving" || !value.trim()} type="submit">
          {state.status === "saving" ? "Linking…" : "Link"}
        </button>
      </div>
      {state.message ? (
        <p className="trk-muted-note" data-tone={state.status === "error" ? "danger" : "success"} role="status">
          {state.message}
        </p>
      ) : null}
    </form>
  );
}

function ConversationCard({ conversation, now }: { conversation: SlackConversationRef; now: number }): React.ReactElement {
  return (
    <li className="trk-conv">
      <div className="trk-conv-head">
        <span className="trk-conv-channel">
          <Icon name="hash" size={12} />
          {conversation.channelName ?? conversation.channel}
        </span>
        {conversation.escalationHint ? <span className="trk-badge" data-tone="warning">Escalation</span> : null}
      </div>
      {conversation.snippet ? <p className="trk-conv-snippet">{conversation.snippet}</p> : null}
      <p className="trk-muted-note">
        {conversation.startedByName ? `${conversation.startedByName} · ` : ""}
        {conversation.replyCount} repl{conversation.replyCount === 1 ? "y" : "ies"} · {conversation.participants} people · {relativeTime(conversation.lastActivityAt, now)}
      </p>
      {conversation.permalink ? (
        <a className="trk-inline-link" href={conversation.permalink} rel="noreferrer" target="_blank">
          Open in Slack <Icon name="external-link" size={11} />
        </a>
      ) : null}
    </li>
  );
}

interface TrackerPropertiesProps {
  conversations: SlackConversationRef[];
  jiraBaseUrl: string;
  now: number;
  onLinked: () => void;
  ticket: TrackerTicket;
}

/* The properties sidebar inside the detail panel, Pylon-style collapsible modules. */
export function TrackerProperties({ conversations, jiraBaseUrl, now, onLinked, ticket }: TrackerPropertiesProps): React.ReactElement {
  const signalsByTier = ([1, 2, 3] as const).map((tier) => ({ signals: ticket.signals.filter((signal) => signal.tier === tier), tier }));

  const reasons = attentionReasons(ticket, now);

  return (
    <div className="trk-props">
      {reasons.length > 0 ? (
        <Module title="Needs attention">
          <ul className="trk-plain-list">
            {reasons.map((reason) => (
              <li className="trk-attention-item" data-tone={reason.tone} key={reason.kind}>
                <span className="trk-reason" data-tone={reason.tone}>
                  {reason.label}
                </span>
                <p className="trk-muted-note">{reason.detail}</p>
              </li>
            ))}
          </ul>
        </Module>
      ) : null}

      <Module title="SLA">
        <SlaBlock label="Time to resolution" sla={ticket.ttr} />
        <SlaBlock label="First response" sla={ticket.firstResponse} />
      </Module>

      <Module title="Details">
        <dl className="trk-prop-list">
          <Prop label="Status">{ticket.statusName}</Prop>
          <Prop label="Whose move">
            <WhoseMoveLabel whoseMove={ticket.whoseMove} />
          </Prop>
          <Prop label="Priority">
            <PriorityText priority={ticket.priority} />
          </Prop>
          <Prop label="Assignee">
            <span className="trk-person">
              <Avatar name={ticket.assignee?.name ?? null} size="sm" />
              {ticket.assignee?.name ?? "Unassigned"}
            </span>
          </Prop>
          <Prop label="Reporter">{ticket.reporterName ?? "—"}</Prop>
          <Prop label="Account">{ticket.account ?? "—"}</Prop>
          <Prop label="Pod">{ticket.pod ?? "—"}</Prop>
          <Prop label="Created">{formatDate(ticket.created)}</Prop>
          <Prop label="Updated">{formatDate(ticket.updated)}</Prop>
        </dl>
      </Module>

      <Module title="Escalation signals">
        {ticket.signals.length === 0 ? (
          <p className="trk-muted-note">No escalation signals.</p>
        ) : (
          signalsByTier
            .filter((group) => group.signals.length > 0)
            .map((group) => (
              <div className="trk-signal-group" key={group.tier}>
                <div className="trk-signal-tier">{SIGNAL_TIER_LABEL[group.tier]}</div>
                <div className="trk-signal-chips">
                  {group.signals.map((signal, index) => (
                    <span
                      className="trk-signal"
                      data-tier={signal.tier}
                      key={`${signal.kind}-${index}`}
                      title={[signal.detail, signal.at ? relativeTime(signal.at, now) : null].filter(Boolean).join(" · ") || undefined}
                    >
                      {signal.label}
                    </span>
                  ))}
                </div>
              </div>
            ))
        )}
      </Module>

      <Module title={`Linked CPs${ticket.cps.length > 0 ? ` (${ticket.cps.length})` : ""}`}>
        {ticket.cps.length === 0 ? (
          <p className="trk-muted-note">No CPs linked.</p>
        ) : (
          <ul className="trk-plain-list">
            {ticket.cps.map((cp) => (
              <li className="trk-cp-card" key={cp.key}>
                <div className="trk-cp-card-head">
                  <a className="trk-inline-link" href={`${jiraBaseUrl}/browse/${cp.key}`} rel="noreferrer" target="_blank">
                    {cp.key}
                  </a>
                  <span className="trk-cp-outcome">
                    <CpOutcomeDot outcome={cp.outcome} />
                    {cpOutcomeLabel(cp.outcome)}
                  </span>
                </div>
                {cp.summary ? <p className="trk-conv-snippet">{cp.summary}</p> : null}
                <p className="trk-muted-note">
                  {cp.statusName} · {cp.assigneeName ?? "Unassigned"}
                  {cp.podName ? ` · ${cp.podName}` : ""}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Module>

      <Module title={`Slack conversations${conversations.length > 0 ? ` (${conversations.length})` : ""}`}>
        {conversations.length === 0 ? (
          <p className="trk-muted-note">No Slack conversations found for this ticket yet.</p>
        ) : (
          <ul className="trk-plain-list">
            {conversations.map((conversation) => (
              <ConversationCard conversation={conversation} key={conversation.id} now={now} />
            ))}
          </ul>
        )}
        <LinkSlackThread key={ticket.key} onLinked={onLinked} ticketKey={ticket.key} />
      </Module>

      <Module title="Bot escalation">
        {ticket.botEscalation ? (
          <dl className="trk-prop-list">
            <Prop label="CP">{ticket.botEscalation.cpKey}</Prop>
            <Prop label="State">{ticket.botEscalation.state.replace(/_/g, " ")}</Prop>
            <Prop label="Level">{ticket.botEscalation.levelSent > 0 ? `L${ticket.botEscalation.levelSent} sent` : "Not posted yet"}</Prop>
            <Prop label="Thread">
              {ticket.botEscalation.permalink ? (
                <a className="trk-inline-link" href={ticket.botEscalation.permalink} rel="noreferrer" target="_blank">
                  Open in Slack <Icon name="external-link" size={11} />
                </a>
              ) : (
                "—"
              )}
            </Prop>
          </dl>
        ) : (
          <p className="trk-muted-note">The escalation bot hasn&apos;t picked this ticket up.</p>
        )}
      </Module>
    </div>
  );
}
