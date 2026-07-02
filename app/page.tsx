import Link from "next/link";

import { RefreshCountdown } from "@/components/RefreshCountdown";
import {
  getCategoryCacheMeta,
  getCurrentUser,
  getDashboardTiles,
} from "@/lib/jiraClient";

export const dynamic = "force-dynamic";

export default async function DashboardPage(): Promise<React.ReactElement> {
  const tiles = await getDashboardTiles();
  const meta = getCategoryCacheMeta("actionable");
  const user = await getCurrentUser();

  return (
    <main>
      <header className="page-header">
        <div>
          <h1>TS Dashboard</h1>

          <p className="subtitle">
            Tickets assigned to{" "}
            <span className="user-name">{user.display_name}</span>
          </p>

          <div className="refresh-info">
            Last Jira sync: {meta.last_sync} • Refresh in{" "}
            <RefreshCountdown nextSyncIso={meta.next_sync_iso} />
          </div>
        </div>
      </header>

      <section className="tiles">
        {tiles.map((tile) => (
          <Link className="tile" href={`/category/${tile.key}`} key={tile.key}>
            <div className="tile-count">{tile.count}</div>
            <div className="tile-title">{tile.title}</div>
            <div className="tile-description">{tile.description}</div>
            <div className="tile-badge">{tile.count} tickets</div>
          </Link>
        ))}
      </section>
    </main>
  );
}
