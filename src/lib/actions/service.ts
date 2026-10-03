import { randomUUID } from "node:crypto";

import { executeJiraWrite, getJiraUserName, getTicketVersion, jiraWriteConfigFromEnv, MISSING_TOKEN_MESSAGE } from "@/lib/actions/jiraWrites";
import { defaultSlackWriteDeps, executeSlackWrite, findLinkedConversation, notLinkedMessage } from "@/lib/actions/slackWrites";
import { redisActionStore } from "@/lib/actions/store";
import { isIdempotencyKey, isJiraOperation, TICKET_KEY_PATTERN, validateActionArgs } from "@/lib/actions/validate";
import { checkExternalMessageSafety } from "@/lib/messageSafety";
import { getTrackerDetail, invalidateTrackerDetail } from "@/lib/tracker/detail";
import { getConversationsForTickets } from "@/lib/tracker/slackIndex";
import { getTrackerSnapshot } from "@/lib/tracker/snapshot";
import { getJiraCredentialsForAccount } from "@/lib/userJiraTokens";

import type { JiraWriteResult } from "@/lib/actions/jiraWrites";
import type { SlackTicketFacts, SlackWriteContext, SlackWriteResult } from "@/lib/actions/slackWrites";
import type { ActionStore } from "@/lib/actions/store";
import type { JiraCredentials } from "@/lib/jiraClient";
import type { LeakCheckResult } from "@/lib/messageSafety";
import type { SlackConversationRef, TrackerTicket } from "@/lib/tracker/types";
import type {
  ActionActor,
  ActionArgs,
  ActionDraft,
  ActionExecution,
  ActionProposal,
  ApproveProposalRequest,
  ExecuteActionRequest,
  ProposalSource,
  TicketActionsResponse,
} from "@/lib/workspace/types";

/**
 * The write-back pipeline: every change a person makes to a ticket from the
 * tracker - and every AI / browser-agent proposal they approve - runs
 * through executeAction, in this order:
 *
 * 1. validate         the operation's arguments (src/lib/actions/validate.ts)
 * 2. idempotency      the same (person, idempotencyKey) never writes twice: a
 *                     resend returns the stored execution as "duplicate"; one
 *                     still running answers 409
 * 3. rate limit       60 writes per person per clock hour
 * 4. safety           a customer-visible comment or a Slack post may not name
 *                     another ticket or an internal wiki link
 * 5. version check    Jira writes only: the `updated` the person was looking at
 *                     must still be Jira's, unless they force it ("conflict")
 * 6. write            Jira with their own token / Slack as the bot
 * 7. record           the execution, the audit log, and a fresh detail panel
 *
 * Only an outcome that may have changed something (succeeded, uncertain)
 * stays pinned to its idempotency key; a failed or conflicting attempt
 * releases it - nothing happened, so the same key may try again.
 *
 * Proposals (from AI Assist runs and the browser agent) never write on
 * their own: a person approves one - optionally editing it - and the
 * approval is an executeAction with the proposal id attached.
 *
 * Everything here takes its I/O as injectable deps (scripts/test-actions.ts).
 * The exported functions never throw.
 */

const IDEMPOTENCY_TTL_SECONDS = 7 * 86_400;
const EXECUTION_TTL_SECONDS = 7 * 86_400;
const PROPOSAL_TTL_SECONDS = 7 * 86_400;
const AUDIT_TTL_SECONDS = 90 * 86_400;
const TICKET_LOG_KEEP = 100;
const ALL_LOG_KEEP = 500;
const RATE_LIMIT_PER_HOUR = 60;
const PROPOSAL_LIFETIME_MS = 24 * 3_600_000;
const MAX_PENDING_PER_TICKET = 20;
const PROPOSAL_INDEX_KEEP = 100;
const RECENT_EXECUTIONS = 20;
const RECENT_DECIDED_PROPOSALS = 20;
const RATIONALE_MAX_CHARS = 1_000;
const PROPOSAL_LOCK_SECONDS = 120;
/* Past the route's maxDuration, an "in progress" marker belongs to an attempt that died mid-way. */
const STALE_IN_PROGRESS_MS = 5 * 60_000;

const PROPOSAL_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

type Failure = { error: string; ok: false; status: number };

export type ExecuteActionResult = { execution: ActionExecution; ok: true } | Failure;
export type ProposalDecisionResult = { execution?: ActionExecution; ok: true; proposal: ActionProposal } | Failure;

/* The ticket as the tracker knows it: CP keys for Slack linkage, the ticket line for #firefighters, `updated` for proposals. */
export interface TicketFacts extends SlackTicketFacts {
  updated: string | null;
}

export interface ActionServiceDeps {
  credentials: (accountId: string) => Promise<JiraCredentials | null>;
  invalidate: (ticketKey: string) => Promise<void>;
  jira: {
    getVersion: (ticketKey: string, creds: JiraCredentials) => Promise<{ ok: true; version: string | null } | { error: string; ok: false }>;
    /* name null = Jira has no such account. */
    userName: (accountId: string, creds: JiraCredentials) => Promise<{ name: string | null; ok: true } | { error: string; ok: false }>;
    write: (ticketKey: string, args: ActionArgs, creds: JiraCredentials) => Promise<JiraWriteResult>;
  };
  newId: () => string;
  now: () => Date;
  slack: {
    linkedConversation: (ticketKey: string, cpKeys: readonly string[], channel: string, threadTs: string) => Promise<SlackConversationRef | null>;
    write: (args: ActionArgs, context: SlackWriteContext) => Promise<SlackWriteResult>;
  };
  /* null when Redis isn't configured: every write is refused, because idempotency can't be guaranteed. */
  store: ActionStore | null;
  ticket: (ticketKey: string, accountId: string) => Promise<TicketFacts | null>;
}

/* Our own bookkeeping on top of the contract's ActionProposal - never sent to the browser. */
interface StoredProposal extends ActionProposal {
  /* Set just before an approval starts writing. If the function is killed mid-write (timeout), the proposal can't be
     approved again by someone else until a person has had time to check Jira/Slack - it may already have happened. */
  executingSince?: string;
  /* Why the last approval attempt didn't go through (conflict / failed); cleared once approved. */
  lastError?: string;
}

/* Longer than any approval can run (route maxDuration), so a live attempt is never mistaken for a dead one. */
const EXECUTING_HOLD_MS = 10 * 60_000;

type IdempotencyRecord = { executionId: string; state: "done" } | { startedAt: string; state: "in_progress" };

const keys = {
  allLog: "actions:log:all",
  execution: (id: string) => `actions:exec:${id}`,
  idempotency: (accountId: string, key: string) => `actions:idem:${accountId}:${key}`,
  proposal: (id: string) => `actions:proposal:${id}`,
  proposalIndex: (ticketKey: string) => `actions:proposals:${ticketKey}`,
  proposalLock: (id: string) => `actions:proposal-lock:${id}`,
  rate: (accountId: string, hour: number) => `actions:rate:${accountId}:${hour}`,
  ticketLog: (ticketKey: string) => `actions:log:${ticketKey}`,
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeTicketKey(value: unknown): string {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

/** Jira returns `updated` as "2026-10-03T10:00:00.000+0000"; compare instants, not spellings. Pure. */
export function sameVersion(a: string, b: string): boolean {
  const msA = Date.parse(a);
  const msB = Date.parse(b);
  return Number.isFinite(msA) && Number.isFinite(msB) ? msA === msB : a === b;
}

/* Customer-visible comments and Slack posts. Internal notes, status, assignee, priority and links carry no prose. */
function bodyToCheck(args: ActionArgs): string | null {
  if (args.operation === "jira_comment") {
    return args.visibility === "public" ? args.body : null;
  }
  return args.operation === "slack_thread_reply" || args.operation === "firefighter_escalation" ? args.body : null;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * checkExternalMessageSafety, except that a Slack post may name the ticket's own linked CPs: the conversation is
 * linked BECAUSE those keys are in it, and #firefighters is internal. A public Jira reply gets the strict check.
 */
export function checkActionSafety(body: string, ticketKey: string, allowedKeys: readonly string[], internal = false): LeakCheckResult {
  let text = body;
  for (const key of allowedKeys) {
    text = text.replace(new RegExp(`\\b${escapeRegExp(key)}\\b`, "g"), ticketKey);
  }
  /* Slack posts are internal: links to other Slack threads or the dashboard are normal there. */
  return checkExternalMessageSafety(text, ticketKey, { allowInternalLinks: internal });
}

function isExpired(proposal: Pick<ActionProposal, "expiresAt">, now: Date): boolean {
  const expiresMs = Date.parse(proposal.expiresAt);
  return !Number.isFinite(expiresMs) || expiresMs <= now.getTime();
}

function toProposal(stored: StoredProposal, now: Date): ActionProposal {
  const proposal: StoredProposal = { ...stored };
  delete proposal.lastError;
  delete proposal.executingSince;
  return proposal.status === "pending" && isExpired(proposal, now) ? { ...proposal, status: "expired" } : proposal;
}

function normalizeSource(source: unknown): ProposalSource | null {
  if (!source || typeof source !== "object") {
    return null;
  }
  const record = source as { runId?: unknown; type?: unknown };
  if (record.type === "browser_agent") {
    return { type: "browser_agent" };
  }
  if (record.type === "assist" && typeof record.runId === "string" && /^[A-Za-z0-9_.:-]{1,100}$/.test(record.runId)) {
    return { runId: record.runId, type: "assist" };
  }
  return null;
}

/* ----------------------------------------------------------- idempotency */

async function replayIdempotent(store: ActionStore, idemKey: string, ticketKey: string, args: ActionArgs, now: Date, proposalId?: string): Promise<ExecuteActionResult | null> {
  const record = await store.get<IdempotencyRecord>(idemKey);
  if (!record) {
    return null;
  }
  if (record.state === "in_progress") {
    const startedMs = Date.parse(record.startedAt);
    if (Number.isFinite(startedMs) && now.getTime() - startedMs > STALE_IN_PROGRESS_MS) {
      return {
        error: "An earlier attempt with this idempotency key never finished - it may or may not have happened. Check Jira/Slack, then send it again as a new action.",
        ok: false,
        status: 409,
      };
    }
    return { error: "This action is already in progress - wait for it to finish.", ok: false, status: 409 };
  }

  const previous = await store.get<ActionExecution>(keys.execution(record.executionId));
  if (!previous) {
    /* The key outlived the execution record (both are 7 days; a manual purge could split them). Still never write twice. */
    return { error: "This idempotency key was already used, and its result is no longer available. Send it as a new action if it's still needed.", ok: false, status: 409 };
  }
  /* The whole intended write must match, not just its kind: a reused key for different text or another proposal would
     otherwise come back "duplicate" and mark that other proposal approved without anything being written for it. */
  if (
    previous.ticketKey !== ticketKey ||
    JSON.stringify(previous.args) !== JSON.stringify(args) ||
    (previous.proposalId ?? null) !== (proposalId ?? null)
  ) {
    return { error: "This idempotency key was already used for a different action - use a new key for each intended write.", ok: false, status: 422 };
  }
  return { execution: { ...previous, status: "duplicate" }, ok: true };
}

/* ----------------------------------------------------------------- run */

interface RunInput {
  args: ActionArgs;
  expectedVersion: string | null;
  force: boolean;
  idempotencyKey: string;
  proposalId?: string;
  ticketKey: string;
}

async function run(deps: ActionServiceDeps, input: RunInput, actor: ActionActor, id: string, at: string): Promise<ActionExecution> {
  const { args, ticketKey } = input;
  const base: ActionExecution = {
    actorAccountId: actor.accountId,
    actorName: actor.displayName,
    args,
    at,
    id,
    idempotencyKey: input.idempotencyKey,
    ...(input.proposalId ? { proposalId: input.proposalId } : {}),
    status: "failed",
    ticketKey,
  };
  const jira = isJiraOperation(args.operation);
  /* Slack actions need the CP keys (linkage, safety) and the ticket line; Jira ones don't read the tracker at all. */
  const facts = jira ? null : await deps.ticket(ticketKey, actor.accountId);

  const body = bodyToCheck(args);
  if (body !== null) {
    const verdict = checkActionSafety(body, ticketKey, jira ? [] : (facts?.cpKeys ?? []), !jira);
    if (!verdict.safe) {
      return { ...base, error: `Not sent - this would leak internal details: ${verdict.violations.join("; ")}.`, status: "failed" };
    }
  }

  if (!jira) {
    const result = await deps.slack.write(args, { actor, ticket: facts, ticketKey });
    return { ...base, ...result };
  }

  const creds = await deps.credentials(actor.accountId);
  if (!creds) {
    return { ...base, error: MISSING_TOKEN_MESSAGE, status: "failed" };
  }

  if (input.expectedVersion !== null && !input.force) {
    const live = await deps.jira.getVersion(ticketKey, creds);
    if (!live.ok) {
      return { ...base, error: `Couldn't check whether ${ticketKey} changed (${live.error}). Nothing was changed.`, status: "failed" };
    }
    if (live.version !== null && !sameVersion(input.expectedVersion, live.version)) {
      return {
        ...base,
        error: `${ticketKey} changed in Jira since this was loaded. Reload to see what changed, or do it anyway.`,
        status: "conflict",
      };
    }
  }

  const result = await deps.jira.write(ticketKey, args, creds);
  return { ...base, ...result };
}

async function record(deps: ActionServiceDeps, store: ActionStore, idemKey: string, execution: ActionExecution): Promise<void> {
  const mayHaveHappened = execution.status === "succeeded" || execution.status === "uncertain";
  try {
    await store.set(keys.execution(execution.id), execution, EXECUTION_TTL_SECONDS);
    if (mayHaveHappened) {
      await store.set(idemKey, { executionId: execution.id, state: "done" } satisfies IdempotencyRecord, IDEMPOTENCY_TTL_SECONDS);
    } else {
      await store.del(idemKey);
    }
  } catch (error) {
    /* The write itself is done; a lost record only weakens the duplicate check for this key (the marker still blocks it). */
    console.warn(`Actions: couldn't record execution ${execution.id} for ${execution.ticketKey}.`, errorText(error));
  }
  try {
    await store.pushCapped(keys.ticketLog(execution.ticketKey), execution, TICKET_LOG_KEEP, AUDIT_TTL_SECONDS);
    await store.pushCapped(keys.allLog, execution, ALL_LOG_KEEP, AUDIT_TTL_SECONDS);
  } catch (error) {
    console.warn(`Actions: couldn't append execution ${execution.id} to the audit log.`, errorText(error));
  }
  if (execution.status === "succeeded") {
    await deps.invalidate(execution.ticketKey).catch((error: unknown) => console.warn("Actions: detail invalidation failed.", errorText(error)));
  }
}

/* ------------------------------------------------------------- execute */

/** executeAction with explicit deps - what the tests drive. Never throws. */
export async function executeActionWith(
  deps: ActionServiceDeps,
  request: ExecuteActionRequest & { proposalId?: string },
  actor: ActionActor,
): Promise<ExecuteActionResult> {
  const ticketKey = normalizeTicketKey(request?.ticketKey);
  const valid = validateActionArgs(ticketKey, request?.args);
  if (!valid.ok) {
    return { error: valid.error, ok: false, status: 400 };
  }
  if (!isIdempotencyKey(request.idempotencyKey)) {
    return { error: "idempotencyKey must be 8-128 letters, digits, '-', '_', ':' or '.' - generate one per intended write (crypto.randomUUID()).", ok: false, status: 400 };
  }
  if (request.expectedVersion !== undefined && request.expectedVersion !== null && typeof request.expectedVersion !== "string") {
    return { error: "expectedVersion must be the ticket's Jira `updated` string, or null.", ok: false, status: 400 };
  }
  const store = deps.store;
  if (!store) {
    return { error: "Actions are unavailable: Redis isn't configured, so a write couldn't be protected from happening twice.", ok: false, status: 503 };
  }

  const args = valid.args;
  const now = deps.now();
  const idemKey = keys.idempotency(actor.accountId, request.idempotencyKey);

  try {
    const replay = await replayIdempotent(store, idemKey, ticketKey, args, now, request.proposalId);
    if (replay) {
      return replay;
    }

    const count = await store.incr(keys.rate(actor.accountId, Math.floor(now.getTime() / 3_600_000)), 3_700);
    if (count > RATE_LIMIT_PER_HOUR) {
      return { error: `That's ${RATE_LIMIT_PER_HOUR} changes from the dashboard this hour - the limit per person. Try again after the top of the hour.`, ok: false, status: 429 };
    }

    const marker: IdempotencyRecord = { startedAt: now.toISOString(), state: "in_progress" };
    if (!(await store.setIfAbsent(idemKey, marker, IDEMPOTENCY_TTL_SECONDS))) {
      /* Lost a race with a concurrent resend of the same key. */
      return (await replayIdempotent(store, idemKey, ticketKey, args, now, request.proposalId)) ?? { error: "This action is already in progress - wait for it to finish.", ok: false, status: 409 };
    }
  } catch (error) {
    console.warn("Actions: the action store is unavailable.", errorText(error));
    return { error: "Couldn't reach the action store - nothing was changed. Try again in a moment.", ok: false, status: 503 };
  }

  const expectedVersion = typeof request.expectedVersion === "string" && request.expectedVersion.trim() ? request.expectedVersion.trim() : null;
  const id = deps.newId();
  let execution: ActionExecution;
  try {
    execution = await run(
      deps,
      { args, expectedVersion, force: request.force === true, idempotencyKey: request.idempotencyKey, proposalId: request.proposalId, ticketKey },
      actor,
      id,
      now.toISOString(),
    );
  } catch (error) {
    /* run() reports every expected failure as a result; an exception here could have come after a write went out. */
    console.warn(`Actions: ${args.operation} on ${ticketKey} threw.`, errorText(error));
    execution = {
      actorAccountId: actor.accountId,
      actorName: actor.displayName,
      args,
      at: now.toISOString(),
      error: "Something went wrong mid-way - the change may have happened. Check Jira/Slack before retrying.",
      id,
      idempotencyKey: request.idempotencyKey,
      ...(request.proposalId ? { proposalId: request.proposalId } : {}),
      status: "uncertain",
      ticketKey,
    };
  }

  await record(deps, store, idemKey, execution);
  return { execution, ok: true };
}

/* ----------------------------------------------------------- proposals */

async function loadProposals(store: ActionStore, ticketKey: string): Promise<StoredProposal[]> {
  const ids = [...new Set(await store.range<string>(keys.proposalIndex(ticketKey), PROPOSAL_INDEX_KEEP))];
  const stored = await store.mget<StoredProposal>(ids.map(keys.proposal));
  return stored.filter((proposal): proposal is StoredProposal => proposal !== null && proposal.ticketKey === ticketKey);
}

/**
 * An assignment proposal's displayName is what the reviewer reads, but the accountId is what gets written - so the
 * name shown is Jira's own for that account, never the proposer's. When Jira can't be asked, the name is dropped
 * (the card then shows the bare account id) rather than trusted.
 */
async function verifiedAssignee(deps: ActionServiceDeps, args: ActionArgs, actor: ActionActor): Promise<{ args: ActionArgs; ok: true } | Failure> {
  if (args.operation !== "jira_assign" || args.accountId === null) {
    return { args, ok: true };
  }
  const unlabelled: ActionArgs = { accountId: args.accountId, operation: "jira_assign" };
  const creds = await deps.credentials(actor.accountId);
  if (!creds) {
    return { args: unlabelled, ok: true };
  }
  const user = await deps.jira.userName(args.accountId, creds);
  if (!user.ok) {
    return { args: unlabelled, ok: true };
  }
  if (user.name === null) {
    return { error: `No Jira user has the account id ${args.accountId}.`, ok: false, status: 400 };
  }
  return { args: { ...unlabelled, displayName: user.name }, ok: true };
}

/** createProposal with explicit deps - what the tests drive. Never throws. */
export async function createProposalWith(
  deps: ActionServiceDeps,
  draft: ActionDraft,
  source: ProposalSource,
  actor: ActionActor,
): Promise<{ ok: true; proposal: ActionProposal } | Failure> {
  if (!draft || typeof draft !== "object") {
    return { error: "Expected a draft: { ticketKey, args, rationale? }.", ok: false, status: 400 };
  }
  const ticketKey = normalizeTicketKey(draft.ticketKey);
  if (!TICKET_KEY_PATTERN.test(ticketKey)) {
    return { error: "Proposals only apply to TS tickets (a key like TS-123).", ok: false, status: 400 };
  }
  const valid = validateActionArgs(ticketKey, draft.args);
  if (!valid.ok) {
    return { error: valid.error, ok: false, status: 400 };
  }
  const normalizedSource = normalizeSource(source);
  if (!normalizedSource) {
    return { error: "A proposal's source must be an assist run or the browser agent.", ok: false, status: 400 };
  }
  if (draft.rationale !== undefined && typeof draft.rationale !== "string") {
    return { error: "rationale must be a string when given.", ok: false, status: 400 };
  }
  const store = deps.store;
  if (!store) {
    return { error: "Proposals are unavailable: Redis isn't configured.", ok: false, status: 503 };
  }

  try {
    const labelled = await verifiedAssignee(deps, valid.args, actor);
    if (!labelled.ok) {
      return labelled;
    }
    const args = labelled.args;
    const facts = await deps.ticket(ticketKey, actor.accountId);
    if (args.operation === "slack_thread_reply") {
      const conversation = await deps.slack.linkedConversation(ticketKey, facts?.cpKeys ?? [], args.channel, args.threadTs);
      if (!conversation) {
        return { error: notLinkedMessage(ticketKey), ok: false, status: 400 };
      }
    }

    const now = deps.now();
    const pending = (await loadProposals(store, ticketKey)).filter((proposal) => proposal.status === "pending" && !isExpired(proposal, now));
    if (pending.length >= MAX_PENDING_PER_TICKET) {
      return { error: `${ticketKey} already has ${MAX_PENDING_PER_TICKET} proposals waiting for review - approve or reject some first.`, ok: false, status: 429 };
    }

    const rationale = draft.rationale?.trim().slice(0, RATIONALE_MAX_CHARS);
    const proposal: ActionProposal = {
      args,
      createdAt: now.toISOString(),
      createdBy: actor.displayName,
      expectedVersion: facts?.updated ?? null,
      expiresAt: new Date(now.getTime() + PROPOSAL_LIFETIME_MS).toISOString(),
      id: deps.newId(),
      ...(rationale ? { rationale } : {}),
      source: normalizedSource,
      status: "pending",
      ticketKey,
    };
    await store.set(keys.proposal(proposal.id), proposal, PROPOSAL_TTL_SECONDS);
    await store.pushCapped(keys.proposalIndex(ticketKey), proposal.id, PROPOSAL_INDEX_KEEP, PROPOSAL_TTL_SECONDS);
    return { ok: true, proposal };
  } catch (error) {
    console.warn(`Actions: couldn't store a proposal for ${ticketKey}.`, errorText(error));
    return { error: "Couldn't save the proposal right now. Try again in a moment.", ok: false, status: 503 };
  }
}

/* Approving and rejecting hold a short per-proposal lock, so two reviewers can't both execute one proposal. */
async function withProposalLock(store: ActionStore, id: string, actor: ActionActor, work: () => Promise<ProposalDecisionResult>): Promise<ProposalDecisionResult> {
  const lockKey = keys.proposalLock(id);
  if (!(await store.setIfAbsent(lockKey, actor.accountId, PROPOSAL_LOCK_SECONDS))) {
    return { error: "Someone is deciding on this proposal right now - reload in a moment.", ok: false, status: 409 };
  }
  try {
    return await work();
  } finally {
    await store.del(lockKey).catch((error: unknown) => console.warn(`Actions: couldn't release the lock on proposal ${id}.`, errorText(error)));
  }
}

async function loadPending(store: ActionStore, id: string, now: Date): Promise<{ ok: true; stored: StoredProposal } | Failure> {
  const stored = await store.get<StoredProposal>(keys.proposal(id));
  if (!stored) {
    return { error: "That proposal doesn't exist (proposals are kept for 7 days).", ok: false, status: 404 };
  }
  if (stored.status !== "pending") {
    return { error: `This proposal was already ${stored.status}.`, ok: false, status: 409 };
  }
  if (isExpired(stored, now)) {
    await store.set(keys.proposal(id), { ...stored, status: "expired" } satisfies StoredProposal, PROPOSAL_TTL_SECONDS);
    return { error: "This proposal expired (they last 24 hours) - ask for a fresh one.", ok: false, status: 410 };
  }
  const executingMs = stored.executingSince ? Date.parse(stored.executingSince) : Number.NaN;
  if (Number.isFinite(executingMs) && now.getTime() - executingMs < EXECUTING_HOLD_MS) {
    return {
      error: "An earlier approval of this proposal started writing and didn't finish - it may have happened. Check Jira/Slack before doing it again yourself.",
      ok: false,
      status: 409,
    };
  }
  return { ok: true, stored };
}

/** approveProposal with explicit deps - what the tests drive. Never throws. */
export async function approveProposalWith(
  deps: ActionServiceDeps,
  id: string,
  request: ApproveProposalRequest,
  actor: ActionActor,
): Promise<ProposalDecisionResult> {
  if (typeof id !== "string" || !PROPOSAL_ID_PATTERN.test(id)) {
    return { error: "Not a proposal id.", ok: false, status: 400 };
  }
  if (!request || typeof request !== "object") {
    return { error: "Expected { idempotencyKey, args?, force? }.", ok: false, status: 400 };
  }
  const store = deps.store;
  if (!store) {
    return { error: "Proposals are unavailable: Redis isn't configured.", ok: false, status: 503 };
  }

  try {
    return await withProposalLock(store, id, actor, async () => {
      const now = deps.now();
      const loaded = await loadPending(store, id, now);
      if (!loaded.ok) {
        return loaded;
      }
      const { stored } = loaded;

      let args = stored.args;
      if (request.args !== undefined) {
        const edited = validateActionArgs(stored.ticketKey, request.args);
        if (!edited.ok) {
          return { error: edited.error, ok: false, status: 400 };
        }
        if (edited.args.operation !== stored.args.operation) {
          return { error: `An edit must keep the same kind of action (${stored.args.operation}) - reject this one and do the other action yourself.`, ok: false, status: 400 };
        }
        args = edited.args;
      }

      await store.set(keys.proposal(id), { ...stored, executingSince: now.toISOString() } satisfies StoredProposal, PROPOSAL_TTL_SECONDS);
      const result = await executeActionWith(
        deps,
        {
          args,
          expectedVersion: stored.expectedVersion,
          force: request.force === true,
          idempotencyKey: request.idempotencyKey,
          proposalId: stored.id,
          ticketKey: stored.ticketKey,
        },
        actor,
      );
      if (!result.ok) {
        /* Refused before writing (validation, rate limit, in progress): nothing happened, so it can be approved again. */
        await store.set(keys.proposal(id), { ...stored, executingSince: undefined } satisfies StoredProposal, PROPOSAL_TTL_SECONDS);
        return result;
      }

      const { execution } = result;
      const approved = execution.status === "succeeded" || execution.status === "uncertain" || execution.status === "duplicate";
      /* The proposal keeps the args as proposed; the execution records what was actually written (an edit shows as the difference). */
      const next: StoredProposal = approved
        ? { ...stored, decidedAt: now.toISOString(), decidedBy: actor.displayName, executingSince: undefined, executionId: execution.id, lastError: undefined, status: "approved" }
        : { ...stored, executingSince: undefined, lastError: execution.error ?? execution.status };
      await store.set(keys.proposal(id), next, PROPOSAL_TTL_SECONDS);
      return { execution, ok: true, proposal: toProposal(next, now) };
    });
  } catch (error) {
    console.warn(`Actions: approving proposal ${id} failed.`, errorText(error));
    return { error: "Couldn't approve the proposal right now - check the action log before trying again.", ok: false, status: 503 };
  }
}

/** rejectProposal with explicit deps - what the tests drive. Never throws. */
export async function rejectProposalWith(deps: ActionServiceDeps, id: string, actor: ActionActor): Promise<ProposalDecisionResult> {
  if (typeof id !== "string" || !PROPOSAL_ID_PATTERN.test(id)) {
    return { error: "Not a proposal id.", ok: false, status: 400 };
  }
  const store = deps.store;
  if (!store) {
    return { error: "Proposals are unavailable: Redis isn't configured.", ok: false, status: 503 };
  }

  try {
    return await withProposalLock(store, id, actor, async () => {
      const now = deps.now();
      const loaded = await loadPending(store, id, now);
      if (!loaded.ok) {
        return loaded;
      }
      const next: StoredProposal = { ...loaded.stored, decidedAt: now.toISOString(), decidedBy: actor.displayName, status: "rejected" };
      await store.set(keys.proposal(id), next, PROPOSAL_TTL_SECONDS);
      return { ok: true, proposal: toProposal(next, now) };
    });
  } catch (error) {
    console.warn(`Actions: rejecting proposal ${id} failed.`, errorText(error));
    return { error: "Couldn't reject the proposal right now. Try again in a moment.", ok: false, status: 503 };
  }
}

/** listTicketActions with explicit deps - what the tests drive. Never throws. */
export async function listTicketActionsWith(deps: Pick<ActionServiceDeps, "now" | "store">, ticketKey: string): Promise<TicketActionsResponse> {
  const store = deps.store;
  if (!store || !TICKET_KEY_PATTERN.test(ticketKey)) {
    return { executions: [], proposals: [] };
  }
  try {
    const now = deps.now();
    const [stored, executions] = await Promise.all([loadProposals(store, ticketKey), store.range<ActionExecution>(keys.ticketLog(ticketKey), RECENT_EXECUTIONS)]);
    const proposals = stored.map((proposal) => toProposal(proposal, now));
    const newest = (a: ActionProposal, b: ActionProposal): number => Date.parse(b.decidedAt ?? b.createdAt) - Date.parse(a.decidedAt ?? a.createdAt);
    const pending = proposals.filter((proposal) => proposal.status === "pending").sort(newest);
    const decided = proposals
      .filter((proposal) => proposal.status !== "pending")
      .sort(newest)
      .slice(0, RECENT_DECIDED_PROPOSALS);
    return { executions, proposals: [...pending, ...decided] };
  } catch (error) {
    console.warn(`Actions: couldn't list actions for ${ticketKey}.`, errorText(error));
    return { executions: [], proposals: [] };
  }
}

/* --------------------------------------------------------------- wiring */

function factsFrom(ticket: TrackerTicket): TicketFacts {
  return { cpKeys: ticket.cps.map((cp) => cp.key), priority: ticket.priority, summary: ticket.summary || null, updated: ticket.updated || null };
}

/* The snapshot row; a ticket outside the tracker's scope falls back to its (cached) detail panel read. */
async function trackerTicketFacts(ticketKey: string, accountId: string): Promise<TicketFacts | null> {
  const snapshot = await getTrackerSnapshot();
  const row = snapshot?.tickets.find((ticket) => ticket.key === ticketKey);
  if (row) {
    return factsFrom(row);
  }
  const detail = await getTrackerDetail(ticketKey, accountId);
  return detail.ok ? factsFrom(detail.detail.ticket) : null;
}

function defaultDeps(): ActionServiceDeps {
  const jiraConfig = jiraWriteConfigFromEnv();
  const jiraMissing = "Jira isn't configured on the server (JIRA_BASE_URL).";
  return {
    credentials: (accountId) => getJiraCredentialsForAccount(accountId),
    invalidate: invalidateTrackerDetail,
    jira: {
      getVersion: (ticketKey, creds) => (jiraConfig ? getTicketVersion(ticketKey, creds, jiraConfig) : Promise.resolve({ error: jiraMissing, ok: false as const })),
      userName: (accountId, creds) => (jiraConfig ? getJiraUserName(accountId, creds, jiraConfig) : Promise.resolve({ error: jiraMissing, ok: false as const })),
      write: (ticketKey, args, creds) =>
        jiraConfig ? executeJiraWrite(ticketKey, args, creds, jiraConfig) : Promise.resolve({ error: jiraMissing, status: "failed" as const }),
    },
    newId: () => randomUUID(),
    now: () => new Date(),
    slack: {
      linkedConversation: (ticketKey, cpKeys, channel, threadTs) => findLinkedConversation(ticketKey, cpKeys, channel, threadTs, getConversationsForTickets),
      write: (args, context) => executeSlackWrite(args, context, defaultSlackWriteDeps(jiraConfig?.baseUrl ?? "")),
    },
    store: redisActionStore(),
    ticket: trackerTicketFacts,
  };
}

/** A person's own action (their click is the approval), or an approved proposal's. Never throws. */
export async function executeAction(
  request: ExecuteActionRequest & { proposalId?: string },
  actor: ActionActor,
): Promise<{ ok: true; execution: ActionExecution } | { ok: false; error: string; status: number }> {
  return executeActionWith(defaultDeps(), request, actor);
}

/** Store an AI Assist / browser-agent suggestion for a person to review. Never throws. */
export async function createProposal(
  draft: ActionDraft,
  source: ProposalSource,
  actor: ActionActor,
): Promise<{ ok: true; proposal: ActionProposal } | { ok: false; error: string; status: number }> {
  return createProposalWith(defaultDeps(), draft, source, actor);
}

/** Approve a pending proposal (optionally edited) - executes it as `actor`. Never throws. */
export async function approveProposal(id: string, request: ApproveProposalRequest, actor: ActionActor): Promise<ProposalDecisionResult> {
  return approveProposalWith(defaultDeps(), id, request, actor);
}

/** Reject a pending proposal. Never throws. */
export async function rejectProposal(id: string, actor: ActionActor): Promise<ProposalDecisionResult> {
  return rejectProposalWith(defaultDeps(), id, actor);
}

/** A ticket's proposals (pending first, expired marked) and its last 20 executions. Never throws. */
export async function listTicketActions(ticketKey: string): Promise<TicketActionsResponse> {
  return listTicketActionsWith({ now: () => new Date(), store: redisActionStore() }, ticketKey);
}
