import { Icon } from "@/components/Icon";
import { PriorityIndicator } from "@/components/PriorityIndicator";
import { RiskBadge } from "@/components/RiskBadge";
import { StatusBadge } from "@/components/StatusBadge";
import { formatAge, formatRelativeTime, formatShortDate } from "@/lib/issueRow";

import type { IssueRow } from "@/lib/issueRow";

export type SortKey =
  | "age"
  | "assignee"
  | "category"
  | "created"
  | "key"
  | "pod"
  | "priority"
  | "reporter"
  | "risk"
  | "status"
  | "updated";

export type SortDirection = "asc" | "desc";

interface IssueTableProps {
  onRowClick: (issueKey: string) => void;
  onSort: (key: SortKey) => void;
  rows: IssueRow[];
  sortDirection: SortDirection;
  sortKey: SortKey;
}

export function IssueTable({
  onRowClick,
  onSort,
  rows,
  sortDirection,
  sortKey,
}: IssueTableProps): React.ReactElement {
  const sortIcon = (key: SortKey): React.ReactElement => {
    if (sortKey !== key) {
      return <Icon name="sort" size={12} />;
    }
    return <Icon name={sortDirection === "asc" ? "sort-asc" : "sort-desc"} size={12} />;
  };

  const sortableHeader = (key: SortKey, label: string): React.ReactElement => (
    <th className="sortable" onClick={() => onSort(key)} scope="col">
      <span className="th-inner">
        {label}
        {sortIcon(key)}
      </span>
    </th>
  );

  if (rows.length === 0) {
    return <div className="empty-state">No tickets match the current filters.</div>;
  }

  return (
    <div className="table-scroll">
      <table className="data-table">
        <caption className="visually-hidden">Issue list</caption>
        <thead>
          <tr>
            {sortableHeader("key", "Ticket")}
            <th scope="col">Summary</th>
            {sortableHeader("category", "Category")}
            {sortableHeader("pod", "POD")}
            {sortableHeader("priority", "Priority")}
            {sortableHeader("status", "Status")}
            {sortableHeader("risk", "Risk")}
            {sortableHeader("assignee", "Assignee")}
            {sortableHeader("reporter", "Reporter")}
            {sortableHeader("created", "Created")}
            {sortableHeader("age", "Age")}
            {sortableHeader("updated", "Last Updated")}
            <th scope="col">Linked Issue</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const { issue } = row;
            return (
              <tr
                key={issue.key}
                onClick={() => onRowClick(issue.key)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    onRowClick(issue.key);
                  }
                }}
                tabIndex={0}
              >
                <td>
                  <span className="cell-ticket">
                    <span className={`project-dot project-${issue.project ?? ""}`}>{issue.project ?? "—"}</span>
                    <span className="ticket-key-link">{issue.key}</span>
                  </span>
                </td>
                <td className="cell-summary wrap-cell" title={issue.summary}>
                  {issue.summary}
                </td>
                <td className="cell-muted">{issue.support_category ?? "—"}</td>
                <td className="cell-muted">{issue.pod ?? issue.team ?? "—"}</td>
                <td>
                  <PriorityIndicator priority={issue.priority} />
                </td>
                <td>
                  <div className="cell-with-sub">
                    <StatusBadge status={issue.status} />
                    {issue.pending_reason ? (
                      <span className="cell-sub" title={issue.pending_reason}>
                        Pending: {issue.pending_reason}
                      </span>
                    ) : null}
                  </div>
                </td>
                <td>
                  <RiskBadge analysis={row.analysis} />
                </td>
                <td className="cell-muted">{issue.assignee || "Unassigned"}</td>
                <td>
                  <span
                    className={issue.reporter_is_external ? "reporter-tag external" : "reporter-tag internal"}
                  >
                    {issue.reporter_is_external ? "Ext" : "Int"}
                  </span>
                  <span className="cell-muted">{issue.reporter || "—"}</span>
                </td>
                <td className="cell-muted">{formatShortDate(issue.created)}</td>
                <td className="cell-muted">{formatAge(row.ageDays)}</td>
                <td className="cell-muted">{formatRelativeTime(issue.latest_comment_created || issue.updated)}</td>
                <td>
                  {issue.linked_cp_issue ? (
                    <span className={issue.linked_cp_issue.isDone ? "linked-chip resolved" : "linked-chip"}>
                      {issue.linked_cp_issue.key}
                    </span>
                  ) : (
                    <span className="cell-muted">—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
