import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import type { FollowUpAuditEntry, FollowUpKind } from "@/lib/followupAudit";
import { followUpAuditLogKey, followUpCooldownKey, trimAndExpireAuditLog } from "@/lib/followupAudit";
import { addFollowUpComment, getIssueByKey, JiraRequestError, transitionIssueToDone } from "@/lib/jiraClient";
import type { JiraCredentials } from "@/lib/jiraClient";
import { appendFollowUpLogRow } from "@/lib/googleSheetsWriter";
import { checkExternalMessageSafety } from "@/lib/messageSafety";
import { getRedis, isRedisConfigured } from "@/lib/redis";
import { getJiraCredentialsForAccount } from "@/lib/userJiraTokens";

interface SendFollowUpRequestBody {
  kind?: unknown;
  mentionAccountId?: unknown;
  text?: unknown;
}

/* Every FollowUpKind value must be listed here - an unrecognized kind
   silently coerces to "manual" below (see the check() call), which would
   corrupt cadence/re-tag tracking for any feature keying off entry.kind.
   scripts/test-agent-followups.ts asserts these two arrays stay in sync
   with the FollowUpKind type so this can't drift silently again. */
export const VALID_KINDS: FollowUpKind[] = [
  "closure_candidate",
  "cp_escalation",
  "manual",
  "product_wait",
  "sla_stage_1",
  "sla_stage_2",
  "sla_stage_3",
];
const CLOSING_KINDS: FollowUpKind[] = ["closure_candidate", "sla_stage_2", "sla_stage_3"];

function parseCooldownHours(value: string | undefined): number {
  if (!value) {
    return 24;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 24;
}

/* A mentionAccountId sourced from an old comment (see
   getLatestCommentMentions in jiraClient.ts) can reference a deactivated/
   removed account, which Jira rejects - without this retry, one stale
   accountId would silently kill the whole comment post rather than just
   posting without a mention. */
async function postCommentRetryingWithoutMention(
  key: string,
  text: string,
  mentionAccountId: string | undefined,
  credentials: JiraCredentials | undefined,
): Promise<{ comment: Awaited<ReturnType<typeof addFollowUpComment>>; mentionFailed: boolean }> {
  try {
    const comment = await addFollowUpComment(key, text, mentionAccountId, credentials);
    return { comment, mentionFailed: false };
  } catch (error) {
    if (!mentionAccountId) {
      throw error;
    }
    console.warn(`Comment post with mention failed for ${key}; retrying without the mention.`, error);
    const comment = await addFollowUpComment(key, text, undefined, credentials);
    return { comment, mentionFailed: true };
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ key: string }> },
): Promise<NextResponse> {
  const { key } = await params;

  let body: SendFollowUpRequestBody;

  try {
    body = (await request.json()) as SendFollowUpRequestBody;
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  const text = body.text;

  if (typeof text !== "string" || text.trim().length === 0) {
    return NextResponse.json(
      { error: "A non-empty \"text\" field is required." },
      { status: 400 },
    );
  }

  const kind: FollowUpKind = VALID_KINDS.includes(body.kind as FollowUpKind)
    ? (body.kind as FollowUpKind)
    : "manual";
  const mentionAccountId =
    typeof body.mentionAccountId === "string" && body.mentionAccountId ? body.mentionAccountId : undefined;

  // The one non-bypassable safety gate: re-fetch the issue and re-derive
  // reporter_is_external server-side (never trust the client), since the
  // textarea is human-editable and drafts may be hours-old from a cron run -
  // neither can be trusted to have respected the safety rules by the time
  // Send is actually clicked.
  const issue = await getIssueByKey(key);

  if (!issue) {
    return NextResponse.json({ error: `Ticket ${key} not found.` }, { status: 404 });
  }

  if (issue.reporter_is_external) {
    const safety = checkExternalMessageSafety(text, key);

    if (!safety.safe) {
      console.warn(`Blocked an external-facing send for ${key}: ${safety.violations.join("; ")}`);
      return NextResponse.json(
        {
          error:
            "This message references internal ticket details that can't be sent to an external client - please edit and remove them before sending.",
          violations: safety.violations,
        },
        { status: 422 },
      );
    }
  }

  // Stage 3 only exists because an earlier closing attempt (stage 2 or a
  // closure-candidate draft) already ran and set this same cooldown key
  // without actually closing the ticket - exempting it is what makes the
  // retry button usable instead of blocked for up to FOLLOWUP_COOLDOWN_HOURS.
  const cooldownExempt = kind === "sla_stage_3";

  if (isRedisConfigured() && !cooldownExempt) {
    try {
      const existingCooldown = await getRedis().get(followUpCooldownKey(key));

      if (existingCooldown) {
        return NextResponse.json(
          { cooldownActive: true, error: `A follow-up was already sent recently for ${key}.` },
          { status: 429 },
        );
      }
    } catch (error) {
      console.warn(`Follow-up cooldown check failed for ${key}; proceeding without it.`, error);
    }
  }

  // Post under the ticket's assignee's own Jira identity if they've
  // registered a personal token (see src/lib/userJiraTokens.ts) - falls back
  // to the shared service account exactly as before if they haven't, or if
  // their stored token turns out to be expired/revoked (401/403). Whichever
  // credentials actually succeed also close the ticket below, so the same
  // identity that posted the comment is the one that transitions it.
  const personalCredentials = await getJiraCredentialsForAccount(issue.assignee_account_id);
  let effectiveCredentials = personalCredentials ?? undefined;
  let usedFallbackAccount = false;

  try {
    let comment: Awaited<ReturnType<typeof addFollowUpComment>>;
    let mentionFailed = false;

    try {
      ({ comment, mentionFailed } = await postCommentRetryingWithoutMention(
        key,
        text,
        mentionAccountId,
        effectiveCredentials,
      ));
    } catch (error) {
      if (!personalCredentials || !(error instanceof JiraRequestError) || (error.status !== 401 && error.status !== 403)) {
        throw error;
      }
      console.warn(
        `${issue.assignee}'s personal Jira token was rejected (status ${error.status}) for ${key}; falling back to the shared service account.`,
      );
      usedFallbackAccount = true;
      effectiveCredentials = undefined;
      ({ comment, mentionFailed } = await postCommentRetryingWithoutMention(key, text, mentionAccountId, undefined));
    }

    const postedAt = new Date().toISOString();

    if (isRedisConfigured()) {
      try {
        const redis = getRedis();
        const auditEntry: FollowUpAuditEntry = {
          id: randomUUID(),
          jira_comment_id: comment.id,
          kind,
          posted_at: postedAt,
          posted_text: text,
          status: "sent",
        };

        await redis.zadd(followUpAuditLogKey(key), {
          member: JSON.stringify(auditEntry),
          score: Date.now(),
        });
        await trimAndExpireAuditLog(redis, key);
        await redis.set(followUpCooldownKey(key), postedAt, {
          ex: parseCooldownHours(process.env.FOLLOWUP_COOLDOWN_HOURS) * 3600,
        });
      } catch (error) {
        console.warn(`Follow-up audit log write failed for ${key}; comment was posted successfully.`, error);
      }
    }

    // Durable record independent of Redis (which is capped/TTL'd for memory
    // reasons - see followupAudit.ts). Awaited, not fire-and-forget - a
    // serverless function's background promises aren't guaranteed to finish
    // once the response is sent, which would silently defeat the point of a
    // durable log. appendFollowUpLogRow never throws (returns false on any
    // failure), so this can't fail or block the response either way.
    await appendFollowUpLogRow({
      issueKey: key,
      jiraCommentId: comment.id,
      kind,
      postedAt,
      postedText: text,
      status: "sent",
    });

    // Every "closing" kind (the SLA stage-2 final-notice, a stage-3 retry
    // after a previous close attempt didn't take, or a closure-candidate
    // resolved-elsewhere draft) posts its comment and attempts the Jira
    // transition as one human-confirmed action, not two. If the transition
    // fails, the comment has already posted successfully, so this is
    // reported back rather than treated as an overall request failure - the
    // human still needs to know either way, and an unresolved case like this
    // resurfaces for a retry (see CLOSE_ATTEMPT_KINDS in slaFollowup.ts).
    if (CLOSING_KINDS.includes(kind)) {
      const transitionResult = await transitionIssueToDone(key, effectiveCredentials);

      return NextResponse.json({
        commentId: comment.id,
        mentionFailed,
        postedAt,
        transitionedToDone: transitionResult.transitioned,
        transitionError: transitionResult.transitioned ? undefined : transitionResult.reason,
        usedFallbackAccount,
      });
    }

    return NextResponse.json({ commentId: comment.id, mentionFailed, postedAt, usedFallbackAccount });
  } catch (error) {
    console.error(`Failed to post follow-up comment for ${key}:`, error);
    return NextResponse.json(
      { error: `Failed to post follow-up comment to ${key}.` },
      { status: 502 },
    );
  }
}
