"use client";

import { useState } from "react";

interface ClosureCandidateActionProps {
  issueKey: string;
}

type Status = "idle" | "drafting" | "drafted" | "sending" | "sent" | "error";

interface DraftResponseBody {
  draftText?: string;
  error?: string;
  mentionAccountId?: string;
  toolCallCount?: number;
}

interface SendResponseBody {
  error?: string;
  transitionError?: string;
  transitionedToDone?: boolean;
}

const DEFAULT_DRAFT_ERROR = "Failed to draft a closure message.";
const DEFAULT_SEND_ERROR = "Failed to send the closure message.";

export function ClosureCandidateAction({ issueKey }: ClosureCandidateActionProps): React.ReactElement {
  const [status, setStatus] = useState<Status>("idle");
  const [draftText, setDraftText] = useState("");
  const [mentionAccountId, setMentionAccountId] = useState<string | undefined>(undefined);
  const [errorMessage, setErrorMessage] = useState("");
  const [resultMessage, setResultMessage] = useState("");
  const [toolCallCount, setToolCallCount] = useState(0);

  const requestDraft = async (): Promise<void> => {
    setStatus("drafting");

    try {
      const response = await fetch(`/api/closure-candidates/${issueKey}/draft`, {
        method: "POST",
      });
      const body = (await response.json()) as DraftResponseBody;

      if (!response.ok || typeof body.draftText !== "string") {
        setErrorMessage(body.error ?? DEFAULT_DRAFT_ERROR);
        setStatus("error");
        return;
      }

      setDraftText(body.draftText);
      setMentionAccountId(body.mentionAccountId);
      setToolCallCount(body.toolCallCount ?? 0);
      setStatus("drafted");
    } catch {
      setErrorMessage(DEFAULT_DRAFT_ERROR);
      setStatus("error");
    }
  };

  const sendClosure = async (): Promise<void> => {
    setStatus("sending");

    try {
      const response = await fetch(`/api/tickets/${issueKey}/followup/send`, {
        body: JSON.stringify({
          kind: "closure_candidate",
          mentionAccountId,
          text: draftText,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const body = (await response.json()) as SendResponseBody;

      if (!response.ok) {
        setErrorMessage(body.error ?? DEFAULT_SEND_ERROR);
        setStatus("error");
        return;
      }

      setResultMessage(
        body.transitionedToDone
          ? "Closure message sent and ticket marked Done."
          : `Closure message sent, but could not mark the ticket Done automatically (${body.transitionError ?? "unknown error"}). Please close it manually in Jira.`,
      );
      setStatus("sent");
    } catch {
      setErrorMessage(DEFAULT_SEND_ERROR);
      setStatus("error");
    }
  };

  const handleCancel = (): void => {
    setDraftText("");
    setStatus("idle");
  };

  if (status === "idle") {
    return (
      <button
        className="followup-button"
        onClick={() => {
          void requestDraft();
        }}
        type="button"
      >
        Close ticket
      </button>
    );
  }

  if (status === "drafting") {
    return (
      <button className="followup-button" disabled type="button">
        Drafting…
      </button>
    );
  }

  if (status === "drafted" || status === "sending") {
    const sending = status === "sending";

    return (
      <div className="followup-panel">
        {toolCallCount > 0 ? (
          <p className="followup-research-note">
            Researched {toolCallCount} related {toolCallCount === 1 ? "item" : "items"} while drafting this.
          </p>
        ) : null}
        <textarea
          className="followup-textarea"
          disabled={sending}
          onChange={(event) => setDraftText(event.target.value)}
          rows={5}
          value={draftText}
        />
        <p className="sla-stage-note">
          Sending this will also mark {issueKey} as <strong>Done</strong>.
        </p>
        <div className="followup-panel-actions">
          <button
            className="followup-button followup-button-primary"
            disabled={sending || draftText.trim().length === 0}
            onClick={() => {
              void sendClosure();
            }}
            type="button"
          >
            {sending ? "Sending…" : "Send & mark Done"}
          </button>
          <button className="followup-button" disabled={sending} onClick={handleCancel} type="button">
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (status === "sent") {
    return <span className="followup-status followup-status-success">{resultMessage}</span>;
  }

  return (
    <div className="followup-panel">
      <span className="followup-status followup-status-error">{errorMessage}</span>
      <button
        className="followup-button"
        onClick={() => {
          void requestDraft();
        }}
        type="button"
      >
        Retry
      </button>
    </div>
  );
}
