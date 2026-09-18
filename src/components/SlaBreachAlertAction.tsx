"use client";

import { useState } from "react";

interface SlaBreachAlertActionProps {
  issueKey: string;
}

type Status = "idle" | "drafting" | "drafted" | "sending" | "sent" | "error";

interface DraftResponseBody {
  channel?: string;
  error?: string;
  pmDisplayName?: string;
  podName?: string;
  text?: string;
}

interface SendResponseBody {
  error?: string;
}

const DEFAULT_DRAFT_ERROR = "Failed to draft the SLA-breach alert.";
const DEFAULT_SEND_ERROR = "Failed to send the SLA-breach alert.";

export function SlaBreachAlertAction({ issueKey }: SlaBreachAlertActionProps): React.ReactElement {
  const [status, setStatus] = useState<Status>("idle");
  const [text, setText] = useState("");
  const [channel, setChannel] = useState("");
  const [pmDisplayName, setPmDisplayName] = useState<string | undefined>(undefined);
  const [podName, setPodName] = useState<string | undefined>(undefined);
  const [errorMessage, setErrorMessage] = useState("");

  const requestDraft = async (): Promise<void> => {
    setStatus("drafting");

    try {
      const response = await fetch(`/api/sla-followups/${issueKey}/slack-alert/draft`, { method: "POST" });
      const body = (await response.json()) as DraftResponseBody;

      if (!response.ok || typeof body.text !== "string" || !body.channel) {
        setErrorMessage(body.error ?? DEFAULT_DRAFT_ERROR);
        setStatus("error");
        return;
      }

      setText(body.text);
      setChannel(body.channel);
      setPmDisplayName(body.pmDisplayName);
      setPodName(body.podName);
      setStatus("drafted");
    } catch {
      setErrorMessage(DEFAULT_DRAFT_ERROR);
      setStatus("error");
    }
  };

  const sendAlert = async (): Promise<void> => {
    setStatus("sending");

    try {
      const response = await fetch(`/api/sla-followups/${issueKey}/slack-alert/send`, {
        body: JSON.stringify({ channel, text }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const body = (await response.json()) as SendResponseBody;

      if (!response.ok) {
        setErrorMessage(body.error ?? DEFAULT_SEND_ERROR);
        setStatus("error");
        return;
      }

      setStatus("sent");
    } catch {
      setErrorMessage(DEFAULT_SEND_ERROR);
      setStatus("error");
    }
  };

  const handleCancel = (): void => {
    setText("");
    setStatus("idle");
  };

  if (status === "idle") {
    return (
      <button className="followup-button" onClick={() => void requestDraft()} type="button">
        Alert POD (Slack)
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
        <p className="followup-research-note">
          Posting to {podName ?? "an unmapped POD's fallback"} channel{pmDisplayName ? `, tagging ${pmDisplayName}` : ""}.
        </p>
        <textarea
          className="followup-textarea"
          disabled={sending}
          onChange={(event) => setText(event.target.value)}
          rows={4}
          value={text}
        />
        <div className="followup-panel-actions">
          <button
            className="followup-button followup-button-primary"
            disabled={sending || text.trim().length === 0}
            onClick={() => void sendAlert()}
            type="button"
          >
            {sending ? "Sending…" : "Send to Slack"}
          </button>
          <button className="followup-button" disabled={sending} onClick={handleCancel} type="button">
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (status === "sent") {
    return <span className="followup-status followup-status-success">SLA-breach alert posted to Slack.</span>;
  }

  return (
    <div className="followup-panel">
      <span className="followup-status followup-status-error">{errorMessage}</span>
      <button className="followup-button" onClick={() => void requestDraft()} type="button">
        Retry
      </button>
    </div>
  );
}
