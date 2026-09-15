import { NextResponse } from "next/server";
import { after } from "next/server";

import { enqueueOcrForIssues } from "@/lib/attachmentOcr";
import { draftFollowUpMessage } from "@/lib/followupDraft";
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

  const comments = await getTicketCommentContext(key);
  const { text: draftText, toolCallCount } = await draftFollowUpMessage(issue, comments);

  return NextResponse.json({ draftText, toolCallCount });
}
