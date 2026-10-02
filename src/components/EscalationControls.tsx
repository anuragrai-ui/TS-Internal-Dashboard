"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import type { RunSummary } from "@/lib/escalation/runnerStore";

interface EscalationControlsProps {
  mode: "off" | "shadow";
  shadowChannel: string | null;
}

function describeRun(summary: RunSummary): string {
  if (summary.skipped === "already_running") return "A run is already in progress - refresh in a minute.";
  if (summary.skipped === "off") return "The shadow run is switched off.";
  if (summary.skipped === "killed") return "ESCALATION_KILL is set in Vercel, so nothing runs.";
  if (summary.skipped === "no_shadow_channel") return "There's no shadow channel (SLACK_TEST_CHANNEL) configured.";
  if (summary.error) return `The run failed: ${summary.error}`;
  const posted = summary.posted.length;
  const held = summary.heldBackByCaps.length;
  return `Done in ${Math.round(summary.durationMs / 1000)}s: ${posted} message${posted === 1 ? "" : "s"} posted${held ? `, ${held} new thread${held === 1 ? "" : "s"} waiting for the per-run / per-day caps` : ""}, ${summary.trackedLive} escalation${summary.trackedLive === 1 ? "" : "s"} open.`;
}

export function EscalationControls({ mode, shadowChannel }: EscalationControlsProps): React.ReactElement {
  const router = useRouter();
  const [busy, setBusy] = useState<"mode" | "run" | null>(null);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);

  const setMode = async (next: "off" | "shadow"): Promise<void> => {
    setBusy("mode");
    setMessage(null);
    try {
      const response = await fetch("/api/escalations/config", {
        body: JSON.stringify({ mode: next }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) {
        setMessage({ error: true, text: body.error ?? "Couldn't change the mode." });
      } else {
        setMessage({
          error: false,
          text: next === "shadow" ? "Shadow run is on. Press Run now to open the first threads, or wait for the next 10-minute run." : "Paused. Nothing more is posted.",
        });
        router.refresh();
      }
    } catch {
      setMessage({ error: true, text: "Couldn't change the mode." });
    } finally {
      setBusy(null);
    }
  };

  const runNow = async (): Promise<void> => {
    setBusy("run");
    setMessage(null);
    try {
      const response = await fetch("/api/escalations/run", { method: "POST" });
      const body = (await response.json()) as { error?: string; summary?: RunSummary };
      setMessage(body.summary ? { error: Boolean(body.summary.error), text: describeRun(body.summary) } : { error: true, text: body.error ?? "The run failed." });
      router.refresh();
    } catch {
      setMessage({ error: true, text: "The run failed - check the connection and try again." });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="followup-panel">
      <div className="followup-panel-actions">
        {mode === "shadow" ? (
          <button className="followup-button" disabled={busy !== null} onClick={() => void setMode("off")} type="button">
            {busy === "mode" ? "Pausing…" : "Pause shadow run"}
          </button>
        ) : (
          <button
            className="followup-button followup-button-primary"
            disabled={busy !== null || !shadowChannel}
            onClick={() => void setMode("shadow")}
            title={shadowChannel ? undefined : "Needs SLACK_TEST_CHANNEL in Vercel"}
            type="button"
          >
            {busy === "mode" ? "Starting…" : "Start shadow run"}
          </button>
        )}
        <button className="followup-button" disabled={busy !== null || mode !== "shadow"} onClick={() => void runNow()} type="button">
          {busy === "run" ? "Running… (up to a minute)" : "Run now"}
        </button>
      </div>
      {message ? (
        <span className={message.error ? "followup-status followup-status-error" : "followup-status followup-status-success"}>{message.text}</span>
      ) : null}
    </div>
  );
}
