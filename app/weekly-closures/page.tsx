import Link from "next/link";

import { BreakdownBars } from "@/components/BreakdownBars";
import { Icon } from "@/components/Icon";
import { IdentityRequired } from "@/components/IdentityRequired";
import { KpiStrip } from "@/components/KpiStrip";
import { getCurrentIdentity } from "@/lib/currentIdentity";
import { addDays, formatClosedAt, getWeeklyClosureReport } from "@/lib/weeklyClosures";

import type { KpiItem } from "@/components/KpiStrip";
import type { WeeklyClosureReport } from "@/lib/weeklyClosures";

export const dynamic = "force-dynamic";

/* Neutral on purpose - mid-week, this week is a partial count against a
   full previous week, so a red "down" would mostly just mean "it's Tuesday". */
function lastWeekNote(previous: number): { sub: string } {
  return { sub: `${previous} last week` };
}

export default async function WeeklyClosuresPage(): Promise<React.ReactElement> {
  const identity = await getCurrentIdentity();

  let report: WeeklyClosureReport | null = null;
  let loadError = false;

  if (identity) {
    try {
      report = await getWeeklyClosureReport(identity.accountId);
    } catch (error) {
      console.error("Weekly closures report failed.", error);
      loadError = true;
    }
  }

  const current = report?.weeks.at(-1);
  const previous = report?.weeks.at(-2);
  const history = report?.weeks ?? [];
  const average = history.length > 0 ? history.reduce((sum, week) => sum + week.closed, 0) / history.length : 0;

  const kpis: KpiItem[] = report
    ? [
        { label: "TS Closed This Week", value: current?.closed ?? 0, ...lastWeekNote(previous?.closed ?? 0) },
        {
          label: "From Waiting for Product",
          value: current?.fromProduct ?? 0,
          ...lastWeekNote(previous?.fromProduct ?? 0),
        },
        { label: "Closed Last Week", value: previous?.closed ?? 0 },
        { label: `${history.length}-Week Average`, value: Math.round(average * 10) / 10 },
        {
          label: "Whole TS Team This Week",
          sub:
            report.teamFromProductThisWeek === null
              ? "all assignees"
              : `${report.teamFromProductThisWeek} from Waiting for Product`,
          value: report.teamClosedThisWeek ?? "—",
        },
      ]
    : [];

  return (
    <>
      <Link className="back-link" href="/">
        <Icon name="chevron-left" size={14} />
        Back to dashboard
      </Link>

      <div className="page-header-row">
        <div className="page-title-group">
          <h1 className="page-title">Weekly Closures</h1>
          <p className="page-subtitle">
            TS tickets assigned to you that moved to Done/Closed, week by week (Monday start), and how many of
            those had been waiting on Product. Counts come straight from Jira and refresh every 15 minutes.
          </p>
          {report ? (
            <div className="sync-meta">
              <span>
                This week: {formatClosedAt(`${report.weekStart}T12:00:00Z`)} –{" "}
                {formatClosedAt(`${addDays(report.weekStart, 6)}T12:00:00Z`)}
              </span>
            </div>
          ) : null}
        </div>
      </div>

      {!identity ? (
        <IdentityRequired itemsLabel="weekly closures" />
      ) : loadError || !report ? (
        <div className="empty-state">Couldn't load closures from Jira right now. Try refreshing in a minute.</div>
      ) : (
        <>
          <KpiStrip items={kpis} />

          <div className="analytics-row">
            <BreakdownBars
              entries={[...history].reverse().map((week) => ({ count: week.closed, label: week.label }))}
              title="TS Closed per Week"
            />
            <BreakdownBars
              entries={[...history].reverse().map((week) => ({ count: week.fromProduct, label: week.label }))}
              title='Resolved From "Waiting for Product" per Week'
            />
          </div>

          <div className="page-title-group">
            <h2 className="page-title" style={{ fontSize: "1.05rem" }}>
              Closed This Week
            </h2>
          </div>

          {report.thisWeek.length === 0 ? (
            <div className="empty-state">Nothing closed yet this week.</div>
          ) : (
            <div className="table-scroll">
              <table className="data-table">
                <caption className="visually-hidden">TS tickets closed this week</caption>
                <thead>
                  <tr>
                    <th scope="col">Ticket</th>
                    <th scope="col">Summary</th>
                    <th scope="col">Reporter</th>
                    <th scope="col">Status</th>
                    <th scope="col">Closed</th>
                    <th scope="col">Was Waiting for Product</th>
                  </tr>
                </thead>
                <tbody>
                  {report.thisWeek.map((ticket) => (
                    <tr key={ticket.key}>
                      <td>
                        <a className="ticket-key-link" href={ticket.url} rel="noreferrer" target="_blank">
                          {ticket.key}
                        </a>
                      </td>
                      <td className="cell-summary wrap-cell" title={ticket.summary}>
                        {ticket.summary}
                      </td>
                      <td className="cell-muted">{ticket.reporter || "—"}</td>
                      <td>
                        <span className="status-badge tone-success">{ticket.status ?? "Done"}</span>
                      </td>
                      <td className="cell-muted">{formatClosedAt(ticket.closedAt)}</td>
                      <td>
                        {ticket.fromProduct ? (
                          <span className="status-badge tone-accent">Yes</span>
                        ) : (
                          <span className="cell-muted">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </>
  );
}
