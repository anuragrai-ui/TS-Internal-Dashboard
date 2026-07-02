import Link from "next/link";
import { notFound } from "next/navigation";

import { RefreshCountdown } from "@/components/RefreshCountdown";
import { getCategoryCacheMeta, getCategoryIssues } from "@/lib/jiraClient";

export const dynamic = "force-dynamic";

interface CategoryPageProps {
  params: Promise<{
    categoryKey: string;
  }>;
}

export default async function CategoryPage({
  params,
}: CategoryPageProps): Promise<React.ReactElement> {
  const { categoryKey } = await params;
  const [category, issues] = await getCategoryIssues(categoryKey);

  if (!category) {
    notFound();
  }

  const meta = getCategoryCacheMeta(categoryKey);
  const count = issues.length;

  return (
    <main>
      <Link className="back-link" href="/">
        ← Back to dashboard
      </Link>

      <header className="page-header">
        <div>
          <h1>{category.title}</h1>
          <p className="subtitle">{category.description}</p>
          <div className="refresh-info">
            Last Jira sync: {meta.last_sync} • Refresh in{" "}
            <RefreshCountdown nextSyncIso={meta.next_sync_iso} />
          </div>
        </div>
      </header>

      <div className="summary">
        {count} ticket{count === 1 ? "" : "s"}
      </div>

      <div className="ticket-list">
        {count === 0 ? <div className="empty-state">No tickets found.</div> : null}

        {issues.map((issue) => (
          <a
            className="ticket-card"
            href={issue.url}
            key={issue.key}
            rel="noreferrer"
            target="_blank"
          >
            <div className="ticket-top-row">
              <div>
                <div className="ticket-key">{issue.key}</div>
                <div className="ticket-summary">{issue.summary}</div>
                <span className={`project-badge project-${issue.project}`}>
                  {issue.project}
                </span>
              </div>

              <div className="ticket-status">{issue.status}</div>
            </div>

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
          </a>
        ))}
      </div>
    </main>
  );
}
