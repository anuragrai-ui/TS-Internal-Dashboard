import { getFollowUpAuditEntries } from "@/lib/followupAudit";
import type { FollowUpAuditEntry } from "@/lib/followupAudit";
import { CATEGORIES, getCategoryIssues, mapWithConcurrency, searchIssuesSummary } from "@/lib/jiraClient";
import type { FormattedIssue, IssueSummary } from "@/lib/jiraClient";
import { hasOpenLinkedCp } from "@/lib/linkedCp";
import { callChatCompletionChain, getApiKey, getModelChain, isEscalationEnabled } from "@/lib/llmClient";
import { getRedis, isRedisConfigured } from "@/lib/redis";
import { getReplyTracking } from "@/lib/replyTracking";
import type { ReplyTracking } from "@/lib/replyTracking";

export type ClosureReason = "client_unresponsive" | "linked_cp_resolved" | "retry_close" | "similar_issue_resolved";

export interface ClosureCandidate {
  explanation: string;
  issue: FormattedIssue;
  reason: ClosureReason;
  referenceKey?: string;
}

function parseIntEnv(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getSimilarityLimit(): number {
  return parseIntEnv(process.env.CLOSURE_SIMILARITY_LIMIT, 20);
}

/* "We've asked twice and it's been 4+ days with no reply" - read from the
   ticket's real Jira comments, so follow-ups posted directly in Jira count
   too, not only ones sent through this dashboard. */
export const UNRESPONSIVE_MIN_FOLLOW_UPS = 2;
export const UNRESPONSIVE_MIN_DAYS = 4;

const CACHE_KEY = "closure:candidates";
const CACHE_TTL_SECONDS = 1800;

async function getAllOpenTsIssues(): Promise<FormattedIssue[]> {
  const results = await Promise.all(
    Object.keys(CATEGORIES).map((key) => getCategoryIssues(key)),
  );

  const byKey = new Map<string, FormattedIssue>();

  for (const [, issues] of results) {
    for (const issue of issues) {
      if (issue.project === "TS") {
        byKey.set(issue.key, issue);
      }
    }
  }

  return Array.from(byKey.values());
}

/**
 * A ticket already has a closure_candidate audit entry: either it's now
 * actually Done (fully handled, drop it) or the closing attempt didn't take
 * (failed transition) and it needs a retry - the same "post a comment, try
 * transitionIssueToDone again" action, offered right here rather than a
 * second, separate retry mechanism.
 */
function retryCandidateFor(issue: FormattedIssue): ClosureCandidate {
  return {
    explanation: "A previous closing attempt was sent but the ticket wasn't actually marked Done - retry closing it.",
    issue,
    reason: "retry_close",
  };
}

interface SimilarityMatch {
  key: string;
  matched_key: string;
  reason: string;
}

function buildSimilarityPrompt(
  openTickets: Array<{ key: string; summary?: string }>,
  resolvedShortlist: IssueSummary[],
): string {
  return `You are reviewing open support tickets against a list of already-resolved tickets from the same project, looking for genuine duplicates or same-root-cause matches - not superficial keyword overlap. A match means the underlying problem is the same, not just a similar topic area.

Return only a valid JSON array, no markdown fences. Include an entry ONLY for open tickets that have a genuine match; omit any open ticket with no real match. Each object must have: key (the open ticket's key), matched_key (the resolved ticket's key), reason (one sentence explaining why they're the same underlying issue).

Open tickets:
${JSON.stringify(openTickets, null, 2)}

Resolved tickets to check against:
${JSON.stringify(resolvedShortlist.map((item) => ({ key: item.key, summary: item.summary })), null, 2)}`;
}

export function parseSimilarityMatches(text: string): SimilarityMatch[] {
  const jsonStart = text.indexOf("[");
  const jsonEnd = text.lastIndexOf("]");

  if (jsonStart === -1 || jsonEnd === -1 || jsonEnd < jsonStart) {
    return [];
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1));
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed.filter(
    (item): item is SimilarityMatch =>
      Boolean(item) &&
      typeof (item as SimilarityMatch).key === "string" &&
      typeof (item as SimilarityMatch).matched_key === "string" &&
      typeof (item as SimilarityMatch).reason === "string",
  );
}

/**
 * One bounded, batched judgment call - not per-ticket tool-calling. This is
 * a bulk scan across every open TS ticket; keeping it to one shortlist fetch
 * plus one completion regardless of how many tickets are being checked is
 * what keeps this from turning into the kind of slow-page-load problem the
 * earlier N+1 Jira fetch fix addressed.
 */
async function judgeSimilarIssues(
  openTickets: FormattedIssue[],
): Promise<Map<string, SimilarityMatch>> {
  const matches = new Map<string, SimilarityMatch>();

  if (openTickets.length === 0 || !isEscalationEnabled() || !getApiKey()) {
    return matches;
  }

  const resolvedShortlist = await searchIssuesSummary(
    "project = TS AND statusCategory = Done ORDER BY updated DESC",
    50,
  );

  if (resolvedShortlist.length === 0) {
    return matches;
  }

  const prompt = buildSimilarityPrompt(
    openTickets.map((issue) => ({ key: issue.key, summary: issue.summary })),
    resolvedShortlist,
  );

  const text = await callChatCompletionChain(prompt, {
    maxTokens: 4096,
    models: getModelChain(),
    temperature: 0.1,
  });

  if (!text) {
    return matches;
  }

  for (const match of parseSimilarityMatches(text)) {
    matches.set(match.key, match);
  }

  return matches;
}

async function getCache(): Promise<ClosureCandidate[] | null> {
  if (!isRedisConfigured()) {
    return null;
  }
  try {
    return await getRedis().get<ClosureCandidate[]>(CACHE_KEY);
  } catch (error) {
    console.warn("Closure-candidate cache read failed; treating as a cache miss.", error);
    return null;
  }
}

async function setCache(value: ClosureCandidate[]): Promise<void> {
  if (!isRedisConfigured()) {
    return;
  }
  try {
    await getRedis().set(CACHE_KEY, value, { ex: CACHE_TTL_SECONDS });
  } catch (error) {
    console.warn("Closure-candidate cache write failed; continuing without caching this result.", error);
  }
}

/**
 * Scans every open TS ticket (all four dashboard categories, not just
 * "Waiting for Client") for three closure signals: the linked CP ticket
 * already resolved, a nearly identical past ticket was already fixed, or
 * the reporter has gone unresponsive even after a second follow-up (see the
 * slaCloseAttempted branch in classifyIssue() - reuses the SLA cadence's own
 * stage-2/3 tracking rather than a separate counter). Every candidate is a
 * suggestion for a human to review - nothing here drafts, sends, or closes
 * anything.
 */
type IssueClassification =
  | { candidate: ClosureCandidate; kind: "candidate" }
  | { issue: FormattedIssue; kind: "needs-similarity" }
  | { kind: "skip" };

export async function classifyIssue(
  issue: FormattedIssue,
  getAuditEntries: (issueKey: string) => Promise<FollowUpAuditEntry[]> = getFollowUpAuditEntries,
  getTracking: (issue: FormattedIssue) => Promise<ReplyTracking | null> = getReplyTracking,
): Promise<IssueClassification> {
  // Never close, or suggest closing, while any linked CP is still open -
  // not even a retry of an earlier close attempt (see src/lib/linkedCp.ts).
  if (issue.status_category === "done" || hasOpenLinkedCp(issue)) {
    return { kind: "skip" };
  }

  const auditEntries = await getAuditEntries(issue.key);
  const closureAttempted = auditEntries.some((entry) => entry.kind === "closure_candidate");

  if (closureAttempted) {
    if (issue.status_category !== "done") {
      return { candidate: retryCandidateFor(issue), kind: "candidate" };
    }
    return { kind: "skip" };
  }

  // A stage-2/3 entry means the SLA cadence already sent a second follow-up
  // (or a retry of one) and the ticket is still open - "the reporter hasn't
  // responded even after a second follow-up," which is exactly what the
  // user asked to see surfaced here, not silently owned by the SLA tab
  // alone. (Open linked CPs were already excluded above.)
  const slaCloseAttempted = auditEntries.some(
    (entry) => entry.kind === "sla_stage_2" || entry.kind === "sla_stage_3",
  );
  if (slaCloseAttempted) {
    return {
      candidate: {
        explanation: "The reporter hasn't responded even after a second follow-up.",
        issue,
        reason: "client_unresponsive",
      },
      kind: "candidate",
    };
  }

  // Every linked CP is resolved by this point (open ones were excluded
  // above). A Story-type CP still doesn't count as proof the reporter's
  // problem is fixed, though - so "resolved" needs at least one resolved
  // non-Story CP; a ticket linked only to Stories falls through to the
  // unresponsive / similarity checks below instead.
  const blockingCps = (issue.linked_cp_issues ?? []).filter((cp) => cp.issueType !== "Story");

  if (blockingCps.length > 0 && blockingCps.every((cp) => cp.isDone)) {
    const [first] = blockingCps;

    return {
      candidate: {
        explanation:
          blockingCps.length === 1
            ? `Linked ticket ${first!.key} has been resolved.`
            : `All linked tickets (${blockingCps.map((cp) => cp.key).join(", ")}) have been resolved.`,
        issue,
        reason: "linked_cp_resolved",
        referenceKey: first!.key,
      },
      kind: "candidate",
    };
  }

  // Reporter gone quiet, per the ticket's own comments: at least two of our
  // follow-ups in a row with no reply, the latest 4+ days old. Covers every
  // open status, Waiting for Product included - either there was never a
  // CP, or every linked CP has been resolved and the client still hasn't
  // replied.
  const tracking = await getTracking(issue);

  if (
    tracking &&
    tracking.unansweredFollowUps >= UNRESPONSIVE_MIN_FOLLOW_UPS &&
    (tracking.daysSinceLastFollowUp ?? 0) >= UNRESPONSIVE_MIN_DAYS
  ) {
    return {
      candidate: {
        explanation: `No reply from the reporter in ${Math.floor(tracking.daysSinceLastFollowUp ?? 0)} days, after ${tracking.unansweredFollowUps} follow-ups.`,
        issue,
        reason: "client_unresponsive",
      },
      kind: "candidate",
    };
  }

  return { issue, kind: "needs-similarity" };
}

/**
 * Fresh, single-ticket version of the classification used when drafting one
 * candidate from the UI - avoids re-running the full bulk scan (all four
 * categories + the batched AI call over every open ticket) just to draft
 * one closure message. Returns null if this ticket no longer qualifies
 * (e.g. it's since been closed, or the signal that made it a candidate is
 * gone) - the draft route treats that as "nothing to draft."
 */
export async function getClosureCandidateForIssue(issue: FormattedIssue): Promise<ClosureCandidate | null> {
  const result = await classifyIssue(issue);

  if (result.kind === "candidate") {
    return result.candidate;
  }

  if (result.kind === "skip") {
    return null;
  }

  const matches = await judgeSimilarIssues([issue]);
  const match = matches.get(issue.key);

  if (!match) {
    return null;
  }

  return {
    explanation: match.reason,
    issue,
    reason: "similar_issue_resolved",
    referenceKey: match.matched_key,
  };
}

export async function getClosureCandidates(): Promise<ClosureCandidate[]> {
  const cached = await getCache();
  if (cached) {
    return cached;
  }

  const issues = await getAllOpenTsIssues();
  const classifications = await mapWithConcurrency(issues, 8, (issue) => classifyIssue(issue));

  const candidates: ClosureCandidate[] = [];
  const needsSimilarityCheck: FormattedIssue[] = [];

  for (const result of classifications) {
    if (result.kind === "candidate") {
      candidates.push(result.candidate);
    } else if (result.kind === "needs-similarity") {
      needsSimilarityCheck.push(result.issue);
    }
  }

  // No linked CP at all is the higher-priority case to spend the bounded AI
  // check on - a ticket with an active linked CP already has somewhere else
  // tracking it.
  const prioritized = [...needsSimilarityCheck].sort((a, b) => {
    const aHasCp = a.linked_cp_issue ? 1 : 0;
    const bHasCp = b.linked_cp_issue ? 1 : 0;
    return aHasCp - bHasCp;
  });
  const capped = prioritized.slice(0, getSimilarityLimit());

  const matches = await judgeSimilarIssues(capped);

  for (const issue of capped) {
    const match = matches.get(issue.key);
    if (match) {
      candidates.push({
        explanation: match.reason,
        issue,
        reason: "similar_issue_resolved",
        referenceKey: match.matched_key,
      });
    }
  }

  await setCache(candidates);
  return candidates;
}
