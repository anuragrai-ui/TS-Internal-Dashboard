"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";

import { fetchAssistRun, fetchAssistRuns, fetchAssistSummary, startAssistInvestigation } from "@/components/assist/assistApi";
import { Icon } from "@/components/Icon";
import { AI_NOT_CONFIGURED_CODE } from "@/lib/assist/config";
import { relativeTime } from "@/lib/tracker/views";
import { UI_EVENTS } from "@/lib/workspace/types";

import type { AssistRunView } from "@/components/assist/assistApi";
import type { IconName } from "@/components/Icon";
import type { AssistRunStatus, AssistSource, AssistSummary, PrepareReplyDetail, ProposalsChangedDetail } from "@/lib/workspace/types";

/**
 * The detail panel's "Assist" card:
 * - a 3-5 line summary of the ticket, loaded when the ticket opens (cached
 *   server-side per Jira update) with a Refresh
 * - Investigate: starts (or joins) a tool-using investigation, polls it every
 *   3s until it ends (giving up after 7 minutes), and picks an in-flight run
 *   back up when the ticket is reopened
 * - the result: sourced facts, hypotheses marked as such, what's missing, the
 *   next step, a customer draft that can be dropped into the composer (never
 *   sent from here) and how many actions were proposed for review
 * - the last 5 runs, collapsible
 *
 * Talks to the rest of the page only through window events
 * (UI_EVENTS.prepareReply / proposalsChanged), so it can be mounted anywhere.
 */

const POLL_MS = 3_000;
const POLL_LIMIT_MS = 7 * 60_000;
const PAST_RUNS = 5;

type SummaryState = { code?: string; error: string; status: "error" } | { status: "loading" } | { status: "ready"; summary: AssistSummary };

const SOURCE_ICON: Record<AssistSource["kind"], IconName> = {
  confluence: "note",
  cp: "layers",
  jira_comment: "message",
  jira_field: "ticket",
  jira_search: "search",
  oncall: "user",
  slack_message: "hash",
};

const STATUS_LABEL: Record<AssistRunStatus, string> = {
  failed: "Failed",
  queued: "Queued",
  running: "Running",
  succeeded: "Done",
};

const OPERATION_LABEL: Record<string, string> = {
  firefighter_escalation: "Escalate to #firefighters",
  jira_assign: "Assign",
  jira_comment: "Comment",
  jira_link_cp: "Link a CP",
  jira_priority: "Change priority",
  jira_transition: "Change status",
  slack_thread_reply: "Reply in Slack",
};

function isOpen(run: AssistRunView): boolean {
  return run.status === "queued" || run.status === "running";
}

function byNewest(a: AssistRunView, b: AssistRunView): number {
  return Date.parse(b.createdAt) - Date.parse(a.createdAt);
}

function proposalCount(run: AssistRunView): number {
  return run.result?.proposedActions.filter((action) => Boolean(action.proposalId)).length ?? 0;
}

/* "claude-sonnet-5-5" -> "Claude Sonnet 5.5"; anything unrecognised is shown as is. */
function modelLabel(model: string): string {
  const match = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(model);
  if (!match) {
    return model;
  }
  const [, family = "", major = "", minor] = match;
  return `Claude ${family.charAt(0).toUpperCase()}${family.slice(1)} ${major}${minor ? `.${minor}` : ""}`;
}

function elapsedText(fromIso: string, now: number): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(fromIso)) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/* Links come from the server's tool outputs, but only plain https links are ever made clickable. */
function safeUrl(url: string | undefined): string | null {
  return url && /^https:\/\//i.test(url) ? url : null;
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/* ------------------------------------------------------------- pieces */

function SourceChips({ sources }: { sources: AssistSource[] }): React.ReactElement {
  return (
    <ul aria-label="Sources" className="ast-sources">
      {sources.map((source, index) => {
        const url = safeUrl(source.url);
        const content = (
          <>
            <Icon name={SOURCE_ICON[source.kind] ?? "link"} size={11} />
            <span className="ast-chip-label">{source.label}</span>
          </>
        );
        return (
          <li key={`${source.label}-${index}`}>
            {url ? (
              <a className="ast-chip" href={url} rel="noreferrer" target="_blank">
                {content}
                <span className="visually-hidden"> (opens in a new tab)</span>
              </a>
            ) : (
              <span className="ast-chip" data-static="true">
                {content}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function SummaryBlock({
  now,
  onRefresh,
  refreshing,
  state,
}: {
  now: number;
  onRefresh: () => void;
  refreshing: boolean;
  state: SummaryState;
}): React.ReactElement {
  return (
    <div aria-busy={state.status === "loading" || refreshing} className="ast-section">
      <div className="ast-section-head">
        <h4 className="ast-subhead">Summary</h4>
        <button className="ast-link-btn" disabled={state.status === "loading" || refreshing} onClick={onRefresh} type="button">
          <Icon name="refresh" size={12} />
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      {state.status === "loading" ? (
        <div aria-label="Loading the summary" className="ast-skeleton" role="status">
          <span />
          <span />
          <span />
        </div>
      ) : state.status === "error" ? (
        <p className="ast-note" data-tone="danger">
          {state.error}
        </p>
      ) : (
        <>
          <ul className="ast-summary-lines">
            {state.summary.text.split("\n").map((line, index) => (
              <li key={index}>{line}</li>
            ))}
          </ul>
          <p className="ast-meta">
            {modelLabel(state.summary.model)} · written {relativeTime(state.summary.generatedAt, now)}
            {state.summary.basedOnUpdated ? ` · Jira last updated ${relativeTime(state.summary.basedOnUpdated, now)}` : ""}
          </p>
        </>
      )}
    </div>
  );
}

function RunProgress({ now, run }: { now: number; run: AssistRunView }): React.ReactElement {
  return (
    <div className="ast-progress">
      <div className="ast-progress-head">
        <span aria-hidden="true" className="ast-spinner" />
        <strong>{run.status === "queued" ? "Starting the investigation…" : "Investigating…"}</strong>
        <span className="ast-muted">
          {elapsedText(run.startedAt ?? run.createdAt, now)}
          {run.toolCalls > 0 ? ` · ${plural(run.toolCalls, "lookup")} so far` : ""}
        </span>
      </div>
      <div aria-label="Investigation in progress" className="ast-progress-bar" role="progressbar">
        <span />
      </div>
      <p className="ast-muted">Usually one to three minutes. It keeps running if you move to another ticket.</p>
    </div>
  );
}

function RunResult({
  now,
  onUseDraft,
  run,
}: {
  now: number;
  onUseDraft: (body: string, target: "internal" | "public") => void;
  run: AssistRunView;
}): React.ReactElement | null {
  const meta = (
    <p className="ast-meta">
      {run.status === "failed" ? "Failed" : "Investigated"} {relativeTime(run.finishedAt ?? run.createdAt, now)} · started by {run.startedBy} ·{" "}
      {plural(run.toolCalls, "lookup")} · {modelLabel(run.model)}
    </p>
  );

  if (run.status === "failed") {
    return (
      <div className="ast-result">
        <p className="ast-note" data-tone="danger">
          The investigation failed: {run.error ?? "unknown error"}
        </p>
        {meta}
      </div>
    );
  }

  const result = run.result;
  if (!result) {
    return null;
  }
  const proposed = proposalCount(run);
  const dropped = result.droppedActions ?? [];

  return (
    <div className="ast-result">
      {meta}
      <p className="ast-result-summary">{result.summary}</p>

      {result.facts.length > 0 ? (
        <div className="ast-section">
          <h4 className="ast-subhead">Facts</h4>
          <ul className="ast-facts">
            {result.facts.map((fact, index) => (
              <li className="ast-fact" key={index}>
                <p>{fact.text}</p>
                <SourceChips sources={fact.sources} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {result.hypotheses.length > 0 ? (
        <div className="ast-section">
          <h4 className="ast-subhead">Hypotheses</h4>
          <ul className="ast-hypotheses">
            {result.hypotheses.map((hypothesis, index) => (
              <li className="ast-hypothesis" key={index}>
                <span className="ast-tag">Hypothesis</span>
                <span>{hypothesis}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {result.missing.length > 0 ? (
        <div className="ast-section">
          <h4 className="ast-subhead">Missing information</h4>
          <ul className="ast-missing">
            {result.missing.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {result.nextStep ? (
        <div className="ast-next">
          <h4 className="ast-subhead">Next step</h4>
          <p>{result.nextStep}</p>
        </div>
      ) : null}

      {result.customerDraft ? (
        <div className="ast-draft">
          <h4 className="ast-subhead">Customer draft</h4>
          <p className="ast-draft-text">{result.customerDraft}</p>
          <div className="ast-row">
            <button className="ast-btn" onClick={() => onUseDraft(result.customerDraft ?? "", "public")} type="button">
              <Icon name="message" size={13} />
              Use as reply
            </button>
            <button className="ast-btn" onClick={() => onUseDraft(result.customerDraft ?? "", "internal")} type="button">
              <Icon name="note" size={13} />
              Use as internal note
            </button>
          </div>
          <p className="ast-muted">Puts the text in the composer to edit - nothing is sent until you send it.</p>
        </div>
      ) : null}

      {proposed > 0 ? (
        <p className="ast-proposed">
          <Icon name="zap" size={13} />
          {plural(proposed, "action")} proposed - review below
        </p>
      ) : null}

      {dropped.length > 0 ? (
        <details className="ast-dropped">
          <summary>{plural(dropped.length, "suggestion")} not proposed</summary>
          <ul>
            {dropped.map((item, index) => (
              <li key={index}>
                {OPERATION_LABEL[item.operation] ?? item.operation}: {item.reason}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------------- card */

function AssistCard({ ticketKey }: { ticketKey: string }): React.ReactElement {
  const headingId = useId();
  const [summary, setSummary] = useState<SummaryState>({ status: "loading" });
  const [refreshing, setRefreshing] = useState(false);
  const [runs, setRuns] = useState<AssistRunView[]>([]);
  const [runsError, setRunsError] = useState<string | null>(null);
  const [pollingId, setPollingId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<{ code?: string; error: string } | null>(null);
  const [pollNote, setPollNote] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [now, setNow] = useState(() => Date.now());
  /* Runs whose proposals were already announced to the proposals list - once per run. */
  const proposalsAnnounced = useRef(new Set<string>());

  const upsertRun = useCallback((run: AssistRunView) => {
    setRuns((previous) => [run, ...previous.filter((existing) => existing.id !== run.id)].sort(byNewest));
  }, []);

  /* The summary loads as soon as the ticket opens. */
  useEffect(() => {
    let cancelled = false;
    void fetchAssistSummary(ticketKey, false).then((result) => {
      if (!cancelled) {
        setSummary(result.ok ? { status: "ready", summary: result.data } : { code: result.code, error: result.error, status: "error" });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [ticketKey]);

  /* Past runs - and an investigation still in flight is picked back up. */
  useEffect(() => {
    let cancelled = false;
    void fetchAssistRuns(ticketKey).then((result) => {
      if (cancelled) {
        return;
      }
      if (!result.ok) {
        setRunsError(result.error);
        return;
      }
      /* A run started (or polled) while this was loading is fresher than the list's copy. */
      setRuns((previous) => {
        const known = new Set(previous.map((run) => run.id));
        return [...previous, ...result.data.runs.filter((run) => !known.has(run.id))].sort(byNewest);
      });
      const inFlight = result.data.runs.find(isOpen);
      if (inFlight) {
        setPollingId((current) => current ?? inFlight.id);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [ticketKey]);

  /* A clock for "2m ago" and the elapsed time: every second while a run is going, else every 30s. */
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), pollingId ? 1_000 : 30_000);
    return () => clearInterval(timer);
  }, [pollingId]);

  /* Polls the open run until it ends; a network blip just waits for the next tick. */
  useEffect(() => {
    if (!pollingId) {
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pollStarted = Date.now();

    const finish = (run: AssistRunView): void => {
      setSelectedId(run.id);
      if (run.status !== "succeeded") {
        setAnnouncement(`The investigation failed: ${run.error ?? "unknown error"}`);
        return;
      }
      const proposed = proposalCount(run);
      setAnnouncement(`Investigation finished${proposed > 0 ? `, ${plural(proposed, "action")} proposed for review` : ""}.`);
      if (proposed > 0 && !proposalsAnnounced.current.has(run.id)) {
        proposalsAnnounced.current.add(run.id);
        window.dispatchEvent(new CustomEvent<ProposalsChangedDetail>(UI_EVENTS.proposalsChanged, { detail: { ticketKey } }));
      }
    };

    const tick = async (): Promise<void> => {
      if (cancelled) {
        return;
      }
      if (Date.now() - pollStarted > POLL_LIMIT_MS) {
        setPollingId(null);
        setPollNote("Still no answer after 7 minutes - stopped checking. Reopen the ticket later to see whether it finished.");
        setAnnouncement("Stopped waiting for the investigation.");
        return;
      }
      const result = await fetchAssistRun(pollingId);
      if (cancelled) {
        return;
      }
      if (result.ok) {
        upsertRun(result.data.run);
        if (!isOpen(result.data.run)) {
          setPollingId(null);
          finish(result.data.run);
          return;
        }
      } else if (result.status === 404) {
        setPollingId(null);
        setPollNote(result.error);
        return;
      }
      timer = setTimeout(() => void tick(), POLL_MS);
    };

    timer = setTimeout(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [pollingId, ticketKey, upsertRun]);

  const refresh = async (): Promise<void> => {
    setRefreshing(true);
    const result = await fetchAssistSummary(ticketKey, true);
    setRefreshing(false);
    if (result.ok) {
      setSummary({ status: "ready", summary: result.data });
      setAnnouncement("Summary refreshed.");
    } else {
      /* A failed refresh keeps the summary on screen and says why. */
      setSummary((previous) => (previous.status === "ready" ? previous : { code: result.code, error: result.error, status: "error" }));
      setAnnouncement(`Couldn't refresh the summary: ${result.error}`);
    }
  };

  const start = async (): Promise<void> => {
    setStarting(true);
    setStartError(null);
    setPollNote(null);
    const result = await startAssistInvestigation(ticketKey);
    setStarting(false);
    if (!result.ok) {
      setStartError({ code: result.code, error: result.error });
      setAnnouncement(`Couldn't start the investigation: ${result.error}`);
      return;
    }
    const run = result.data.run;
    upsertRun(run);
    if (isOpen(run)) {
      setPollingId(run.id);
      setAnnouncement("Investigation started. It usually takes one to three minutes.");
    } else {
      setSelectedId(run.id);
    }
  };

  const prepareDraft = (body: string, target: "internal" | "public"): void => {
    const detail: PrepareReplyDetail = { body, target, ticketKey };
    window.dispatchEvent(new CustomEvent<PrepareReplyDetail>(UI_EVENTS.prepareReply, { detail }));
    setAnnouncement(target === "public" ? "Draft placed in the reply box - review it before sending." : "Draft placed in the internal note box.");
  };

  const unconfigured = (summary.status === "error" && summary.code === AI_NOT_CONFIGURED_CODE) || startError?.code === AI_NOT_CONFIGURED_CODE;
  const activeRun = pollingId ? runs.find((run) => run.id === pollingId) : undefined;
  const finishedRuns = runs.filter((run) => !isOpen(run));
  const shownRun = finishedRuns.find((run) => run.id === selectedId) ?? finishedRuns[0];
  const pastRuns = runs.slice(0, PAST_RUNS);

  return (
    <section aria-labelledby={headingId} className="ast-card">
      <div aria-live="polite" className="visually-hidden">
        {announcement}
      </div>

      <header className="ast-head">
        <span aria-hidden="true" className="ast-head-icon">
          <Icon name="bot" size={14} />
        </span>
        <h3 className="ast-title" id={headingId}>
          Assist
        </h3>
        <span className="ast-ai-badge" title="Written by AI - check it before relying on it">
          AI
        </span>
      </header>

      {unconfigured ? (
        <p className="ast-note" data-tone="warning">
          AI is not configured for this dashboard yet: an admin needs to set ANTHROPIC_API_KEY in Vercel. Summaries and investigations stay off until then.
        </p>
      ) : (
        <>
          <SummaryBlock now={now} onRefresh={() => void refresh()} refreshing={refreshing} state={summary} />

          <div className="ast-investigate">
            <button
              aria-busy={starting}
              className="ast-btn"
              data-variant="primary"
              disabled={starting || Boolean(activeRun)}
              onClick={() => void start()}
              type="button"
            >
              <Icon name="search" size={13} />
              {starting ? "Starting…" : activeRun ? "Investigating…" : shownRun ? "Investigate again" : "Investigate"}
            </button>
            <p className="ast-muted">Reads the ticket, its Slack threads and CPs, similar tickets and Confluence, then suggests actions for you to approve. It never sends anything.</p>
          </div>

          {startError ? (
            <p className="ast-note" data-tone="danger" role="alert">
              {startError.error}
            </p>
          ) : null}
          {activeRun ? <RunProgress now={now} run={activeRun} /> : null}
          {pollNote ? <p className="ast-note">{pollNote}</p> : null}
          {runsError && runs.length === 0 ? <p className="ast-note">Past investigations couldn&apos;t be loaded: {runsError}</p> : null}
          {shownRun ? <RunResult now={now} onUseDraft={prepareDraft} run={shownRun} /> : null}

          {pastRuns.length > 1 ? (
            <details className="ast-past">
              <summary>Past investigations ({pastRuns.length})</summary>
              <ul className="ast-past-list">
                {pastRuns.map((run) => (
                  <li key={run.id}>
                    <button
                      aria-pressed={run.id === shownRun?.id}
                      className="ast-past-item"
                      disabled={isOpen(run)}
                      onClick={() => setSelectedId(run.id)}
                      type="button"
                    >
                      <span className="ast-status" data-status={run.status}>
                        {STATUS_LABEL[run.status]}
                      </span>
                      <span className="ast-past-when">
                        {relativeTime(run.createdAt, now)} · {run.startedBy}
                      </span>
                      {run.status === "succeeded" ? <span className="ast-muted">{plural(proposalCount(run), "proposal")}</span> : null}
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </>
      )}
    </section>
  );
}

/** The Assist card for one TS ticket. Remounts per ticket, so nothing (polling, results) carries over to the next one. */
export function AssistPanel({ ticketKey }: { ticketKey: string }): React.ReactElement {
  return <AssistCard key={ticketKey} ticketKey={ticketKey} />;
}
