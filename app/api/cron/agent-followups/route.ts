import { NextResponse } from "next/server";

import {
  setCachedCpCandidates,
  setCachedDraft,
  setCachedTsCandidates,
} from "@/lib/agentFollowupCache";
import { draftCpEscalationMessage, getCpEscalationCandidates } from "@/lib/cpEscalation";
import { getTicketCommentContext, mapWithConcurrency } from "@/lib/jiraClient";
import { draftProductWaitMessage, getProductWaitCandidates } from "@/lib/productWaitFollowup";
import { postSlackMessage } from "@/lib/slackApi";

export const maxDuration = 300;

/* A background batch job should fail fast to a template rather than chase a
   polished draft for minutes - this is deliberately much tighter than the
   interactive click path's retry/backoff budget (which can legitimately run
   to 45s x several retries x multiple models). */
const PER_ITEM_DEADLINE_MS = 25_000;
/* maxDuration minus a buffer for up to `concurrency` already-in-flight
   drafts to finish their own PER_ITEM_DEADLINE_MS after this is hit, plus
   the final Slack post and response - see the worked-through math in the
   design review this route came from. */
const SOFT_TIME_BUDGET_MS = 180_000;
const DRAFT_CONCURRENCY = 4;

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    promise,
    new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), ms);
    }),
  ]);
}

export async function GET(request: Request): Promise<NextResponse> {
  const authHeader = request.headers.get("authorization");

  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  const timeBudgetExceeded = (): boolean => Date.now() - startedAt > SOFT_TIME_BUDGET_MS;

  // Phase 1: fast scans, no LLM calls - always completes.
  const [cpCandidates, tsCandidates] = await Promise.all([
    getCpEscalationCandidates(),
    getProductWaitCandidates(),
  ]);

  await Promise.all([setCachedCpCandidates(cpCandidates), setCachedTsCandidates(tsCandidates)]);

  // Phase 2: bounded, incremental draft generation - CP first since it's a
  // small set (confirmed ~4 candidates in practice) and always finishes
  // quickly, leaving the rest of the time budget for the TS side, which can
  // be much larger (especially on the very first run, before any
  // "product_wait" audit history exists to space cadence out naturally).
  let draftedCp = 0;
  let draftedTs = 0;

  await mapWithConcurrency(cpCandidates, DRAFT_CONCURRENCY, async (candidate) => {
    if (timeBudgetExceeded()) {
      return;
    }

    const comments = await getTicketCommentContext(candidate.cp.key);
    const result = await withDeadline(draftCpEscalationMessage(candidate, comments), PER_ITEM_DEADLINE_MS);

    if (result) {
      await setCachedDraft(candidate.cp.key, "cp_escalation", {
        generatedAt: new Date().toISOString(),
        mentionAccountId: candidate.mentionTarget.people.map((person) => person.accountId),
        text: result.text,
        toolCallCount: result.toolCallCount,
      });
      draftedCp += 1;
    }
  });

  await mapWithConcurrency(tsCandidates, DRAFT_CONCURRENCY, async (candidate) => {
    if (timeBudgetExceeded()) {
      return;
    }

    const comments = await getTicketCommentContext(candidate.issue.key);
    const result = await withDeadline(draftProductWaitMessage(candidate, comments), PER_ITEM_DEADLINE_MS);

    if (result) {
      await setCachedDraft(candidate.issue.key, "product_wait", {
        generatedAt: new Date().toISOString(),
        text: result.text,
        toolCallCount: result.toolCallCount,
      });
      draftedTs += 1;
    }
  });

  const timeBudgetHit = timeBudgetExceeded();
  const summaryLines = [
    `*Agent Follow-Ups* — ${draftedCp}/${cpCandidates.length} CP escalations and ${draftedTs}/${tsCandidates.length} TS product-wait follow-ups drafted and ready for review.`,
    timeBudgetHit
      ? "This run hit its time budget before finishing everything - the rest will be picked up on the next run."
      : undefined,
  ].filter((line): line is string => Boolean(line));

  const channel = process.env.SLACK_AGENT_FOLLOWUP_CHANNEL;

  if (channel) {
    await postSlackMessage(channel, summaryLines.join("\n"));
  }

  return NextResponse.json({
    cpCandidates: cpCandidates.length,
    cpDrafted: draftedCp,
    timeBudgetHit,
    tsCandidates: tsCandidates.length,
    tsDrafted: draftedTs,
  });
}
