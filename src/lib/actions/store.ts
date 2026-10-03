import { getRedis, isRedisConfigured } from "@/lib/redis";

/**
 * The slice of Redis the action pipeline uses, so the service logic
 * (idempotency, rate limit, proposals, audit) runs against an in-memory
 * fake in scripts/test-actions.ts. Unlike src/lib/cache.ts these methods
 * THROW on a Redis failure: the service must know when it couldn't claim an
 * idempotency key, because writing without one could write twice.
 *
 * Keys (all under actions:):
 * - idem:<accountId>:<idempotencyKey>   in-progress marker, then the execution id (7 days)
 * - exec:<id>                          one ActionExecution (7 days)
 * - rate:<accountId>:<hour>            writes this clock hour
 * - proposal:<id>                      one proposal (7 days); proposals:<KEY> is the ticket's index
 * - proposal-lock:<id>                 held while a proposal is being approved or rejected
 * - log:<KEY> / log:all                the audit trail, newest first
 */
export interface ActionStore {
  del(key: string): Promise<void>;
  get<T>(key: string): Promise<T | null>;
  /* INCR, then (re)apply the expiry. Returns the new count. */
  incr(key: string, ttlSeconds: number): Promise<number>;
  mget<T>(keys: string[]): Promise<Array<T | null>>;
  /* LPUSH, keep the newest `keep`, (re)apply the expiry. */
  pushCapped(key: string, value: unknown, keep: number, ttlSeconds: number): Promise<void>;
  /* The newest `count` entries of a list (LRANGE 0..count-1). */
  range<T>(key: string, count: number): Promise<T[]>;
  set(key: string, value: unknown, ttlSeconds: number): Promise<void>;
  /* SET NX EX - true when this call created the key. */
  setIfAbsent(key: string, value: unknown, ttlSeconds: number): Promise<boolean>;
}

/** The Upstash-backed store, or null when Redis isn't configured (writes are then refused - see service.ts). */
export function redisActionStore(): ActionStore | null {
  if (!isRedisConfigured()) {
    return null;
  }
  const redis = getRedis();
  return {
    del: async (key) => {
      await redis.del(key);
    },
    get: <T>(key: string) => redis.get<T>(key),
    incr: async (key, ttlSeconds) => {
      const [count] = await redis.pipeline().incr(key).expire(key, ttlSeconds).exec<[number, number]>();
      return count;
    },
    mget: async <T>(keys: string[]) => (keys.length === 0 ? [] : redis.mget<Array<T | null>>(...keys)),
    pushCapped: async (key, value, keep, ttlSeconds) => {
      await redis
        .pipeline()
        .lpush(key, value)
        .ltrim(key, 0, keep - 1)
        .expire(key, ttlSeconds)
        .exec();
    },
    range: <T>(key: string, count: number) => redis.lrange<T>(key, 0, count - 1),
    set: async (key, value, ttlSeconds) => {
      await redis.set(key, value, { ex: ttlSeconds });
    },
    setIfAbsent: async (key, value, ttlSeconds) => (await redis.set(key, value, { ex: ttlSeconds, nx: true })) === "OK",
  };
}
