import Link from "next/link";
import { notFound } from "next/navigation";

import { Icon } from "@/components/Icon";
import { IssueWorkspace } from "@/components/IssueWorkspace";
import { KpiStrip } from "@/components/KpiStrip";
import {
  countTicketsNeedingFollowup,
  getSheetBacklog,
} from "@/lib/googleSheetBacklog";
import { toIssueRow } from "@/lib/issueRow";

import type { KpiItem } from "@/components/KpiStrip";
import type {
  SheetBacklogTicket,
  SheetFollowup,
} from "@/lib/googleSheetBacklog";
import type { TicketEscalationAnalysis } from "@/lib/openrouterEscalation";

export const dynamic = "force-dynamic";

interface CategoryPageProps {
  params: Promise<{
    categoryKey: string;
  }>;
}

interface SheetCategory {
  description: string;
  matches: (ticket: SheetBacklogTicket) => boolean;
  title: string;
}

const WAITING_STATUSES = new Set([
  "waiting for client",
  "waiting for operations",
  "waiting for product",
]);

const SHEET_CATEGORIES: Record<string, SheetCategory> = {
  actionable: {
    description:
      "Open TS tickets requiring team action, including To-do, In Progress, Reopened, and TS review work.",
    matches: (ticket) =>
      !ticket.resolved &&
      !WAITING_STATUSES.has(ticket.issue.status?.trim().toLowerCase() ?? ""),
    title: "Actionable Items",
  },
  "waiting-product": {
    description: "TS tickets currently waiting for Product.",
    matches: (ticket) =>
      !ticket.resolved &&
      ticket.issue.status?.trim().toLowerCase() === "waiting for product",
    title: "Waiting for Product",
  },
  "waiting-client": {
    description: "TS tickets currently waiting for Client.",
    matches: (ticket) =>
      !ticket.resolved &&
      ticket.issue.status?.trim().toLowerCase() === "waiting for client",
    title: "Waiting for Client",
  },
  "waiting-operations": {
    description: "TS tickets currently waiting for Operations.",
    matches: (ticket) =>
      !ticket.resolved &&
      ticket.issue.status?.trim().toLowerCase() === "waiting for operations",
    title: "Waiting for Operations",
  },
};

function followupAnalysis(
  followup: SheetFollowup | undefined,
): TicketEscalationAnalysis | undefined {
  if (!followup?.aiInsight && !followup?.recommendedAction) {
    return undefined;
  }

  const urgent = /urgent|immediate|overdue|ready/i.test(followup.followupState);

  return {
    key: followup.key,
    next_action: followup.recommendedAction || "Review the scheduled follow-up draft.",
    reason: followup.aiInsight || "A scheduled follow-up is ready for review.",
    risk_level: urgent ? "immediate" : "watch",
    risk_score: urgent ? 90 : 60,
  };
}

export default async function CategoryPage({
  params,
}: CategoryPageProps): Promise<React.ReactElement> {
  const { categoryKey } = await params;
  const category = SHEET_CATEGORIES[categoryKey];

  if (!category) {
    notFound();
  }

  const data = await getSheetBacklog();
  const tickets = data.tickets.filter(category.matches);
  const followupsByKey = new Map(
    data.followups.map((followup) => [followup.key, followup]),
  );
  const rows = tickets.map((ticket) => {
    const followup = followupsByKey.get(ticket.issue.key);

    return toIssueRow(ticket.issue, {
      analysis: followupAnalysis(followup),
      scheduledFollowup: followup
        ? {
            draft: followup.followupDraft,
            generatedAt: followup.generatedAt,
            state: followup.followupState,
          }
        : undefined,
    });
  });
  const linkedCpCount = new Set(
    tickets.flatMap((ticket) =>
      ticket.linkedIssues.filter((key) => key.startsWith("CP-")),
    ),
  ).size;
  const draftsReady = tickets.filter((ticket) =>
    Boolean(followupsByKey.get(ticket.issue.key)?.followupDraft),
  ).length;
  const kpis: KpiItem[] = [
    { label: "Total Tickets", value: tickets.length },
    {
      label: "3+ Days Without Activity",
      tone: "warning",
      value: countTicketsNeedingFollowup(tickets),
    },
    { label: "Linked CP Tickets", value: linkedCpCount },
    { label: "AI Drafts Ready", value: draftsReady },
  ];

  return (
    <>
      <Link className="back-link" href="/">
        <Icon name="chevron-left" size={14} />
        Back to dashboard
      </Link>

      <div className="page-header-row">
        <div className="page-title-group">
          <h1 className="page-title">{category.title}</h1>
          <p className="page-subtitle">{category.description}</p>
          <div className="sync-meta">
            <span>Source: TS Backlog</span>
            <span aria-hidden="true">•</span>
            <span>Refresh cadence: every 4 hours</span>
          </div>
        </div>
        <div className="page-actions">
          <Link className="btn" href="/sheet-followups">
            <Icon name="bot" size={14} />
            AI drafts
          </Link>
          <a className="btn" href={data.sourceUrl} rel="noreferrer" target="_blank">
            <Icon name="external-link" size={14} />
            Open sheet
          </a>
        </div>
      </div>

      <KpiStrip items={kpis} />

      <IssueWorkspace rows={rows} showAssigneeTabs />
    </>
  );
}
