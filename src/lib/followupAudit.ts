import { getRedis, isRedisConfigured } from "@/lib/redis";

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
