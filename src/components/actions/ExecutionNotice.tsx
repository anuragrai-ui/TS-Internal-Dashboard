"use client";

import { Icon } from "@/components/Icon";
import { describeAction, EXECUTION_STATUS_LABEL, EXECUTION_STATUS_TONE, externalLinkLabel } from "@/lib/actions/describe";

import type { IconName } from "@/components/Icon";
import type { ActionExecution, ExecutionStatus } from "@/lib/workspace/types";

const STATUS_ICON: Record<ExecutionStatus, IconName> = {
  conflict: "alert",
  duplicate: "history",
  failed: "alert",
  succeeded: "check-circle",
  uncertain: "alert",
};

/* What each outcome means for the person - the part they must act on comes first. */
function headline(execution: ActionExecution): string {
  switch (execution.status) {
    case "succeeded":
      return `${describeAction(execution.args)} - done.`;
    case "duplicate":
      return "Already done earlier - nothing was sent again.";
    case "conflict":
      return "The ticket changed since you loaded it. Nothing was changed.";
    case "uncertain":
      return "It may or may not have happened - check before retrying.";
    case "failed":
      return "Not done.";
  }
}

interface ExecutionNoticeProps {
  execution: ActionExecution;
  /* Conflict only: send the same action again with force. */
  onForce?: () => void;
  /* Conflict only: reload the ticket instead. */
  onReload?: () => void;
  /* Label for the force button ("Do it anyway", "Approve anyway"). */
  forceLabel?: string;
}

/** One action's outcome, inline under the control that caused it. */
export function ExecutionNotice({ execution, forceLabel = "Do it anyway", onForce, onReload }: ExecutionNoticeProps): React.ReactElement {
  const tone = EXECUTION_STATUS_TONE[execution.status];
  return (
    <div className="act-notice" data-tone={tone} role={tone === "danger" || tone === "warning" ? "alert" : "status"}>
      <span aria-hidden="true" className="act-notice-icon">
        <Icon name={STATUS_ICON[execution.status]} size={14} />
      </span>
      <div className="act-notice-body">
        <p className="act-notice-title">
          <span className="act-visually-hidden">{EXECUTION_STATUS_LABEL[execution.status]}: </span>
          {headline(execution)}
        </p>
        {execution.error && execution.status !== "succeeded" ? <p className="act-notice-detail">{execution.error}</p> : null}
        {execution.redirectedToTestChannel ? <p className="act-notice-detail">Slack test mode is on: it went to the test channel, with mentions suppressed.</p> : null}
        <div className="act-notice-actions">
          {execution.externalUrl ? (
            <a className="trk-inline-link" href={execution.externalUrl} rel="noreferrer" target="_blank">
              {externalLinkLabel(execution)} <Icon name="external-link" size={11} />
            </a>
          ) : null}
          {execution.status === "conflict" && onReload ? (
            <button className="trk-btn" onClick={onReload} type="button">
              <Icon name="refresh" size={12} />
              Reload
            </button>
          ) : null}
          {execution.status === "conflict" && onForce ? (
            <button className="trk-btn" onClick={onForce} type="button">
              {forceLabel}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** A request-level error (validation, rate limit, offline) - no execution was recorded. */
export function ErrorNotice({ message }: { message: string }): React.ReactElement {
  return (
    <div className="act-notice" data-tone="danger" role="alert">
      <span aria-hidden="true" className="act-notice-icon">
        <Icon name="alert" size={14} />
      </span>
      <div className="act-notice-body">
        <p className="act-notice-title">{message}</p>
      </div>
    </div>
  );
}
