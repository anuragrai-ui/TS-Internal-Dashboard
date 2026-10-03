import { getRedis } from "@/lib/redis";

/**
 * Per-person hourly limits for Assist (60 summaries, 20 investigations).
 *
 * A fixed clock-hour window over one INCR per call: atomic, one round trip,
 * and the key expires on its own. The trade-off is a burst of up to twice the
 * limit across an hour boundary, which is fine for a cost guard against a
 * stuck client or a runaway script - this is not a billing meter.
 */

export interface RateLimitCounter {
  /* INCR, setting the TTL when the key is new. Resolves to the value after the increment. */
  incr(key: string, ttlSeconds: number): Promise<number>;
}

/** INCR + EXPIRE NX over Upstash, in one round trip. */
export function upstashRateLimitCounter(): RateLimitCounter {
  const redis = getRedis();
  return {
    incr: async (key, ttlSeconds) => {
      const pipeline = redis.pipeline();
      pipeline.incr(key);
      pipeline.expire(key, ttlSeconds, "NX");
      const [count] = await pipeline.exec<[number, number]>();
      return count;
    },
  };
}

export type RateLimitResult = { ok: true; remaining: number } | { ok: false; retryAfterSeconds: number };

const HOUR_MS = 3_600_000;

/** Counts one use of `bucket` by `accountId` this hour; refuses once `limit` is passed. */
export async function takeRateLimit(
  counter: RateLimitCounter,
  args: { accountId: string; bucket: string; limit: number; now: Date },
): Promise<RateLimitResult> {
  const nowMs = args.now.getTime();
  const window = Math.floor(nowMs / HOUR_MS);
  const key = `assist:rl:${args.bucket}:${args.accountId}:${window}`;
  /* A minute past the window, so a slow clock on another instance still finds the count. */
  const count = await counter.incr(key, 3_600 + 60);
  if (count > args.limit) {
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil(((window + 1) * HOUR_MS - nowMs) / 1000)) };
  }
  return { ok: true, remaining: args.limit - count };
}

/** "try again in 12 minutes" */
export function retryAfterText(seconds: number): string {
  const minutes = Math.ceil(seconds / 60);
  return minutes <= 1 ? "in a minute" : `in ${minutes} minutes`;
}
