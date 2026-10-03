import { randomUUID } from "node:crypto";

import { agentModel } from "@/lib/assist/config";
import { retryAfterText, takeRateLimit, upstashRateLimitCounter } from "@/lib/assist/rateLimit";
import { getRedis, isRedisConfigured } from "@/lib/redis";

import type { InvestigateArgs, InvestigationOutcome } from "@/lib/assist/investigate";
import type { StoredInvestigationResult } from "@/lib/assist/result";
import type { ActionActor, AssistRun } from "@/lib/workspace/types";

/**
 * Assist investigation runs in Redis. The POST route creates a queued run
 * and answers 202 straight away; the investigation itself runs after the
 * response (next/server `after`), and the panel polls the run until it ends.
 *
 * - assist:run:<id>             the run (TTL 14 days)
 * - assist:runs_for:<KEY>       the ticket's last 10 run ids, newest first (list, same TTL)
 * - assist:startlock:<KEY>      serializes starts on one ticket for a few seconds
 * - assist:claim:<id>           the one worker allowed to execute a run
 * - assist:rl:investigate:<accountId>:<hour>   20 investigations per person per hour
 *
 * A run that has sat in queued/running for more than 6 minutes is reported as
 * failed ("timed out"): the route's maxDuration is 300s, so by then its worker
 * is gone for sure, and a crashed worker must not leave the panel spinning or
 * block the next run forever.
 *
 * Everything takes an injectable store and clock, so scripts/test-assist.ts
 * runs it in memory.
 */

export const RUN_TTL_SECONDS = 14 * 86_400;
export const RUNS_PER_TICKET = 10;
export const STALE_RUN_MS = 6 * 60_000;
export const INVESTIGATIONS_PER_HOUR = 20;
const START_LOCK_SECONDS = 15;
const CLAIM_SECONDS = 600;
const START_LOCK_WAITS = 6;
const START_LOCK_WAIT_MS = 250;

/** The stored run: the contract's AssistRun plus who started it (by account), and the result's dropped actions. */
export interface StoredAssistRun extends AssistRun {
  result?: StoredInvestigationResult;
  /* accountId of the person who started it; `startedBy` is their display name. Never sent to the browser. */
  startedByAccountId: string;
}

/* The operations the run store needs, over the Upstash client - injectable so the tests run in memory. */
export interface AssistRunRedis {
  del(key: string): Promise<void>;
  get<T>(key: string): Promise<T | null>;
  incr(key: string, ttlSeconds: number): Promise<number>;
  /* LPUSH + LTRIM to `keep` + EXPIRE. */
  lpushCapped(key: string, value: string, keep: number, ttlSeconds: number): Promise<void>;
  lrange(key: string, count: number): Promise<string[]>;
  mget<T>(keys: string[]): Promise<Array<T | null>>;
  set(key: string, value: unknown, ttlSeconds: number): Promise<void>;
  /* SET NX EX - true only for the call that created the key. */
  setIfAbsent(key: string, value: unknown, ttlSeconds: number): Promise<boolean>;
}

export function upstashAssistRunRedis(): AssistRunRedis {
  const redis = getRedis();
  const counter = upstashRateLimitCounter();
  return {
    del: async (key) => {
      await redis.del(key);
    },
    get: (key) => redis.get(key),
    incr: (key, ttlSeconds) => counter.incr(key, ttlSeconds),
    lpushCapped: async (key, value, keep, ttlSeconds) => {
      const pipeline = redis.pipeline();
      pipeline.lpush(key, value);
      pipeline.ltrim(key, 0, keep - 1);
      pipeline.expire(key, ttlSeconds);
      await pipeline.exec();
    },
    lrange: async (key, count) => (await redis.lrange(key, 0, count - 1)).map(String),
    mget: async <T>(keys: string[]) => (keys.length === 0 ? [] : redis.mget<Array<T | null>>(...keys)),
    set: async (key, value, ttlSeconds) => {
      await redis.set(key, value, { ex: ttlSeconds });
    },
    setIfAbsent: async (key, value, ttlSeconds) => (await redis.set(key, value, { ex: ttlSeconds, nx: true })) === "OK",
  };
}

export interface RunStoreDeps {
  newId: () => string;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  store: AssistRunRedis;
}

export function defaultRunStoreDeps(): RunStoreDeps | null {
  if (!isRedisConfigured()) {
    return null;
  }
  return {
    newId: randomUUID,
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    store: upstashAssistRunRedis(),
  };
}

const runKey = (id: string): string => `assist:run:${id}`;
const ticketRunsKey = (ticketKey: string): string => `assist:runs_for:${ticketKey}`;

/* ----------------------------------------------------------------- views */

function isOpen(run: AssistRun): boolean {
  return run.status === "queued" || run.status === "running";
}

/** A queued/running run past the stale limit reads as failed ("timed out"). Pure. */
export function effectiveRun<T extends AssistRun>(run: T, now: Date): T {
  if (!isOpen(run)) {
    return run;
  }
  const since = Date.parse(run.startedAt ?? run.createdAt);
  if (Number.isNaN(since) || now.getTime() - since <= STALE_RUN_MS) {
    return run;
  }
  return {
    ...run,
    error: run.status === "queued" ? "The investigation timed out before it started." : "The investigation timed out.",
    finishedAt: new Date(since + STALE_RUN_MS).toISOString(),
    status: "failed",
  };
}

/** What the API returns: the run without the starter's accountId. */
export function toPublicRun(run: StoredAssistRun): AssistRun {
  const copy: AssistRun & { startedByAccountId?: string } = { ...run };
  delete copy.startedByAccountId;
  return copy;
}

export async function readRunWith(id: string, deps: RunStoreDeps): Promise<StoredAssistRun | null> {
  const run = await deps.store.get<StoredAssistRun>(runKey(id));
  return run ? effectiveRun(run, deps.now()) : null;
}

/** A ticket's runs, newest first (up to RUNS_PER_TICKET). */
export async function listRunsWith(ticketKey: string, deps: RunStoreDeps, limit = RUNS_PER_TICKET): Promise<StoredAssistRun[]> {
  const ids = await deps.store.lrange(ticketRunsKey(ticketKey), Math.min(limit, RUNS_PER_TICKET));
  const runs = await deps.store.mget<StoredAssistRun>(ids.map(runKey));
  const now = deps.now();
  return runs
    .filter((run): run is StoredAssistRun => run !== null && run.ticketKey === ticketKey)
    .map((run) => effectiveRun(run, now))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

async function findOpenRun(ticketKey: string, deps: RunStoreDeps): Promise<StoredAssistRun | null> {
  const runs = await listRunsWith(ticketKey, deps, 3);
  return runs.find(isOpen) ?? null;
}

/* ----------------------------------------------------------------- start */

export type StartResult =
  | { ok: true; run: StoredAssistRun; started: boolean }
  | { error: string; ok: false; retryAfterSeconds?: number; status: number };

/**
 * Starts an investigation of `ticketKey` for `actor`, or returns the one
 * already in progress on that ticket (`started: false`) - a second click, or
 * a colleague on the same ticket, joins it instead of paying for another.
 * The caller executes a started run with runInvestigation(run.id).
 */
export async function startInvestigationWith(ticketKey: string, actor: ActionActor, deps: RunStoreDeps, model: string): Promise<StartResult> {
  const open = await findOpenRun(ticketKey, deps);
  if (open) {
    return { ok: true, run: open, started: false };
  }

  const lockKey = `assist:startlock:${ticketKey}`;
  if (!(await deps.store.setIfAbsent(lockKey, "1", START_LOCK_SECONDS))) {
    /* Someone is creating a run on this ticket right now: join theirs once it is visible. */
    for (let attempt = 0; attempt < START_LOCK_WAITS; attempt++) {
      await deps.sleep(START_LOCK_WAIT_MS);
      const theirs = await findOpenRun(ticketKey, deps);
      if (theirs) {
        return { ok: true, run: theirs, started: false };
      }
    }
    return { error: "An investigation is already starting on this ticket - try again in a moment.", ok: false, status: 409 };
  }

  try {
    /* Re-check under the lock: a start that finished between our first look and the lock. */
    const raced = await findOpenRun(ticketKey, deps);
    if (raced) {
      return { ok: true, run: raced, started: false };
    }

    const now = deps.now();
    const limit = await takeRateLimit(deps.store, { accountId: actor.accountId, bucket: "investigate", limit: INVESTIGATIONS_PER_HOUR, now });
    if (!limit.ok) {
      return {
        error: `You've started ${INVESTIGATIONS_PER_HOUR} investigations in the last hour - try again ${retryAfterText(limit.retryAfterSeconds)}.`,
        ok: false,
        retryAfterSeconds: limit.retryAfterSeconds,
        status: 429,
      };
    }

    const run: StoredAssistRun = {
      createdAt: now.toISOString(),
      id: deps.newId(),
      kind: "investigation",
      model,
      startedBy: actor.displayName,
      startedByAccountId: actor.accountId,
      status: "queued",
      ticketKey,
      toolCalls: 0,
    };
    await deps.store.set(runKey(run.id), run, RUN_TTL_SECONDS);
    await deps.store.lpushCapped(ticketRunsKey(ticketKey), run.id, RUNS_PER_TICKET, RUN_TTL_SECONDS);
    return { ok: true, run, started: true };
  } finally {
    await deps.store.del(lockKey).catch(() => undefined);
  }
}

/* ------------------------------------------------------------------- run */

export type Investigate = (args: InvestigateArgs) => Promise<InvestigationOutcome>;

/**
 * Executes a queued run: running -> succeeded/failed, with the tool-call
 * count and model recorded. A run that isn't queued, or that another worker
 * already claimed, is left alone. Never throws; resolves to the final run (or null).
 */
export async function runInvestigationWith(id: string, deps: RunStoreDeps, investigate: Investigate): Promise<StoredAssistRun | null> {
  try {
    const queued = await deps.store.get<StoredAssistRun>(runKey(id));
    if (!queued || queued.status !== "queued" || effectiveRun(queued, deps.now()).status !== "queued") {
      return queued ? effectiveRun(queued, deps.now()) : null;
    }
    if (!(await deps.store.setIfAbsent(`assist:claim:${id}`, "1", CLAIM_SECONDS))) {
      return queued;
    }

    let current: StoredAssistRun = { ...queued, startedAt: deps.now().toISOString(), status: "running" };
    await deps.store.set(runKey(id), current, RUN_TTL_SECONDS);

    let outcome: InvestigationOutcome;
    try {
      outcome = await investigate({
        actor: { accountId: queued.startedByAccountId, displayName: queued.startedBy },
        onProgress: async (toolCalls) => {
          current = { ...current, toolCalls };
          await deps.store.set(runKey(id), current, RUN_TTL_SECONDS).catch(() => undefined);
        },
        runId: id,
        ticketKey: queued.ticketKey,
      });
    } catch (error) {
      outcome = { error: error instanceof Error ? error.message : String(error), model: current.model, ok: false, toolCalls: current.toolCalls };
    }

    const finishedAt = deps.now().toISOString();
    const finished: StoredAssistRun = outcome.ok
      ? { ...current, finishedAt, model: outcome.model, result: outcome.result, status: "succeeded", toolCalls: outcome.toolCalls }
      : { ...current, error: outcome.error, finishedAt, model: outcome.model, status: "failed", toolCalls: outcome.toolCalls };
    await deps.store.set(runKey(id), finished, RUN_TTL_SECONDS);
    return finished;
  } catch (error) {
    console.warn(`Assist: run ${id} couldn't be executed.`, error instanceof Error ? error.message : error);
    return null;
  }
}

/* ------------------------------------------------------------ live store */

const NO_REDIS = "Assist needs Redis (UPSTASH_REDIS_REST_URL) to keep investigations.";

/** startInvestigationWith over the live Redis. Never throws. */
export async function startInvestigation(ticketKey: string, actor: ActionActor): Promise<StartResult> {
  const deps = defaultRunStoreDeps();
  if (!deps) {
    return { error: NO_REDIS, ok: false, status: 503 };
  }
  try {
    return await startInvestigationWith(ticketKey, actor, deps, agentModel());
  } catch (error) {
    console.warn(`Assist: couldn't start an investigation of ${ticketKey}.`, error instanceof Error ? error.message : error);
    return { error: "Couldn't start the investigation right now. Try again in a moment.", ok: false, status: 503 };
  }
}

/**
 * Executes a queued run with the live agent. The agent is imported lazily: it
 * pulls in the LLM client, Jira, Slack and the actions service, none of which
 * reading or listing runs needs. Never throws.
 */
export async function runInvestigation(id: string): Promise<StoredAssistRun | null> {
  const deps = defaultRunStoreDeps();
  if (!deps) {
    return null;
  }
  return runInvestigationWith(id, deps, async (args) => {
    const { investigateTicket } = await import("@/lib/assist/investigate");
    return investigateTicket(args);
  });
}

/** One run by id, with staleness applied. null when unknown or unreadable. Never throws. */
export async function getRun(id: string): Promise<StoredAssistRun | null> {
  const deps = defaultRunStoreDeps();
  if (!deps) {
    return null;
  }
  try {
    return await readRunWith(id, deps);
  } catch (error) {
    console.warn(`Assist: couldn't read run ${id}.`, error instanceof Error ? error.message : error);
    return null;
  }
}

/** A ticket's recent runs, newest first. [] when unreadable. Never throws. */
export async function listRunsForTicket(ticketKey: string): Promise<StoredAssistRun[]> {
  const deps = defaultRunStoreDeps();
  if (!deps) {
    return [];
  }
  try {
    return await listRunsWith(ticketKey, deps);
  } catch (error) {
    console.warn(`Assist: couldn't list the runs of ${ticketKey}.`, error instanceof Error ? error.message : error);
    return [];
  }
}
