import Link from "next/link";

import { ClosureCandidateAction } from "@/components/ClosureCandidateAction";
import { getClosureCandidates } from "@/lib/closureCandidates";
import { getCurrentIdentity } from "@/lib/currentIdentity";
import { Icon } from "@/components/Icon";
import { IdentityRequired } from "@/components/IdentityRequired";
import { KpiStrip } from "@/components/KpiStrip";

import type { ClosureReason } from "@/lib/closureCandidates";
import type { KpiItem } from "@/components/KpiStrip";

export const dynamic = "force-dynamic";

function reasonLabel(reason: ClosureReason): string {
  if (reason === "linked_cp_resolved") {
    return "Linked CP resolved";
  }
  if (reason === "similar_issue_resolved") {
    return "Similar ticket resolved";
  }
  return "Retry closing";
}

export default async function ClosureCandidatesPage(): Promise<React.ReactElement> {
  const identity = await getCurrentIdentity();
  const allCandidates = identity ? await getClosureCandidates() : [];
  const candidates = identity
    ? allCandidates.filter((candidate) => candidate.issue.assignee_account_id === identity.accountId)
    : [];
  const linkedCpCount = candidates.filter((candidate) => candidate.reason === "linked_cp_resolved").length;
  const similarCount = candidates.filter((candidate) => candidate.reason === "similar_issue_resolved").length;
  const retryCount = candidates.filter((candidate) => candidate.reason === "retry_close").length;

  const kpis: KpiItem[] = [
    { label: "Total Candidates", value: candidates.length },
    { label: "Linked CP Resolved", value: linkedCpCount },
    { label: "Similar Ticket Resolved", value: similarCount },
    { label: "Retry Closing", tone: retryCount > 0 ? "danger" : undefined, value: retryCount },
  ];

  return (
    <>
      <Link className="back-link" href="/">
        <Icon name="chevron-left" size={14} />
        Back to dashboard
      </Link>

      <div className="page-header-row">
        <div className="page-title-group">
          <h1 className="page-title">Closure Candidates</h1>
          <p className="page-subtitle">
            Open TS tickets whose underlying problem appears already resolved elsewhere - a linked CP
            ticket closed, or a near-identical past ticket was already fixed. Every closure is drafted
            for review — nothing sends automatically.
          </p>
        </div>
      </div>

      <KpiStrip items={kpis} />

      {!identity ? (
        <IdentityRequired itemsLabel="closure candidates" />
      ) : candidates.length === 0 ? (
        <div className="empty-state">No open TS tickets assigned to you currently look resolved elsewhere.</div>
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <caption className="visually-hidden">Closure candidates</caption>
            <thead>
              <tr>
                <th scope="col">Ticket</th>
                <th scope="col">Summary</th>
                <th scope="col">Reason</th>
                <th scope="col">Reference</th>
                <th scope="col">Reporter</th>
                <th scope="col">Status</th>
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
                      <span
                        className={
                          candidate.reason === "retry_close" ? "status-badge tone-danger" : "status-badge tone-success"
                        }
                      >
                        {reasonLabel(candidate.reason)}
                      </span>
                      <span className="cell-sub" title={candidate.explanation}>
                        {candidate.explanation}
                      </span>
                    </div>
                  </td>
                  <td className="cell-muted">{candidate.referenceKey ?? "—"}</td>
                  <td>
                    <span
                      className={candidate.issue.reporter_is_external ? "reporter-tag external" : "reporter-tag internal"}
                    >
                      {candidate.issue.reporter_is_external ? "Ext" : "Int"}
                    </span>
                    <span className="cell-muted">{candidate.issue.reporter}</span>
                  </td>
                  <td className="cell-muted">{candidate.issue.status}</td>
                  <td className="wrap-cell">
                    <ClosureCandidateAction issueKey={candidate.issue.key} />
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
