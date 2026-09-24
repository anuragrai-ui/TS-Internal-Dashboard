import type { FormattedIssue, LinkedCpIssue } from "@/lib/jiraClient";

/**
 * The one closing rule every closing path shares: a TS ticket with ANY
 * linked CP still open - Bug, Task, Story, Epic, any type - is never closed
 * or suggested for closing. The Product fix hasn't shipped, so the client's
 * silence is expected rather than a reason to close. A ticket becomes
 * closable again once every linked CP is resolved (Closure Candidates'
 * linked_cp_resolved, or the client then going quiet), or if it never had a
 * CP at all and the client went unresponsive.
 *
 * Used by Closure Candidates (classifyIssue), the SLA cadence (no closing
 * stage 2/3 while a CP is open), the Agent Follow-Ups "Ready to close" flag,
 * and - as the final safety net - the send route itself, which refuses any
 * closing send for such a ticket regardless of what the browser asked for.
 */
export function openLinkedCps(issue: FormattedIssue): LinkedCpIssue[] {
  const all = issue.linked_cp_issues ?? (issue.linked_cp_issue ? [issue.linked_cp_issue] : []);
  return all.filter((cp) => !cp.isDone);
}

export function hasOpenLinkedCp(issue: FormattedIssue): boolean {
  return openLinkedCps(issue).length > 0;
}

export function describeOpenCps(issue: FormattedIssue): string {
  return openLinkedCps(issue)
    .map((cp) => `${cp.key} (${cp.status})`)
    .join(", ");
}
