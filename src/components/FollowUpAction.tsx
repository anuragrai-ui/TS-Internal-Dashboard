"use client";

import { useState } from "react";

import type { FormattedIssue } from "@/lib/jiraClient";

interface FollowUpActionProps {
  initialCooldownActive?: boolean;
  issue: FormattedIssue;
}

type FollowUpStatus = "idle" | "drafting" | "drafted" | "sending" | "sent" | "error";
type FollowUpFailedAction = "draft" | "send";

interface DraftResponseBody {
  draftText?: string;
  error?: string;
  toolCallCount?: number;
}

interface SendResponseBody {
  error?: string;
  postedAt?: string;
}

const DEFAULT_DRAFT_ERROR = "Failed to draft a follow-up message.";
const DEFAULT_SEND_ERROR = "Failed to send the follow-up.";

export function FollowUpAction({
  initialCooldownActive = false,
  issue,
}: FollowUpActionProps): React.ReactElement {
  const [status, setStatus] = useState<FollowUpStatus>("idle");
  const [draftText, setDraftText] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [failedAction, setFailedAction] = useState<FollowUpFailedAction>("draft");
  const [toolCallCount, setToolCallCount] = useState(0);

  const requestDraft = async (): Promise<void> => {
    setStatus("drafting");

    try {
      const response = await fetch(`/api/tickets/${issue.key}/followup/draft`, {
        method: "POST",
      });
      const body = (await response.json()) as DraftResponseBody;

      if (!response.ok || typeof body.draftText !== "string") {
        setErrorMessage(body.error ?? DEFAULT_DRAFT_ERROR);
        setFailedAction("draft");
        setStatus("error");
        return;
      }

      setDraftText(body.draftText);
      setToolCallCount(body.toolCallCount ?? 0);
      setStatus("drafted");
    } catch {
      setErrorMessage(DEFAULT_DRAFT_ERROR);
      setFailedAction("draft");
      setStatus("error");
    }
  };

  const sendFollowUp = async (): Promise<void> => {
    setStatus("sending");

    try {
      const response = await fetch(`/api/tickets/${issue.key}/followup/send`, {
        headers: { "Content-Type": "application/json" },
        method: "POST",
        body: JSON.stringify({ text: draftText }),
      });
      const body = (await response.json()) as SendResponseBody;

      if (!response.ok) {
        setErrorMessage(body.error ?? DEFAULT_SEND_ERROR);
        setFailedAction("send");
        setStatus("error");
        return;
      }

      setStatus("sent");
    } catch {
      setErrorMessage(DEFAULT_SEND_ERROR);
      setFailedAction("send");
      setStatus("error");
    }
  };

  const handleCancel = (): void => {
    setDraftText("");
    setStatus("idle");
  };

  const handleRetry = (): void => {
    if (failedAction === "send") {
      void sendFollowUp();
    } else {
      void requestDraft();
    }
  };

  if (status === "idle" && initialCooldownActive) {
    return (
      <button className="followup-button" disabled type="button">
        Already followed up recently
      </button>
    );
  }

  if (status === "idle") {
    return (
      <button
        className="followup-button"
        onClick={() => {
          void requestDraft();
        }}
        type="button"
      >
        Draft follow-up
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
        <div className="followup-panel-actions">
          <button
            className="followup-button followup-button-primary"
            disabled={sending || draftText.trim().length === 0}
            onClick={() => {
              void sendFollowUp();
            }}
            type="button"
          >
            {sending ? "Sending…" : "Send"}
          </button>
          <button className="followup-button" disabled={sending} onClick={handleCancel} type="button">
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (status === "sent") {
    return <span className="followup-status followup-status-success">Follow-up sent</span>;
  }

  return (
    <div className="followup-panel">
      <span className="followup-status followup-status-error">{errorMessage}</span>
      <button className="followup-button" onClick={handleRetry} type="button">
        Retry
      </button>
    </div>
  );
}
