import { getCache, setCache } from "@/lib/cache";
import { countIssues, searchClosedIssues } from "@/lib/jiraClient";
import type { ClosedIssueSummary } from "@/lib/jiraClient";

/* JQL date literals are read in the Jira account's own timezone (the
   service account is America/Los_Angeles, confirmed via /myself), so week
   boundaries are computed in that same zone - otherwise a Sunday-evening
   close would land in the wrong week. */
const REPORT_TIMEZONE = process.env.WEEKLY_REPORT_TIMEZONE || "America/Los_Angeles";
const WEEKS_OF_HISTORY = 6;
const CACHE_TTL_SECONDS = 900;

export interface ClosedTicket extends ClosedIssueSummary {
  fromProduct: boolean;
}

export interface WeeklyClosureBucket {
  closed: number;
  fromProduct: number;
  label: string;
  weekStart: string;
}

export interface WeeklyClosureReport {
  generatedAt: string;
  /* Everything closed in the whole TS project this week, anyone's - for context next to your own numbers. */
  teamClosedThisWeek: number | null;
  teamFromProductThisWeek: number | null;
  thisWeek: ClosedTicket[];
  weekStart: string;
  /* Oldest first, current week last. */
  weeks: WeeklyClosureBucket[];
}

/** "YYYY-MM-DD" for `date` as seen in REPORT_TIMEZONE. */
function localDateString(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: REPORT_TIMEZONE,
    year: "numeric",
  }).format(date);
}

/** Pure date-string arithmetic (UTC noon avoids any DST edge) - the Monday on or before `ymd`. */
export function mondayOf(ymd: string): string {
  const date = new Date(`${ymd}T12:00:00Z`);
  const daysSinceMonday = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - daysSinceMonday);
  return date.toISOString().slice(0, 10);
}

export function addDays(ymd: string, days: number): string {
  const date = new Date(`${ymd}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function weekLabel(weekStart: string): string {
  return new Date(`${weekStart}T12:00:00Z`).toLocaleDateString("en-US", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

/** Groups closed tickets into Monday-start weeks, oldest first, with empty weeks kept as zeros. */
export function bucketByWeek(tickets: ClosedTicket[], firstWeekStart: string, weekCount: number): WeeklyClosureBucket[] {
  const buckets = Array.from({ length: weekCount }, (_, index) => {
    const weekStart = addDays(firstWeekStart, index * 7);
    return { closed: 0, fromProduct: 0, label: `Week of ${weekLabel(weekStart)}`, weekStart };
  });
  const byStart = new Map(buckets.map((bucket) => [bucket.weekStart, bucket]));

  for (const ticket of tickets) {
    const parsed = Date.parse(ticket.closedAt);
    if (Number.isNaN(parsed)) {
      continue;
    }
    const bucket = byStart.get(mondayOf(localDateString(new Date(parsed))));
    if (bucket) {
      bucket.closed += 1;
      if (ticket.fromProduct) {
        bucket.fromProduct += 1;
      }
    }
  }

  return buckets;
}

function escapeJqlString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

async function countOrNull(jql: string): Promise<number | null> {
  try {
    return await countIssues(jql);
  } catch (error) {
    console.warn("Weekly closures: team-wide count failed.", error);
    return null;
  }
}

/**
 * TS tickets assigned to `accountId` that moved into a Done-category status
 * over the last few weeks, and which of those had been "Waiting for
 * Product" at some point in the reporting window. "Closed" is Jira's own
 * statusCategoryChangedDate, so it counts Done/Closed/Resolved alike
 * regardless of which exact status name the workflow uses.
 */
export async function getWeeklyClosureReport(accountId: string): Promise<WeeklyClosureReport> {
  const weekStart = mondayOf(localDateString(new Date()));
  const windowStart = addDays(weekStart, -7 * (WEEKS_OF_HISTORY - 1));
  const cacheKey = `weekly_closures:${accountId}:${weekStart}`;

  const cached = await getCache<WeeklyClosureReport>(cacheKey);
  if (cached) {
    return cached.value;
  }

  const assignee = escapeJqlString(accountId);
  const closedInWindow = `project = TS AND statusCategory = Done AND statusCategoryChangedDate >= "${windowStart}"`;
  const wasProduct = `status WAS "Waiting for Product" DURING ("${windowStart}", now())`;
  const teamThisWeek = `project = TS AND statusCategory = Done AND statusCategoryChangedDate >= "${weekStart}"`;

  const [closed, fromProduct, teamClosedThisWeek, teamFromProductThisWeek] = await Promise.all([
    searchClosedIssues(`${closedInWindow} AND assignee = "${assignee}" ORDER BY statusCategoryChangedDate DESC`),
    searchClosedIssues(`${closedInWindow} AND assignee = "${assignee}" AND ${wasProduct}`),
    countOrNull(teamThisWeek),
    countOrNull(`${teamThisWeek} AND status WAS "Waiting for Product" DURING ("${weekStart}", now())`),
  ]);

  const fromProductKeys = new Set(fromProduct.map((ticket) => ticket.key));
  const tickets: ClosedTicket[] = closed.map((ticket) => ({ ...ticket, fromProduct: fromProductKeys.has(ticket.key) }));
  const weeks = bucketByWeek(tickets, windowStart, WEEKS_OF_HISTORY);

  const report: WeeklyClosureReport = {
    generatedAt: new Date().toISOString(),
    teamClosedThisWeek,
    teamFromProductThisWeek,
    thisWeek: tickets.filter((ticket) => {
      const parsed = Date.parse(ticket.closedAt);
      return !Number.isNaN(parsed) && localDateString(new Date(parsed)) >= weekStart;
    }),
    weekStart,
    weeks,
  };

  await setCache(cacheKey, report, CACHE_TTL_SECONDS);
  return report;
}

/** "Mon, Sep 21" in the report's timezone - for the closed-ticket list. */
export function formatClosedAt(iso: string): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) {
    return "—";
  }
  return new Date(parsed).toLocaleDateString("en-US", {
    day: "numeric",
    month: "short",
    timeZone: REPORT_TIMEZONE,
    weekday: "short",
  });
}
