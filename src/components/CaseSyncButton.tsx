"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

interface SyncResponse {
  error?: string;
  ok?: boolean;
  skipped?: string;
  summary?: { durationMs: number; errors: string[]; processed: number; skippedUnchanged: number };
}

const SKIP_TEXT: Record<string, string> = {
  already_running: "A sync is already running; refresh in a moment to see its progress.",
  db_unconfigured: "The case store database is not configured.",
  jira_unconfigured: "The Jira service account is not configured.",
  redis_unconfigured: "Redis is not configured, so syncs cannot be coordinated.",
  throttled: "A sync ran in the last 30 seconds; try again shortly.",
};

/** The /cases "Sync now" button: POST /api/cases/sync, then re-render the server page with the new status. */
export function CaseSyncButton(): React.ReactElement {
  const router = useRouter();
  const [status, setStatus] = useState<"idle" | "running" | "done" | "error">("idle");
  const [message, setMessage] = useState("");

  const run = async (): Promise<void> => {
    setStatus("running");
    setMessage("");
    try {
      const response = await fetch("/api/cases/sync", { method: "POST" });
      const body = (await response.json()) as SyncResponse;
      if (body.skipped) {
        setMessage(SKIP_TEXT[body.skipped] ?? `Skipped (${body.skipped}).`);
        setStatus(body.ok ? "done" : "error");
      } else if (!response.ok || !body.ok) {
        setMessage(body.error ?? "The sync failed.");
        setStatus("error");
      } else {
        const summary = body.summary;
        const errors = summary?.errors.length ?? 0;
        setMessage(
          `Synced ${summary?.processed ?? 0} issue(s)${summary?.skippedUnchanged ? `, ${summary.skippedUnchanged} unchanged` : ""} in ${Math.round((summary?.durationMs ?? 0) / 1000)}s${errors ? ` with ${errors} error(s)` : ""}.`,
        );
        setStatus(errors ? "error" : "done");
      }
    } catch {
      setMessage("The sync request failed.");
      setStatus("error");
    }
    router.refresh();
  };

  return (
    <div className="followup-panel">
      <div className="followup-panel-actions">
        <button className="followup-button followup-button-primary" disabled={status === "running"} onClick={() => void run()} type="button">
          {status === "running" ? "Syncing…" : "Sync now"}
        </button>
        <button className="followup-button" onClick={() => router.refresh()} type="button">
          Refresh
        </button>
      </div>
      {message ? (
        <span className={status === "error" ? "followup-status followup-status-error" : "followup-status followup-status-success"}>{message}</span>
      ) : null}
    </div>
  );
}
