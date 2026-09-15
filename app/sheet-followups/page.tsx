import Link from "next/link";

import { Icon } from "@/components/Icon";
import { IssueWorkspace } from "@/components/IssueWorkspace";
import { KpiStrip } from "@/components/KpiStrip";
import { getSheetBacklog } from "@/lib/googleSheetBacklog";
import { toIssueRow } from "@/lib/issueRow";

import type { KpiItem } from "@/components/KpiStrip";
import type { SheetFollowup } from "@/lib/googleSheetBacklog";
import type { FormattedIssue } from "@/lib/jiraClient";
import type { TicketEscalationAnalysis } from "@/lib/openrouterEscalation";

export const dynamic = "force-dynamic";

function asIssue(followup: SheetFollowup): FormattedIssue {
  const project = followup.ticketType.toUpperCase().startsWith("CP") ? "CP" : "TS";
  const priority = followup.priority || "Unknown";
  const priorityRanks: Record<string, number> = {
    critical: 1,
    high: 2,
    medium: 3,
    low: 4,
  };

  return {
    assignee: followup.assignee || "Unassigned",
    attachment_count: 0,
    attachments: [],
    comment_count: 0,
    components: [],
    created: followup.lastActivity || followup.generatedAt,
    description: followup.aiInsight,
    issue_type: `${project} follow-up`,
    key: followup.key,
    labels: ["scheduled-followup"],
    latest_comment_created: followup.lastActivity,
    linked_cp_issue: followup.linkedTicket
      ? { isDone: false, key: followup.linkedTicket, status: "Linked" }
      : undefined,
    priority,
    priority_sort: priorityRanks[priority.toLowerCase()] ?? 99,
    project,
    reporter: "Scheduled analysis",
    reporter_is_external: false,
    source: "AI Follow-ups sheet",
    status: followup.status || followup.followupState || "Ready",
    status_category: "In Progress",
    subtask_count: 0,
    summary: followup.summary || "Scheduled follow-up",
    support_category: followup.ticketType || project,
    updated: followup.generatedAt || followup.lastActivity,
    url:
      followup.sourceLink ||
      `https://certifyos.atlassian.net/browse/${followup.key}`,
  };
}

function asAnalysis(followup: SheetFollowup): TicketEscalationAnalysis | undefined {
  if (!followup.aiInsight && !followup.recommendedAction) {
    return undefined;
  }

  const urgent = /urgent|immediate|overdue|ready/i.test(followup.followupState);
  return {
    key: followup.key,
    next_action: followup.recommendedAction || "Review the generated draft.",
    reason: followup.aiInsight || "A scheduled follow-up draft is ready for review.",
    risk_level: urgent ? "immediate" : "watch",
    risk_score: urgent ? 90 : 60,
  };
}

export default async function SheetFollowupsPage(): Promise<React.ReactElement> {
  const data = await getSheetBacklog();
  const rows = data.followups.map((followup) =>
    toIssueRow(asIssue(followup), {
      analysis: asAnalysis(followup),
      scheduledFollowup: {
        draft: followup.followupDraft,
        generatedAt: followup.generatedAt,
        state: followup.followupState,
      },
    }),
  );
  const tsCount = data.followups.filter((item) =>
    item.ticketType.toUpperCase().startsWith("TS"),
  ).length;
  const cpCount = data.followups.filter((item) =>
    item.ticketType.toUpperCase().startsWith("CP"),
  ).length;
  const readyCount = data.followups.filter((item) => item.followupDraft).length;
  const kpis: KpiItem[] = [
    { label: "Total Insights", value: data.followups.length },
    { label: "TS Tickets", value: tsCount },
    { label: "CP Tickets", value: cpCount },
    { label: "Drafts Ready", value: readyCount },
  ];

  return (
    <>
      <Link className="back-link" href="/backlog">
        <Icon name="chevron-left" size={14} />
        Back to sheet backlog
      </Link>

      <div className="page-header-row">
        <div className="page-title-group">
          <h1 className="page-title">Scheduled AI Follow-Ups</h1>
          <p className="page-subtitle">
            GPT-5.5 insights and three-day follow-up drafts for TS and linked CP tickets.
          </p>
          <div className="sync-meta">
            <span>Source: AI Follow-ups</span>
            <span aria-hidden="true">•</span>
            <span>Generated every 4 hours</span>
          </div>
        </div>
        <div className="page-actions">
          <a className="btn" href={`${data.sourceUrl}#gid=957104001`} rel="noreferrer" target="_blank">
            <Icon name="external-link" size={14} />
            Open AI sheet
          </a>
        </div>
      </div>

      <KpiStrip items={kpis} />

      {rows.length > 0 ? (
        <IssueWorkspace rows={rows} showAssigneeTabs />
      ) : (
        <div className="empty-state">
          The AI Follow-ups sheet is ready. Insights and drafts will appear after the next
          scheduled four-hour analysis run.
        </div>
      )}
    </>
  );
}
