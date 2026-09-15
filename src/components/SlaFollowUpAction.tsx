"use client";

import { useState } from "react";

interface SlaFollowUpActionProps {
  issueKey: string;
  stage: 1 | 2 | 3;
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

const DEFAULT_DRAFT_ERROR = "Failed to draft a follow-up message.";
const DEFAULT_SEND_ERROR = "Failed to send the follow-up.";

export function SlaFollowUpAction({ issueKey, stage }: SlaFollowUpActionProps): React.ReactElement {
  const [status, setStatus] = useState<Status>("idle");
  const [draftText, setDraftText] = useState("");
  const [mentionAccountId, setMentionAccountId] = useState<string | undefined>(undefined);
  const [errorMessage, setErrorMessage] = useState("");
  const [resultMessage, setResultMessage] = useState("");
  const [toolCallCount, setToolCallCount] = useState(0);

  const requestDraft = async (): Promise<void> => {
    setStatus("drafting");

    try {
      const response = await fetch(`/api/sla-followups/${issueKey}/draft`, {
        body: JSON.stringify({ stage }),
        headers: { "Content-Type": "application/json" },
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

  const sendFollowUp = async (): Promise<void> => {
    setStatus("sending");

    try {
      const kindByStage = { 1: "sla_stage_1", 2: "sla_stage_2", 3: "sla_stage_3" } as const;

      const response = await fetch(`/api/tickets/${issueKey}/followup/send`, {
        body: JSON.stringify({
          kind: kindByStage[stage],
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

      if (stage !== 1) {
        setResultMessage(
          body.transitionedToDone
            ? "Follow-up sent and ticket marked Done."
            : `Follow-up sent, but could not mark the ticket Done automatically (${body.transitionError ?? "unknown error"}). Please close it manually in Jira.`,
        );
      } else {
        setResultMessage("Follow-up sent.");
      }

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
        {stage === 3 ? "Close ticket" : stage === 2 ? "Draft closure follow-up" : "Draft follow-up"}
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
        {stage !== 1 ? (
          <p className="sla-stage-note">
            Sending this will also mark {issueKey} as <strong>Done</strong>.
          </p>
        ) : null}
        <div className="followup-panel-actions">
          <button
            className="followup-button followup-button-primary"
            disabled={sending || draftText.trim().length === 0}
            onClick={() => {
              void sendFollowUp();
            }}
            type="button"
          >
            {sending ? "Sending…" : stage !== 1 ? "Send & mark Done" : "Send"}
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
