import Link from "next/link";

import { getCurrentIdentity } from "@/lib/currentIdentity";
import { Icon } from "@/components/Icon";
import { IdentityRequired } from "@/components/IdentityRequired";
import { isEligibleForSlaBreachAlert } from "@/lib/slaBreachAlert";
import { KpiStrip } from "@/components/KpiStrip";
import { SlaBreachAlertAction } from "@/components/SlaBreachAlertAction";
import { SlaFollowUpAction } from "@/components/SlaFollowUpAction";
import { getSlaFollowUpCandidates } from "@/lib/slaFollowup";

import type { KpiItem } from "@/components/KpiStrip";

export const dynamic = "force-dynamic";

function reasonLabel(reason: "cp_not_worked" | "no_reporter_response"): string {
  return reason === "cp_not_worked" ? "Linked CP not worked" : "No reporter response";
}

export default async function SlaFollowUpsPage(): Promise<React.ReactElement> {
  const identity = await getCurrentIdentity();
  const allCandidates = identity ? await getSlaFollowUpCandidates() : [];
  const candidates = identity
    ? allCandidates.filter((candidate) => candidate.issue.assignee_account_id === identity.accountId)
    : [];
  const stage1Count = candidates.filter((candidate) => candidate.stage === 1).length;
  const stage2Count = candidates.filter((candidate) => candidate.stage === 2).length;
  const stage3Count = candidates.filter((candidate) => candidate.stage === 3).length;
  const missedSlaCount = candidates.filter((candidate) => candidate.missedSla).length;

  const kpis: KpiItem[] = [
    { label: "Total Due", value: candidates.length },
    { label: "First Follow-Up", value: stage1Count },
    { label: "Closure / Final Notice", tone: stage2Count > 0 ? "danger" : undefined, value: stage2Count },
    { label: "Ready to Close", tone: stage3Count > 0 ? "danger" : undefined, value: stage3Count },
    { label: "Missed Our SLA", tone: missedSlaCount > 0 ? "warning" : undefined, value: missedSlaCount },
  ];

  return (
    <>
      <Link className="back-link" href="/">
        <Icon name="chevron-left" size={14} />
        Back to dashboard
      </Link>

      <div className="page-header-row">
        <div className="page-title-group">
          <h1 className="page-title">SLA Follow-Ups</h1>
          <p className="page-subtitle">
            TS tickets waiting on the reporter, or blocked on a linked CP ticket, for 3+ days. Every
            follow-up is drafted for review — nothing sends automatically.
          </p>
        </div>
      </div>

      <KpiStrip items={kpis} />

      {!identity ? (
        <IdentityRequired itemsLabel="SLA follow-ups" />
      ) : candidates.length === 0 ? (
        <div className="empty-state">No tickets assigned to you currently need an SLA follow-up.</div>
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <caption className="visually-hidden">SLA follow-up candidates</caption>
            <thead>
              <tr>
                <th scope="col">Ticket</th>
                <th scope="col">Summary</th>
                <th scope="col">Stage</th>
                <th scope="col">Reason</th>
                <th scope="col">Reporter</th>
                <th scope="col">Status</th>
                <th scope="col">Linked CP</th>
                <th scope="col">Idle</th>
                <th scope="col">Action</th>
              </tr>
            </thead>
            <tbody>
              {candidates.map((candidate) => (
                <tr key={candidate.issue.key}>
                  <td>
                    <a
                      className="ticket-key-link"
                      href={candidate.issue.url}
                      rel="noreferrer"
                      target="_blank"
                    >
                      {candidate.issue.key}
                    </a>
                  </td>
                  <td className="cell-summary wrap-cell" title={candidate.issue.summary}>
                    {candidate.issue.summary}
                  </td>
                  <td>
                    <div className="cell-with-sub">
                      <span className={candidate.stage !== 1 ? "status-badge tone-danger" : "status-badge tone-warning"}>
                        {candidate.stage === 3 ? "Ready to close" : `Stage ${candidate.stage}`}
                      </span>
                      {candidate.missedSla ? (
                        <span className="cell-sub" style={{ color: "var(--warning)", fontWeight: 600 }}>
                          Missed our SLA
                        </span>
                      ) : null}
                    </div>
                  </td>
                  <td className="cell-muted">{reasonLabel(candidate.reason)}</td>
                  <td>
                    <span
                      className={candidate.issue.reporter_is_external ? "reporter-tag external" : "reporter-tag internal"}
                    >
                      {candidate.issue.reporter_is_external ? "Ext" : "Int"}
                    </span>
                    <span className="cell-muted">{candidate.issue.reporter}</span>
                  </td>
                  <td className="cell-muted">{candidate.issue.status}</td>
                  <td>
                    {candidate.issue.linked_cp_issue ? (
                      <span
                        className={
                          candidate.isResolved || candidate.issue.linked_cp_issue.isDone
                            ? "linked-chip resolved"
                            : "linked-chip"
                        }
                      >
                        {candidate.issue.linked_cp_issue.key}
                      </span>
                    ) : (
                      <span className="cell-muted">—</span>
                    )}
                  </td>
                  <td className="cell-muted">
                    {candidate.reason === "no_reporter_response"
                      ? `${Math.round(candidate.daysSinceLastActivity * 10) / 10}d`
                      : "—"}
                  </td>
                  <td className="wrap-cell" style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
                    <SlaFollowUpAction issueKey={candidate.issue.key} stage={candidate.stage} />
                    {isEligibleForSlaBreachAlert(candidate) ? (
                      <SlaBreachAlertAction issueKey={candidate.issue.key} />
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
