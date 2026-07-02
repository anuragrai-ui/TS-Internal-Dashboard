import type { TicketEscalationAnalysis } from "@/lib/openrouterEscalation";
import type { FormattedIssue } from "@/lib/jiraClient";

interface TicketCardProps {
  analysis?: TicketEscalationAnalysis;
  issue: FormattedIssue;
}

function getRiskLabel(analysis?: TicketEscalationAnalysis): string {
  if (!analysis) {
    return "Not assessed";
  }

  if (analysis.risk_level === "immediate") {
    return "Immediate";
  }

  if (analysis.risk_level === "watch") {
    return "Watch";
  }

  if (analysis.risk_level === "normal") {
    return "Normal";
  }

  return "Unknown";
}

export function TicketCard({
  analysis,
  issue,
}: TicketCardProps): React.ReactElement {
  const riskLevel = analysis?.risk_level ?? "unknown";
  const riskLabel = getRiskLabel(analysis);
  const riskDescription = analysis
    ? `${riskLabel} risk, score ${analysis.risk_score}`
    : "Risk not assessed";

  return (
    <a
      aria-label={`${issue.key}: ${issue.summary}. ${riskDescription}`}
      className="ticket-card"
      href={issue.url}
      rel="noreferrer"
      target="_blank"
    >
      <div className="ticket-top-row">
        <div>
          <div className="ticket-key">{issue.key}</div>
          <div className="ticket-summary">{issue.summary}</div>
          <div className="ticket-badges">
            <span className={`badge project-badge project-${issue.project}`}>
              {issue.project}
            </span>
            {issue.issue_type ? (
              <span className="badge" style={{ background: "var(--info-soft)", color: "var(--info)" }}>
                {issue.issue_type}
              </span>
            ) : null}
            {issue.severity ? (
              <span className="badge" style={{ background: "var(--warning-soft)", color: "var(--warning)" }}>
                {issue.severity}
              </span>
            ) : null}
            <span className={`badge risk-${riskLevel}`}>
              {riskLabel}
              {analysis ? ` · ${analysis.risk_score}` : ""}
            </span>
          </div>
        </div>

        <div className="ticket-status">{issue.status}</div>
      </div>

      {issue.description ? (
        <p className="ticket-description">{issue.description}</p>
      ) : null}

      {analysis ? (
        <div className="ai-insight">
          <strong>{analysis.reason}</strong>
          <span>{analysis.next_action}</span>
        </div>
      ) : null}

      <div className="ticket-meta-row">
        <div className="ticket-meta-item">
          <span className="meta-label">Waiting Since</span>
          <span className="meta-value">{issue.action_date}</span>
        </div>
        <div className="ticket-meta-item">
          <span className="meta-label">Priority</span>
          <span className="meta-value">{issue.priority}</span>
        </div>
        <div className="ticket-meta-item">
          <span className="meta-label">Assignee</span>
          <span className="meta-value">{issue.assignee}</span>
        </div>
        <div className="ticket-meta-item">
          <span className="meta-label">Reporter</span>
          <span className="meta-value">{issue.reporter}</span>
        </div>
        <div className="ticket-meta-item">
          <span className="meta-label">Latest Comment</span>
          <span className="meta-value">{issue.latest_comment_created}</span>
        </div>
      </div>

      <div className="ticket-extra-badges">
        {issue.support_category ? (
          <span className="badge" style={{ background: "var(--accent-soft)", color: "var(--accent)" }}>
            {issue.support_category}
          </span>
        ) : null}
        {issue.client_support_task_type ? (
          <span className="badge" style={{ background: "var(--info-soft)", color: "var(--info)" }}>
            {issue.client_support_task_type}
          </span>
        ) : null}
        {issue.team ? (
          <span className="badge" style={{ background: "var(--surface-hover)", color: "var(--text-muted)" }}>
            {issue.team}
          </span>
        ) : null}
        {issue.urgency ? (
          <span className="badge" style={{ background: "var(--warning-soft)", color: "var(--warning)" }}>
            {issue.urgency}
          </span>
        ) : null}
        {issue.source ? (
          <span className="badge" style={{ background: "var(--success-soft)", color: "var(--success)" }}>
            Source: {issue.source}
          </span>
        ) : null}
        {issue.duedate ? (
          <span className="badge" style={{ background: "var(--danger-soft)", color: "var(--danger)" }}>
            Due: {issue.duedate}
          </span>
        ) : null}
        {issue.comment_count > 0 ? (
          <span className="badge" style={{ background: "var(--surface-hover)", color: "var(--text-muted)" }}>
            💬 {issue.comment_count}
          </span>
        ) : null}
        {issue.attachment_count > 0 ? (
          <span className="badge" style={{ background: "var(--surface-hover)", color: "var(--text-muted)" }}>
            📎 {issue.attachment_count}
          </span>
        ) : null}
        {issue.subtask_count > 0 ? (
          <span className="badge" style={{ background: "var(--surface-hover)", color: "var(--text-muted)" }}>
            📝 {issue.subtask_count}
          </span>
        ) : null}
        {issue.labels.slice(0, 3).map((label) => (
          <span
            className="badge"
            key={label}
            style={{ background: "var(--accent-soft)", color: "var(--accent)" }}
          >
            {label}
          </span>
        ))}
      </div>
    </a>
  );
}
