"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

interface SlackTestPanelProps {
  testChannel: string | null;
}

export function SlackTestPanel({ testChannel }: SlackTestPanelProps): React.ReactElement {
  const router = useRouter();
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [message, setMessage] = useState("");

  const send = async (): Promise<void> => {
    setStatus("sending");
    try {
      const response = await fetch("/api/settings/slack-connection/test", { method: "POST" });
      const body = (await response.json()) as { error?: string; sent?: boolean };
      if (!response.ok || !body.sent) {
        setMessage(body.error ?? "Failed to send the test message.");
        setStatus("error");
        return;
      }
      setMessage("Sent. Check the test channel, then add a reaction to the message and press Refresh events.");
      setStatus("sent");
    } catch {
      setMessage("Failed to send the test message.");
      setStatus("error");
    }
  };

  return (
    <div className="followup-panel">
      <div className="followup-panel-actions">
        <button
          className="followup-button followup-button-primary"
          disabled={!testChannel || status === "sending"}
          onClick={() => void send()}
          title={testChannel ? undefined : "Only available in test mode"}
          type="button"
        >
          {status === "sending" ? "Sending…" : "Send test message"}
        </button>
        <button className="followup-button" onClick={() => router.refresh()} type="button">
          Refresh events
        </button>
      </div>
      {message ? (
        <span className={status === "error" ? "followup-status followup-status-error" : "followup-status followup-status-success"}>
          {message}
        </span>
      ) : null}
    </div>
  );
}
