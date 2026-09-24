import { NextResponse } from "next/server";
import { after } from "next/server";

import { enqueueOcrForIssues } from "@/lib/attachmentOcr";
import { canMentionReporter, draftSlaFollowUpMessage } from "@/lib/followupDraft";
import { getIssueByKey, getTicketCommentContext } from "@/lib/jiraClient";
import type { SlaFollowUpCandidate, SlaFollowUpStage } from "@/lib/slaFollowup";
import { hasOpenLinkedCp } from "@/lib/linkedCp";
import { isCpNotWorkedOn } from "@/lib/slaFollowup";

interface DraftSlaFollowUpRequestBody {
  stage?: unknown;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ key: string }> },
): Promise<NextResponse> {
  const { key } = await params;

  let body: DraftSlaFollowUpRequestBody;

  try {
    body = (await request.json()) as DraftSlaFollowUpRequestBody;
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  const requestedStage: SlaFollowUpStage = body.stage === 3 ? 3 : body.stage === 2 ? 2 : 1;
  const issue = await getIssueByKey(key);

  if (!issue) {
    return NextResponse.json({ error: `Ticket ${key} not found.` }, { status: 404 });
  }

  // Never draft a "we're closing this" message while a linked CP is open
  // (see src/lib/linkedCp.ts) - even if a stale page asked for stage 2/3.
  const cpOpen = hasOpenLinkedCp(issue);
  const stage: SlaFollowUpStage = cpOpen ? 1 : requestedStage;

  after(() =>
    enqueueOcrForIssues([issue]).catch((error) => {
      console.error(`Failed to enqueue attachment OCR for ${key}:`, error);
    }),
  );

  const cpNotWorked = await isCpNotWorkedOn(issue);
  const candidate: SlaFollowUpCandidate = {
    daysSinceLastActivity: 0,
    isResolved: issue.linked_cp_issue?.isDone ?? false,
    issue,
    missedSla: false,
    reason: cpNotWorked ? "cp_not_worked" : cpOpen ? "cp_in_progress" : "no_reporter_response",
    stage,
  };

  const comments = await getTicketCommentContext(key);
  const { text: draftText, toolCallCount } = await draftSlaFollowUpMessage(candidate, comments);

  return NextResponse.json({
    draftText,
    mentionAccountId: canMentionReporter(issue) ? issue.reporter_account_id : undefined,
    toolCallCount,
  });
}
