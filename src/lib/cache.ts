import { getRedis, isRedisConfigured } from "@/lib/redis";

export interface CacheEntry<T> {
  value: T;
  createdAt: Date;
  expiresAt: Date;
}

interface StoredCacheEntry<T> {
  value: T;
  createdAt: string;
  expiresAt: string;
}

const KEY_PREFIX = "cache:";

function toRedisKey(key: string): string {
  return `${KEY_PREFIX}${key}`;
}

export async function getCache<T>(key: string): Promise<CacheEntry<T> | null> {
  if (!isRedisConfigured()) {
    return null;
  }

  let stored: StoredCacheEntry<T> | null;

  try {
    stored = await getRedis().get<StoredCacheEntry<T>>(toRedisKey(key));
  } catch (error) {
    console.warn(`Cache read failed for "${key}"; treating as a cache miss.`, error);
    return null;
  }

  if (!stored) {
    return null;
  }

  const expiresAt = new Date(stored.expiresAt);

  if (Date.now() >= expiresAt.getTime()) {
    return null;
  }

  return {
    value: stored.value,
    createdAt: new Date(stored.createdAt),
    expiresAt,
  };
}

export async function setCache<T>(
  key: string,
  value: T,
  ttlSeconds = 600,
): Promise<void> {
  if (!isRedisConfigured()) {
    return;
  }

  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + ttlSeconds * 1000);

  const stored: StoredCacheEntry<T> = {
    value,
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };

  try {
    await getRedis().set(toRedisKey(key), stored, { ex: ttlSeconds });
  } catch (error) {
    console.warn(`Cache write failed for "${key}"; continuing without caching this result.`, error);
  }
}

export async function getCacheMeta(
  key: string,
): Promise<Pick<CacheEntry<unknown>, "createdAt" | "expiresAt"> | null> {
  const entry = await getCache(key);

  if (!entry) {
    return null;
  }

  return {
    createdAt: entry.createdAt,
    expiresAt: entry.expiresAt,
  };
}

export async function clearCache(): Promise<void> {
  if (!isRedisConfigured()) {
    return;
  }

  try {
    const redis = getRedis();
    const keys = await redis.keys(`${KEY_PREFIX}*`);

    if (keys.length > 0) {
      await redis.del(...keys);
    }
  } catch (error) {
    console.warn("Cache clear failed; cached entries will expire on their own TTL instead.", error);
  }
}
