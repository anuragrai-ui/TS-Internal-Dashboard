import Link from "next/link";

import { BreakdownBars } from "@/components/BreakdownBars";
import { Icon } from "@/components/Icon";
import { KpiStrip } from "@/components/KpiStrip";
import { RefreshCountdown } from "@/components/RefreshCountdown";
import {
  countTicketsNeedingFollowup,
  getSheetBacklog,
} from "@/lib/googleSheetBacklog";
import { getCategoryCacheMeta, getDashboardTiles } from "@/lib/jiraClient";
import { getJiraSnapshotSummary } from "@/lib/jiraSnapshotStore";

import type { IconName } from "@/components/Icon";
import type { KpiItem } from "@/components/KpiStrip";

export const dynamic = "force-dynamic";

interface OverviewRow {
  count: number;
  description: string;
  href: string;
  icon: IconName;
  key: string;
  title: string;
}

const categoryIcons: Record<string, IconName> = {
  actionable: "layers",
  "waiting-client": "clock",
  "waiting-operations": "gear",
  "waiting-product": "wrench",
};

function statusIcon(status: string): IconName {
  const normalized = status.toLowerCase();
  if (normalized.includes("client")) return "clock";
  if (normalized.includes("product")) return "wrench";
  if (normalized.includes("operations")) return "gear";
  if (normalized.includes("progress")) return "refresh";
  return "layers";
}

export default async function DashboardPage(): Promise<React.ReactElement> {
  let source: "Google Sheet" | "Jira" = "Google Sheet";
  let sourceUrl = "";
  let overviewRows: OverviewRow[] = [];
  let kpis: KpiItem[] = [];
  let assigneeBreakdown: Array<{ count: number; label: string }> = [];
  let syncDetail: React.ReactNode = "Refreshes every 4 hours";

  try {
    const sheet = await getSheetBacklog();
    const needsFollowup = countTicketsNeedingFollowup(sheet.tickets);

    sourceUrl = sheet.sourceUrl;
    kpis = [
      { label: "Unique TS Tickets", value: sheet.tickets.length },
      { label: "Linked CP Tickets", value: sheet.linkedCpCount },
      {
        label: "3+ Days Without Activity",
        tone: needsFollowup > 0 ? "warning" : undefined,
        value: needsFollowup,
      },
      { label: "Team Members", value: sheet.assignees.length },
      { label: "AI Drafts Ready", value: sheet.followups.length },
    ];
    overviewRows = sheet.statusCounts.map(({ count, status }) => ({
      count,
      description: `Tickets currently marked ${status} in TS Backlog.`,
      href: `/backlog?status=${encodeURIComponent(status)}`,
      icon: statusIcon(status),
      key: status,
      title: status,
    }));
    assigneeBreakdown = sheet.assignees.map(({ count, name }) => ({
      count,
      label: name,
    }));
  } catch (error) {
    console.error("Google Sheet backlog unavailable; using the existing Jira overview.", error);
    source = "Jira";

    const [tiles, meta, snapshot] = await Promise.all([
      getDashboardTiles(),
      getCategoryCacheMeta("actionable"),
      getJiraSnapshotSummary(),
    ]);
    const totalTickets = tiles.reduce((sum, tile) => sum + tile.count, 0);
    const actionableCount =
      tiles.find((tile) => tile.key === "actionable")?.count ?? 0;

    kpis = [
      { label: "Total Tickets", value: totalTickets },
      { label: "Actionable", value: actionableCount },
      { label: "Waiting on Others", value: totalTickets - actionableCount },
      {
        label: "Snapshot Rows",
        sub: `${snapshot.retention_hours}h retention`,
        value: snapshot.row_count,
      },
    ];
    overviewRows = tiles.map((tile) => ({
      ...tile,
      href: `/category/${tile.key}`,
      icon: categoryIcons[tile.key] ?? "layers",
    }));
    syncDetail = (
      <>
        Last Jira sync: {meta.last_sync} · Refresh in{" "}
        <RefreshCountdown nextSyncIso={meta.next_sync_iso} />
      </>
    );
  }

  return (
    <>
      <div className="page-header-row">
        <div className="page-title-group">
          <h1 className="page-title">Issue Analytics</h1>
          <p className="page-subtitle">
            Monitor TS and linked CP tickets across the support team, with scheduled AI follow-ups.
          </p>
          <div className="sync-meta">
            <span>Source: {source}</span>
            <span aria-hidden="true">•</span>
            <span>{syncDetail}</span>
          </div>
        </div>
        <div className="page-actions">
          {source === "Google Sheet" ? (
            <>
              <Link className="btn" href="/backlog">
                <Icon name="layers" size={14} />
                Team backlog
              </Link>
              <a className="btn" href={sourceUrl} rel="noreferrer" target="_blank">
                <Icon name="external-link" size={14} />
                Open sheet
              </a>
            </>
          ) : (
            <>
              <Link className="btn" href="/history">
                <Icon name="history" size={14} />
                History
              </Link>
              <Link className="btn" href="/refresh">
                <Icon name="refresh" size={14} />
                Refresh
              </Link>
            </>
          )}
        </div>
      </div>

      <KpiStrip items={kpis} />

      <div className="analytics-row">
        <BreakdownBars
          entries={overviewRows.map((row) => ({ count: row.count, label: row.title }))}
          title={source === "Google Sheet" ? "Tickets by Status" : "Tickets by Category"}
        />
        {assigneeBreakdown.length > 0 ? (
          <BreakdownBars entries={assigneeBreakdown} title="Tickets by Assignee" />
        ) : null}
      </div>

      <div className="category-list">
        {overviewRows.map((row) => (
          <Link className="category-row" href={row.href} key={row.key}>
            <span className="category-row-icon" aria-hidden="true">
              <Icon name={row.icon} size={18} />
            </span>
            <span className="category-row-body">
              <span className="category-row-title">{row.title}</span>
              <span className="category-row-desc">{row.description}</span>
            </span>
            <span className="category-row-count">{row.count}</span>
            <Icon name="chevron-right" size={16} />
          </Link>
        ))}
      </div>
    </>
  );
}
