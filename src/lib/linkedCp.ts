import type { FormattedIssue, LinkedCpIssue } from "@/lib/jiraClient";

/**
 * The one closing rule every closing path shares: a TS ticket with ANY
 * linked CP still open - Bug, Task, Story, Epic, any type - is never closed
 * or suggested for closing. "Open" means the fix hasn't shipped: a CP in
 * Ready for Release still counts as open (see isFixShipped below). The Product fix hasn't shipped, so the client's
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
  return all.filter((cp) => !isFixShipped(cp));
}

/* Jira files "Ready for Release" (10131) under the done status category, but
   the fix hasn't reached the customer yet - closing the TS ticket then would
   tell the client "resolved" before it is. HF-Ready for Release (12665) is
   already in the in-progress category; listed too so a workflow change can't
   quietly flip it. Matched by id, with the name as a fallback for cached
   issues fetched before statusId was recorded. */
const NOT_YET_SHIPPED_STATUS_IDS = new Set(["10131", "12665"]);
const NOT_YET_SHIPPED_STATUS_NAMES = new Set(["ready for release", "hf-ready for release"]);

/** True once the CP's fix has actually shipped (or the CP was otherwise closed out) - not merely marked ready for release. */
export function isFixShipped(cp: LinkedCpIssue): boolean {
  if (!cp.isDone) {
    return false;
  }
  return !(
    NOT_YET_SHIPPED_STATUS_IDS.has(cp.statusId ?? "") ||
    NOT_YET_SHIPPED_STATUS_NAMES.has(cp.status.trim().toLowerCase())
  );
}

export function hasOpenLinkedCp(issue: FormattedIssue): boolean {
  return openLinkedCps(issue).length > 0;
}

export function describeOpenCps(issue: FormattedIssue): string {
  return openLinkedCps(issue)
    .map((cp) => `${cp.key} (${cp.status})`)
    .join(", ");
}
