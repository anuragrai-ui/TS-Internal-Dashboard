import { daysSince, getFollowUpAuditEntries, mostRecentEntryOfKind } from "@/lib/followupAudit";
import type { FollowUpAuditEntry } from "@/lib/followupAudit";
import { draftViaChain } from "@/lib/followupDraft";
import type { DraftResult } from "@/lib/followupDraft";
import {
  CATEGORIES,
  findJiraUserByName,
  getCategoryIssues,
  getIssueByKey,
  getLatestCommentMentions,
  mapWithConcurrency,
  MENTION_PLACEHOLDER,
} from "@/lib/jiraClient";
import type { FormattedIssue, TicketCommentContext } from "@/lib/jiraClient";
import { resolvePodRoute } from "@/lib/podRouting";
import { HUMAN_VARIETY_INSTRUCTION, pickVariant } from "@/lib/textVariety";

/** Not user-specified as a number - "every 3 days" for High/Critical, "a week" for Medium, per the user's own list. Low priority is out of scope. */
const CADENCE_DAYS_BY_PRIORITY: Record<string, number> = {
  Critical: 3,
  High: 3,
  Medium: 7,
};

export type CpMentionSource =
  | "assignee"
  | "latest_comment_mention"
  | "pod_em_pm"
  | "pod_em_pm_manager"
  | "unconfirmed_reporter_guess";

export interface CpMentionPerson {
  accountId: string;
  displayName: string;
}

export interface CpMentionTarget {
  people: CpMentionPerson[];
  source: CpMentionSource;
}

export interface CpEscalationCandidate {
  cp: FormattedIssue;
  daysSinceLastNudge: number;
  linkedTsAssigneeAccountId?: string;
  linkedTsKey: string;
  mentionTarget: CpMentionTarget;
}

type JiraNameLookup = (name: string) => Promise<{ account_id: string; display_name: string } | null>;

/** Resolves a POD route's names to real Jira accountIds, dropping (not failing on) any name that doesn't resolve to exactly one account - see findJiraUserByName's own contract for why an ambiguous/missing name is treated as "skip this one," not an error. */
async function resolvePodPeople(names: Array<string | undefined>, findUserByName: JiraNameLookup): Promise<CpMentionPerson[]> {
  const resolved = await Promise.all(
    names.filter((name): name is string => Boolean(name)).map((name) => findUserByName(name)),
  );

  return resolved
    .filter((user): user is { account_id: string; display_name: string } => user !== null)
    .map((user) => ({ accountId: user.account_id, displayName: user.display_name }));
}

/**
 * Resolves who to tag on a CP ticket, in order:
 * (1) the assignee, if any - the ticket already has a real, current owner,
 * no need to broaden beyond them;
 * (2) otherwise ("no tag"), the owning POD's Engineering Manager and Product
 * Manager together (src/lib/podRouting.ts, keyed by the ticket's own `pod`
 * field) - both tagged at once (source "pod_em_pm") on the FIRST nudge for
 * this ticket; once a prior cp_escalation nudge already went out and this is
 * due again (still no response), the PM Manager is added on top (source
 * "pod_em_pm_manager") rather than tagging only them - broadening visibility
 * on escalation, not replacing the original owners;
 * (3) if the POD is unmapped/unknown or none of its names resolve to a real
 * Jira account, falls back to the pre-POD-routing ladder: whoever the
 * reporter already @-mentioned in the most recent comment that mentions
 * anyone, then the reporter itself as an explicitly-flagged guess (source
 * "unconfirmed_reporter_guess") for the UI to surface as "please confirm"
 * rather than treating it as settled;
 * (4) null if truly nobody can be identified.
 * Re-running this fresh each cycle (rather than storing a "locked-in"
 * target) means the same person(s) naturally keep getting tagged as long as
 * nothing's changed, but it also self-corrects if the assignee changes.
 */
export async function resolveCpMentionTarget(
  cp: FormattedIssue,
  hasPriorNudge: boolean,
  findUserByName: JiraNameLookup = findJiraUserByName,
): Promise<CpMentionTarget | null> {
  if (cp.assignee_account_id) {
    return { people: [{ accountId: cp.assignee_account_id, displayName: cp.assignee }], source: "assignee" };
  }

  const route = resolvePodRoute(cp.pod);
  const names = hasPriorNudge ? [route.em, route.pm, route.pmManager] : [route.em, route.pm];
  const people = await resolvePodPeople(names, findUserByName);

  if (people.length > 0) {
    return { people, source: hasPriorNudge ? "pod_em_pm_manager" : "pod_em_pm" };
  }

  const [firstMention] = await getLatestCommentMentions(cp.key);

  if (firstMention) {
    return {
      people: [{ accountId: firstMention.accountId, displayName: firstMention.displayName }],
      source: "latest_comment_mention",
    };
  }

  if (cp.reporter_account_id) {
    return {
      people: [{ accountId: cp.reporter_account_id, displayName: cp.reporter }],
      source: "unconfirmed_reporter_guess",
    };
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
  resolveMentionTarget: (cp: FormattedIssue, hasPriorNudge: boolean) => Promise<CpMentionTarget | null> = resolveCpMentionTarget,
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

  // A prior cp_escalation entry existing here means we already nudged once
  // (tagging the POD's EM+PM) and cadence has elapsed again with no
  // resolution - that's the "no response within SLA" trigger for adding the
  // PM Manager, not a separate tracked flag.
  const mentionTarget = await resolveMentionTarget(cp, Boolean(lastNudge));

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

function mentionOpeningInstruction(mentionCount: number): string {
  if (mentionCount <= 1) {
    return `Open with the literal placeholder text ${MENTION_PLACEHOLDER} exactly as written (it becomes a real Jira @-mention when posted)`;
  }

  const placeholders = Array(mentionCount).fill(MENTION_PLACEHOLDER).join(" ");
  return `Open by @-mentioning all ${mentionCount} people this needs to go to - write the literal placeholder text ${MENTION_PLACEHOLDER} exactly as written once per person, back to back (e.g. "${placeholders}"), each becomes a real Jira @-mention when posted`;
}

function buildCpEscalationSystemPrompt(candidate: CpEscalationCandidate): string {
  const { cp, mentionTarget } = candidate;
  const isBug = cp.issue_type === "Bug";
  const ask = isBug ? "ask for an ETA and a fix update" : "ask for an ETA / progress update";

  return `You are a calm, courteous engineering manager drafting a short Jira comment nudging whoever owns this ticket for a status update. Write only the comment text itself - no subject line, no markdown, no surrounding quotes.

${mentionOpeningInstruction(mentionTarget.people.length)}, then ${ask}. This ticket is blocking a client-facing ticket, named as linked_ts_key in the ticket details below - mention that it's blocking a client to convey why this matters, without being alarmist or terse. ${urgencyRegister(cp.priority)} Keep the tone warm and collaborative, like checking in with a teammate, not issuing a demand. This is an internal engineering message - full technical detail is fine. Keep it to 1-3 sentences.

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
  const { cp, linkedTsKey, mentionTarget } = candidate;
  const ask = cp.issue_type === "Bug" ? "an ETA and a fix update" : "an ETA / progress update";
  const mentions = Array(Math.max(mentionTarget.people.length, 1)).fill(MENTION_PLACEHOLDER).join(" ");

  return [
    `${mentions} could you share ${ask} on this when you get a chance? It's currently blocking client-facing ticket ${linkedTsKey} - really appreciate the help!`,
    `${mentions} any chance you could get us ${ask} here? ${linkedTsKey} is waiting on this one. Thank you!`,
    `${mentions} following up on this - would love ${ask} when you're able, since it's holding up client-facing ${linkedTsKey}. Thanks so much!`,
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
