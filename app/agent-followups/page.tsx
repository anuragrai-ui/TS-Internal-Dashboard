import Link from "next/link";

import { getCachedCpCandidates, getCachedTsCandidates } from "@/lib/agentFollowupCache";
import { CpEscalationAction } from "@/components/CpEscalationAction";
import { getCpEscalationCandidates } from "@/lib/cpEscalation";
import { getProductWaitCandidates } from "@/lib/productWaitFollowup";
import { Icon } from "@/components/Icon";
import { KpiStrip } from "@/components/KpiStrip";
import { ProductWaitFollowUpAction } from "@/components/ProductWaitFollowUpAction";

import type { KpiItem } from "@/components/KpiStrip";

export const dynamic = "force-dynamic";

function mentionSourceLabel(source: string): string {
  if (source === "assignee") {
    return "assignee";
  }
  if (source === "latest_comment_mention") {
    return "last mentioned";
  }
  return "unconfirmed guess";
}

export default async function AgentFollowUpsPage(): Promise<React.ReactElement> {
  const [cpCandidates, tsCandidates] = await Promise.all([
    getCachedCpCandidates().then((cached) => cached ?? getCpEscalationCandidates()),
    getCachedTsCandidates().then((cached) => cached ?? getProductWaitCandidates()),
  ]);

  const highPriorityCount = cpCandidates.filter(
    (candidate) => candidate.cp.priority === "Critical" || candidate.cp.priority === "High",
  ).length;
  const unconfirmedCount = cpCandidates.filter(
    (candidate) => candidate.mentionTarget.source === "unconfirmed_reporter_guess",
  ).length;

  const cpKpis: KpiItem[] = [
    { label: "CP Escalations Due", value: cpCandidates.length },
    { label: "High / Critical", tone: highPriorityCount > 0 ? "danger" : undefined, value: highPriorityCount },
    { label: "No Confirmed Owner", tone: unconfirmedCount > 0 ? "warning" : undefined, value: unconfirmedCount },
  ];

  const externalCount = tsCandidates.filter((candidate) => candidate.issue.reporter_is_external).length;
  const repeatFollowUpCount = tsCandidates.filter((candidate) => candidate.followUpOrdinal > 1).length;

  const tsKpis: KpiItem[] = [
    { label: "TS Follow-Ups Due", value: tsCandidates.length },
    { label: "External Reporter", value: externalCount },
    { label: "Repeat Follow-Up (2nd+)", tone: repeatFollowUpCount > 0 ? "warning" : undefined, value: repeatFollowUpCount },
  ];

  return (
    <>
      <Link className="back-link" href="/">
        <Icon name="chevron-left" size={14} />
        Back to dashboard
      </Link>

      <div className="page-header-row">
        <div className="page-title-group">
          <h1 className="page-title">Agent Follow-Ups</h1>
          <p className="page-subtitle">
            Proactive CP nudges and TS "Waiting for Product" follow-ups on their own cadence (3 days for
            High/Critical CPs, 7 for Medium; 3 days for TS). A scheduled scan prepares drafts and posts a
            Slack summary - every message is still drafted for review, nothing sends automatically.
          </p>
        </div>
      </div>

      <div className="page-title-group">
        <h2 className="page-title" style={{ fontSize: "1.05rem" }}>
          CP Escalations
        </h2>
        <p className="page-subtitle">
          Open CP tickets blocking a client-facing TS ticket, due for a nudge to whoever owns them.
        </p>
      </div>

      <KpiStrip items={cpKpis} />

      {cpCandidates.length === 0 ? (
        <div className="empty-state">No CP escalations are currently due.</div>
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <caption className="visually-hidden">CP escalation candidates</caption>
            <thead>
              <tr>
                <th scope="col">CP Ticket</th>
                <th scope="col">Summary</th>
                <th scope="col">Priority</th>
                <th scope="col">Type</th>
                <th scope="col">Linked TS</th>
                <th scope="col">Owner To Tag</th>
                <th scope="col">Idle</th>
                <th scope="col">Action</th>
              </tr>
            </thead>
            <tbody>
              {cpCandidates.map((candidate) => (
                <tr key={candidate.cp.key}>
                  <td>
                    <a className="ticket-key-link" href={candidate.cp.url} rel="noreferrer" target="_blank">
                      {candidate.cp.key}
                    </a>
                  </td>
                  <td className="cell-summary wrap-cell" title={candidate.cp.summary}>
                    {candidate.cp.summary}
                  </td>
                  <td>
                    <span
                      className={
                        candidate.cp.priority === "Critical" || candidate.cp.priority === "High"
                          ? "status-badge tone-danger"
                          : "status-badge tone-warning"
                      }
                    >
                      {candidate.cp.priority}
                    </span>
                  </td>
                  <td className="cell-muted">{candidate.cp.issue_type ?? "—"}</td>
                  <td>
                    <span className="linked-chip">{candidate.linkedTsKey}</span>
                  </td>
                  <td>
                    <div className="cell-with-sub">
                      <span>{candidate.mentionTarget.displayName}</span>
                      <span
                        className="cell-sub"
                        style={
                          candidate.mentionTarget.source === "unconfirmed_reporter_guess"
                            ? { color: "var(--warning)", fontWeight: 600 }
                            : undefined
                        }
                      >
                        {mentionSourceLabel(candidate.mentionTarget.source)}
                      </span>
                    </div>
                  </td>
                  <td className="cell-muted">{Math.round(candidate.daysSinceLastNudge * 10) / 10}d</td>
                  <td className="wrap-cell">
                    <CpEscalationAction
                      cpKey={candidate.cp.key}
                      mentionDisplayName={candidate.mentionTarget.displayName}
                      mentionSource={candidate.mentionTarget.source}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="page-title-group">
        <h2 className="page-title" style={{ fontSize: "1.05rem" }}>
          TS Product-Wait Follow-Ups
        </h2>
        <p className="page-subtitle">
          TS tickets "Waiting for Product" for 3+ days since the last follow-up (or ever, for a first one).
        </p>
      </div>

      <KpiStrip items={tsKpis} />

      {tsCandidates.length === 0 ? (
        <div className="empty-state">No TS product-wait follow-ups are currently due.</div>
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <caption className="visually-hidden">TS product-wait follow-up candidates</caption>
            <thead>
              <tr>
                <th scope="col">Ticket</th>
                <th scope="col">Summary</th>
                <th scope="col">Reporter</th>
                <th scope="col">Status</th>
                <th scope="col">Linked CP</th>
                <th scope="col">Follow-Up #</th>
                <th scope="col">Action</th>
              </tr>
            </thead>
            <tbody>
              {tsCandidates.map((candidate) => (
                <tr key={candidate.issue.key}>
                  <td>
                    <a className="ticket-key-link" href={candidate.issue.url} rel="noreferrer" target="_blank">
                      {candidate.issue.key}
                    </a>
                  </td>
                  <td className="cell-summary wrap-cell" title={candidate.issue.summary}>
                    {candidate.issue.summary}
                  </td>
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
                      <span className="linked-chip">{candidate.issue.linked_cp_issue.key}</span>
                    ) : (
                      <span className="cell-muted">—</span>
                    )}
                  </td>
                  <td className="cell-muted">{candidate.followUpOrdinal}</td>
                  <td className="wrap-cell">
                    <ProductWaitFollowUpAction issueKey={candidate.issue.key} />
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
