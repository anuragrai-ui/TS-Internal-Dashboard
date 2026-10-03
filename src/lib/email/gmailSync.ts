import { getDb, isDatabaseConfigured, redactDbError } from "@/lib/db/client";
import { createGmailClient, GmailApiError } from "@/lib/email/gmailApi";
import { parseGmailMessage } from "@/lib/email/mime";
import { intakeTicketKey, planIntake, skipReason } from "@/lib/email/rules";
import { emailMessageRecord, postgresEmailStore } from "@/lib/email/store";
import { defaultGoogleDeps, getGoogleAccessToken, getGoogleConnectionStatus, invalidateGoogleAccessToken, supportMailboxAddress } from "@/lib/google/oauth";
import { getRedis, isRedisConfigured } from "@/lib/redis";

import type { GmailClient } from "@/lib/email/gmailApi";
import type { SkipReason } from "@/lib/email/rules";
import type { EmailStore, EmailSyncState } from "@/lib/email/store";

/**
 * Brings customer email from the support Gmail mailbox into the case store.
 *
 * Like the Jira case sync there is no cron (Vercel Hobby): the notification
 * poll calls gmailSyncTick after its response, at most once every 2 minutes
 * across all browsers (Redis throttle + SET NX lock), and it stops starting
 * new messages after ~35 seconds. Each tick:
 *
 * 1. finds new message ids:
 *    - first run (no saved history id): the mailbox's current historyId is
 *      read FIRST, then messages.list q="in:inbox newer_than:14d" - so
 *      anything arriving during the listing is caught by step (b) next time
 *    - afterwards: users.history.list from the saved historyId, messageAdded
 *      only. Gmail keeps history for about a week; a 404 means it expired,
 *      and the 14-day window is listed again (already-stored messages are
 *      skipped by id, so that costs reads, not duplicates)
 * 2. fetches each one (format=full), skips non-customer mail (rules.ts),
 *    and stores it per planIntake. Idempotent on the Gmail message id.
 *
 * Message ids not yet handled are kept in sync_state ("pending"), with a
 * retry count, so a budget cut or a failure never loses one. Status and
 * errors live in sync_state under "gmail_intake". Never throws.
 */

export const INITIAL_QUERY = "in:inbox newer_than:14d";
const LOCK_KEY = "email:sync:lock";
const THROTTLE_KEY = "email:sync:throttle";
const MANUAL_KEY = "email:sync:manual";
const LOCK_SECONDS = 120;
const THROTTLE_SECONDS = 120;
const MANUAL_THROTTLE_SECONDS = 30;
const DEFAULT_BUDGET_MS = 35_000;
/* No message starts with less than this left: one fetch and one transaction. */
const PER_MESSAGE_RESERVE_MS = 4_000;
const MAX_INITIAL_MESSAGES = 500;
const MAX_HISTORY_PAGES = 10;
const MAX_PENDING = 1_000;
const MAX_ATTEMPTS = 3;
const MAX_TICK_ERRORS = 10;
/* Labels that are never a customer's message to us. */
const IGNORED_LABELS = new Set(["DRAFT", "SENT", "SPAM", "TRASH"]);

export interface EmailSyncLocks {
  del(key: string): Promise<void>;
  setIfAbsent(key: string, ttlSeconds: number): Promise<boolean>;
}

export interface GmailSyncDeps {
  gmail: GmailClient;
  locks: EmailSyncLocks;
  now: () => number;
  store: EmailStore;
  supportAddress: string;
}

export type EmailSyncSkip = "already_running" | "db_unconfigured" | "mailbox_not_connected" | "mailbox_unconfigured" | "redis_unconfigured" | "throttled";

export interface EmailSyncResult {
  error?: string;
  ok: boolean;
  skipped?: EmailSyncSkip;
  summary?: NonNullable<EmailSyncState["lastTick"]>;
}

export interface EmailSyncOptions {
  budgetMs?: number;
  /* Manual runs skip the 2-minute throttle (they have their own) but still take the lock. */
  force?: boolean;
  trigger?: "manual" | "poll";
}

interface TickContext {
  deadlineMs: number;
  deps: GmailSyncDeps;
  errors: string[];
  processed: number;
  skipped: number;
  state: EmailSyncState;
}

function errorText(error: unknown): string {
  return error instanceof GmailApiError ? error.message : redactDbError(error);
}

function noteError(ctx: TickContext, message: string): void {
  if (ctx.errors.length < MAX_TICK_ERRORS) {
    ctx.errors.push(message);
  }
}

function enqueue(state: EmailSyncState, ids: string[]): void {
  const known = new Set(state.pending.map((entry) => entry.id));
  for (const id of ids) {
    if (!known.has(id) && state.pending.length < MAX_PENDING) {
      state.pending.push({ attempts: 0, id });
      known.add(id);
    }
  }
}

/* -------------------------------------------------------------- discover */

/** The 14-day inbox window, oldest first, after pinning the history id the next tick continues from. */
async function initialSync(ctx: TickContext): Promise<void> {
  const profile = await ctx.deps.gmail.getProfile();
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const page = await ctx.deps.gmail.listMessages(INITIAL_QUERY, pageToken);
    ids.push(...(page.messages ?? []).map((message) => message.id));
    pageToken = page.nextPageToken;
  } while (pageToken && ids.length < MAX_INITIAL_MESSAGES);
  /* messages.list is newest first; cases should be created in the order the mail arrived. */
  enqueue(ctx.state, ids.slice(0, MAX_INITIAL_MESSAGES).reverse());
  ctx.state.historyId = profile.historyId;
  ctx.state.initialSyncAt = new Date(ctx.deps.now()).toISOString();
}

/** New messages since the saved history id. A 404 (history expired) falls back to the 14-day window. */
async function historySync(ctx: TickContext, startHistoryId: string): Promise<void> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  let latest: string | null = null;
  let lastRecord: string | null = null;
  let pages = 0;
  try {
    do {
      const page = await ctx.deps.gmail.listHistory(startHistoryId, pageToken);
      for (const record of page.history ?? []) {
        for (const added of record.messagesAdded ?? []) {
          const message = added.message;
          if (message?.id && !(message.labelIds ?? []).some((label) => IGNORED_LABELS.has(label))) {
            ids.push(message.id);
          }
        }
        lastRecord = record.id ?? lastRecord;
      }
      latest = page.historyId ?? latest;
      pageToken = page.nextPageToken;
      pages += 1;
    } while (pageToken && pages < MAX_HISTORY_PAGES);
  } catch (error) {
    if (error instanceof GmailApiError && error.status === 404) {
      noteError(ctx, "Gmail's change history expired (over a week without a sync) - re-reading the last 14 days of the inbox.");
      ctx.state.historyId = null;
      await initialSync(ctx);
      return;
    }
    throw error;
  }
  enqueue(ctx.state, ids);
  /* Stopped early on a long backlog: continue from the last record read, not from "now", or the rest would be skipped. */
  ctx.state.historyId = pageToken ? (lastRecord ?? startHistoryId) : (latest ?? startHistoryId);
}

/* --------------------------------------------------------------- ingest */

export type IngestOutcome = { kind: "duplicate" } | { caseId: string; kind: "stored" } | { kind: "skipped"; reason: SkipReason };

/** Stores one Gmail message per the rules. Exported for tests. Throws on a Gmail or database failure. */
export async function ingestMessage(deps: Pick<GmailSyncDeps, "gmail" | "now" | "store" | "supportAddress">, id: string): Promise<IngestOutcome> {
  if (await deps.store.hasMessage(id)) {
    return { kind: "duplicate" };
  }
  const email = parseGmailMessage(await deps.gmail.getMessage(id), deps.now());
  const reason = skipReason(email, deps.supportAddress);
  if (reason) {
    return { kind: "skipped", reason };
  }
  const key = intakeTicketKey(email);
  const threadCase = await deps.store.findCaseByThread(email.threadId);
  const keyCase = key && (!threadCase || !threadCase.jiraKey) ? await deps.store.findCaseByJiraKey(key) : null;
  const plan = planIntake(email, { keyCase, threadCase });
  const { caseId } = await deps.store.applyIntake(plan, emailMessageRecord(email, deps.supportAddress), email.from);
  if (plan.kind === "append" && plan.linkKey) {
    const linked = await deps.store.linkCase(caseId, plan.linkKey, null);
    if (!linked.ok) {
      console.warn(`Email intake: couldn't link a thread to ${plan.linkKey}: ${linked.error}`);
    }
    return { caseId: linked.ok ? linked.caseId : caseId, kind: "stored" };
  }
  return { caseId, kind: "stored" };
}

async function processPending(ctx: TickContext): Promise<void> {
  const queue = [...ctx.state.pending];
  for (const entry of queue) {
    if (ctx.deps.now() >= ctx.deadlineMs - PER_MESSAGE_RESERVE_MS) {
      break;
    }
    try {
      const outcome = await ingestMessage(ctx.deps, entry.id);
      if (outcome.kind === "skipped") {
        ctx.skipped += 1;
      } else if (outcome.kind === "stored") {
        ctx.processed += 1;
        ctx.state.processed += 1;
      }
      ctx.state.pending = ctx.state.pending.filter((candidate) => candidate.id !== entry.id);
    } catch (error) {
      if (error instanceof GmailApiError && error.status === 404) {
        /* Deleted from the mailbox before we got to it. */
        ctx.state.pending = ctx.state.pending.filter((candidate) => candidate.id !== entry.id);
        continue;
      }
      const message = `message ${entry.id}: ${errorText(error)}`;
      noteError(ctx, message);
      entry.attempts += 1;
      if (entry.attempts >= MAX_ATTEMPTS) {
        noteError(ctx, `message ${entry.id}: gave up after ${entry.attempts} attempts`);
        ctx.state.pending = ctx.state.pending.filter((candidate) => candidate.id !== entry.id);
      }
      /* The token is gone: every other message would fail the same way. */
      if (error instanceof GmailApiError && error.status === 401) {
        break;
      }
    }
  }
}

/* ------------------------------------------------------------------ tick */

/** One bounded step with explicit deps - what the tests drive. Never throws. */
export async function gmailSyncTickWith(deps: GmailSyncDeps, opts: EmailSyncOptions = {}): Promise<EmailSyncResult> {
  const startedMs = deps.now();
  try {
    /* Taken even when forced, so a manual run also holds off the poll's next tick. */
    const throttleFree = await deps.locks.setIfAbsent(THROTTLE_KEY, THROTTLE_SECONDS);
    if (!opts.force && !throttleFree) {
      return { ok: true, skipped: "throttled" };
    }
    if (!(await deps.locks.setIfAbsent(LOCK_KEY, LOCK_SECONDS))) {
      return { ok: true, skipped: "already_running" };
    }
  } catch (error) {
    const message = `Email sync lock unavailable: ${errorText(error)}`;
    console.warn(message);
    return { error: message, ok: false };
  }

  const ctx: TickContext = { deadlineMs: startedMs + (opts.budgetMs ?? DEFAULT_BUDGET_MS), deps, errors: [], processed: 0, skipped: 0, state: { historyId: null, initialSyncAt: null, lastError: null, lastTick: null, pending: [], processed: 0 } };
  let fatal: string | null = null;
  /* Until the saved state is read there is nothing safe to write back - saving defaults would forget the history id. */
  let loaded = false;
  try {
    ctx.state = await deps.store.loadState();
    loaded = true;
    if (ctx.state.historyId) {
      await historySync(ctx, ctx.state.historyId);
    } else {
      await initialSync(ctx);
    }
  } catch (error) {
    fatal = errorText(error);
    noteError(ctx, fatal);
  }
  if (loaded) {
    /* Even when listing failed, already-queued messages can still be stored. */
    try {
      await processPending(ctx);
    } catch (error) {
      fatal ??= errorText(error);
      noteError(ctx, errorText(error));
    }
  }

  const summary: NonNullable<EmailSyncState["lastTick"]> = {
    at: new Date(startedMs).toISOString(),
    durationMs: deps.now() - startedMs,
    errors: ctx.errors,
    processed: ctx.processed,
    skipped: ctx.skipped,
    trigger: opts.trigger ?? "poll",
  };
  ctx.state.lastTick = summary;
  if (ctx.errors.length > 0) {
    ctx.state.lastError = { at: summary.at, message: ctx.errors[0] ?? "" };
  }
  try {
    if (loaded) {
      await deps.store.saveState(ctx.state);
    }
  } catch (error) {
    /* Not saved: the next tick redoes this one's listing; stored messages are skipped by id. */
    fatal ??= `Could not save email sync progress: ${errorText(error)}`;
  } finally {
    await deps.locks.del(LOCK_KEY).catch(() => undefined);
  }
  if (fatal) {
    console.warn(`Email intake: ${fatal}`);
  }
  return fatal ? { error: fatal, ok: false, summary } : { ok: true, summary };
}

/* --------------------------------------------------------------- wiring */

type DepsOrSkip = { deps: GmailSyncDeps } | { skipped: EmailSyncSkip };

async function defaultDeps(): Promise<DepsOrSkip> {
  const supportAddress = supportMailboxAddress();
  if (!supportAddress) {
    return { skipped: "mailbox_unconfigured" };
  }
  const db = getDb();
  if (!db || !isDatabaseConfigured()) {
    return { skipped: "db_unconfigured" };
  }
  if (!isRedisConfigured()) {
    return { skipped: "redis_unconfigured" };
  }
  const google = defaultGoogleDeps();
  const status = await getGoogleConnectionStatus(google, "mailbox");
  if (status.state !== "connected") {
    return { skipped: status.state === "unconfigured" ? "mailbox_unconfigured" : "mailbox_not_connected" };
  }
  const redis = getRedis();
  return {
    deps: {
      gmail: createGmailClient({ accessToken: () => getGoogleAccessToken(google, "mailbox"), onUnauthorized: () => invalidateGoogleAccessToken(google, "mailbox") }),
      locks: {
        del: async (key) => {
          await redis.del(key);
        },
        setIfAbsent: async (key, ttlSeconds) => (await redis.set(key, new Date().toISOString(), { ex: ttlSeconds, nx: true })) === "OK",
      },
      now: Date.now,
      store: postgresEmailStore(db),
      supportAddress,
    },
  };
}

/** The poll's throttled tick: a no-op until the mailbox is connected and the database is set. Never throws. */
export async function gmailSyncTick(opts: EmailSyncOptions = {}): Promise<EmailSyncResult> {
  try {
    const resolved = await defaultDeps();
    if ("skipped" in resolved) {
      return { ok: false, skipped: resolved.skipped };
    }
    return await gmailSyncTickWith(resolved.deps, opts);
  } catch (error) {
    const message = errorText(error);
    console.warn(`Email intake: tick failed. ${message}`);
    return { error: message, ok: false };
  }
}

/** The inbox's "Sync now": at most once every 30 seconds across all browsers, then a forced tick. Never throws. */
export async function runManualEmailSync(): Promise<EmailSyncResult> {
  try {
    const resolved = await defaultDeps();
    if ("skipped" in resolved) {
      return { ok: false, skipped: resolved.skipped };
    }
    if (!(await resolved.deps.locks.setIfAbsent(MANUAL_KEY, MANUAL_THROTTLE_SECONDS))) {
      return { ok: true, skipped: "throttled" };
    }
    return await gmailSyncTickWith(resolved.deps, { force: true, trigger: "manual" });
  } catch (error) {
    return { error: errorText(error), ok: false };
  }
}
