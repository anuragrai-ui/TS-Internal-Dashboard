"use client";

import { useState } from "react";

interface CpEscalationActionProps {
  cpKey: string;
  mentionDisplayName: string;
  mentionSource: string;
}

type Status = "idle" | "drafting" | "drafted" | "sending" | "sent" | "error";

interface DraftResponseBody {
  draftText?: string;
  error?: string;
  mentionAccountId?: string;
  mentionDisplayName?: string;
  mentionSource?: string;
  toolCallCount?: number;
}

interface SendResponseBody {
  error?: string;
  mentionFailed?: boolean;
}

const DEFAULT_DRAFT_ERROR = "Failed to draft an escalation message.";
const DEFAULT_SEND_ERROR = "Failed to send the escalation.";

export function CpEscalationAction({
  cpKey,
  mentionDisplayName: initialMentionDisplayName,
  mentionSource: initialMentionSource,
}: CpEscalationActionProps): React.ReactElement {
  const [status, setStatus] = useState<Status>("idle");
  const [draftText, setDraftText] = useState("");
  const [mentionAccountId, setMentionAccountId] = useState<string | undefined>(undefined);
  const [mentionDisplayName, setMentionDisplayName] = useState(initialMentionDisplayName);
  const [mentionSource, setMentionSource] = useState(initialMentionSource);
  const [errorMessage, setErrorMessage] = useState("");
  const [resultMessage, setResultMessage] = useState("");

  const requestDraft = async (): Promise<void> => {
    setStatus("drafting");

    try {
      const response = await fetch(`/api/agent-followups/cp/${cpKey}/draft`, { method: "POST" });
      const body = (await response.json()) as DraftResponseBody;

      if (!response.ok || typeof body.draftText !== "string") {
        setErrorMessage(body.error ?? DEFAULT_DRAFT_ERROR);
        setStatus("error");
        return;
      }

      setDraftText(body.draftText);
      setMentionAccountId(body.mentionAccountId);
      if (body.mentionDisplayName) {
        setMentionDisplayName(body.mentionDisplayName);
      }
      if (body.mentionSource) {
        setMentionSource(body.mentionSource);
      }
      setStatus("drafted");
    } catch {
      setErrorMessage(DEFAULT_DRAFT_ERROR);
      setStatus("error");
    }
  };

  const sendEscalation = async (): Promise<void> => {
    setStatus("sending");

    try {
      const response = await fetch(`/api/tickets/${cpKey}/followup/send`, {
        body: JSON.stringify({ kind: "cp_escalation", mentionAccountId, text: draftText }),
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
        body.mentionFailed
          ? "Escalation sent, but the mention couldn't be posted (the account may be deactivated) - sent as plain text instead. Please check who owns this in Jira."
          : "Escalation sent.",
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

  const unconfirmedTarget = mentionSource === "unconfirmed_reporter_guess";

  if (status === "idle") {
    return (
      <button
        className="followup-button"
        onClick={() => {
          void requestDraft();
        }}
        type="button"
      >
        Draft nudge
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
        {unconfirmedTarget ? (
          <p className="sla-stage-note">
            No assignee or prior mention found - defaulting to reporter <strong>{mentionDisplayName}</strong>.
            Please confirm this is the right person before sending.
          </p>
        ) : (
          <p className="followup-research-note">Tagging {mentionDisplayName} ({mentionSource.replace(/_/g, " ")}).</p>
        )}
        <textarea
          className="followup-textarea"
          disabled={sending}
          onChange={(event) => setDraftText(event.target.value)}
          rows={4}
          value={draftText}
        />
        <div className="followup-panel-actions">
          <button
            className="followup-button followup-button-primary"
            disabled={sending || draftText.trim().length === 0}
            onClick={() => {
              void sendEscalation();
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
