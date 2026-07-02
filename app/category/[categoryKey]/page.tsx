import Link from "next/link";
import { notFound } from "next/navigation";

import { RefreshCountdown } from "@/components/RefreshCountdown";
import { ThemeToggle } from "@/components/ThemeToggle";
import { TicketCard } from "@/components/TicketCard";
import { analyzeEscalationRisk } from "@/lib/openrouterEscalation";
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
  const analyses = await analyzeEscalationRisk(issues);
  const analysesByKey = new Map(analyses.map((analysis) => [analysis.key, analysis]));
  const immediateCount = analyses.filter(
    (analysis) => analysis.risk_level === "immediate",
  ).length;
  const watchCount = analyses.filter(
    (analysis) => analysis.risk_level === "watch",
  ).length;
  const normalCount = analyses.filter(
    (analysis) => analysis.risk_level === "normal",
  ).length;

  return (
    <>
      <a className="skip-link" href="#main-content">
        Skip to category content
      </a>

      <nav className="app-navbar" aria-label="Main navigation">
        <Link className="app-brand" href="/">
          <span className="app-brand-mark" aria-hidden="true">TS</span>
          <span>Dashboard</span>
        </Link>
        <div className="app-navbar-actions">
          <ThemeToggle />
        </div>
      </nav>

      <main id="main-content">
        <Link className="back-link" href="/">
          <span aria-hidden="true">←</span>
          Back to dashboard
        </Link>

        <header className="hero-gradient">
          <h1>{category.title}</h1>
          <p className="subtitle">{category.description}</p>
          <div className="refresh-info">
            <span>Last Jira sync: {meta.last_sync}</span>
            <span aria-hidden="true">•</span>
            <span>
              Refresh in <RefreshCountdown nextSyncIso={meta.next_sync_iso} />
            </span>
          </div>
        </header>

        <section aria-label="Risk summary" className="stats-grid">
          <div className="stat-card">
            <div className="stat-icon accent" aria-hidden="true">🎫</div>
            <div className="stat-content">
              <div className="stat-value">{count}</div>
              <div className="stat-label">Total tickets</div>
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-icon danger" aria-hidden="true">🚨</div>
            <div className="stat-content">
              <div className="stat-value">{immediateCount}</div>
              <div className="stat-label">Immediate action</div>
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-icon warning" aria-hidden="true">👀</div>
            <div className="stat-content">
              <div className="stat-value">{watchCount}</div>
              <div className="stat-label">Watch</div>
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-icon success" aria-hidden="true">✅</div>
            <div className="stat-content">
              <div className="stat-value">{normalCount}</div>
              <div className="stat-label">Normal</div>
            </div>
          </div>
        </section>

        <div className="ticket-list">
          {count === 0 ? <div className="empty-state">No tickets found.</div> : null}

          {issues.map((issue) => (
            <TicketCard
              analysis={analysesByKey.get(issue.key)}
              issue={issue}
              key={issue.key}
            />
          ))}
        </div>
      </main>
    </>
  );
}
