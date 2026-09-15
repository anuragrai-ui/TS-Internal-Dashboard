"use client";

import { Fragment, useEffect } from "react";

import { FollowUpAction } from "@/components/FollowUpAction";
import { Icon } from "@/components/Icon";
import { PriorityIndicator } from "@/components/PriorityIndicator";
import { RiskBadge } from "@/components/RiskBadge";
import { StatusBadge } from "@/components/StatusBadge";
import { formatRelativeTime, formatShortDate } from "@/lib/issueRow";

import type { IssueRow } from "@/lib/issueRow";

interface IssueDrawerProps {
  onClose: () => void;
  row: IssueRow | null;
}

interface FieldRow {
  label: string;
  value: React.ReactNode;
}

export function IssueDrawer({ onClose, row }: IssueDrawerProps): React.ReactElement | null {
  useEffect(() => {
    if (!row) {
      return undefined;
    }

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [row, onClose]);

  if (!row) {
    return null;
  }

  const { issue } = row;
  const jiraBaseUrl = issue.url.replace(`/browse/${issue.key}`, "");

  const fields: FieldRow[] = [
    { label: "Priority", value: <PriorityIndicator priority={issue.priority} /> },
    { label: "Assignee", value: issue.assignee || "Unassigned" },
    {
      label: "Reporter",
      value: `${issue.reporter || "—"} (${issue.reporter_is_external ? "External" : "Internal"})`,
    },
    { label: "Project", value: issue.project ?? "—" },
    { label: "POD / Team", value: issue.pod ?? issue.team ?? "—" },
    { label: "Category", value: issue.support_category ?? "—" },
    { label: "Task Type", value: issue.client_support_task_type },
    { label: "Severity", value: issue.severity },
    { label: "Urgency", value: issue.urgency },
    { label: "Source", value: issue.source },
    { label: "Created", value: formatShortDate(issue.created) },
    { label: "Last Comment", value: formatRelativeTime(issue.latest_comment_created || issue.updated) },
    { label: "Due Date", value: issue.duedate },
    {
      label: "Linked Issue",
      value: issue.linked_cp_issue ? (
        <a href={`${jiraBaseUrl}/browse/${issue.linked_cp_issue.key}`} rel="noreferrer" target="_blank">
          {issue.linked_cp_issue.key} · {issue.linked_cp_issue.status}
        </a>
      ) : undefined,
    },
    { label: "Pending Reason", value: issue.pending_reason },
    { label: "Major Incident", value: issue.major_incident },
    { label: "Affected Services", value: issue.affected_services },
    { label: "Components", value: issue.components.length > 0 ? issue.components.join(", ") : undefined },
    { label: "Labels", value: issue.labels.length > 0 ? issue.labels.join(", ") : undefined },
  ].filter((field) => field.value !== undefined && field.value !== "" && field.value !== "—");

  return (
    <>
      <div aria-hidden="true" className="drawer-overlay" onClick={onClose} />
      <div aria-modal="true" className="drawer-panel" role="dialog">
        <div className="drawer-header">
          <div className="drawer-header-titles">
            <a className="drawer-key-link" href={issue.url} rel="noreferrer" target="_blank">
              {issue.key}
              <Icon name="external-link" size={12} />
            </a>
            <span className="drawer-summary">{issue.summary}</span>
          </div>
          <button aria-label="Close details" className="drawer-close-btn" onClick={onClose} type="button">
            <Icon name="close" />
          </button>
        </div>

        <div className="drawer-body">
          <div className="drawer-quickbar">
            <StatusBadge status={issue.status} />
            <RiskBadge analysis={row.analysis} />
            {issue.comment_count > 0 ? <span className="badge cell-muted">💬 {issue.comment_count}</span> : null}
            {issue.attachment_count > 0 ? (
              <span className="badge cell-muted">📎 {issue.attachment_count}</span>
            ) : null}
            {issue.subtask_count > 0 ? <span className="badge cell-muted">📝 {issue.subtask_count}</span> : null}
            {row.slackMention ? (
              <a
                className="badge cell-muted"
                href={`https://slack.com/app_redirect?channel=${row.slackMention.channel_id}&message_ts=${row.slackMention.message_ts}`}
                rel="noreferrer"
                target="_blank"
              >
                💬 Mentioned in Slack
              </a>
            ) : null}
          </div>

          {issue.description ? (
            <div>
              <div className="drawer-section-title">Description</div>
              <p style={{ color: "var(--text-muted)", fontSize: "var(--text-sm)", lineHeight: 1.6, margin: 0 }}>
                {issue.description}
              </p>
            </div>
          ) : null}

          <div>
            <div className="drawer-section-title">Overview</div>
            <div className="field-grid">
              {fields.map((field) => (
                <Fragment key={field.label}>
                  <span className="field-label">{field.label}</span>
                  <span className="field-value">{field.value}</span>
                </Fragment>
              ))}
            </div>
          </div>

          {row.analysis ? (
            <div>
              <div className="drawer-section-title">AI Insight</div>
              <div className="ai-insight">
                <strong>{row.analysis.reason}</strong>
                <span>{row.analysis.next_action}</span>
              </div>
            </div>
          ) : null}
        </div>

        <div className="drawer-footer">
          {row.scheduledFollowup?.draft ? (
            <div className="scheduled-followup">
              <div className="scheduled-followup-heading">
                <div>
                  <div className="drawer-section-title">Scheduled AI Draft</div>
                  <span className="cell-sub">
                    {row.scheduledFollowup.state || "Ready"}
                    {row.scheduledFollowup.generatedAt
                      ? ` · ${formatRelativeTime(row.scheduledFollowup.generatedAt)}`
                      : ""}
                  </span>
                </div>
                <span className="status-badge tone-accent">GPT-5.5</span>
              </div>
              <textarea
                aria-label={`Scheduled follow-up draft for ${issue.key}`}
                className="scheduled-followup-draft"
                readOnly
                rows={8}
                value={row.scheduledFollowup.draft}
              />
            </div>
          ) : null}
          <div className="drawer-section-title">Manual Follow-Up</div>
          <FollowUpAction initialCooldownActive={row.cooldownActive} issue={issue} />
        </div>
      </div>
    </>
  );
}
