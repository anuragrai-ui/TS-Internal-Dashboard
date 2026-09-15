import { NextResponse } from "next/server";

import { getCachedDraft } from "@/lib/agentFollowupCache";
import { draftCpEscalationMessage, getCpEscalationCandidates } from "@/lib/cpEscalation";
import { getIssueByKey, getTicketCommentContext } from "@/lib/jiraClient";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ key: string }> },
): Promise<NextResponse> {
  const { key } = await params;

  const cached = await getCachedDraft(key, "cp_escalation");

  if (cached) {
    // A cached draft can be within its TTL and still describe a world
    // that's changed (the CP got assigned or resolved since the cron ran) -
    // one cheap re-check before trusting it.
    const cp = await getIssueByKey(key);

    if (cp && cp.status_category !== "done") {
      return NextResponse.json({
        cached: true,
        draftText: cached.text,
        mentionAccountId: cached.mentionAccountId,
        toolCallCount: cached.toolCallCount,
      });
    }
  }

  // Re-run the scan rather than reconstructing partial state from just the
  // key - guarantees the exact same eligibility/mention-target logic the
  // list view used, with no risk of drift between two implementations of
  // the same decision.
  const candidates = await getCpEscalationCandidates();
  const candidate = candidates.find((item) => item.cp.key === key);

  if (!candidate) {
    return NextResponse.json(
      { error: `${key} no longer qualifies as a CP escalation candidate.` },
      { status: 409 },
    );
  }

  const comments = await getTicketCommentContext(key);
  const result = await draftCpEscalationMessage(candidate, comments);

  return NextResponse.json({
    draftText: result.text,
    mentionAccountId: candidate.mentionTarget.accountId,
    mentionDisplayName: candidate.mentionTarget.displayName,
    mentionSource: candidate.mentionTarget.source,
    toolCallCount: result.toolCallCount,
  });
}
