import Link from "next/link";

import { Icon } from "@/components/Icon";
import { IssueWorkspace } from "@/components/IssueWorkspace";
import { KpiStrip } from "@/components/KpiStrip";
import {
  countTicketsNeedingFollowup,
  getSheetBacklog,
} from "@/lib/googleSheetBacklog";
import { toIssueRow } from "@/lib/issueRow";

import type { KpiItem } from "@/components/KpiStrip";
import type { SheetFollowup } from "@/lib/googleSheetBacklog";
import type { TicketEscalationAnalysis } from "@/lib/openrouterEscalation";

export const dynamic = "force-dynamic";

interface BacklogPageProps {
  searchParams: Promise<{
    status?: string | string[];
  }>;
}

function followupAnalysis(
  followup: SheetFollowup | undefined,
): TicketEscalationAnalysis | undefined {
  if (!followup?.aiInsight) {
    return undefined;
  }

  const state = followup.followupState.toLowerCase();
  const priority = followup.priority.toLowerCase();
  const riskLevel = /urgent|immediate|overdue|ready/.test(state)
    ? "immediate"
    : /watch|waiting|pending/.test(state) || /critical|high/.test(priority)
      ? "watch"
      : "normal";

  return {
    key: followup.key,
    next_action: followup.recommendedAction || "Review the scheduled follow-up draft.",
    reason: followup.aiInsight,
    risk_level: riskLevel,
    risk_score: riskLevel === "immediate" ? 90 : riskLevel === "watch" ? 65 : 35,
  };
}

export default async function BacklogPage({
  searchParams,
}: BacklogPageProps): Promise<React.ReactElement> {
  const { status } = await searchParams;
  const initialStatus = Array.isArray(status) ? status[0] : status;
  const data = await getSheetBacklog();
  const followupsByKey = new Map(
    data.followups.map((followup) => [followup.key, followup]),
  );
  const rows = data.tickets.map((ticket) => {
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
  const kpis: KpiItem[] = [
    { label: "Unique TS Tickets", value: data.tickets.length },
    { label: "Team Members", value: data.assignees.length },
    { label: "Linked CP Tickets", value: data.linkedCpCount },
    {
      label: "3+ Days Without Activity",
      tone: "warning",
      value: countTicketsNeedingFollowup(data.tickets),
    },
    { label: "AI Drafts Ready", value: data.followups.length },
  ];

  return (
    <>
      <div className="page-header-row">
        <div className="page-title-group">
          <h1 className="page-title">Team Sheet Backlog</h1>
          <p className="page-subtitle">
            Live, deduplicated TS backlog with linked CP tickets and individual assignee views.
          </p>
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

      <IssueWorkspace
        initialStatus={initialStatus}
        rows={rows}
        showAssigneeTabs
      />
    </>
  );
}
