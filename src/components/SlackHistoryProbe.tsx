"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import type { SlackHistoryProbeResult } from "@/lib/tracker/slackBackfill";

const VERDICT_TEXT: Record<SlackHistoryProbeResult["verdict"], string> = {
  clamped: "Throttled: Slack limits this app's history reads (about one call a minute, 15 messages a page). The tracker's backfill drips slowly and live events do most of the work.",
  full: "Full access: Slack returned a full page. The backfill can catch up quickly.",
  unknown: "Inconclusive: the channel has too few messages to tell. Try again once it has more than 15.",
};

/* Settings -> Slack "Check Slack history access": two back-to-back history reads, counts only. */
export function SlackHistoryProbe(): React.ReactElement {
  const router = useRouter();
  const [status, setStatus] = useState<"error" | "idle" | "running" | "done">("idle");
  const [result, setResult] = useState<SlackHistoryProbeResult | null>(null);
  const [message, setMessage] = useState("");

  const run = async (): Promise<void> => {
    setStatus("running");
    setMessage("");
    try {
      const response = await fetch("/api/settings/slack-connection/history-probe", { method: "POST" });
      const body = (await response.json()) as Partial<SlackHistoryProbeResult> & { error?: string };
      if (!response.ok || body.verdict === undefined) {
        setMessage(body.error ?? "The check failed.");
        setStatus("error");
        return;
      }
      setResult(body as SlackHistoryProbeResult);
      setStatus("done");
    } catch {
      setMessage("The check failed.");
      setStatus("error");
    }
  };

  return (
    <div className="followup-panel">
      <div className="followup-panel-actions">
        <button className="followup-button followup-button-primary" disabled={status === "running"} onClick={() => void run()} type="button">
          {status === "running" ? "Checking…" : "Check Slack history access"}
        </button>
        <button className="followup-button" onClick={() => router.refresh()} type="button">
          Refresh progress
        </button>
      </div>
      {result ? (
        <span className={result.verdict === "full" ? "followup-status followup-status-success" : "followup-status"}>
          {VERDICT_TEXT[result.verdict]} First call on <code>{result.channel}</code>: {result.firstCallCount} message
          {result.firstCallCount === 1 ? "" : "s"}
          {result.hasMore ? ", more available" : ""}. Second call: {result.secondCallRateLimited ? `rate limited${result.retryAfterSeconds ? ` (retry after ${result.retryAfterSeconds}s)` : ""}` : "allowed"}.
          {result.error ? ` Slack said: ${result.error}.` : ""}
        </span>
      ) : null}
      {message ? <span className="followup-status followup-status-error">{message}</span> : null}
    </div>
  );
}
