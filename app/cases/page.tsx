import Link from "next/link";

import { CaseSyncButton } from "@/components/CaseSyncButton";
import { Icon } from "@/components/Icon";
import { IdentityRequired } from "@/components/IdentityRequired";
import { CASE_POD } from "@/lib/cases/jiraSync";
import { getSyncStatus, listCases } from "@/lib/cases/read";
import { getCurrentIdentity } from "@/lib/currentIdentity";
import { isDatabaseConfigured } from "@/lib/db/client";

import type { CaseListItem, SyncStatus } from "@/lib/cases/types";
import type { Metadata } from "next";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Case store · TS Dashboard",
};

function formatTime(iso: string | null | undefined): string {
  const parsed = iso ? Date.parse(iso) : Number.NaN;
  return Number.isNaN(parsed)
    ? "—"
    : new Date(parsed).toLocaleString("en-US", { day: "numeric", hour: "numeric", minute: "2-digit", month: "short", timeZone: "America/New_York" }) + " ET";
}

/* Business hours, signed (negative = overrun), e.g. "-3.5 bh". */
function formatHours(ms: number | null | undefined): string {
  return ms === null || ms === undefined ? "—" : `${(ms / 3_600_000).toFixed(1)} bh`;
}

function clockBadge(state: string): React.ReactElement {
  const tone = state === "breached" ? "tone-danger" : state === "met" ? "tone-success" : state === "paused" ? "tone-warning" : "tone-accent";
  return <span className={`status-badge ${tone}`}>{state}</span>;
}

function Kpi({ label, sub, value }: { label: string; sub?: string; value: number | string }): React.ReactElement {
  return (
    <div className="kpi-item">
      <span className="kpi-label">{label}</span>
      <span className="kpi-value">{value}</span>
      {sub ? <span className="kpi-sub">{sub}</span> : null}
    </div>
  );
}

function SyncProgress({ status }: { status: SyncStatus }): React.ReactElement {
  const { backfill, incremental, lastError, lastTick, retry } = status.state;
  return (
    <div className="followup-panel">
      <span className="page-subtitle">
        Backfill:{" "}
        {backfill.done ? (
          <span className="status-badge tone-success">Done {formatTime(backfill.completedAt)}</span>
        ) : (
          <span className="status-badge tone-accent">{backfill.startedAt ? `In progress, after ${backfill.afterKey ?? "start"}` : "Not started"}</span>
        )}{" "}
        ({backfill.processed} issues). Incremental cursor: {formatTime(incremental.cursor)} ({incremental.processed} issues).
        {lastTick
          ? ` Last tick ${formatTime(lastTick.at)} (${lastTick.trigger}, ${lastTick.phase}): ${lastTick.processed} synced, ${lastTick.skippedUnchanged} unchanged, ${Math.round(lastTick.durationMs / 1000)}s.`
          : " No tick yet."}
        {retry.length > 0 ? ` ${retry.length} issue(s) queued for retry.` : ""}
      </span>
      {lastError ? (
        <span className="followup-status followup-status-error">
          Last error {formatTime(lastError.at)}: {lastError.message}
        </span>
      ) : null}
    </div>
  );
}

function ParityTable({ status }: { status: SyncStatus }): React.ReactElement {
  const { parity } = status;
  if (parity.examples.length === 0) {
    return <div className="empty-state">{parity.compared === 0 ? "No SLA clocks yet." : `All ${parity.compared} SLA clocks agree with Jira.`}</div>;
  }
  return (
    <div className="table-scroll">
      <table className="data-table">
        <caption className="visually-hidden">SLA clocks where our computation and Jira disagree</caption>
        <thead>
          <tr>
            <th scope="col">Ticket</th>
            <th scope="col">Metric</th>
            <th scope="col">Ours</th>
            <th scope="col">Jira</th>
            <th scope="col">Why</th>
          </tr>
        </thead>
        <tbody>
          {parity.examples.map((item) => (
            <tr key={`${item.jiraKey}-${item.metric}`}>
              <td>
                <Link href={`/tracker?ticket=${encodeURIComponent(item.jiraKey)}`}>{item.jiraKey}</Link>
              </td>
              <td className="cell-muted">{item.metric === "first_response" ? "First response" : "Resolution"}</td>
              <td>
                {clockBadge(item.ours.state)} <span className="cell-sub">{formatHours(item.ours.remainingMs)}</span>
              </td>
              <td>
                {clockBadge(item.jira.state)} <span className="cell-sub">{formatHours(item.jira.remainingMs)}</span>
              </td>
              <td className="cell-muted">{item.reason}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CaseTable({ cases }: { cases: CaseListItem[] }): React.ReactElement {
  if (cases.length === 0) {
    return <div className="empty-state">No cases synced yet - the first sync runs with the next poll, or press Sync now.</div>;
  }
  return (
    <div className="table-scroll">
      <table className="data-table">
        <caption className="visually-hidden">Cases in the case store</caption>
        <thead>
          <tr>
            <th scope="col">Ticket</th>
            <th scope="col">Summary</th>
            <th scope="col">Account</th>
            <th scope="col">Priority</th>
            <th scope="col">Status</th>
            <th scope="col">Assignee</th>
            <th scope="col">Resolution SLA (ours)</th>
            <th scope="col">Updated in Jira</th>
          </tr>
        </thead>
        <tbody>
          {cases.map((item) => (
            <tr key={item.jiraKey}>
              <td>
                <Link href={`/tracker?ticket=${encodeURIComponent(item.jiraKey)}`}>{item.jiraKey}</Link>
              </td>
              <td>{item.summary}</td>
              <td className="cell-muted">{item.accountName ?? "—"}</td>
              <td className="cell-muted">{item.priority ?? "—"}</td>
              <td className="cell-muted">{item.statusName}</td>
              <td className="cell-muted">{item.assigneeName ?? "Unassigned"}</td>
              <td>
                {item.resolution ? (
                  <>
                    {clockBadge(item.resolution.state)} <span className="cell-sub">{formatHours(item.resolution.remainingMs)}</span>
                  </>
                ) : (
                  "—"
                )}
              </td>
              <td className="cell-muted">{formatTime(item.jiraUpdated)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The case store (item 1: our own system of record) for the pilot pod:
 * sync progress, row counts, SLA parity against Jira, and the synced cases.
 * Jira stays authoritative; everything here is a copy kept in sync from it.
 */
export default async function CasesPage(): Promise<React.ReactElement> {
  const identity = await getCurrentIdentity();
  const configured = isDatabaseConfigured();
  const [status, cases] = identity && configured ? await Promise.all([getSyncStatus(), listCases()]) : [null, null];

  return (
    <>
      <Link className="back-link" href="/">
        <Icon name="chevron-left" size={14} />
        Back to dashboard
      </Link>

      <div className="page-header-row">
        <div className="page-title-group">
          <h1 className="page-title">Case store</h1>
          <p className="page-subtitle">
            Every {CASE_POD.name} Support Ticket, copied from Jira into our own database with its comments, history and links, plus our own
            SLA clocks computed beside Jira&apos;s. Jira stays the source of truth; the parity table shows where our clocks disagree.
          </p>
        </div>
      </div>

      {!identity ? (
        <IdentityRequired itemsLabel="case store status" />
      ) : !configured ? (
        <div className="empty-state">The case store database is not configured (DATABASE_URL is unset in this environment).</div>
      ) : (
        <>
          <CaseSyncButton />
          {status && !status.ok ? <div className="empty-state">The case store is unavailable right now: {status.error}</div> : null}
          {status?.ok ? (
            <>
              <SyncProgress status={status.value} />
              <div className="kpi-strip">
                <Kpi label="Cases" sub={`${status.value.counts.openCases} open`} value={status.value.counts.cases} />
                <Kpi label="Messages" value={status.value.counts.messages} />
                <Kpi label="Events" value={status.value.counts.events} />
                <Kpi label="Accounts" sub={`${status.value.counts.contacts} contacts`} value={status.value.counts.accounts} />
                <Kpi
                  label="SLA parity"
                  sub={`${status.value.parity.mismatched} mismatched`}
                  value={`${status.value.parity.matched}/${status.value.parity.compared}`}
                />
              </div>
              <div className="page-title-group">
                <h2 className="page-title" style={{ fontSize: "1.05rem" }}>
                  SLA parity mismatches
                </h2>
              </div>
              <ParityTable status={status.value} />
            </>
          ) : null}
          <div className="page-title-group">
            <h2 className="page-title" style={{ fontSize: "1.05rem" }}>
              Cases
            </h2>
          </div>
          {cases && !cases.ok ? <div className="empty-state">Cases could not be read: {cases.error}</div> : null}
          {cases?.ok ? <CaseTable cases={cases.value} /> : null}
        </>
      )}
    </>
  );
}
