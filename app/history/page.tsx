import Link from "next/link";

import { assigneeMatchesIdentity, getCurrentIdentity } from "@/lib/currentIdentity";
import { Icon } from "@/components/Icon";
import { IdentityRequired } from "@/components/IdentityRequired";
import { KpiStrip } from "@/components/KpiStrip";
import { getSheetBacklog } from "@/lib/googleSheetBacklog";

import type { KpiItem } from "@/components/KpiStrip";

export const dynamic = "force-dynamic";

function formatDate(value: string): string {
  if (!value) {
    return "Not available";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString("en-US", {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export default async function HistoryPage(): Promise<React.ReactElement> {
  const identity = await getCurrentIdentity();
  const data = identity ? await getSheetBacklog() : null;
  const rows = data && identity
    ? [...data.followups]
        .filter((followup) => assigneeMatchesIdentity(followup.assignee, identity))
        .sort((a, b) => b.generatedAt.localeCompare(a.generatedAt))
    : [];
  const tsCount = rows.filter((row) =>
    row.ticketType.toUpperCase().startsWith("TS"),
  ).length;
  const cpCount = rows.filter((row) =>
    row.ticketType.toUpperCase().startsWith("CP"),
  ).length;
  const latestGeneratedAt = rows.find((row) => row.generatedAt)?.generatedAt ?? "";
  const kpis: KpiItem[] = [
    { label: "Source Tickets", value: data?.tickets.length ?? 0 },
    { label: "History Entries", value: rows.length },
    { label: "TS Analyses", value: tsCount },
    { label: "CP Analyses", value: cpCount },
  ];

  return (
    <>
      <Link className="back-link" href="/">
        <Icon name="chevron-left" size={14} />
        Back to dashboard
      </Link>

      <div className="page-header-row">
        <div className="page-title-group">
          <h1 className="page-title">History</h1>
          <p className="page-subtitle">
            Generated TS and CP analysis records from the AI Follow-ups sheet.
          </p>
          {data ? (
            <div className="sync-meta">
              <span>Latest generated: {formatDate(latestGeneratedAt)}</span>
              <span aria-hidden="true">•</span>
              <span>Source loaded: {formatDate(data.fetchedAt)}</span>
            </div>
          ) : null}
        </div>
        <div className="page-actions">
          <Link className="btn" href="/sheet-followups">
            <Icon name="bot" size={14} />
            AI follow-ups
          </Link>
          {data ? (
            <a
              className="btn"
              href={`${data.sourceUrl}#gid=957104001`}
              rel="noreferrer"
              target="_blank"
            >
              <Icon name="external-link" size={14} />
              Open history sheet
            </a>
          ) : null}
        </div>
      </div>

      <KpiStrip items={kpis} />

      {!identity ? (
        <IdentityRequired itemsLabel="history" />
      ) : rows.length === 0 ? (
        <div className="empty-state">
          The source backlog loaded successfully with {data?.tickets.length ?? 0} tickets. No generated
          history is assigned to you yet - it will appear here after the next scheduled GPT-5.5 analysis
          run.
        </div>
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <caption className="visually-hidden">Scheduled AI analysis history</caption>
            <thead>
              <tr>
                <th scope="col">Generated</th>
                <th scope="col">Type</th>
                <th scope="col">Ticket</th>
                <th scope="col">Summary</th>
                <th scope="col">Assignee</th>
                <th scope="col">Status</th>
                <th scope="col">Follow-up State</th>
                <th scope="col">Recommended Action</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={`${row.key}-${row.generatedAt}-${index}`}>
                  <td className="cell-muted">{formatDate(row.generatedAt)}</td>
                  <td className="cell-muted">{row.ticketType || "—"}</td>
                  <td>
                    <a
                      className="ticket-key-link"
                      href={
                        row.sourceLink ||
                        `https://certifyos.atlassian.net/browse/${row.key}`
                      }
                      rel="noreferrer"
                      target="_blank"
                    >
                      {row.key}
                    </a>
                  </td>
                  <td className="cell-summary wrap-cell" title={row.summary}>
                    {row.summary || "—"}
                  </td>
                  <td className="cell-muted">{row.assignee || "Unassigned"}</td>
                  <td className="cell-muted">{row.status || "—"}</td>
                  <td className="cell-muted">{row.followupState || "—"}</td>
                  <td className="wrap-cell">{row.recommendedAction || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
