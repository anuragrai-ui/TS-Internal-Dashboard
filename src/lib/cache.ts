export interface CacheEntry<T> {
  value: T;
  createdAt: Date;
  expiresAt: Date;
}

const cache = new Map<string, CacheEntry<unknown>>();

export function getCache<T>(key: string): CacheEntry<T> | null {
  const item = cache.get(key) as CacheEntry<T> | undefined;

  if (!item) {
    return null;
  }

  if (Date.now() >= item.expiresAt.getTime()) {
    cache.delete(key);
    return null;
  }

  return item;
}

export function setCache<T>(key: string, value: T, ttlSeconds = 600): void {
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + ttlSeconds * 1000);

  cache.set(key, {
    value,
    createdAt,
    expiresAt,
  });
}

export function getCacheMeta(
  key: string,
): Pick<CacheEntry<unknown>, "createdAt" | "expiresAt"> | null {
  const item = cache.get(key);

  if (!item) {
    return null;
  }

  return {
    createdAt: item.createdAt,
    expiresAt: item.expiresAt,
  };
}

export function clearCache(): void {
  cache.clear();
}
