import { NextResponse } from "next/server";
import { after } from "next/server";

import { getClosureCandidateForIssue } from "@/lib/closureCandidates";
import { canMentionReporter, draftClosureMessage } from "@/lib/followupDraft";
import { enqueueOcrForIssues } from "@/lib/attachmentOcr";
import { getIssueByKey, getTicketCommentContext } from "@/lib/jiraClient";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ key: string }> },
): Promise<NextResponse> {
  const { key } = await params;
  const issue = await getIssueByKey(key);

  if (!issue) {
    return NextResponse.json({ error: `Ticket ${key} not found.` }, { status: 404 });
  }

  after(() =>
    enqueueOcrForIssues([issue]).catch((error) => {
      console.error(`Failed to enqueue attachment OCR for ${key}:`, error);
    }),
  );

  const candidate = await getClosureCandidateForIssue(issue);

  if (!candidate) {
    return NextResponse.json(
      { error: `${key} no longer qualifies as a closure candidate.` },
      { status: 409 },
    );
  }

  const comments = await getTicketCommentContext(key);
  const { text: draftText, toolCallCount } = await draftClosureMessage(candidate, comments);

  return NextResponse.json({
    draftText,
    mentionAccountId: canMentionReporter(issue) ? issue.reporter_account_id : undefined,
    toolCallCount,
  });
}
