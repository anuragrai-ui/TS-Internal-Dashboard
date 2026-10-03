"use client";

import { useCallback, useEffect, useId, useState } from "react";

import { ErrorNotice, ExecutionNotice } from "@/components/actions/ExecutionNotice";
import { fetchTicketActions, mightHaveArrived, postApproveProposal, postRejectProposal, useAttemptKey } from "@/components/actions/actionsApi";
import { Icon } from "@/components/Icon";
import { describeAction, EXECUTION_STATUS_LABEL, EXECUTION_STATUS_TONE, externalLinkLabel, isTextAction, proposalSourceLabel } from "@/lib/actions/describe";
import { BODY_MAX_CHARS } from "@/lib/actions/validate";
import { relativeTime } from "@/lib/tracker/views";
import { UI_EVENTS } from "@/lib/workspace/types";

import type { SlackConversationRef } from "@/lib/tracker/types";
import type { ActionArgs, ActionExecution, ActionProposal, ProposalsChangedDetail, TicketActionsResponse } from "@/lib/workspace/types";

type ListState = { data: TicketActionsResponse; status: "ready" } | { error: string; status: "error" } | { status: "loading" };

function channelNameFor(args: ActionArgs, conversations: readonly SlackConversationRef[]): string | undefined {
  if (args.operation !== "slack_thread_reply") {
    return undefined;
  }
  const match = conversations.find((conversation) => conversation.channel === args.channel && conversation.rootTs === args.threadTs);
  return match?.channelName ?? match?.channel;
}

interface ProposalsListProps {
  conversations: SlackConversationRef[];
  now: number;
  /* After a proposal was approved and went through: reload the detail panel. */
  onApproved: () => void;
  /* Changes when the panel did something itself (sent a reply, changed status) - the action log refetches. */
  refreshToken: number;
  ticketKey: string;
}

/**
 * The ticket's proposals and action log, near the top of the detail panel:
 * pending AI Assist / browser-agent proposals as review cards (edit, then
 * approve or reject), then every recent write with who, what, when and how
 * it went. Refetches when an Assist run or a page tool says proposals changed.
 */
export function ProposalsList({ conversations, now, onApproved, refreshToken, ticketKey }: ProposalsListProps): React.ReactElement {
  const headingId = useId();
  const [state, setState] = useState<ListState>({ status: "loading" });
  const [nonce, setNonce] = useState(0);
  const [expanded, setExpanded] = useState(true);

  const reload = useCallback(() => setNonce((value) => value + 1), []);

  useEffect(() => {
    setState({ status: "loading" });
  }, [ticketKey]);

  useEffect(() => {
    let cancelled = false;
    void fetchTicketActions(ticketKey).then((result) => {
      if (cancelled) {
        return;
      }
      /* A failed background refresh keeps what is on screen. */
      setState((previous) => (result.ok ? { data: result.data, status: "ready" } : previous.status === "ready" ? previous : { error: result.error, status: "error" }));
    });
    return () => {
      cancelled = true;
    };
  }, [nonce, refreshToken, ticketKey]);

  useEffect(() => {
    const onChanged = (event: Event): void => {
      const detail = (event as CustomEvent<ProposalsChangedDetail>).detail;
      if (!detail || detail.ticketKey === ticketKey) {
        reload();
        setExpanded(true);
      }
    };
    window.addEventListener(UI_EVENTS.proposalsChanged, onChanged);
    return () => window.removeEventListener(UI_EVENTS.proposalsChanged, onChanged);
  }, [reload, ticketKey]);

  const proposals = state.status === "ready" ? state.data.proposals : [];
  const executions = state.status === "ready" ? state.data.executions : [];
  const pending = proposals.filter((proposal) => proposal.status === "pending");
  const decided = proposals.filter((proposal) => proposal.status !== "pending");

  return (
    <section aria-labelledby={headingId} className="act-proposals">
      <div className="act-section-head">
        <button aria-controls={`${headingId}-body`} aria-expanded={expanded} className="act-section-toggle" onClick={() => setExpanded((value) => !value)} type="button">
          <Icon name={expanded ? "chevron-down" : "chevron-right"} size={12} />
          <span className="act-section-title" id={headingId}>
            Proposals &amp; actions
          </span>
          {pending.length > 0 ? <span className="act-count-badge">{pending.length} to review</span> : null}
        </button>
        <button aria-label="Refresh proposals and actions" className="trk-icon-btn" onClick={reload} title="Refresh" type="button">
          <Icon name="refresh" size={13} />
        </button>
      </div>

      {expanded ? (
        <div className="act-section-body" id={`${headingId}-body`}>
          {state.status === "loading" ? (
            <p aria-busy="true" className="trk-muted-note" role="status">
              Loading proposals…
            </p>
          ) : state.status === "error" ? (
            <p className="trk-muted-note" data-tone="danger" role="status">
              {state.error}{" "}
              <button className="trk-link-btn" onClick={reload} type="button">
                Try again
              </button>
            </p>
          ) : (
            <>
              {pending.length > 0 ? (
                <ul aria-label="Waiting for review" className="act-card-list">
                  {pending.map((proposal) => (
                    <ProposalCard
                      channelName={channelNameFor(proposal.args, conversations)}
                      key={proposal.id}
                      now={now}
                      onDecided={(refreshDetail) => {
                        reload();
                        if (refreshDetail) {
                          onApproved();
                        }
                      }}
                      proposal={proposal}
                    />
                  ))}
                </ul>
              ) : (
                <p className="trk-muted-note">No proposals waiting. AI Assist and page tools suggest changes here; nothing is written until you approve.</p>
              )}

              {decided.length > 0 ? (
                <details className="act-fold">
                  <summary>Earlier proposals ({decided.length})</summary>
                  <ul className="act-log">
                    {decided.map((proposal) => (
                      <li className="act-log-item" key={proposal.id}>
                        <span className="act-status" data-tone={proposal.status === "approved" ? "success" : proposal.status === "rejected" ? "danger" : "muted"}>
                          {proposal.status}
                        </span>
                        <span className="act-log-what">{describeAction(proposal.args, channelNameFor(proposal.args, conversations))}</span>
                        <span className="act-log-meta">
                          {proposalSourceLabel(proposal.source)}
                          {proposal.decidedBy ? ` · ${proposal.decidedBy}` : ""} · {relativeTime(proposal.decidedAt ?? proposal.createdAt, now)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}

              <ExecutionLog conversations={conversations} executions={executions} now={now} />
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}

function ExecutionLog({ conversations, executions, now }: { conversations: SlackConversationRef[]; executions: ActionExecution[]; now: number }): React.ReactElement | null {
  if (executions.length === 0) {
    return null;
  }
  return (
    <div className="act-log-wrap">
      <h3 className="act-subhead">Recent actions</h3>
      <ul className="act-log">
        {executions.map((execution) => (
          <li className="act-log-item" key={execution.id}>
            <span className="act-status" data-tone={EXECUTION_STATUS_TONE[execution.status]}>
              {EXECUTION_STATUS_LABEL[execution.status]}
            </span>
            <span className="act-log-what">
              {describeAction(execution.args, channelNameFor(execution.args, conversations))}
              {execution.proposalId ? <span className="act-log-tag">from a proposal</span> : null}
            </span>
            <span className="act-log-meta">
              {execution.actorName} · <time dateTime={execution.at}>{relativeTime(execution.at, now)}</time>
              {execution.externalUrl ? (
                <>
                  {" · "}
                  <a className="trk-inline-link" href={execution.externalUrl} rel="noreferrer" target="_blank">
                    {externalLinkLabel(execution)}
                  </a>
                </>
              ) : null}
            </span>
            {execution.error && execution.status !== "succeeded" ? <span className="act-log-error">{execution.error}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

/* --------------------------------------------------------------- card */

function ProposalCard({
  channelName,
  now,
  onDecided,
  proposal,
}: {
  channelName?: string;
  now: number;
  /* `refreshDetail`: something may have changed on the ticket, so the panel should reload too. */
  onDecided: (refreshDetail: boolean) => void;
  proposal: ActionProposal;
}): React.ReactElement {
  const bodyId = useId();
  const original = isTextAction(proposal.args) ? proposal.args.body : "";
  const [body, setBody] = useState(original);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ execution: ActionExecution } | { error: string } | null>(null);
  const attempt = useAttemptKey();
  const expired = Date.parse(proposal.expiresAt) <= now;
  const edited = isTextAction(proposal.args) && body.trim() !== original.trim();
  const bodyOk = !isTextAction(proposal.args) || (body.trim().length > 0 && body.trim().length <= BODY_MAX_CHARS);

  const approve = async (force = false): Promise<void> => {
    const args: ActionArgs | undefined = edited && isTextAction(proposal.args) ? { ...proposal.args, body: body.trim() } : undefined;
    setBusy(true);
    setOutcome(null);
    const result = await postApproveProposal(proposal.id, {
      ...(args ? { args } : {}),
      force,
      idempotencyKey: attempt.keyFor(JSON.stringify({ args: args ?? null, force, id: proposal.id })),
    });
    setBusy(false);
    if (!result.ok) {
      if (!mightHaveArrived(result)) {
        attempt.settle();
      }
      setOutcome({ error: result.error });
      return;
    }
    attempt.settle();
    const execution = result.data.execution;
    if (!execution || result.data.proposal.status === "approved") {
      onDecided(Boolean(execution && execution.status !== "duplicate"));
      return;
    }
    /* Still pending: a conflict or a failure - show why and let the person decide again. */
    setOutcome({ execution });
  };

  const reject = async (): Promise<void> => {
    setBusy(true);
    const result = await postRejectProposal(proposal.id);
    setBusy(false);
    /* 410: it expired meanwhile - the refetch shows it under earlier proposals, which is what Dismiss wanted. */
    if (!result.ok && result.status !== 410) {
      setOutcome({ error: result.error });
      return;
    }
    onDecided(false);
  };

  return (
    <li className="act-card" data-expired={expired}>
      <div className="act-card-head">
        <span className="act-source" data-source={proposal.source.type}>
          <Icon name={proposal.source.type === "assist" ? "bot" : "grid"} size={11} />
          {proposalSourceLabel(proposal.source)}
        </span>
        <span className="act-card-title">{describeAction(proposal.args, channelName)}</span>
        <span className="act-card-meta">
          {expired ? "Expired" : `for ${proposal.createdBy} · ${relativeTime(proposal.createdAt, now)}`}
        </span>
      </div>

      {proposal.rationale ? <p className="act-card-rationale">{proposal.rationale}</p> : null}

      {proposal.args.operation === "jira_comment" && proposal.args.visibility === "public" ? (
        <p className="act-warning">
          <Icon name="alert" size={13} />
          Visible to the customer on the portal.
        </p>
      ) : null}

      {isTextAction(proposal.args) ? (
        <div className="act-field">
          <label className="act-field-label" htmlFor={bodyId}>
            {edited ? "Message (edited - approving sends your version)" : "Message - edit before approving if needed"}
          </label>
          <textarea
            aria-invalid={!bodyOk}
            className="act-textarea"
            disabled={busy || expired}
            id={bodyId}
            onChange={(event) => setBody(event.target.value)}
            rows={Math.min(8, Math.max(3, body.split("\n").length))}
            value={body}
          />
          {proposal.args.operation === "firefighter_escalation" ? (
            <p className="trk-muted-note">{proposal.args.mentionOnCall ? "Tags whoever is on call." : "Doesn't tag anyone."}</p>
          ) : null}
        </div>
      ) : null}

      {outcome ? (
        "error" in outcome ? (
          <ErrorNotice message={outcome.error} />
        ) : (
          <ExecutionNotice execution={outcome.execution} forceLabel="Approve anyway" onForce={() => void approve(true)} onReload={() => onDecided(true)} />
        )
      ) : null}

      <div className="act-card-actions">
        <button className="act-send" disabled={busy || expired || !bodyOk} onClick={() => void approve()} type="button">
          <Icon name="check" size={13} />
          {busy ? "Working…" : edited ? "Approve edited" : "Approve"}
        </button>
        <button className="trk-btn" disabled={busy} onClick={() => void reject()} type="button">
          {expired ? "Dismiss" : "Reject"}
        </button>
      </div>
    </li>
  );
}
