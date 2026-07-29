import Link from "next/link";

import { RefreshCountdown } from "@/components/RefreshCountdown";
import { ThemeToggle } from "@/components/ThemeToggle";
import {
  getCategoryCacheMeta,
  getCurrentUser,
  getDashboardTiles,
} from "@/lib/jiraClient";
import { getJiraSnapshotSummary } from "@/lib/jiraSnapshotStore";

export const dynamic = "force-dynamic";

const categoryIcons: Record<string, string> = {
  actionable: "⚡",
  "waiting-product": "🛠",
  "waiting-client": "⏳",
  "waiting-operations": "🔧",
};

export default async function DashboardPage(): Promise<React.ReactElement> {
  const tiles = await getDashboardTiles();
  const meta = getCategoryCacheMeta("actionable");
  const user = await getCurrentUser();
  const snapshot = await getJiraSnapshotSummary();
  const totalTickets = tiles.reduce((sum, tile) => sum + tile.count, 0);
  const actionableCount = tiles.find((tile) => tile.key === "actionable")?.count ?? 0;
  const waitingCount = totalTickets - actionableCount;

  return (
    <>
      <a className="skip-link" href="#main-content">
        Skip to dashboard
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
          <h1>Welcome back, {user.display_name}</h1>
          <p className="subtitle">
            Here is what is happening with your tickets today.
          </p>
          <div className="refresh-info">
            <span>Last Jira sync: {meta.last_sync}</span>
            <span aria-hidden="true">•</span>
            <span>
              Refresh in <RefreshCountdown nextSyncIso={meta.next_sync_iso} />
            </span>
          </div>
        </header>

        <section aria-label="Ticket statistics" className="stats-grid">
          <div className="stat-card">
            <div className="stat-icon accent" aria-hidden="true">📋</div>
            <div className="stat-content">
              <div className="stat-value">{totalTickets}</div>
              <div className="stat-label">Total active tickets</div>
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-icon success" aria-hidden="true">⚡</div>
            <div className="stat-content">
              <div className="stat-value">{actionableCount}</div>
              <div className="stat-label">Actionable items</div>
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-icon warning" aria-hidden="true">⏳</div>
            <div className="stat-content">
              <div className="stat-value">{waitingCount}</div>
              <div className="stat-label">Waiting on others</div>
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-icon danger" aria-hidden="true">🗂</div>
            <div className="stat-content">
              <div className="stat-value">{snapshot.row_count}</div>
              <div className="stat-label">Snapshot rows</div>
            </div>
          </div>
        </section>

        <nav aria-label="Dashboard views" className="view-tabs">
          <Link aria-current="page" className="view-tab active" href="/">
            Current refresh
          </Link>
          <Link className="view-tab" href="/history">
            Previous refresh data
            <span>{snapshot.row_count}</span>
          </Link>
        </nav>

        <section aria-label="Ticket categories" className="tiles">
          {tiles.map((tile) => (
            <Link className="tile" href={`/category/${tile.key}`} key={tile.key}>
              <div className="tile-header">
                <div className="tile-icon" aria-hidden="true">
                  {categoryIcons[tile.key] ?? "🎫"}
                </div>
                <div className="tile-count">{tile.count}</div>
              </div>
              <div className="tile-title">{tile.title}</div>
              <div className="tile-description">{tile.description}</div>
              <div className="tile-badge">{tile.count} tickets</div>
            </Link>
          ))}
        </section>
      </main>
    </>
  );
}
