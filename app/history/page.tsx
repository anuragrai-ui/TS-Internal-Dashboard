import Link from "next/link";

import { ThemeToggle } from "@/components/ThemeToggle";
import { getJiraSnapshotRows, getJiraSnapshotSummary } from "@/lib/jiraSnapshotStore";

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
  const [rows, summary] = await Promise.all([
    getJiraSnapshotRows(),
    getJiraSnapshotSummary(),
  ]);
  const sortedRows = [...rows].sort((a, b) => b.fetched_at.localeCompare(a.fetched_at));

  return (
    <>
      <a className="skip-link" href="#main-content">
        Skip to history content
      </a>

      <nav className="app-navbar" aria-label="Main navigation">
        <Link className="app-brand" href="/">
          <span className="app-brand-mark" aria-hidden="true">TS</span>
          <span>Dashboard</span>
        </Link>
        <div className="app-navbar-actions">
          <ThemeToggle />
        </div>
      </nav>

      <main id="main-content">
        <header className="hero-gradient">
          <h1>Previous Refresh Data</h1>
          <p className="subtitle">
            Snapshot rows retained from the last {summary.retention_hours} hours.
          </p>
          <div className="refresh-info">
            <span>Latest saved refresh: {formatDate(summary.latest_fetched_at)}</span>
            <span aria-hidden="true">•</span>
            <span>Last clear: {formatDate(summary.last_cleared_at)}</span>
          </div>
        </header>

        <nav aria-label="Dashboard views" className="view-tabs">
          <Link className="view-tab" href="/">
            Current refresh
          </Link>
          <Link aria-current="page" className="view-tab active" href="/history">
            Previous refresh data
            <span>{summary.row_count}</span>
          </Link>
        </nav>

        <section aria-label="Snapshot statistics" className="history-grid">
          <div className="history-stat">
            <span className="meta-label">Rows</span>
            <strong>{summary.row_count}</strong>
          </div>
          <div className="history-stat">
            <span className="meta-label">Categories</span>
            <strong>{summary.categories.length}</strong>
          </div>
          <div className="history-stat">
            <span className="meta-label">Retention</span>
            <strong>{summary.retention_hours}h</strong>
          </div>
        </section>

        <section aria-label="Snapshot rows" className="history-table-wrap">
          {sortedRows.length === 0 ? (
            <div className="empty-state">No previous refresh rows saved yet.</div>
          ) : (
            <table className="history-table">
              <caption className="visually-hidden">
                Previous refresh snapshot rows
              </caption>
              <thead>
                <tr>
                  <th scope="col">Fetched</th>
                  <th scope="col">Category</th>
                  <th scope="col">Ticket</th>
                  <th scope="col">Summary</th>
                  <th scope="col">Status</th>
                  <th scope="col">Priority</th>
                  <th scope="col">Reporter</th>
                </tr>
              </thead>
              <tbody>
                {sortedRows.map((row, index) => (
                  <tr key={`${row.fetched_at}-${row.category_key}-${row.key}-${index}`}>
                    <td>{formatDate(row.fetched_at)}</td>
                    <td>{row.category_title}</td>
                    <td>
                      <a href={row.url} rel="noreferrer" target="_blank">
                        {row.key}
                      </a>
                    </td>
                    <td>{row.summary}</td>
                    <td>{row.status}</td>
                    <td>{row.priority}</td>
                    <td>{row.reporter}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </main>
    </>
  );
}
