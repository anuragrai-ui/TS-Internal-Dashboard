import { getRedis, isRedisConfigured } from "@/lib/redis";
import { getSlackTestChannel } from "@/lib/slackTestMode";

import type { EscalationLevel, Priority } from "@/lib/escalation/types";
import type { EscalationState, StoredEscalation } from "@/lib/escalation/stateMachine";

/**
 * Redis state for the shadow runner (src/lib/escalation/runner.ts). The
 * README's plan puts live state in Postgres; for the shadow phase, which
 * only ever posts to the test channel, Redis is enough and is already
 * attached.
 *
 * - esc:config            mode ("off" | "shadow"), go-live time, who switched it on
 * - esc:record:<cpKey>    one escalation: the state machine's record plus its Slack thread
 * - esc:tracked           set of CP keys with a record
 * - esc:ack:<cp>:<ep>     a ✅ acknowledgement for one episode, written by the Slack event handler
 * - esc:sent:<dedupeKey>  every message ever posted, so a retry never posts twice
 * - esc:parents:<date>    new threads opened that day (ET), for the daily cap
 * - esc:run:lock / esc:run:throttle / esc:run:last
 */

export type RunnerMode = "off" | "shadow";

export interface RunnerConfig {
  enabledAt?: string;
  /* Who switched shadow mode on - always told about escalation activity, even on tickets they don't own. */
  enabledByAccountId?: string;
  enabledByName?: string;
  /* First time shadow mode was switched on: CPs already waiting then are backlog, timed from here. */
  goLiveAt?: string;
  mode: RunnerMode;
}

export interface EscalationRecord extends StoredEscalation {
  /* The last state announced in the thread, so each transition is posted exactly once, even across a failed post. */
  announcedState?: EscalationState;
  /* TS tickets the thread has been told are waiting. */
  announcedTsKeys?: string[];
  /* Bumped on every state / ticket announcement - keeps their dedupe keys unique when a state comes back (fix_ready -> open -> fix_ready). */
  announceSeq?: number;
  /* Where the thread lives (the shadow channel). */
  channelId?: string;
  cpStatusName?: string;
  /* What the latest run computed - for the Escalations page. */
  lastPlan?: {
    effectivePriority: Priority;
    engineeringWaitBh: number;
    levelDue: EscalationLevel;
    nextLevel: { dueInBh: number; level: EscalationLevel } | null;
  };
  parentPostedAt?: string;
  permalink?: string;
  podName?: string;
  threadTs?: string;
  updatedAt?: string;
}

export interface AckRecord {
  ackedAt: string;
  name: string;
  slackUserId: string;
}

export interface SentRef {
  channel: string;
  ts: string;
}

export interface RunSummary {
  at: string;
  durationMs: number;
  error?: string;
  exceptions?: { actionable: number; info: number };
  heldBackByCaps: string[];
  posted: Array<{ cpKey: string; kind: string }>;
  skipped?: "already_running" | "killed" | "no_shadow_channel" | "off" | "unconfigured";
  trackedLive: number;
  trigger: "manual" | "poll";
}

const CONFIG_KEY = "esc:config";
const TRACKED_KEY = "esc:tracked";
const LOCK_KEY = "esc:run:lock";
const THROTTLE_KEY = "esc:run:throttle";
const LAST_RUN_KEY = "esc:run:last";
const LOCK_SECONDS = 600;
/* The ladder counts business hours, so a 10-minute cadence is plenty (the README's planned live polling interval). */
export const RUN_INTERVAL_SECONDS = 600;
const SENT_TTL_SECONDS = 180 * 86_400;
const ACK_TTL_SECONDS = 180 * 86_400;

function recordKey(cpKey: string): string {
  return `esc:record:${cpKey}`;
}

function ackKey(cpKey: string, episode: number): string {
  return `esc:ack:${cpKey}:${episode}`;
}

function sentKey(dedupeKey: string): string {
  return `esc:sent:${dedupeKey}`;
}

function parentsKey(day: string): string {
  return `esc:parents:${day}`;
}

/**
 * Shadow posts only ever go to the test channel (or a channel set just for
 * this): never a pod channel, so switching test mode off can't send shadow
 * threads to engineering. Read from the environment, not from Redis, so
 * nothing in the UI can point it anywhere else.
 */
export function getShadowChannel(): string | null {
  return process.env.ESCALATION_SHADOW_CHANNEL?.trim() || getSlackTestChannel();
}

export async function getRunnerConfig(): Promise<RunnerConfig> {
  if (!isRedisConfigured()) {
    return { mode: "off" };
  }
  const stored = await getRedis().get<RunnerConfig>(CONFIG_KEY);
  return stored?.mode === "shadow" ? stored : { ...stored, mode: "off" };
}

export async function setRunnerMode(mode: RunnerMode, by: { accountId: string; displayName: string }): Promise<RunnerConfig> {
  const current = await getRunnerConfig();
  const now = new Date().toISOString();
  const next: RunnerConfig =
    mode === "shadow"
      ? {
          enabledAt: now,
          enabledByAccountId: by.accountId,
          enabledByName: by.displayName,
          /* Kept across pause/resume: re-enabling must not turn every open escalation into backlog again. */
          goLiveAt: current.goLiveAt ?? now,
          mode,
        }
      : { ...current, mode };
  await getRedis().set(CONFIG_KEY, next);
  return next;
}

export async function loadRecords(): Promise<Map<string, EscalationRecord>> {
  const records = new Map<string, EscalationRecord>();
  if (!isRedisConfigured()) {
    return records;
  }
  const redis = getRedis();
  const keys = await redis.smembers(TRACKED_KEY);
  if (keys.length === 0) {
    return records;
  }
  const values = await redis.mget<Array<EscalationRecord | null>>(...keys.map(recordKey));
  keys.forEach((key, index) => {
    const value = values[index];
    if (value) {
      records.set(key, value);
    }
  });
  return records;
}

export async function loadRecord(cpKey: string): Promise<EscalationRecord | null> {
  return isRedisConfigured() ? getRedis().get<EscalationRecord>(recordKey(cpKey)) : null;
}

export async function saveRecord(record: EscalationRecord): Promise<void> {
  const redis = getRedis();
  await redis.set(recordKey(record.cpKey), record);
  await redis.sadd(TRACKED_KEY, record.cpKey);
}

export async function forgetRecord(cpKey: string): Promise<void> {
  const redis = getRedis();
  await redis.del(recordKey(cpKey));
  await redis.srem(TRACKED_KEY, cpKey);
}

export async function getAck(cpKey: string, episode: number): Promise<AckRecord | null> {
  return isRedisConfigured() ? getRedis().get<AckRecord>(ackKey(cpKey, episode)) : null;
}

/* True only for the first acknowledgement of an episode. */
export async function setAckIfFirst(cpKey: string, episode: number, ack: AckRecord): Promise<boolean> {
  return (await getRedis().set(ackKey(cpKey, episode), ack, { ex: ACK_TTL_SECONDS, nx: true })) === "OK";
}

export async function getSent(dedupeKey: string): Promise<SentRef | null> {
  return getRedis().get<SentRef>(sentKey(dedupeKey));
}

export async function markSent(dedupeKey: string, ref: SentRef): Promise<void> {
  await getRedis().set(sentKey(dedupeKey), ref, { ex: SENT_TTL_SECONDS });
}

export async function parentsOpenedOn(day: string): Promise<number> {
  return Number((await getRedis().get<number | string>(parentsKey(day))) ?? 0) || 0;
}

export async function countParentOpened(day: string): Promise<void> {
  const redis = getRedis();
  await redis.incr(parentsKey(day));
  await redis.expire(parentsKey(day), 3 * 86_400);
}

export async function acquireRunLock(): Promise<boolean> {
  return (await getRedis().set(LOCK_KEY, new Date().toISOString(), { ex: LOCK_SECONDS, nx: true })) === "OK";
}

export async function releaseRunLock(): Promise<void> {
  await getRedis().del(LOCK_KEY);
}

/* At most one poll-triggered run per interval across every open dashboard. */
export async function acquireRunThrottle(): Promise<boolean> {
  return (await getRedis().set(THROTTLE_KEY, new Date().toISOString(), { ex: RUN_INTERVAL_SECONDS, nx: true })) === "OK";
}

export async function saveLastRun(summary: RunSummary): Promise<void> {
  await getRedis().set(LAST_RUN_KEY, summary, { ex: 30 * 86_400 });
}

export async function getLastRun(): Promise<RunSummary | null> {
  return isRedisConfigured() ? getRedis().get<RunSummary>(LAST_RUN_KEY) : null;
}
