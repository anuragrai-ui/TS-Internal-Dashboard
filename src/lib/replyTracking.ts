import { daysSince } from "@/lib/followupAudit";
import { getIssueCommentAuthorship } from "@/lib/jiraClient";
import type { CommentAuthorship, FormattedIssue } from "@/lib/jiraClient";

/**
 * Who's waiting on whom on a ticket, read straight from its Jira comment
 * history. The Redis follow-up audit log only knows about follow-ups sent
 * through this dashboard, so anything posted directly in Jira (or before the
 * log existed, or after a Redis clean) was invisible to it - the "Follow-Up #"
 * column sat at 1 forever. The comments themselves are the ground truth.
 */
export interface ReplyTracking {
  /* null when there's no such comment at all */
  daysSinceLastFollowUp: number | null;
  daysSinceReporterReply: number | null;
  lastFollowUpAt?: string;
  lastReporterReplyAt?: string;
  /* Follow-up rounds (see FOLLOW_UP_ROUND_HOURS) from us since the reporter
     last commented, or since the ticket opened if they never have - "we've
     asked N times and heard nothing back." */
  unansweredFollowUps: number;
}

/* Only a real licensed teammate counts as "us" - "app" accounts (Jira
   automation, integrations) post status noise, not follow-ups, and
   "customer" accounts are portal users on the client side. */
function isTeamComment(comment: CommentAuthorship, reporterAccountId: string | undefined): boolean {
  return comment.authorAccountType === "atlassian" && comment.authorAccountId !== reporterAccountId;
}

/* Several comments in a burst (a message, a quick correction, a teammate
   chiming in the same afternoon) are one follow-up from the reporter's point
   of view, not four - only a comment more than this long after the start of
   the previous round starts a new one. */
const FOLLOW_UP_ROUND_HOURS = 24;

/** Pure half of getReplyTracking() - takes comments oldest-first, so it can be unit-tested with fixtures. */
export function computeReplyTracking(
  comments: CommentAuthorship[],
  reporterAccountId: string | undefined,
): ReplyTracking {
  let lastReporterIndex = -1;
  if (reporterAccountId) {
    for (let i = comments.length - 1; i >= 0; i -= 1) {
      if (comments[i]!.authorAccountId === reporterAccountId) {
        lastReporterIndex = i;
        break;
      }
    }
  }

  const teamComments = comments.filter((comment) => isTeamComment(comment, reporterAccountId));
  const lastFollowUpAt = teamComments.at(-1)?.created;

  let unansweredFollowUps = 0;
  let roundStartMs = Number.NEGATIVE_INFINITY;
  for (const comment of comments.slice(lastReporterIndex + 1)) {
    const createdMs = Date.parse(comment.created);
    if (!isTeamComment(comment, reporterAccountId) || Number.isNaN(createdMs)) {
      continue;
    }
    if (createdMs - roundStartMs > FOLLOW_UP_ROUND_HOURS * 3_600_000) {
      unansweredFollowUps += 1;
      roundStartMs = createdMs;
    }
  }

  const lastReporterReplyAt = lastReporterIndex >= 0 ? comments[lastReporterIndex]!.created : undefined;

  return {
    daysSinceLastFollowUp: lastFollowUpAt ? daysSince(lastFollowUpAt) : null,
    daysSinceReporterReply: lastReporterReplyAt ? daysSince(lastReporterReplyAt) : null,
    lastFollowUpAt,
    lastReporterReplyAt,
    unansweredFollowUps,
  };
}

/** One Jira comment fetch per ticket. Returns null (never throws) if Jira can't be reached, so callers fall back to the audit log instead of dropping the ticket. */
export async function getReplyTracking(issue: FormattedIssue): Promise<ReplyTracking | null> {
  try {
    const comments = await getIssueCommentAuthorship(issue.key);
    return computeReplyTracking(comments, issue.reporter_account_id);
  } catch (error) {
    console.warn(`Failed to read comment history for ${issue.key}; falling back to the follow-up audit log.`, error);
    return null;
  }
}
