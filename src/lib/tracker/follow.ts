import { getRedis, isRedisConfigured } from "@/lib/redis";

/**
 * "Follow this ticket" on the escalation tracker. A follower hears about a
 * ticket exactly like its assignee does: Jira comments and moves (the
 * notification sync adds followed keys to its query), activity on its CPs,
 * Slack mentions, and the tracker's SLA warnings.
 *
 * - tracker:follow:<accountId>  set of TS/CP keys that person follows
 * - tracker:followers:<KEY>     set of accountIds following that key
 *
 * Both directions are kept so either question is one SMEMBERS. Writes touch
 * both sets; a crash between the two leaves at worst a stale follower, which
 * every reader filters through the registered-user list anyway.
 */

const KEY_PATTERN = /^(TS|CP)-\d+$/;
/* Followed tickets get closed and forgotten; a set nobody has touched in half a year expires on its own. */
const FOLLOW_TTL_SECONDS = 180 * 86_400;
/* Keeps one person's set (and the sync's `key in (...)`) bounded. */
export const MAX_FOLLOWED_PER_PERSON = 200;

/* The slice of Redis this module uses - injectable so tests run against an in-memory fake. */
export interface FollowStore {
  expire(key: string, seconds: number): Promise<void>;
  sadd(key: string, member: string): Promise<void>;
  scard(key: string): Promise<number>;
  smembers(key: string): Promise<string[]>;
  srem(key: string, member: string): Promise<void>;
}

function personKey(accountId: string): string {
  return `tracker:follow:${accountId}`;
}

function followersKey(key: string): string {
  return `tracker:followers:${key}`;
}

export function isTrackerKey(key: unknown): key is string {
  return typeof key === "string" && KEY_PATTERN.test(key);
}

export function upstashFollowStore(): FollowStore {
  const redis = getRedis();
  return {
    expire: async (key, seconds) => {
      await redis.expire(key, seconds);
    },
    sadd: async (key, member) => {
      await redis.sadd(key, member);
    },
    scard: (key) => redis.scard(key),
    smembers: (key) => redis.smembers(key),
    srem: async (key, member) => {
      await redis.srem(key, member);
    },
  };
}

function defaultStore(): FollowStore | null {
  return isRedisConfigured() ? upstashFollowStore() : null;
}

/** Follow or unfollow one ticket. Returns false (and changes nothing) for a malformed key or a full follow list. */
export async function setFollowing(accountId: string, key: string, following: boolean, store: FollowStore | null = defaultStore()): Promise<boolean> {
  if (!store || !accountId || !isTrackerKey(key)) {
    return false;
  }

  if (!following) {
    await store.srem(personKey(accountId), key);
    await store.srem(followersKey(key), accountId);
    return true;
  }

  const already = (await store.smembers(personKey(accountId))).includes(key);
  if (!already && (await store.scard(personKey(accountId))) >= MAX_FOLLOWED_PER_PERSON) {
    return false;
  }
  await store.sadd(personKey(accountId), key);
  await store.sadd(followersKey(key), accountId);
  await store.expire(personKey(accountId), FOLLOW_TTL_SECONDS);
  await store.expire(followersKey(key), FOLLOW_TTL_SECONDS);
  return true;
}

export function followTicket(accountId: string, key: string, store?: FollowStore | null): Promise<boolean> {
  return setFollowing(accountId, key, true, store);
}

export function unfollowTicket(accountId: string, key: string, store?: FollowStore | null): Promise<boolean> {
  return setFollowing(accountId, key, false, store);
}

/** Keys one person follows, sorted. Never throws: an unreadable list reads as empty. */
export async function getFollowedKeys(accountId: string, store: FollowStore | null = defaultStore()): Promise<string[]> {
  if (!store || !accountId) {
    return [];
  }
  try {
    return (await store.smembers(personKey(accountId))).filter(isTrackerKey).sort();
  } catch (error) {
    console.warn("Could not read followed tickets.", error instanceof Error ? error.message : error);
    return [];
  }
}

/** Followers per key (keys nobody follows are absent). Never throws. */
export async function getFollowersByKey(keys: string[], store: FollowStore | null = defaultStore()): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const unique = [...new Set(keys.filter(isTrackerKey))];
  if (!store || unique.length === 0) {
    return out;
  }
  try {
    const lists = await Promise.all(unique.map((key) => store.smembers(followersKey(key))));
    unique.forEach((key, index) => {
      const followers = lists[index] ?? [];
      if (followers.length > 0) {
        out.set(key, [...followers].sort());
      }
    });
  } catch (error) {
    console.warn("Could not read ticket followers.", error instanceof Error ? error.message : error);
  }
  return out;
}

/**
 * Everything these people follow, inverted to key -> followers. The
 * notification sync passes the registered users, so a follower who has
 * since unregistered drops out without any cleanup. Never throws.
 */
export async function getFollowersForAccounts(accountIds: string[], store: FollowStore | null = defaultStore()): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (const [accountId, keys] of await Promise.all(
    [...new Set(accountIds)].map(async (accountId) => [accountId, await getFollowedKeys(accountId, store)] as const),
  )) {
    for (const key of keys) {
      out.set(key, [...(out.get(key) ?? []), accountId].sort());
    }
  }
  return out;
}
