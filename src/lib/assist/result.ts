import type {
  ActionActor,
  ActionArgs,
  ActionDraft,
  ActionOperation,
  ActionProposal,
  AssistFact,
  AssistSource,
  InvestigationResult,
  ProposalSource,
} from "@/lib/workspace/types";

/**
 * Turning the agent's final answer into something safe to store and show:
 * - extractJsonObject   find the JSON object in a reply that may be fenced or wrapped in prose
 * - normalizeInvestigation  coerce it into InvestigationResult: every fact keeps only sources
 *                       with a known kind (and URLs that really appeared in the tool outputs);
 *                       a fact left without sources becomes a hypothesis; everything is clipped
 * - scopeProposals      each proposed action is forced onto this run's ticket, checked, and
 *                       turned into a pending ActionProposal - or dropped with a reason
 *
 * The agent never executes anything: a proposal only exists so a person can
 * approve (or edit, then approve) it in the UI.
 *
 * Pure apart from the injected createProposal/validate, so the tests drive it
 * with fakes.
 */

export const MAX_PROPOSED_ACTIONS = 5;
const MAX_FACTS = 12;
const MAX_SOURCES_PER_FACT = 4;
const MAX_LIST_ITEMS = 6;
const SUMMARY_CHARS = 700;
const FACT_CHARS = 450;
const LIST_ITEM_CHARS = 300;
const NEXT_STEP_CHARS = 450;
const DRAFT_CHARS = 2_500;
const LABEL_CHARS = 160;
const RATIONALE_CHARS = 300;
/* Raw action candidates looked at, before the cap - so "more than 5" is reported, not silently lost. */
const MAX_RAW_ACTIONS = 10;

const SOURCE_KINDS: ReadonlySet<AssistSource["kind"]> = new Set(["confluence", "cp", "jira_comment", "jira_field", "jira_search", "oncall", "slack_message"]);

export const ALLOWED_OPERATIONS: ReadonlySet<ActionOperation> = new Set([
  "firefighter_escalation",
  "jira_assign",
  "jira_comment",
  "jira_link_cp",
  "jira_priority",
  "jira_transition",
  "slack_thread_reply",
]);

/** A proposed action that didn't become a proposal, and why (shown under the result). */
export interface DroppedAction {
  operation: string;
  reason: string;
}

/** What the store keeps as a run's result: the contract's InvestigationResult plus the dropped actions. */
export interface StoredInvestigationResult extends InvestigationResult {
  droppedActions?: DroppedAction[];
}

/* ------------------------------------------------------- JSON extraction */

function tryParseObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/* From an opening "{", the index just past its matching "}" - string-aware, so braces inside strings don't count. */
function matchingBraceEnd(text: string, start: number): number | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return i + 1;
      }
    }
  }
  return null;
}

/**
 * The first JSON object in a model reply: the whole text, a ```json fenced
 * block, or the first balanced {...} in surrounding prose. null when there is none.
 */
export function extractJsonObject(text: string | null | undefined): Record<string, unknown> | null {
  if (!text) {
    return null;
  }
  const whole = tryParseObject(text.trim());
  if (whole) {
    return whole;
  }

  for (const match of text.matchAll(/```[a-zA-Z]*\s*\n?([\s\S]*?)```/g)) {
    const fenced = tryParseObject((match[1] ?? "").trim());
    if (fenced) {
      return fenced;
    }
  }

  /* Prose around it: try each "{" in turn (bounded, so a reply full of braces can't make this quadratic for long). */
  let from = 0;
  for (let attempts = 0; attempts < 20; attempts++) {
    const start = text.indexOf("{", from);
    if (start < 0) {
      break;
    }
    const end = matchingBraceEnd(text, start);
    if (end !== null) {
      const candidate = tryParseObject(text.slice(start, end));
      if (candidate) {
        return candidate;
      }
    }
    from = start + 1;
  }
  return null;
}

/* ---------------------------------------------------------- normalizing */

export function clipText(value: unknown, max: number): string {
  if (typeof value !== "string") {
    return "";
  }
  /* Keeps line breaks (a customer draft has paragraphs) but trims runs of blank lines and spaces. */
  const text = value.replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function stringList(value: unknown, maxItems: number, maxChars: number): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => clipText(item, maxChars))
    .filter(Boolean)
    .slice(0, maxItems);
}

function isoOrUndefined(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

function normalizeSource(value: unknown, knownUrls: ReadonlySet<string> | null): AssistSource | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const kind = raw.kind as AssistSource["kind"];
  const label = clipText(raw.label, LABEL_CHARS);
  if (!SOURCE_KINDS.has(kind) || !label) {
    return null;
  }
  const source: AssistSource = { kind, label };
  /* A link the tools never returned is the model's invention: keep the citation, lose the link. */
  if (typeof raw.url === "string" && /^https:\/\//.test(raw.url) && (knownUrls === null || knownUrls.has(raw.url))) {
    source.url = raw.url;
  }
  const at = isoOrUndefined(raw.at);
  if (at) {
    source.at = at;
  }
  return source;
}

export interface NormalizeContext {
  /* URLs that appeared in this run's tool outputs; null = don't check. */
  knownUrls: ReadonlySet<string> | null;
}

export interface NormalizedInvestigation {
  /* proposedActions is empty here - scopeProposals fills it. */
  result: StoredInvestigationResult;
  /* The model's proposedActions, untouched, for scopeProposals. */
  rawActions: unknown[];
}

/** Coerces the parsed answer into an InvestigationResult. null when it has nothing usable at all. */
export function normalizeInvestigation(parsed: Record<string, unknown>, ctx: NormalizeContext): NormalizedInvestigation | null {
  const facts: AssistFact[] = [];
  const unsourced: string[] = [];

  const rawFacts: unknown[] = Array.isArray(parsed.facts) ? parsed.facts : [];
  for (const rawFact of rawFacts) {
    const fact: Record<string, unknown> = rawFact && typeof rawFact === "object" ? (rawFact as Record<string, unknown>) : { text: rawFact };
    const text = clipText(fact.text, FACT_CHARS);
    if (!text) {
      continue;
    }
    const rawSources: unknown[] = Array.isArray(fact.sources) ? fact.sources : [];
    const sources = rawSources
      .map((source) => normalizeSource(source, ctx.knownUrls))
      .filter((source): source is AssistSource => source !== null)
      .slice(0, MAX_SOURCES_PER_FACT);
    if (sources.length === 0) {
      unsourced.push(text);
    } else if (facts.length < MAX_FACTS) {
      facts.push({ sources, text });
    }
  }

  /* A "fact" nobody can trace is a hypothesis at best. */
  const hypotheses = [...stringList(parsed.hypotheses, MAX_LIST_ITEMS, LIST_ITEM_CHARS), ...unsourced.map((text) => clipText(`Unverified: ${text}`, LIST_ITEM_CHARS))].slice(
    0,
    MAX_LIST_ITEMS + 3,
  );
  const missing = stringList(parsed.missing, MAX_LIST_ITEMS, LIST_ITEM_CHARS);
  const nextStep = clipText(parsed.nextStep, NEXT_STEP_CHARS);
  const summary = clipText(parsed.summary, SUMMARY_CHARS) || facts[0]?.text || "";
  const customerDraft = clipText(parsed.customerDraft, DRAFT_CHARS);
  const rawActions: unknown[] = Array.isArray(parsed.proposedActions) ? parsed.proposedActions.slice(0, MAX_RAW_ACTIONS) : [];

  if (!summary && facts.length === 0 && hypotheses.length === 0) {
    return null;
  }

  const result: StoredInvestigationResult = { facts, hypotheses, missing, nextStep, proposedActions: [], summary };
  if (customerDraft) {
    result.customerDraft = customerDraft;
  }
  return { rawActions, result };
}

/* ------------------------------------------------------------ proposals */

export type ValidateActionArgs = (ticketKey: string, args: unknown) => { args: ActionArgs; ok: true } | { error: string; ok: false };

export type CreateProposal = (
  draft: ActionDraft,
  source: ProposalSource,
  actor: ActionActor,
) => Promise<{ ok: true; proposal: ActionProposal } | { error: string; ok: false; status: number }>;

export interface ProposalScope {
  actor: ActionActor;
  /* Text the agent actually saw (tool outputs): an account id or CP key it proposes must appear there. */
  evidence: string;
  /* `${channel}:${rootTs}` of the Slack conversations linked to this ticket. */
  linkedConversations: ReadonlySet<string>;
  runId: string;
  ticketKey: string;
  /* The workflow transitions Jira offered for this ticket when the run started. */
  transitionIds: ReadonlySet<string>;
}

export interface ProposalDeps {
  createProposal: CreateProposal;
  /* Customer-facing text check (src/lib/messageSafety.ts). */
  isCustomerSafe: (text: string, ticketKey: string) => { safe: boolean; violations: string[] };
  validate: ValidateActionArgs;
}

export interface ScopedProposals {
  dropped: DroppedAction[];
  proposed: Array<ActionDraft & { proposalId: string }>;
}

function operationOf(args: unknown): string {
  const op = args && typeof args === "object" ? (args as Record<string, unknown>).operation : undefined;
  return typeof op === "string" ? op.slice(0, 40) : "unknown";
}

/* `token` appears in `text` as a whole word ("CP-5" is not in "CP-55"). */
export function mentions(text: string, token: string): boolean {
  if (!token) {
    return false;
  }
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^A-Za-z0-9-])${escaped}(?![A-Za-z0-9])`).test(text);
}

/*
 * Checks the model can't satisfy by guessing. A transition must be one Jira
 * offered for this ticket; an account id or CP key must have come out of a
 * tool; a Slack reply only goes into a conversation already linked to this
 * ticket. The actions service validates again on approval - this keeps
 * inventions off the review list, where a wrong id behind a plausible label
 * would be easy to approve.
 */
function groundingProblem(args: ActionArgs, scope: ProposalScope, deps: ProposalDeps): string | null {
  switch (args.operation) {
    case "jira_transition":
      return scope.transitionIds.has(args.transitionId) ? null : `transition ${clipText(args.transitionId, 20)} isn't one Jira offers for ${scope.ticketKey}`;
    case "jira_assign":
      return args.accountId === null || mentions(scope.evidence, args.accountId) ? null : "the account id didn't come from any tool output";
    case "slack_thread_reply":
      return scope.linkedConversations.has(`${args.channel}:${args.threadTs}`) ? null : "that Slack thread isn't linked to this ticket";
    case "jira_link_cp":
      return mentions(scope.evidence, args.cpKey) ? null : `${clipText(args.cpKey, 20)} didn't come from any tool output`;
    case "jira_comment": {
      if (args.visibility !== "public") {
        return null;
      }
      const check = deps.isCustomerSafe(args.body, scope.ticketKey);
      return check.safe ? null : `the customer-visible reply isn't customer-safe (${check.violations.join("; ")})`;
    }
    default:
      return null;
  }
}

/**
 * Each raw proposed action -> a pending proposal on THIS ticket, or a dropped
 * entry saying why. At most MAX_PROPOSED_ACTIONS become proposals. Never throws.
 */
export async function scopeProposals(rawActions: unknown[], scope: ProposalScope, deps: ProposalDeps): Promise<ScopedProposals> {
  const proposed: ScopedProposals["proposed"] = [];
  const dropped: DroppedAction[] = [];

  for (const raw of rawActions) {
    const draft = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const operation = operationOf(draft.args);

    if (proposed.length >= MAX_PROPOSED_ACTIONS) {
      dropped.push({ operation, reason: `more than ${MAX_PROPOSED_ACTIONS} actions were proposed` });
      continue;
    }

    const claimedKey = typeof draft.ticketKey === "string" ? draft.ticketKey.trim().toUpperCase() : "";
    if (claimedKey && claimedKey !== scope.ticketKey) {
      dropped.push({ operation, reason: `it was for another ticket (${claimedKey.slice(0, 20)})` });
      continue;
    }

    if (!ALLOWED_OPERATIONS.has(operation as ActionOperation)) {
      dropped.push({ operation, reason: "not an operation Assist may propose" });
      continue;
    }

    const validated = deps.validate(scope.ticketKey, draft.args);
    if (!validated.ok) {
      dropped.push({ operation, reason: clipText(validated.error, 200) });
      continue;
    }

    const problem = groundingProblem(validated.args, scope, deps);
    if (problem) {
      dropped.push({ operation, reason: problem });
      continue;
    }

    const rationale = clipText(draft.rationale, RATIONALE_CHARS);
    const finalDraft: ActionDraft = { args: validated.args, ticketKey: scope.ticketKey, ...(rationale ? { rationale } : {}) };
    try {
      const created = await deps.createProposal(finalDraft, { runId: scope.runId, type: "assist" }, scope.actor);
      if (created.ok) {
        proposed.push({ ...finalDraft, proposalId: created.proposal.id });
      } else {
        dropped.push({ operation, reason: clipText(created.error, 200) });
      }
    } catch (error) {
      dropped.push({ operation, reason: `couldn't be saved (${clipText(error instanceof Error ? error.message : String(error), 160)})` });
    }
  }

  return { dropped, proposed };
}

/**
 * The customer draft goes into a reply box a person reviews, but it is still
 * meant for the customer: one that names another ticket or an internal wiki
 * link is withheld, the same rule the follow-up drafts follow.
 */
export function screenCustomerDraft(
  result: StoredInvestigationResult,
  ticketKey: string,
  isCustomerSafe: ProposalDeps["isCustomerSafe"],
): StoredInvestigationResult {
  if (!result.customerDraft) {
    return result;
  }
  const check = isCustomerSafe(result.customerDraft, ticketKey);
  if (check.safe) {
    return result;
  }
  const withheld: StoredInvestigationResult = {
    ...result,
    missing: [...result.missing, `A customer draft was withheld because it wasn't customer-safe (${check.violations.join("; ")}).`].slice(0, MAX_LIST_ITEMS + 1),
  };
  delete withheld.customerDraft;
  return withheld;
}
