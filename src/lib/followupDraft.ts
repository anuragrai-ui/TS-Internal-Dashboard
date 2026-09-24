import { getCachedOcrTextForIssue } from "@/lib/attachmentOcr";
import { getFollowUpTools } from "@/lib/agentTools";
import type { ClosureCandidate } from "@/lib/closureCandidates";
import { MENTION_PLACEHOLDER } from "@/lib/jiraClient";
import type { FormattedIssue, TicketCommentContext } from "@/lib/jiraClient";
import { checkExternalMessageSafety } from "@/lib/messageSafety";
import {
  callChatCompletionChain,
  callChatCompletionWithTools,
  getChainMaxRetries,
  getChainTimeoutMs,
  getDraftApiKey,
  getDraftModelChain,
  getDraftProvider,
  isEscalationEnabled,
} from "@/lib/llmClient";
import type { SlaFollowUpCandidate } from "@/lib/slaFollowup";
import { HUMAN_VARIETY_INSTRUCTION, pickVariant } from "@/lib/textVariety";

export interface DraftResult {
  text: string;
  toolCallCount: number;
}

export const TOOL_USE_INSTRUCTION =
  "You have optional read-only tools available (search_jira_issues, get_jira_issue, search_confluence). Only use them if they would genuinely improve this draft - e.g. checking a related ticket's current status or a relevant runbook. Do not search out of habit; a clear-cut ticket needs no lookup at all.";

/* Reasoning models spend part of the token budget on hidden chain-of-thought
   before the actual message - measured 700-1800 reasoning tokens for a draft
   this size on some providers, so a tight budget can starve the visible
   content to empty even though the call itself succeeded. 0.7 (up from the
   old 0.1 default) trades a little determinism for real lexical variety;
   checkExternalMessageSafety is the deterministic backstop regardless of
   temperature, so this doesn't add leak risk. */
const DRAFT_TEMPERATURE = 0.7;

function buildFollowUpSystemPrompt(external: boolean): string {
  return `You are a support engineer drafting a short, warm follow-up comment to post directly on a Jira ticket. Write only the comment text itself - no subject line, no markdown, no surrounding quotes.

Use the ticket's status (given in the ticket details below) to address the right team (e.g. a ticket "Waiting for Product" should be addressed to the product team, "Waiting for Client" to the client, "Waiting for Operations" to operations). If the ticket details include a pending_reason, reference it directly so the recipient understands what is being asked of them. attachment_text (when present) is OCR'd text from the ticket's attachments - use it as context if relevant. Ask for a status update or an ETA the way you'd check in with someone whose time you respect - genuinely curious how it's going, not chasing them. Keep it to 2-4 sentences.

${HUMAN_VARIETY_INSTRUCTION}${external ? "" : `\n\n${TOOL_USE_INSTRUCTION}`}`;
}

function buildFollowUpUserPrompt(
  issue: FormattedIssue,
  comments: TicketCommentContext[],
  ocrText: string,
): string {
  /* Comments are internal color (support-agent notes, other tickets/people
     mentioned in passing) with no visibility filtering applied when fetched
     - never pass them to a draft an external reporter will see. */
  const ticketContext = {
    attachment_text: ocrText || undefined,
    comments: issue.reporter_is_external ? undefined : comments,
    key: issue.key,
    pending_reason: issue.pending_reason,
    priority: issue.priority,
    reporter: issue.reporter,
    status: issue.status,
    summary: issue.summary,
  };

  return `Ticket details:\n${JSON.stringify(ticketContext, null, 2)}`;
}

function buildFallbackMessages(issue: FormattedIssue): string[] {
  const summaryClause = issue.summary ? ` regarding "${issue.summary}"` : "";
  const reasonClause = issue.pending_reason ? ` This has been pending on: ${issue.pending_reason}.` : "";

  return [
    `Hi team, hope you're doing well - following up on ${issue.key}${summaryClause}.${reasonClause} Whenever you get a chance, could you share a status update or an ETA? Thank you!`,
    `Checking in on ${issue.key}${summaryClause} - no rush, just wanted to see where this stands.${reasonClause} An ETA would help us plan around it. Thanks so much!`,
    `Circling back on ${issue.key}${summaryClause}.${reasonClause} Would really appreciate a quick status update or ETA whenever it's convenient for you.`,
  ];
}

export interface DraftViaChainOptions {
  /* False for any external-facing draft: there is no legitimate reason a
     plain-English client update needs live JQL search or Confluence access,
     and removing the capability removes that leak class structurally
     instead of relying on the model to decline using it unsafely. */
  allowTools?: boolean;
  /* When set, every candidate draft is checked with checkExternalMessageSafety
     before being accepted - a violation is treated exactly like an empty/
     failed model response (never returned, never silently edited) and this
     function falls through to the hardcoded `fallback` instead. */
  safetyCheck?: { ownIssueKey: string };
  /* The stable instruction preamble for this draft's "kind" (audience +
     intent combination) - sent as Anthropic's cached system prompt so the
     many similar drafts one cron batch generates (many CP escalations, many
     external product-wait follow-ups) reuse the cached prefix instead of
     paying full input price each time. Callers must keep this free of
     per-ticket interpolation (names, keys, free-text explanations) - put
     that in `userPrompt` instead - or cache reuse silently stops working. */
  systemPrompt?: string;
}

export async function draftViaChain(
  userPrompt: string,
  issueKey: string,
  fallback: string,
  options: DraftViaChainOptions = {},
): Promise<DraftResult> {
  const { allowTools = true, safetyCheck, systemPrompt } = options;

  if (!isEscalationEnabled() || !getDraftApiKey()) {
    return { text: fallback, toolCallCount: 0 };
  }

  const passesSafety = (text: string): boolean =>
    !safetyCheck || checkExternalMessageSafety(text, safetyCheck.ownIssueKey).safe;

  try {
    const provider = getDraftProvider();

    /* Both OpenRouter's configured model and Claude have verified
       tool-calling support - NVIDIA's chain mixes several different open
       models with unknown/inconsistent tool support and its fast/no-retry
       settings don't fit a multi-round loop, and Mistral's tool support
       isn't verified either. Falls through to the plain chain below
       (unchanged) for any other provider, or if tool-calling itself
       produces nothing usable. */
    const [primaryModel] = getDraftModelChain();

    if (allowTools && (provider === "openrouter" || provider === "anthropic") && primaryModel) {
      const result = await callChatCompletionWithTools(userPrompt, {
        maxRounds: 3,
        maxTokens: 4096,
        model: primaryModel,
        provider,
        systemPrompt,
        temperature: DRAFT_TEMPERATURE,
        tools: getFollowUpTools(),
      });

      if (result.text?.trim()) {
        if (passesSafety(result.text.trim())) {
          return { text: result.text.trim(), toolCallCount: result.toolCallCount };
        }
        console.warn(`Follow-up draft for ${issueKey} failed the external-safety check (tool-calling path); falling through.`);
      }
    }

    const isFastChain = provider === "nvidia";

    const text = await callChatCompletionChain(userPrompt, {
      maxTokens: 4096,
      models: getDraftModelChain(),
      perModelMaxRetries: isFastChain ? getChainMaxRetries() : undefined,
      perModelTimeoutMs: isFastChain ? getChainTimeoutMs() : undefined,
      provider,
      systemPrompt,
      temperature: DRAFT_TEMPERATURE,
    });

    if (text?.trim()) {
      if (passesSafety(text.trim())) {
        return { text: text.trim(), toolCallCount: 0 };
      }
      console.warn(`Follow-up draft for ${issueKey} failed the external-safety check (plain chain path); using template fallback.`);
    }

    return { text: fallback, toolCallCount: 0 };
  } catch (error) {
    console.warn(`Follow-up draft generation failed for ${issueKey}; using template fallback.`, error);
    return { text: fallback, toolCallCount: 0 };
  }
}

export async function draftFollowUpMessage(
  issue: FormattedIssue,
  comments: TicketCommentContext[],
): Promise<DraftResult> {
  const ocrText = await getCachedOcrTextForIssue(issue);
  return draftViaChain(
    buildFollowUpUserPrompt(issue, comments, ocrText),
    issue.key,
    pickVariant(issue.key, buildFallbackMessages(issue)),
    {
      allowTools: !issue.reporter_is_external,
      safetyCheck: issue.reporter_is_external ? { ownIssueKey: issue.key } : undefined,
      systemPrompt: buildFollowUpSystemPrompt(issue.reporter_is_external),
    },
  );
}

/* Mentioning requires a real Jira accountId (see MENTION_PLACEHOLDER in
   jiraClient.ts) - if an internal reporter is somehow missing one, address
   them by name like an external reporter rather than leaving a literal,
   un-substituted placeholder in the posted comment. */
export function canMentionReporter(issue: FormattedIssue): boolean {
  return !issue.reporter_is_external && Boolean(issue.reporter_account_id);
}

/* Both branches are fully static text (no per-ticket interpolation) on
   purpose - MENTION_PLACEHOLDER is a fixed constant, and the reporter's
   actual name flows through the `reporter` field in the user-prompt ticket
   JSON instead of being embedded here. That keeps this string identical
   across every ticket that lands in the same branch, which is what lets it
   be reused as part of a cached system prompt (see DraftViaChainOptions.systemPrompt). */
export function addressingInstruction(issue: FormattedIssue): string {
  return canMentionReporter(issue)
    ? `The reporter is an internal teammate, not a client. Open with the literal placeholder text ${MENTION_PLACEHOLDER} exactly as written (it becomes a real Jira @-mention when posted) in place of their name, then continue the sentence normally.`
    : `Address the reporter by their name, given as "reporter" in the ticket details below.`;
}

export function addressingFallback(issue: FormattedIssue): string {
  return canMentionReporter(issue) ? MENTION_PLACEHOLDER : issue.reporter;
}

function slaIntent(candidate: SlaFollowUpCandidate): string {
  const { isResolved, reason, stage } = candidate;

  if (stage === 3) {
    return isResolved
      ? "This ticket already had two follow-ups sent with no response, and the underlying issue has since been resolved. Write a brief, kind closing message: let them know it's resolved, genuinely thank them for their patience, and mention they're welcome to reopen or reply if they still have concerns. This ticket is being closed now."
      : "This ticket already had two follow-ups sent with no response. Write a brief, gentle closing message: explain we're closing it now since we haven't heard back, with no hint of blame or impatience, and warmly invite them to reopen or reply any time if they still need help. This ticket is being closed now.";
  }

  if (stage === 1) {
    return reason === "cp_not_worked" || reason === "cp_in_progress"
      ? "This is a polite check-in. The underlying issue is still being worked on internally (tracked via a linked ticket) - let them know it's still in progress and you'll follow up again, without promising a specific date. Reassure, don't just report status."
      : "This is a polite first check-in. We're waiting to hear back from them - ask whether they still need help or still have the issue, and remind them what information (if any) we're waiting on, in a way that makes it easy and low-pressure for them to reply.";
  }

  return isResolved
    ? "This is a closing message: the underlying issue has since been resolved (via a linked internal ticket or directly by us). Let them know it's fixed, genuinely thank them for their patience, and mention they're welcome to reopen or reply if they still have concerns. This ticket is being closed right after this message."
    : "This is a final notice: an earlier follow-up on this same ticket went unanswered. Explain gently that since we haven't heard back, we're closing this ticket for now - no hint of blame or impatience - and warmly invite them to reopen or reply any time if they still need help. This ticket is being closed right after this message.";
}

function buildSlaSystemPrompt(candidate: SlaFollowUpCandidate): string {
  const { issue } = candidate;
  const external = issue.reporter_is_external;

  return `You are a support engineer drafting a short, warm Jira comment. Write only the comment text itself - no subject line, no markdown, no surrounding quotes.

${addressingInstruction(issue)}

${slaIntent(candidate)}

If the ticket details include attachment_text, it's OCR'd text from the ticket's attachments - use it as context if relevant. Keep it to 2-4 sentences.

${HUMAN_VARIETY_INSTRUCTION}${external ? "" : `\n\n${TOOL_USE_INSTRUCTION}`}`;
}

function buildSlaUserPrompt(
  candidate: SlaFollowUpCandidate,
  comments: TicketCommentContext[],
  ocrText: string,
): string {
  const { issue } = candidate;

  /* Comments are internal color with no visibility filtering applied when
     fetched, and linked_cp_status is raw Jira status vocabulary - neither
     should reach a draft an external reporter will see. */
  const ticketContext = {
    attachment_text: ocrText || undefined,
    comments: issue.reporter_is_external ? undefined : comments,
    key: issue.key,
    linked_cp_status: issue.reporter_is_external ? undefined : issue.linked_cp_issue?.status,
    pending_reason: issue.pending_reason,
    priority: issue.priority,
    reporter: issue.reporter,
    status: issue.status,
    summary: issue.summary,
  };

  return `Ticket details:\n${JSON.stringify(ticketContext, null, 2)}`;
}

function buildSlaFallbackMessages(candidate: SlaFollowUpCandidate): string[] {
  const { issue, isResolved, stage } = candidate;
  const greeting = `Hi ${addressingFallback(issue)},`;
  const summaryClause = issue.summary ? ` regarding "${issue.summary}"` : "";

  if (stage === 1) {
    return [
      `${greeting} hope things are going well - following up on ${issue.key}${summaryClause}. Whenever you get a chance, could you share a status update or an ETA? Thank you!`,
      `${greeting} just wanted to check in on ${issue.key}${summaryClause} - no rush at all, just want to keep it on our radar. Any update on timing?`,
      `${greeting} circling back on ${issue.key}${summaryClause}. Let us know where things stand whenever it's convenient for you.`,
    ];
  }

  if (isResolved) {
    return [
      `${greeting} the issue on ${issue.key}${summaryClause} has been resolved. We're closing this ticket - please reopen or reply if you still have concerns. Thank you so much for your patience.`,
      `${greeting} good news - ${issue.key}${summaryClause} is now resolved on our end, so we're closing it out. Reach back out any time if something's still off, we're happy to help.`,
      `${greeting} this has been taken care of, so we're marking ${issue.key}${summaryClause} closed. Just reply or reopen if you still need us to look at anything - thanks for bearing with us.`,
    ];
  }

  return [
    `${greeting} we haven't heard back on ${issue.key}${summaryClause} after a previous follow-up, so we're closing this ticket for now - totally understand if the timing just didn't work out. Please reopen or reply any time if you still need help.`,
    `${greeting} since we haven't gotten a response on ${issue.key}${summaryClause}, we're going to close it out for now - no worries at all, feel free to reopen whenever you're ready to pick it back up.`,
    `${greeting} as we didn't hear back on ${issue.key}${summaryClause}, we're closing this for the time being. No hard feelings though - just reply or reopen any time if you still need this addressed.`,
  ];
}

export async function draftSlaFollowUpMessage(
  candidate: SlaFollowUpCandidate,
  comments: TicketCommentContext[],
): Promise<DraftResult> {
  const { issue } = candidate;
  const ocrText = await getCachedOcrTextForIssue(issue);
  return draftViaChain(
    buildSlaUserPrompt(candidate, comments, ocrText),
    issue.key,
    pickVariant(issue.key, buildSlaFallbackMessages(candidate)),
    {
      allowTools: !issue.reporter_is_external,
      safetyCheck: issue.reporter_is_external ? { ownIssueKey: issue.key } : undefined,
      systemPrompt: buildSlaSystemPrompt(candidate),
    },
  );
}

/* The static "what kind of closure is this" framing only - never embeds
   referenceKey/explanation directly (those are real per-ticket Jira keys and
   free text, which would both break system-prompt cache reuse and, for the
   internal case, need to flow through the user-prompt ticket JSON instead so
   the instruction text stays identical across different tickets of the same
   reason/audience combination). */
function closureSystemContext(candidate: ClosureCandidate): string {
  const { reason } = candidate;
  const external = candidate.issue.reporter_is_external;

  if (reason === "retry_close") {
    return external
      ? "A previous closing message was already sent, but the ticket wasn't actually marked Done - this is a retry. Keep it brief, just confirm this ticket is being closed now."
      : "A previous closing message was already sent to the reporter, but the ticket wasn't actually marked Done - this is a retry. Keep it brief and don't repeat the full original explanation, just confirm this ticket is being closed now.";
  }

  if (reason === "client_unresponsive") {
    return "We've sent more than one follow-up and haven't heard back from the reporter.";
  }

  if (external) {
    return "We believe the underlying issue has already been resolved, either directly or through related work on our end.";
  }

  return reason === "linked_cp_resolved"
    ? "The linked ticket named as reference_key in the ticket details below has been resolved - the explanation field there says why. Mention that plainly, with genuine warmth that this is good news for them."
    : "A very similar past ticket, named as reference_key in the ticket details below, was already resolved - the explanation field there says why. Mention that plainly, with genuine warmth that this is good news for them.";
}

function buildClosureSystemPrompt(candidate: ClosureCandidate): string {
  const { issue, reason } = candidate;
  const external = issue.reporter_is_external;
  const closingBecause =
    reason === "client_unresponsive"
      ? "because we've followed up more than once with no response"
      : "because the underlying issue appears already resolved elsewhere";
  const ask =
    reason === "client_unresponsive"
      ? "Write a gentle closing message: note plainly that we haven't heard back after multiple follow-ups and are closing for now - this is about the lack of a response, NOT a claim that the issue is resolved, and there should be no hint of blame or impatience - and warmly invite them to reopen or reply any time if they still need help."
      : "Write a warm closing message: share why we believe this is resolved like you're glad to deliver good news, and invite them to reopen or reply if it isn't.";

  return `You are a support engineer drafting a short, warm Jira comment closing this ticket ${closingBecause}. Write only the comment text itself - no subject line, no markdown, no surrounding quotes.

${addressingInstruction(issue)}

${closureSystemContext(candidate)} ${ask} This ticket is being closed right after this message. Keep it to 2-4 sentences.${
    external ? " Do not mention any other ticket number - describe this only in plain, simple terms." : ""
  }

If the ticket details include attachment_text, it's OCR'd text from the ticket's attachments - use it as context if relevant.

${HUMAN_VARIETY_INSTRUCTION}${external ? "" : `\n\n${TOOL_USE_INSTRUCTION}`}`;
}

function buildClosureUserPrompt(
  candidate: ClosureCandidate,
  comments: TicketCommentContext[],
  ocrText: string,
): string {
  const { explanation, issue, reason, referenceKey } = candidate;
  const external = issue.reporter_is_external;
  /* referenceKey is a real Jira key (a CP ticket or a similar TS ticket) and
     explanation is model-generated free text from the similarity judgment
     that can itself mention a key - never include either for an external
     reporter, and a retry has no reference of its own to give. For
     client_unresponsive the explanation/reference is a note for whoever
     reviews the candidate (e.g. "linked CP-X still open, check first"), not
     something to repeat to the reporter. */
  const includeReference = !external && reason !== "retry_close" && reason !== "client_unresponsive";

  const ticketContext = {
    attachment_text: ocrText || undefined,
    comments: external ? undefined : comments,
    explanation: includeReference ? explanation : undefined,
    key: issue.key,
    pending_reason: issue.pending_reason,
    priority: issue.priority,
    reference_key: includeReference ? referenceKey : undefined,
    reporter: issue.reporter,
    status: issue.status,
    summary: issue.summary,
  };

  return `Ticket details:\n${JSON.stringify(ticketContext, null, 2)}`;
}

function buildClosureFallbackMessages(candidate: ClosureCandidate): string[] {
  const { issue, reason } = candidate;
  const greeting = `Hi ${addressingFallback(issue)},`;
  const summaryClause = issue.summary ? ` regarding "${issue.summary}"` : "";

  if (reason === "client_unresponsive") {
    return [
      `${greeting} we've followed up a couple of times on ${issue.key}${summaryClause} but haven't heard back, so we're closing this for now. Please reopen or reply any time if you still need help - we're happy to pick it back up.`,
      `${greeting} since we haven't heard back after a couple of follow-ups on ${issue.key}${summaryClause}, we're going ahead and closing this out. Just reopen or reach out any time if that's not right.`,
      `${greeting} we're closing ${issue.key}${summaryClause} since we haven't gotten a response after a few follow-ups - no worries if the timing wasn't right, just reopen or reply whenever you're ready.`,
    ];
  }

  return [
    `${greeting} good news - the issue on ${issue.key}${summaryClause} has been resolved, so we're closing this ticket. Please reopen or reply any time if you still need help. Thanks so much for your patience!`,
    `${greeting} happy to report this looks resolved on our end, so we're going ahead and closing ${issue.key}${summaryClause}. Just reopen or reply if anything's still off - we're glad to take another look.`,
    `${greeting} we're marking ${issue.key}${summaryClause} closed since the underlying issue appears fixed. Reach back out any time if that's not the case, we're happy to help.`,
  ];
}

export async function draftClosureMessage(
  candidate: ClosureCandidate,
  comments: TicketCommentContext[],
): Promise<DraftResult> {
  const { issue } = candidate;
  const ocrText = await getCachedOcrTextForIssue(issue);
  return draftViaChain(
    buildClosureUserPrompt(candidate, comments, ocrText),
    issue.key,
    pickVariant(issue.key, buildClosureFallbackMessages(candidate)),
    {
      allowTools: !issue.reporter_is_external,
      safetyCheck: issue.reporter_is_external ? { ownIssueKey: issue.key } : undefined,
      systemPrompt: buildClosureSystemPrompt(candidate),
    },
  );
}
