import { getCachedOcrTextForIssue } from "@/lib/attachmentOcr";
import { daysSince, getFollowUpAuditEntries, mostRecentEntryOfKind } from "@/lib/followupAudit";
import type { FollowUpAuditEntry } from "@/lib/followupAudit";
import {
  addressingFallback,
  addressingInstruction,
  draftViaChain,
  TOOL_USE_INSTRUCTION,
} from "@/lib/followupDraft";
import type { DraftResult } from "@/lib/followupDraft";
import { getIssueByKey, getWaitingForProductTsOnly, mapWithConcurrency } from "@/lib/jiraClient";
import type { FormattedIssue, TicketCommentContext } from "@/lib/jiraClient";
import { HUMAN_VARIETY_INSTRUCTION, pickVariant } from "@/lib/textVariety";

const CADENCE_DAYS = 3;

export interface ProductWaitCandidate {
  /* 1st, 2nd, 3rd... follow-up for this specific ticket - drives the
     external-branch anti-repetition instruction below. */
  followUpOrdinal: number;
  issue: FormattedIssue;
}

/* Injectable getAuditEntries (defaulting to the real Redis-backed one)
   mirrors determineCandidate() in slaFollowup.ts / classifyIssue() in
   closureCandidates.ts - lets the cadence/ordinal math be unit-tested with
   constructed fixtures instead of needing real Redis. */
export async function determineProductWaitCandidate(
  issue: FormattedIssue,
  getAuditEntries: (issueKey: string) => Promise<FollowUpAuditEntry[]> = getFollowUpAuditEntries,
): Promise<ProductWaitCandidate | null> {
  const auditEntries = await getAuditEntries(issue.key);
  const priorCount = auditEntries.filter((entry) => entry.kind === "product_wait").length;
  const lastFollowUp = mostRecentEntryOfKind(auditEntries, ["product_wait"]);
  const daysSinceLast = lastFollowUp ? daysSince(lastFollowUp.posted_at) : daysSince(issue.updated);

  if (daysSinceLast < CADENCE_DAYS) {
    return null;
  }

  return { followUpOrdinal: priorCount + 1, issue };
}

/**
 * Scans TS tickets in "Waiting for Product" (a status the existing SLA
 * follow-up feature does not cover - that owns "Waiting for Client" only)
 * for ones due a 3-day follow-up. Every candidate is a suggestion for a
 * human to review; this module never drafts-and-sends or closes anything
 * itself.
 */
export async function getProductWaitCandidates(): Promise<ProductWaitCandidate[]> {
  const issues = await getWaitingForProductTsOnly();
  const results = await mapWithConcurrency(issues, 5, determineProductWaitCandidate);

  return results.filter((candidate): candidate is ProductWaitCandidate => candidate !== null);
}

/* Static across every internal product-wait ticket regardless of whether it
   has a linked CP - the model is told to look for linked_cp_key/
   linked_cp_status in the ticket details and act accordingly, rather than
   this text branching on that per ticket. Keeps this cacheable as a single
   system prompt instead of two. */
function buildInternalSystemPrompt(issue: FormattedIssue): string {
  return `You are a support engineer drafting a short, warm check-in comment on a Jira ticket that's waiting on Product/Engineering. Write only the comment text itself - no subject line, no markdown, no surrounding quotes.

${addressingInstruction(issue)}

This ticket is "Waiting for Product". If the ticket details include a linked_cp_key, relay the linked ticket's actual current status (given as linked_cp_status) to the reporter plainly and reassuringly. Otherwise, ask Product/Engineering for a status update the way you'd check in with a teammate whose plate you know is full - genuinely curious, not chasing them - since there's no linked tracking ticket yet. This is an internal update, not client-facing - full technical detail is fine. Keep it to 2-4 sentences.

attachment_text (when present) is OCR'd text from the ticket's attachments - use it as context if relevant.

${HUMAN_VARIETY_INSTRUCTION}

${TOOL_USE_INSTRUCTION}`;
}

function buildInternalUserPrompt(
  candidate: ProductWaitCandidate,
  comments: TicketCommentContext[],
  ocrText: string,
): string {
  const { issue } = candidate;
  const linkedCp = issue.linked_cp_issue;

  return `Ticket details:
${JSON.stringify(
  {
    attachment_text: ocrText || undefined,
    comments,
    key: issue.key,
    linked_cp_key: linkedCp?.key,
    linked_cp_status: linkedCp?.status,
    pending_reason: issue.pending_reason,
    summary: issue.summary,
  },
  null,
  2,
)}`;
}

function buildInternalFallbacks(candidate: ProductWaitCandidate): string[] {
  const { issue } = candidate;
  const greeting = `Hi ${addressingFallback(issue)},`;
  const linkedCp = issue.linked_cp_issue;
  const progress = linkedCp ? ` The linked ticket ${linkedCp.key} is currently "${linkedCp.status}".` : "";

  return [
    `${greeting} hope you're doing well - just checking in on this ticket, which is waiting on Product.${progress} Let us know if there's anything else needed from our side in the meantime, happy to help!`,
    `${greeting} no rush at all, just wanted to flag this one is still waiting on Product.${progress} Ping us any time if there's anything you need from us to help move it along.`,
    `${greeting} following up since this is still sitting on Product's plate - totally understand things get busy.${progress} Happy to help unblock if there's anything we can do.`,
  ];
}

interface CpFraming {
  isBug: boolean;
  progressDescription: string;
}

/** Translates Jira's own status vocabulary into a plain descriptor - the external prompt never sees the raw status word, only this. */
function describeCpProgress(status: string | undefined): string {
  const value = (status ?? "").toLowerCase();

  if (value.includes("backlog") || value.includes("selected for sprint") || value.includes("to do")) {
    return "this is queued up and will be picked up soon";
  }
  if (value.includes("progress") || value.includes("review")) {
    return "our team is actively working on this right now";
  }
  if (value.includes("done") || value.includes("closed") || value.includes("released")) {
    return "this has just been resolved on our end";
  }

  return "our team is looking into this";
}

async function getLinkedCpFraming(issue: FormattedIssue): Promise<CpFraming | null> {
  const linkedCp = issue.linked_cp_issue;

  if (!linkedCp) {
    return null;
  }

  const cpDetail = await getIssueByKey(linkedCp.key);

  return {
    isBug: cpDetail?.issue_type === "Bug",
    progressDescription: describeCpProgress(linkedCp.status),
  };
}

/* Deliberately doesn't interpolate the literal follow-up number for ordinal
   3+ (the exact count still reaches the model via follow_up_number in the
   user prompt below) - a literal number would make this system prompt
   different for every distinct ordinal value a batch happens to contain,
   defeating prompt-cache reuse across tickets on their 3rd vs 4th vs 5th
   follow-up, which is exactly the group most likely to share this tier in
   one run. */
function ordinalGuidance(followUpOrdinal: number): string {
  if (followUpOrdinal <= 1) {
    return "This is the first update on this - introduce the situation naturally.";
  }
  if (followUpOrdinal === 2) {
    return "This is the second follow-up on this ticket - it must NOT sound like a repeat of a first check-in. Acknowledge that some time has passed and use noticeably different phrasing and structure.";
  }
  return "This is a later follow-up on an ongoing thread (the exact count is given as follow_up_number in the ticket details below) - it must read as a genuinely fresh update, not a copy-paste. Acknowledge the wait warmly and vary your wording, structure, and opening substantially from a standard check-in.";
}

function buildExternalSystemPrompt(followUpOrdinal: number, framing: CpFraming | null): string {
  const typeFraming = framing?.isBug
    ? "we're working on a fix and will share an ETA once we have one"
    : "we're working on this and will share an update as soon as we can";

  return `You are a support engineer writing a short, warm, plain-English update to a client on their support request. Write only the message text itself - no subject line, no markdown, no surrounding quotes.

Address them by name, given as "reporter" in the ticket details below.

${ordinalGuidance(followUpOrdinal)}

Explain, in SIMPLE non-technical words, what the underlying issue was (plain terms only) and what we're doing about it: ${typeFraming}. If the ticket details include a progress_description, weave that in plainly too.

CRITICAL RULES - these are non-negotiable:
- NEVER mention any internal ticket number, project key (e.g. "CP-12345", "TS-12345"), or Jira reference of any kind.
- NEVER use technical/engineering jargon - explain things the way you'd explain them to a non-technical friend.
- NEVER mention internal team, tool, or process names (no "backlog", no "sprint", no "Jira", no "Confluence", no internal ticket system of any kind).
- Keep it warm, human, and concise (2-4 sentences).

${HUMAN_VARIETY_INSTRUCTION}`;
}

function buildExternalUserPrompt(candidate: ProductWaitCandidate, framing: CpFraming | null): string {
  const { followUpOrdinal, issue } = candidate;

  return `Ticket details (for you only - do not quote verbatim or reference its source):
${JSON.stringify(
  {
    follow_up_number: followUpOrdinal,
    pending_reason: issue.pending_reason,
    progress_description: framing?.progressDescription,
    reporter: issue.reporter,
    summary: issue.summary,
  },
  null,
  2,
)}`;
}

function buildExternalFallbacks(candidate: ProductWaitCandidate): string[] {
  const { followUpOrdinal, issue } = candidate;
  const reporter = issue.reporter;

  if (followUpOrdinal <= 1) {
    return [
      `Hi ${reporter}, just wanted to check in on this - our team is actively working on it, and we'll share an update as soon as we have more to share. Thank you for your patience!`,
      `Hi ${reporter}, wanted to give you a quick heads up that we're on this and working through it. We'll reach back out with an update as soon as there's something new to share.`,
    ];
  }

  if (followUpOrdinal === 2) {
    return [
      `Hi ${reporter}, following up again on this. We're continuing to work through it and appreciate your patience while we get this resolved for you.`,
      `Hi ${reporter}, wanted to touch base again - this is still moving forward on our end, and we'll let you know the moment there's an update.`,
    ];
  }

  return [
    `Hi ${reporter}, we know this has been an ongoing thread and we appreciate you bearing with us. Our team is still on this, and we'll be in touch with an update soon.`,
    `Hi ${reporter}, thanks for hanging in there with us on this one - it's still actively being worked, and we'll follow up again as soon as we have news.`,
  ];
}

export async function draftProductWaitMessage(
  candidate: ProductWaitCandidate,
  comments: TicketCommentContext[],
): Promise<DraftResult> {
  const { issue } = candidate;
  const ocrText = await getCachedOcrTextForIssue(issue);

  if (!issue.reporter_is_external) {
    return draftViaChain(
      buildInternalUserPrompt(candidate, comments, ocrText),
      issue.key,
      pickVariant(issue.key, buildInternalFallbacks(candidate)),
      { allowTools: true, systemPrompt: buildInternalSystemPrompt(issue) },
    );
  }

  const framing = await getLinkedCpFraming(issue);

  return draftViaChain(
    buildExternalUserPrompt(candidate, framing),
    issue.key,
    pickVariant(issue.key, buildExternalFallbacks(candidate)),
    {
      allowTools: false,
      safetyCheck: { ownIssueKey: issue.key },
      systemPrompt: buildExternalSystemPrompt(candidate.followUpOrdinal, framing),
    },
  );
}
