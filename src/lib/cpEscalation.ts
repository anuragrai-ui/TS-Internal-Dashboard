import { daysSince, getFollowUpAuditEntries, mostRecentEntryOfKind } from "@/lib/followupAudit";
import type { FollowUpAuditEntry } from "@/lib/followupAudit";
import { draftViaChain } from "@/lib/followupDraft";
import type { DraftResult } from "@/lib/followupDraft";
import {
  CATEGORIES,
  getCategoryIssues,
  getIssueByKey,
  getLatestCommentMentions,
  mapWithConcurrency,
  MENTION_PLACEHOLDER,
} from "@/lib/jiraClient";
import type { FormattedIssue, TicketCommentContext } from "@/lib/jiraClient";
import { HUMAN_VARIETY_INSTRUCTION, pickVariant } from "@/lib/textVariety";

/** Not user-specified as a number - "every 3 days" for High/Critical, "a week" for Medium, per the user's own list. Low priority is out of scope. */
const CADENCE_DAYS_BY_PRIORITY: Record<string, number> = {
  Critical: 3,
  High: 3,
  Medium: 7,
};

export type CpMentionSource = "assignee" | "latest_comment_mention" | "unconfirmed_reporter_guess";

export interface CpMentionTarget {
  accountId: string;
  displayName: string;
  source: CpMentionSource;
}

export interface CpEscalationCandidate {
  cp: FormattedIssue;
  daysSinceLastNudge: number;
  linkedTsAssigneeAccountId?: string;
  linkedTsKey: string;
  mentionTarget: CpMentionTarget;
}

/**
 * Resolves who to tag on an unassigned/under-owned CP ticket, in order:
 * (1) the assignee, if any; (2) whoever the reporter already @-mentioned in
 * the most recent comment that mentions anyone - re-running this fresh each
 * cycle (rather than storing a "locked-in" target) means the same person
 * naturally keeps getting tagged as long as nothing's changed, but it also
 * self-corrects if the assignee changes or someone new gets mentioned,
 * rather than nagging a stale target forever; (3) the reporter, as an
 * explicitly-flagged guess (source: "unconfirmed_reporter_guess") for the UI
 * to surface as "no clear owner - please confirm" rather than treating it as
 * settled. A comment can mention more than one person (confirmed live on a
 * real CP ticket) - only the first is used as the actual @-mention target,
 * to reuse the existing single-mention comment infrastructure rather than
 * threading multi-mention support through the whole send pipeline for a
 * rare case.
 */
export async function resolveCpMentionTarget(cp: FormattedIssue): Promise<CpMentionTarget | null> {
  if (cp.assignee_account_id) {
    return { accountId: cp.assignee_account_id, displayName: cp.assignee, source: "assignee" };
  }

  const [firstMention] = await getLatestCommentMentions(cp.key);

  if (firstMention) {
    return {
      accountId: firstMention.accountId,
      displayName: firstMention.displayName,
      source: "latest_comment_mention",
    };
  }

  if (cp.reporter_account_id) {
    return { accountId: cp.reporter_account_id, displayName: cp.reporter, source: "unconfirmed_reporter_guess" };
  }

  return null;
}

/* Injectable getAuditEntries/resolveMentionTarget (defaulting to the real
   Redis/Jira-backed implementations) mirror the pattern already used by
   determineCandidate() in slaFollowup.ts and classifyIssue() in
   closureCandidates.ts - lets the cadence/eligibility math be unit-tested
   with constructed fixtures instead of needing real Redis/Jira. */
export async function determineCpCandidate(
  cp: FormattedIssue,
  linkedTsKey: string,
  linkedTsAssigneeAccountId: string | undefined,
  getAuditEntries: (issueKey: string) => Promise<FollowUpAuditEntry[]> = getFollowUpAuditEntries,
  resolveMentionTarget: (cp: FormattedIssue) => Promise<CpMentionTarget | null> = resolveCpMentionTarget,
): Promise<CpEscalationCandidate | null> {
  if (cp.status_category === "done") {
    return null;
  }

  const cadenceDays = CADENCE_DAYS_BY_PRIORITY[cp.priority];

  if (!cadenceDays) {
    return null;
  }

  const auditEntries = await getAuditEntries(cp.key);
  const lastNudge = mostRecentEntryOfKind(auditEntries, ["cp_escalation"]);
  const daysSinceLastNudge = lastNudge ? daysSince(lastNudge.posted_at) : daysSince(cp.updated);

  if (daysSinceLastNudge < cadenceDays) {
    return null;
  }

  const mentionTarget = await resolveMentionTarget(cp);

  if (!mentionTarget) {
    return null;
  }

  return { cp, daysSinceLastNudge, linkedTsAssigneeAccountId, linkedTsKey, mentionTarget };
}

/**
 * Scans for open CP tickets that are (a) linked to at least one open TS
 * ticket across any of the 4 dashboard categories (not just "waiting for
 * product") - a CP with no client-facing TS ticket depending on it is
 * internal backlog nobody's waiting on, out of scope here - and (b) due for
 * a nudge per their own priority's cadence. Every candidate is a suggestion
 * for a human to review; this module never posts or tags anyone itself.
 * Live-verified count: on a day-1 run (no cp_escalation audit history yet),
 * this surfaced 26 candidates - larger than an earlier CP-centric spot
 * check suggested, since "actionable" alone spans far more open TS tickets
 * than "waiting for product" does. Expect this list to shrink and stabilize
 * once cadence tracking has real history to work from.
 */
export async function getCpEscalationCandidates(): Promise<CpEscalationCandidate[]> {
  const categoryResults = await Promise.all(Object.keys(CATEGORIES).map((key) => getCategoryIssues(key)));

  // Keyed by CP key so each open CP is only evaluated once even if somehow
  // linked from more than one open TS ticket - keeps the linked TS issue's
  // own key/assignee, not just the key, since "is this my CP escalation" is
  // decided by who owns the LINKED TS TICKET (see agent-followups/page.tsx),
  // not by the CP's own (often differently-attributed) reporter field.
  const cpToLinkedTs = new Map<string, { assigneeAccountId?: string; key: string }>();

  for (const [, issues] of categoryResults) {
    for (const issue of issues) {
      const linkedCp = issue.linked_cp_issue;
      if (issue.project === "TS" && linkedCp && !linkedCp.isDone) {
        cpToLinkedTs.set(linkedCp.key, { assigneeAccountId: issue.assignee_account_id, key: issue.key });
      }
    }
  }

  const results = await mapWithConcurrency(
    Array.from(cpToLinkedTs.entries()),
    5,
    async ([cpKey, linkedTs]) => {
      const cp = await getIssueByKey(cpKey);
      return cp ? determineCpCandidate(cp, linkedTs.key, linkedTs.assigneeAccountId) : null;
    },
  );

  return results.filter((candidate): candidate is CpEscalationCandidate => candidate !== null);
}

/* Priority-aware urgency register, on top of the existing Bug/other framing
   below - a Critical nudge and a Medium one shouldn't read identically, per
   the same "not the same type for every CP" concern that motivated the
   fallback-variant pools. Both axes stay small, bounded branches (not
   per-ticket free text), so the resulting system prompt is still one of a
   handful of fixed strings - good for prompt-cache reuse across the many CPs
   that share a given (issue_type, priority-tier) combination in one run. */
function urgencyRegister(priority: string): string {
  return priority === "Critical" || priority === "High"
    ? "This needs a fast turnaround - convey real urgency without sounding alarmist."
    : "This is a standard-priority nudge - polite and direct is enough, no need to sound urgent.";
}

function buildCpEscalationSystemPrompt(candidate: CpEscalationCandidate): string {
  const { cp } = candidate;
  const isBug = cp.issue_type === "Bug";
  const ask = isBug ? "ask for an ETA and a fix update" : "ask for an ETA / progress update";

  return `You are an engineering manager drafting a short, direct Jira comment nudging whoever owns this ticket. Write only the comment text itself - no subject line, no markdown, no surrounding quotes.

Open with the literal placeholder text ${MENTION_PLACEHOLDER} exactly as written (it becomes a real Jira @-mention when posted), then ${ask}. This ticket is blocking a client-facing ticket, named as linked_ts_key in the ticket details below - mention that it's blocking a client to convey urgency, without being alarmist. ${urgencyRegister(cp.priority)} This is an internal engineering message - full technical detail is fine. Keep it to 1-3 sentences.

${HUMAN_VARIETY_INSTRUCTION}`;
}

function buildCpEscalationUserPrompt(candidate: CpEscalationCandidate, comments: TicketCommentContext[]): string {
  const { cp, linkedTsKey } = candidate;

  return `Ticket details:
${JSON.stringify(
  {
    description: cp.description,
    issue_type: cp.issue_type,
    key: cp.key,
    linked_ts_key: linkedTsKey,
    priority: cp.priority,
    recent_comments: comments,
    status: cp.status,
    summary: cp.summary,
  },
  null,
  2,
)}`;
}

function buildCpEscalationFallbacks(candidate: CpEscalationCandidate): string[] {
  const { cp, linkedTsKey } = candidate;
  const ask = cp.issue_type === "Bug" ? "an ETA and a fix update" : "an ETA / progress update";

  return [
    `${MENTION_PLACEHOLDER} could you share ${ask} on this? It's currently blocking client-facing ticket ${linkedTsKey}. Thanks!`,
    `${MENTION_PLACEHOLDER} any chance you can get us ${ask} here? ${linkedTsKey} is blocked on this one.`,
    `${MENTION_PLACEHOLDER} following up on this - we need ${ask} since it's holding up client-facing ${linkedTsKey}.`,
  ];
}

/** Internal-only message, no safety restrictions apply (see src/lib/messageSafety.ts, which is only for external-client-facing drafts). */
export async function draftCpEscalationMessage(
  candidate: CpEscalationCandidate,
  comments: TicketCommentContext[],
): Promise<DraftResult> {
  return draftViaChain(
    buildCpEscalationUserPrompt(candidate, comments),
    candidate.cp.key,
    pickVariant(candidate.cp.key, buildCpEscalationFallbacks(candidate)),
    { allowTools: true, systemPrompt: buildCpEscalationSystemPrompt(candidate) },
  );
}
