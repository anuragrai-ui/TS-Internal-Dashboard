import { daysSince, getFollowUpAuditEntries, mostRecentEntryOfKind } from "@/lib/followupAudit";
import type { FollowUpAuditEntry } from "@/lib/followupAudit";
import { getCategoryIssues, getLinkedCpDetail, mapWithConcurrency } from "@/lib/jiraClient";
import type { FormattedIssue } from "@/lib/jiraClient";
import { hasOpenLinkedCp } from "@/lib/linkedCp";

export type SlaFollowUpStage = 1 | 2 | 3;
/* cp_not_worked: a linked CP is open and nobody's picked it up (Backlog /
   unassigned / stale) - eligible for the SLA-breach Slack alert.
   cp_in_progress: a linked CP is open and actively being worked - a
   reassuring progress check-in only, no PM alert. Either way the ticket
   stays at stage 1 (never closed) until every linked CP is resolved. */
export type SlaFollowUpReason = "cp_in_progress" | "cp_not_worked" | "no_reporter_response";

export interface SlaFollowUpCandidate {
  daysSinceLastActivity: number;
  /* Only meaningful for stage 2: the linked CP issue has since resolved, so
     the draft should be a "we fixed it" closure rather than a "still no
     word from you" final notice. */
  isResolved: boolean;
  issue: FormattedIssue;
  /* True once we're now later acting on this than our own stage window
     allows - e.g. stage 1 was due at day 3 and it's day 5+ with nothing
     sent. Distinct from the client's silence, which is what triggers the
     candidate in the first place. */
  missedSla: boolean;
  reason: SlaFollowUpReason;
  stage: SlaFollowUpStage;
}

const SLA_DAYS = 3;
/* How many days past a stage's own due point before we consider ourselves
   late acting on it, not just the client being silent. Not user-specified -
   a reasonable default alongside SLA_DAYS, kept as a constant for the same
   reason SLA_DAYS is (a fixed business rule, not per-deployment config). */
const MISSED_SLA_BUFFER_DAYS = 2;

export async function isCpNotWorkedOn(issue: FormattedIssue): Promise<boolean> {
  const linkedCp = issue.linked_cp_issue;

  if (!linkedCp || linkedCp.isDone) {
    return false;
  }

  const statusNotStarted = linkedCp.status === "Backlog" || linkedCp.status === "Selected For Sprint";

  if (statusNotStarted) {
    return true;
  }

  const detail = await getLinkedCpDetail(linkedCp.key);
  return Boolean(detail?.assigneeEmpty) || Boolean(detail?.isStale);
}

/* Kinds that represent "we already tried to post a closing comment and mark
   this Done" - shared by the SLA cadence (stage 2) and the separate
   resolved-elsewhere scan (closureCandidates.ts). One retry funnel for both:
   if the attempt didn't actually close the ticket (failed transition), it
   shows up here as stage 3 regardless of which flow sent it. */
const CLOSE_ATTEMPT_KINDS = new Set(["closure_candidate", "sla_stage_2", "sla_stage_3"]);

/* While any linked CP is open the ticket is never closed (see
   src/lib/linkedCp.ts) - so no stage 2/3, just a repeating stage-1
   "still being worked on" check-in every SLA_DAYS since the last one. An
   unworked CP with no check-in yet is due right away, same as before. */
async function openCpCheckIn(
  issue: FormattedIssue,
  auditEntries: FollowUpAuditEntry[],
): Promise<SlaFollowUpCandidate | null> {
  const cpNotWorked = await isCpNotWorkedOn(issue);
  const lastCheckIn = mostRecentEntryOfKind(auditEntries, ["sla_stage_1", "sla_stage_2", "sla_stage_3"]);
  const daysSinceLast = daysSince(lastCheckIn?.posted_at ?? issue.updated);

  if (daysSinceLast < SLA_DAYS && !(cpNotWorked && !lastCheckIn)) {
    return null;
  }

  return {
    daysSinceLastActivity: daysSinceLast,
    isResolved: false,
    issue,
    missedSla: daysSinceLast >= SLA_DAYS + MISSED_SLA_BUFFER_DAYS,
    reason: cpNotWorked ? "cp_not_worked" : "cp_in_progress",
    stage: 1,
  };
}

export async function determineCandidate(
  issue: FormattedIssue,
  getAuditEntries: (issueKey: string) => Promise<FollowUpAuditEntry[]> = getFollowUpAuditEntries,
): Promise<SlaFollowUpCandidate | null> {
  const auditEntries = await getAuditEntries(issue.key);

  if (issue.status_category !== "done" && hasOpenLinkedCp(issue)) {
    return openCpCheckIn(issue, auditEntries);
  }

  const closeAttempted = auditEntries.some((entry) => CLOSE_ATTEMPT_KINDS.has(entry.kind));

  if (closeAttempted) {
    // status_category is Jira's own ground truth ("new" | "indeterminate" |
    // "done") - the reliable way to tell a closing attempt actually took,
    // rather than guessing from a status name.
    if (issue.status_category === "done") {
      return null;
    }

    const lastCloseAttempt = mostRecentEntryOfKind(auditEntries, [
      "closure_candidate",
      "sla_stage_2",
      "sla_stage_3",
    ]);

    return {
      daysSinceLastActivity: daysSince(lastCloseAttempt?.posted_at),
      isResolved: issue.linked_cp_issue?.isDone ?? false,
      issue,
      missedSla: false,
      reason: (await isCpNotWorkedOn(issue)) ? "cp_not_worked" : "no_reporter_response",
      stage: 3,
    };
  }

  // Most recent, not first: a ticket that sat on repeated "CP still in
  // progress" check-ins (openCpCheckIn above) must get a full SLA_DAYS after
  // its latest one once the CP resolves - not an instant stage 2 because
  // its first check-in happened to be weeks ago.
  const stage1Entry = mostRecentEntryOfKind(auditEntries, ["sla_stage_1"]);
  const cpNotWorked = await isCpNotWorkedOn(issue);
  const reason: SlaFollowUpReason = cpNotWorked ? "cp_not_worked" : "no_reporter_response";

  if (stage1Entry) {
    const daysSinceStage1 = daysSince(stage1Entry.posted_at);

    if (daysSinceStage1 < SLA_DAYS) {
      return null;
    }

    return {
      daysSinceLastActivity: daysSinceStage1,
      isResolved: issue.linked_cp_issue?.isDone ?? false,
      issue,
      missedSla: daysSinceStage1 >= SLA_DAYS + MISSED_SLA_BUFFER_DAYS,
      reason,
      stage: 2,
    };
  }

  const daysIdle = daysSince(issue.updated);
  const reporterSilent = daysIdle >= SLA_DAYS;

  if (!reporterSilent && !cpNotWorked) {
    return null;
  }

  return {
    daysSinceLastActivity: daysIdle,
    isResolved: false,
    issue,
    missedSla: daysIdle >= SLA_DAYS + MISSED_SLA_BUFFER_DAYS,
    reason,
    stage: 1,
  };
}

/**
 * Scans TS tickets in "Waiting for Client" or "Waiting for Operations" and
 * flags the ones due for an SLA follow-up: either the reporter has been
 * silent for 3+ days, or a linked CP (Prod) ticket hasn't been picked up
 * (stage 1); both follow-ups already sent but Jira never actually closed the
 * ticket, e.g. a failed transition (stage 3 - see CLOSE_ATTEMPT_KINDS
 * above). Stage tracking reuses the same Redis audit log the manual
 * follow-up button already writes to (see src/lib/followupAudit.ts).
 *
 * "Waiting for Operations" is included alongside "Waiting for Client" (not
 * scanned on its own before this) so an Operations-stage ticket that's gone
 * quiet gets the same cadence tracking - and, downstream, the same
 * eligibility for the Closure Candidates "client unresponsive" reason and
 * the SLA-breach Slack alert - that a Waiting-for-Client ticket already had.
 *
 * Every candidate here is a suggestion for a human to review - this module
 * never drafts, sends, or closes anything itself. A stage-3 case
 * originating from src/lib/closureCandidates.ts's broader all-category scan
 * (a failed closure_candidate transition on a ticket that wasn't in either
 * category here) surfaces on the closure-candidates page instead, as a
 * retry.
 */
export async function getSlaFollowUpCandidates(): Promise<SlaFollowUpCandidate[]> {
  const [[, clientIssues], [, operationsIssues]] = await Promise.all([
    getCategoryIssues("waiting-client"),
    getCategoryIssues("waiting-operations"),
  ]);
  const results = await mapWithConcurrency([...clientIssues, ...operationsIssues], 5, determineCandidate);

  return results.filter((candidate): candidate is SlaFollowUpCandidate => candidate !== null);
}
