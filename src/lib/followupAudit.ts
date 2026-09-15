import type { Redis } from "@upstash/redis";

import { getRedis, isRedisConfigured } from "@/lib/redis";

/* This zset previously had no cap and no TTL - every follow-up ever sent to
   a ticket accumulated forever, the one clearly unbounded key pattern in an
   otherwise TTL-disciplined codebase (see agentFollowupCache.ts/cache.ts/
   the Slack-mentions zset in app/api/slack/events/route.ts, which caps at
   10 entries + a 30-day TTL - this mirrors that same bounded-zset pattern).
   50 entries and 180 days comfortably cover any realistic ticket's full
   follow-up history before it's closed; a ticket still needing more than
   that after 6 months of nudges has bigger problems than log storage. */
const AUDIT_LOG_MAX_ENTRIES = 50;
const AUDIT_LOG_TTL_SECONDS = 180 * 86_400;

/**
 * Not a closed enum enforced by this log itself - kinds are implicitly
 * partitioned by the issue key's project prefix (a "cp_escalation" entry can
 * only ever exist under a CP-* key, "sla_stage_*"/"product_wait" only under
 * a TS-* key), since the log is keyed by arbitrary issue key with no
 * project field of its own.
 */
export type FollowUpKind =
  | "closure_candidate"
  | "cp_escalation"
  | "manual"
  | "product_wait"
  | "sla_stage_1"
  | "sla_stage_2"
  | "sla_stage_3";

/**
 * Runtime-checkable companion to the FollowUpKind type above - TypeScript
 * unions don't exist at runtime, so this is what scripts/test-agent-followups.ts
 * actually iterates to assert VALID_KINDS in the send route hasn't drifted
 * out of sync (an omitted kind there silently coerces to "manual" on send,
 * corrupting cadence/re-tag tracking - see that route for the full story).
 * Keep this in sync with the type above by hand; the test fails loudly if
 * they diverge in the direction that matters (a kind here missing from
 * VALID_KINDS).
 */
export const ALL_FOLLOW_UP_KINDS: FollowUpKind[] = [
  "closure_candidate",
  "cp_escalation",
  "manual",
  "product_wait",
  "sla_stage_1",
  "sla_stage_2",
  "sla_stage_3",
];

export interface FollowUpAuditEntry {
  id: string;
  jira_comment_id: string;
  kind: FollowUpKind;
  posted_at: string;
  posted_text: string;
  status: "sent";
}

/**
 * Canonical day-elapsed calculation - previously copy-pasted with slightly
 * different null handling in jiraClient.ts, slaFollowup.ts,
 * mlEscalationModel.ts, and issueRow.ts.
 */
export function daysSince(dateStr: string | undefined): number {
  if (!dateStr) {
    return 0;
  }
  const parsed = Date.parse(dateStr);
  return Number.isNaN(parsed) ? 0 : (Date.now() - parsed) / 86_400_000;
}

/** The single most recent audit entry of any of `kinds`, or undefined if none exist. */
export function mostRecentEntryOfKind(
  entries: FollowUpAuditEntry[],
  kinds: FollowUpKind[],
): FollowUpAuditEntry | undefined {
  return [...entries]
    .filter((entry) => kinds.includes(entry.kind))
    .sort((a, b) => b.posted_at.localeCompare(a.posted_at))[0];
}

/** Count of prior audit entries of `kind` - used to compute a follow-up's ordinal (1st, 2nd, 3rd...). */
export function countEntriesOfKind(entries: FollowUpAuditEntry[], kind: FollowUpKind): number {
  return entries.filter((entry) => entry.kind === kind).length;
}

export function followUpCooldownKey(issueKey: string): string {
  return `followup:last_sent:${issueKey}`;
}

export function followUpAuditLogKey(issueKey: string): string {
  return `followup:log:${issueKey}`;
}

/**
 * Call right after zadd-ing a new entry into a ticket's audit log - trims it
 * to the most recent AUDIT_LOG_MAX_ENTRIES (oldest-first ranks removed) and
 * refreshes its TTL so an actively-followed-up ticket's log survives, but a
 * ticket nobody's touched in AUDIT_LOG_TTL_SECONDS eventually ages out
 * rather than sitting in Redis forever. Best-effort: a failure here doesn't
 * roll back the write that already succeeded, just logs a warning.
 */
export async function trimAndExpireAuditLog(redis: Redis, issueKey: string): Promise<void> {
  const key = followUpAuditLogKey(issueKey);

  try {
    await redis.zremrangebyrank(key, 0, -(AUDIT_LOG_MAX_ENTRIES + 1));
    await redis.expire(key, AUDIT_LOG_TTL_SECONDS);
  } catch (error) {
    console.warn(`Failed to trim/expire the follow-up audit log for ${issueKey}.`, error);
  }
}

export async function getFollowUpAuditEntries(issueKey: string): Promise<FollowUpAuditEntry[]> {
  if (!isRedisConfigured()) {
    return [];
  }

  try {
    const raw = await getRedis().zrange<string[]>(followUpAuditLogKey(issueKey), 0, -1);

    return raw
      .map((entry) => {
        try {
          return JSON.parse(entry) as FollowUpAuditEntry;
        } catch {
          return null;
        }
      })
      .filter((entry): entry is FollowUpAuditEntry => entry !== null);
  } catch (error) {
    console.warn(`Failed to read follow-up audit log for ${issueKey}.`, error);
    return [];
  }
}
