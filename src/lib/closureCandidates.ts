import { getFollowUpAuditEntries } from "@/lib/followupAudit";
import type { FollowUpAuditEntry } from "@/lib/followupAudit";
import { CATEGORIES, getCategoryIssues, mapWithConcurrency, searchIssuesSummary } from "@/lib/jiraClient";
import type { FormattedIssue, IssueSummary } from "@/lib/jiraClient";
import { callChatCompletionChain, getApiKey, getModelChain, isEscalationEnabled } from "@/lib/llmClient";
import { getRedis, isRedisConfigured } from "@/lib/redis";

export type ClosureReason = "linked_cp_resolved" | "retry_close" | "similar_issue_resolved";

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
 * "Waiting for Client") for two closure signals that have nothing to do
 * with follow-up timing: the linked CP ticket already resolved, or a nearly
 * identical past ticket was already fixed. Every candidate is a suggestion
 * for a human to review - nothing here drafts, sends, or closes anything.
 */
type IssueClassification =
  | { candidate: ClosureCandidate; kind: "candidate" }
  | { issue: FormattedIssue; kind: "needs-similarity" }
  | { kind: "skip" };

export async function classifyIssue(
  issue: FormattedIssue,
  getAuditEntries: (issueKey: string) => Promise<FollowUpAuditEntry[]> = getFollowUpAuditEntries,
): Promise<IssueClassification> {
  const auditEntries = await getAuditEntries(issue.key);
  const closureAttempted = auditEntries.some((entry) => entry.kind === "closure_candidate");

  if (closureAttempted) {
    if (issue.status_category !== "done") {
      return { candidate: retryCandidateFor(issue), kind: "candidate" };
    }
    return { kind: "skip" };
  }

  // Already progressing through the day-3/day-6 SLA cadence - that page
  // owns this ticket's closure, don't also suggest it here.
  const slaCloseAttempted = auditEntries.some(
    (entry) => entry.kind === "sla_stage_2" || entry.kind === "sla_stage_3",
  );
  if (slaCloseAttempted) {
    return { kind: "skip" };
  }

  // A Story-type linked CP tracks planned work, not a blocking bug/task -
  // it never gates closure either way, in either direction. A TS ticket
  // with two or more real (non-Story) linked CPs only counts as resolved
  // once every one of them is - one resolved CP out of several must not
  // let this fall through as if the whole blocker was cleared.
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
  const classifications = await mapWithConcurrency(issues, 8, classifyIssue);

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
