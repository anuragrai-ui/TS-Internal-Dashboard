"use client";

import { useCallback, useEffect, useState } from "react";

import { ProposalsList } from "@/components/actions/ProposalsList";
import { TicketActionsBar } from "@/components/actions/TicketActionsBar";
import { TicketComposer } from "@/components/actions/TicketComposer";
import { AssistPanel } from "@/components/assist/AssistPanel";
import { Icon } from "@/components/Icon";
import { SlackThreadMessages } from "@/components/tracker/SlackThreadMessages";
import { CpOutcomeDot, cpOutcomeLabel, PriorityText, WhoseMoveLabel } from "@/components/tracker/TrackerBits";
import { fetchTrackerDetail } from "@/components/tracker/trackerApi";
import { TrackerProperties } from "@/components/tracker/TrackerProperties";
import { TrackerTimeline } from "@/components/tracker/TrackerTimeline";

import type { ComposerTab } from "@/components/actions/TicketComposer";
import type { TrackerDetail, TrackerTicket } from "@/lib/tracker/types";

type DetailState = { detail: TrackerDetail; status: "ready" } | { error: string; status: "error" } | { status: "loading" };

/* Loads one ticket's live detail; reloads when the list shows new activity on it, or on demand (after linking a thread). */
function useTrackerDetail(key: string, activityStamp: string): { reload: () => void; state: DetailState } {
  const [state, setState] = useState<DetailState>({ status: "loading" });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void fetchTrackerDetail(key).then((result) => {
      if (cancelled) {
        return;
      }
      /* A failed background reload keeps what is on screen instead of blanking the panel. */
      setState((previous) =>
        result.ok
          ? { detail: result.data, status: "ready" }
          : previous.status === "ready" && previous.detail.ticket.key === key
            ? previous
            : { error: result.error, status: "error" },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [activityStamp, key, nonce]);

  /* A different ticket starts from a skeleton, never the previous ticket's timeline. */
  useEffect(() => {
    setState({ status: "loading" });
  }, [key]);

  return { reload: useCallback(() => setNonce((value) => value + 1), []), state };
}

interface TrackerDetailPanelProps {
  /* Over the list (narrow screens) the panel takes focus when it opens; beside it, focus stays on the list. */
  focusOnOpen: boolean;
  following: boolean;
  hasNext: boolean;
  hasPrevious: boolean;
  jiraBaseUrl: string;
  now: number;
  onClose: () => void;
  onNext: () => void;
  onPrevious: () => void;
  onToggleFollow: () => void;
  ticket: TrackerTicket;
}

/* Right-hand detail: toolbar, "TS-123 · summary", tabs (All activity / each Slack conversation / each CP), timeline and properties. */
export function TrackerDetailPanel({
  focusOnOpen,
  following,
  hasNext,
  hasPrevious,
  jiraBaseUrl,
  now,
  onClose,
  onNext,
  onPrevious,
  onToggleFollow,
  ticket,
}: TrackerDetailPanelProps): React.ReactElement {
  const { reload, state } = useTrackerDetail(ticket.key, ticket.lastActivityAt);
  const [tab, setTab] = useState("all");
  const [copied, setCopied] = useState(false);
  /* Bumped after the panel itself wrote something, so the action log refetches alongside the detail. */
  const [actionsNonce, setActionsNonce] = useState(0);
  const [composerRequest, setComposerRequest] = useState<{ nonce: number; tab: ComposerTab } | null>(null);

  useEffect(() => {
    setTab("all");
    setComposerRequest(null);
  }, [ticket.key]);

  const afterWrite = useCallback(() => {
    reload();
    setActionsNonce((value) => value + 1);
  }, [reload]);

  const detail = state.status === "ready" && state.detail.ticket.key === ticket.key ? state.detail : null;
  /* The list's copy is already on screen; the detail's copy is fresher once it arrives. */
  const shown = detail?.ticket ?? ticket;
  const conversations = detail?.conversations ?? [];
  const timeline = detail?.timeline ?? [];
  const activeConversation = conversations.find((conversation) => conversation.id === tab);
  const activeCp = shown.cps.find((cp) => cp.key === tab);
  const tabItems = tab === "all" ? timeline : timeline.filter((item) => item.thread === tab);

  const copyKey = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(shown.key);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* Clipboard blocked (insecure context or permissions) - the key is visible in the title anyway. */
    }
  };

  return (
    <aside aria-label={`${shown.key} details`} className="trk-panel">
      <div className="trk-panel-toolbar">
        <button aria-label="Close panel" autoFocus={focusOnOpen} className="trk-icon-btn" onClick={onClose} title="Close (Esc)" type="button">
          <Icon name="close" size={15} />
        </button>
        <button aria-label="Previous ticket" className="trk-icon-btn" disabled={!hasPrevious} onClick={onPrevious} title="Previous (k)" type="button">
          <Icon name="chevron-up" size={15} />
        </button>
        <button aria-label="Next ticket" className="trk-icon-btn" disabled={!hasNext} onClick={onNext} title="Next (j)" type="button">
          <Icon name="chevron-down" size={15} />
        </button>
        <span className="trk-panel-toolbar-spacer" />
        <button aria-pressed={following} className="trk-btn" data-on={following} onClick={onToggleFollow} type="button">
          <Icon filled={following} name="star" size={13} />
          {following ? "Following" : "Follow"}
        </button>
        <a className="trk-btn" href={`${jiraBaseUrl}/browse/${shown.key}`} rel="noreferrer" target="_blank">
          <Icon name="external-link" size={13} />
          Open in Jira
        </a>
        <button aria-label={`Copy ${shown.key}`} className="trk-icon-btn" onClick={() => void copyKey()} title={copied ? "Copied" : "Copy key"} type="button">
          <Icon name={copied ? "check" : "copy"} size={14} />
        </button>
      </div>

      <div className="trk-panel-scroll">
        <div className="trk-panel-head">
          <h2 className="trk-panel-title">
            <span className="trk-panel-key">{shown.key}</span> · {shown.summary}
          </h2>
          <div className="trk-panel-sub">
            <PriorityText priority={shown.priority} />
            <WhoseMoveLabel whoseMove={shown.whoseMove} />
            <span className="trk-muted">{shown.statusName}</span>
            {shown.account ? <span className="trk-muted">{shown.account}</span> : null}
          </div>
        </div>

        <TicketActionsBar
          onChanged={afterWrite}
          onEscalate={() => setComposerRequest((current) => ({ nonce: (current?.nonce ?? 0) + 1, tab: "firefighters" }))}
          ticket={shown}
        />

        <div aria-label="Activity threads" className="trk-tabs" role="tablist">
          <button aria-selected={tab === "all"} className="trk-tab" onClick={() => setTab("all")} role="tab" type="button">
            All activity
          </button>
          {conversations.map((conversation) => (
            <button
              aria-selected={tab === conversation.id}
              className="trk-tab"
              key={conversation.id}
              onClick={() => setTab(conversation.id)}
              role="tab"
              type="button"
            >
              <Icon name="hash" size={12} />
              {conversation.channelName ?? conversation.channel}
            </button>
          ))}
          {shown.cps.map((cp) => (
            <button aria-selected={tab === cp.key} className="trk-tab" key={cp.key} onClick={() => setTab(cp.key)} role="tab" type="button">
              <CpOutcomeDot outcome={cp.outcome} />
              {cp.key}
            </button>
          ))}
        </div>

        <div className="trk-panel-body">
          <div className="trk-panel-main" role="tabpanel">
            <details className="act-assist-fold" open>
              <summary className="act-assist-summary">
                <Icon name="bot" size={13} />
                AI Assist &amp; proposals
                <Icon name="chevron-down" size={12} />
              </summary>
              <div className="act-assist-body">
                <AssistPanel ticketKey={shown.key} />
                <ProposalsList conversations={conversations} now={now} onApproved={afterWrite} refreshToken={actionsNonce} ticketKey={shown.key} />
              </div>
            </details>

            {detail && detail.errors.length > 0 ? (
              <p className="trk-hint" data-tone="warning" role="status">
                Some activity couldn&apos;t be loaded: {detail.errors.join(" · ")}
              </p>
            ) : null}

            {activeConversation ? (
              <div className="trk-tab-card">
                <div className="trk-tab-card-title">
                  <Icon name="hash" size={13} />
                  {activeConversation.channelName ?? activeConversation.channel}
                  {activeConversation.escalationHint ? <span className="trk-badge" data-tone="warning">Escalation</span> : null}
                </div>
                {activeConversation.snippet ? <p className="trk-conv-snippet">{activeConversation.snippet}</p> : null}
                <SlackThreadMessages conversation={activeConversation} key={activeConversation.id} now={now} />
              </div>
            ) : null}

            {activeCp ? (
              <div className="trk-tab-card">
                <div className="trk-tab-card-title">
                  <a className="trk-inline-link" href={`${jiraBaseUrl}/browse/${activeCp.key}`} rel="noreferrer" target="_blank">
                    {activeCp.key}
                  </a>
                  <span className="trk-cp-outcome">
                    <CpOutcomeDot outcome={activeCp.outcome} />
                    {cpOutcomeLabel(activeCp.outcome)}
                  </span>
                </div>
                {activeCp.summary ? <p className="trk-conv-snippet">{activeCp.summary}</p> : null}
                <p className="trk-muted-note">
                  {activeCp.statusName} · {activeCp.assigneeName ?? "Unassigned"}
                  {activeCp.podName ? ` · ${activeCp.podName}` : ""}
                </p>
              </div>
            ) : null}

            {state.status === "error" ? (
              <p className="trk-hint" data-tone="danger" role="status">
                {state.error}{" "}
                <button className="trk-link-btn" onClick={reload} type="button">
                  Try again
                </button>
              </p>
            ) : detail ? (
              <TrackerTimeline conversations={tab === "all" ? conversations : []} items={tabItems} now={now} />
            ) : (
              <div aria-busy="true" aria-label="Loading activity" className="trk-timeline-skeleton" role="status">
                {Array.from({ length: 4 }, (_, index) => (
                  <div className="trk-tl-item" key={index}>
                    <span className="trk-skel trk-skel-round" />
                    <div className="trk-tl-main">
                      <span className="trk-skel" style={{ inlineSize: "40%" }} />
                      <span className="trk-skel" style={{ inlineSize: "85%" }} />
                    </div>
                  </div>
                ))}
              </div>
            )}

            <TicketComposer
              conversations={conversations}
              defaultConversationId={activeConversation?.id}
              key={shown.key}
              onSent={afterWrite}
              openRequest={composerRequest}
              ticketKey={shown.key}
            />
          </div>

          <TrackerProperties conversations={conversations} jiraBaseUrl={jiraBaseUrl} now={now} onLinked={reload} ticket={shown} />
        </div>
      </div>
    </aside>
  );
}
