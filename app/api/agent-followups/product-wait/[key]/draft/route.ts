import { NextResponse } from "next/server";
import { after } from "next/server";

import { getCachedDraft } from "@/lib/agentFollowupCache";
import { enqueueOcrForIssues } from "@/lib/attachmentOcr";
import { canMentionReporter } from "@/lib/followupDraft";
import { getTicketCommentContext } from "@/lib/jiraClient";
import { draftProductWaitMessage, getProductWaitCandidates } from "@/lib/productWaitFollowup";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ key: string }> },
): Promise<NextResponse> {
  const { key } = await params;

  const candidates = await getProductWaitCandidates();
  const candidate = candidates.find((item) => item.issue.key === key);

  if (!candidate) {
    return NextResponse.json(
      { error: `${key} no longer qualifies as a "Waiting for Product" follow-up candidate.` },
      { status: 409 },
    );
  }

  const { issue } = candidate;

  after(() =>
    enqueueOcrForIssues([issue]).catch((error) => {
      console.error(`Failed to enqueue attachment OCR for ${key}:`, error);
    }),
  );

  const cached = await getCachedDraft(key, "product_wait");

  if (cached) {
    return NextResponse.json({
      cached: true,
      draftText: cached.text,
      mentionAccountId: canMentionReporter(issue) ? issue.reporter_account_id : undefined,
      toolCallCount: cached.toolCallCount,
    });
  }

  const comments = await getTicketCommentContext(key);
  const result = await draftProductWaitMessage(candidate, comments);

  return NextResponse.json({
    draftText: result.text,
    mentionAccountId: canMentionReporter(issue) ? issue.reporter_account_id : undefined,
    toolCallCount: result.toolCallCount,
  });
}
