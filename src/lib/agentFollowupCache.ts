import type { CpEscalationCandidate } from "@/lib/cpEscalation";
import type { ProductWaitCandidate } from "@/lib/productWaitFollowup";
import { getRedis, isRedisConfigured } from "@/lib/redis";

/* Candidate lists: short TTL, written by the cron route's fast Phase 1 scan
   and read by the review page so it doesn't have to re-run the scan on
   every visit. Drafts: longer TTL, written incrementally by Phase 2 as each
   one finishes, read by the review page (falling back to on-demand
   generation if missing/expired) and re-validated at Send time regardless -
   a cached draft can be within its TTL and still describe a world that's
   since changed (CP got assigned, ticket got resolved). */
const CANDIDATE_TTL_SECONDS = 3600;
const DRAFT_TTL_SECONDS = 86_400;

export interface CachedDraft {
  generatedAt: string;
  mentionAccountId?: string;
  text: string;
  toolCallCount: number;
}

function cpCandidatesKey(): string {
  return "agentfollowup:candidates:cp";
}

function tsCandidatesKey(): string {
  return "agentfollowup:candidates:ts";
}

function draftKey(issueKey: string, kind: string): string {
  return `agentfollowup:draft:${issueKey}:${kind}`;
}

export async function getCachedCpCandidates(): Promise<CpEscalationCandidate[] | null> {
  if (!isRedisConfigured()) {
    return null;
  }
  try {
    return await getRedis().get<CpEscalationCandidate[]>(cpCandidatesKey());
  } catch (error) {
    console.warn("Failed to read cached CP escalation candidates.", error);
    return null;
  }
}

export async function setCachedCpCandidates(candidates: CpEscalationCandidate[]): Promise<void> {
  if (!isRedisConfigured()) {
    return;
  }
  try {
    await getRedis().set(cpCandidatesKey(), candidates, { ex: CANDIDATE_TTL_SECONDS });
  } catch (error) {
    console.warn("Failed to cache CP escalation candidates.", error);
  }
}

export async function getCachedTsCandidates(): Promise<ProductWaitCandidate[] | null> {
  if (!isRedisConfigured()) {
    return null;
  }
  try {
    return await getRedis().get<ProductWaitCandidate[]>(tsCandidatesKey());
  } catch (error) {
    console.warn("Failed to read cached TS product-wait candidates.", error);
    return null;
  }
}

export async function setCachedTsCandidates(candidates: ProductWaitCandidate[]): Promise<void> {
  if (!isRedisConfigured()) {
    return;
  }
  try {
    await getRedis().set(tsCandidatesKey(), candidates, { ex: CANDIDATE_TTL_SECONDS });
  } catch (error) {
    console.warn("Failed to cache TS product-wait candidates.", error);
  }
}

export async function getCachedDraft(issueKey: string, kind: string): Promise<CachedDraft | null> {
  if (!isRedisConfigured()) {
    return null;
  }
  try {
    return await getRedis().get<CachedDraft>(draftKey(issueKey, kind));
  } catch (error) {
    console.warn(`Failed to read cached draft for ${issueKey}.`, error);
    return null;
  }
}

export async function setCachedDraft(issueKey: string, kind: string, draft: CachedDraft): Promise<void> {
  if (!isRedisConfigured()) {
    return;
  }
  try {
    await getRedis().set(draftKey(issueKey, kind), draft, { ex: DRAFT_TTL_SECONDS });
  } catch (error) {
    console.warn(`Failed to cache draft for ${issueKey}.`, error);
  }
}
