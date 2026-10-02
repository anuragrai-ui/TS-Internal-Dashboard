import { getRedis, isRedisConfigured } from "@/lib/redis";

import type { AppNotification, NotificationPage, NotificationView } from "@/lib/notifications/types";

/**
 * Redis-backed notification feeds.
 *
 * - notif:item:<id>               the notification itself, 14 days. Written NX: one write per id, ever
 * - notif:feed:<accountId>        sorted set of ids for one reader (score = when the dashboard learned of it)
 * - notif:feed:team               the same for everyone, for the Team tab
 * - notif:read_cursor:<accountId> everything scored at or below this has been read ("Mark all read")
 * - notif:read_ids:<accountId>    ids opened one at a time since the cursor
 * - notif:version:<scope>         bumped on every change, so an idle poll costs one GET
 *
 * Feeds are scored by arrival, not by event time. The Jira sync finds a
 * comment a minute or more after it was written, and an event that happened
 * before someone pressed "Mark all read" but arrived after it must still
 * count as unread.
 */

const ITEM_TTL_SECONDS = 14 * 86_400;
const ITEM_TTL_MS = ITEM_TTL_SECONDS * 1000;
const FEED_TTL_SECONDS = 30 * 86_400;
const MAX_READER_FEED = 300;
const MAX_TEAM_FEED = 500;
/* The whole feed fits in one read-state check, so the badge is exact (it shows 99+ from 100 up). */
const MAX_UNREAD_SCAN = MAX_READER_FEED;
export const MAX_PAGE_SIZE = 50;

export const TEAM_SCOPE = "team";

export type FeedScope = "mine" | "team";

interface StoredNotification extends AppNotification {
  receivedAt: string;
}

type ScoreBound = "+inf" | "-inf" | `(${number}`;

export interface ScoredMember {
  member: string;
  score: number;
}

/* The operations the feed needs, over the Upstash client - injectable so the
   feed logic can be tested against an in-memory fake (scripts/test-notifications.ts). */
export interface FeedRedis {
  del(key: string): Promise<void>;
  expire(key: string, seconds: number): Promise<void>;
  get<T>(key: string): Promise<T | null>;
  incr(key: string): Promise<number>;
  mget<T>(keys: string[]): Promise<Array<T | null>>;
  sadd(key: string, members: string[]): Promise<void>;
  set(key: string, value: unknown, ttlSeconds?: number): Promise<void>;
  /* SET NX EX - true only for the call that created the key. */
  setIfAbsent(key: string, value: unknown, ttlSeconds: number): Promise<boolean>;
  smismember(key: string, members: string[]): Promise<boolean[]>;
  zadd(key: string, entries: ScoredMember[]): Promise<void>;
  zrem(key: string, members: string[]): Promise<void>;
  /* Highest score first. Both bounds are exclusive. */
  zrevrange(key: string, opts: { above?: number; below?: number; count: number }): Promise<ScoredMember[]>;
  /* Keeps only the `keep` highest-scored members. */
  ztrim(key: string, keep: number): Promise<void>;
  /* Drops members scored at or below `maxScore`. */
  ztrimBelow(key: string, maxScore: number): Promise<void>;
}

function itemKey(id: string): string {
  return `notif:item:${id}`;
}

function feedKey(scope: string): string {
  return `notif:feed:${scope}`;
}

function readCursorKey(accountId: string): string {
  return `notif:read_cursor:${accountId}`;
}

function readIdsKey(accountId: string): string {
  return `notif:read_ids:${accountId}`;
}

function versionKey(scope: string): string {
  return `notif:version:${scope}`;
}

export function upstashFeedRedis(): FeedRedis {
  const redis = getRedis();

  return {
    del: async (key) => {
      await redis.del(key);
    },
    expire: async (key, seconds) => {
      await redis.expire(key, seconds);
    },
    get: (key) => redis.get(key),
    incr: (key) => redis.incr(key),
    mget: async <T>(keys: string[]) => (keys.length === 0 ? [] : redis.mget<Array<T | null>>(...keys)),
    sadd: async (key, members) => {
      const [first, ...rest] = members;
      if (first !== undefined) {
        await redis.sadd(key, first, ...rest);
      }
    },
    set: async (key, value, ttlSeconds) => {
      await (ttlSeconds ? redis.set(key, value, { ex: ttlSeconds }) : redis.set(key, value));
    },
    setIfAbsent: async (key, value, ttlSeconds) => (await redis.set(key, value, { ex: ttlSeconds, nx: true })) === "OK",
    smismember: async (key, members) =>
      members.length === 0 ? [] : (await redis.smismember(key, members)).map((flag) => flag === 1),
    zadd: async (key, entries) => {
      const [first, ...rest] = entries;
      if (first !== undefined) {
        await redis.zadd(key, first, ...rest);
      }
    },
    zrem: async (key, members) => {
      if (members.length > 0) {
        await redis.zrem(key, ...members);
      }
    },
    zrevrange: async (key, { above, below, count }) => {
      /* "(" makes a bound exclusive. */
      const max: ScoreBound = below === undefined ? "+inf" : `(${below}`;
      const min: ScoreBound = above === undefined ? "-inf" : `(${above}`;
      const flat = await redis.zrange<Array<string | number>>(key, max, min, {
        byScore: true,
        count,
        offset: 0,
        rev: true,
        withScores: true,
      });
      const pairs: ScoredMember[] = [];
      for (let i = 0; i + 1 < flat.length; i += 2) {
        pairs.push({ member: String(flat[i]), score: Number(flat[i + 1]) });
      }
      return pairs;
    },
    ztrim: async (key, keep) => {
      await redis.zremrangebyrank(key, 0, -(keep + 1));
    },
    ztrimBelow: async (key, maxScore) => {
      await redis.zremrangebyscore(key, "-inf", maxScore);
    },
  };
}

function defaultStore(): FeedRedis | null {
  return isRedisConfigured() ? upstashFeedRedis() : null;
}

/**
 * Adds notifications to their readers' feeds and the team feed. An id seen
 * before is skipped, so callers can re-offer overlapping windows freely.
 * Items with an empty audience are dropped: nobody registered would see
 * them. Returns the notifications that were actually new.
 */
export async function addNotifications(
  items: AppNotification[],
  now: Date = new Date(),
  store: FeedRedis | null = defaultStore(),
): Promise<AppNotification[]> {
  if (!store) {
    return [];
  }

  const nowMs = now.getTime();
  const receivedAt = now.toISOString();
  const touched = new Set<string>();
  const added: AppNotification[] = [];

  /* Oldest first, so within one batch the feed still reads chronologically. */
  const batch = items
    .filter((item) => item.audience.length > 0)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  for (const [index, item] of batch.entries()) {
    const stored: StoredNotification = { ...item, audience: [...new Set(item.audience)], receivedAt };

    if (!(await store.setIfAbsent(itemKey(item.id), stored, ITEM_TTL_SECONDS))) {
      continue;
    }

    /* Fractional offsets keep a batch in order without colliding with the next millisecond's writes. */
    const score = nowMs + Math.min(index, 999) / 1000;
    const scopes = [...stored.audience, TEAM_SCOPE];
    await Promise.all(scopes.map((scope) => store.zadd(feedKey(scope), [{ member: item.id, score }])));
    scopes.forEach((scope) => touched.add(scope));
    added.push(stored);
  }

  await Promise.all(
    [...touched].map(async (scope) => {
      /* Entries whose item has expired would otherwise linger (and count as unread) until trimmed by size. */
      await store.ztrimBelow(feedKey(scope), nowMs - ITEM_TTL_MS);
      await store.ztrim(feedKey(scope), scope === TEAM_SCOPE ? MAX_TEAM_FEED : MAX_READER_FEED);
      await store.expire(feedKey(scope), FEED_TTL_SECONDS);
      await store.incr(versionKey(scope));
    }),
  );

  return added;
}

async function readerCursor(store: FeedRedis, accountId: string): Promise<number> {
  const raw = await store.get<number | string>(readCursorKey(accountId));
  const cursor = Number(raw);
  return Number.isFinite(cursor) ? cursor : 0;
}

/**
 * Unread items in the reader's own feed. Only entries younger than the item
 * TTL count: an older one's item is gone (it can't be shown), and so may be
 * the read marks that covered it.
 */
export async function getUnreadCount(accountId: string, store: FeedRedis | null = defaultStore(), nowMs: number = Date.now()): Promise<number> {
  if (!store) {
    return 0;
  }

  const cursor = await readerCursor(store, accountId);
  const entries = await store.zrevrange(feedKey(accountId), { above: Math.max(cursor, nowMs - ITEM_TTL_MS), count: MAX_UNREAD_SCAN });

  if (entries.length === 0) {
    return 0;
  }

  const opened = await store.smismember(
    readIdsKey(accountId),
    entries.map((entry) => entry.member),
  );
  return entries.filter((_entry, index) => !opened[index]).length;
}

/** Cheap change marker for polling: one or two GETs, no feed reads. */
export async function getFeedVersion(
  accountId: string,
  scope: FeedScope,
  store: FeedRedis | null = defaultStore(),
): Promise<string> {
  if (!store) {
    return "0";
  }

  const own = (await store.get<number | string>(versionKey(accountId))) ?? 0;

  if (scope === "mine") {
    return `m${own}`;
  }

  /* The Team tab still needs the reader's own version: their read marks and badge live there. */
  const team = (await store.get<number | string>(versionKey(TEAM_SCOPE))) ?? 0;
  return `t${team}.${own}`;
}

export async function listNotifications(
  accountId: string,
  opts: { before?: number; limit?: number; nowMs?: number; scope?: FeedScope } = {},
  store: FeedRedis | null = defaultStore(),
): Promise<NotificationPage> {
  const scope = opts.scope ?? "mine";

  if (!store) {
    return { hasMore: false, items: [], unreadCount: 0, version: "0" };
  }

  const limit = Math.max(1, Math.min(MAX_PAGE_SIZE, Math.floor(opts.limit ?? 20)));
  const feed = feedKey(scope === "team" ? TEAM_SCOPE : accountId);
  const before = opts.before !== undefined && Number.isFinite(opts.before) ? opts.before : undefined;

  /* Version first: a write landing mid-read then shows up as a changed version on the next poll, never as a missed one. */
  const version = await getFeedVersion(accountId, scope, store);
  const entries = await store.zrevrange(feed, { below: before, count: limit + 1 });
  const page = entries.slice(0, limit);
  const [items, cursor, opened, unreadCount] = await Promise.all([
    store.mget<StoredNotification>(page.map((entry) => itemKey(entry.member))),
    readerCursor(store, accountId),
    store.smismember(
      readIdsKey(accountId),
      page.map((entry) => entry.member),
    ),
    getUnreadCount(accountId, store, opts.nowMs),
  ]);

  const expired = page.filter((_entry, index) => !items[index]).map((entry) => entry.member);
  if (expired.length > 0) {
    await store.zrem(feed, expired);
  }

  const views: NotificationView[] = [];
  page.forEach((entry, index) => {
    const item = items[index];
    if (!item) {
      return;
    }
    const { audience, ...rest } = item;
    /* Someone else's item on the Team tab has no unread state for this reader. */
    const read = !audience.includes(accountId) || entry.score <= cursor || Boolean(opened[index]);
    views.push({ ...rest, read, score: entry.score });
  });

  return { hasMore: entries.length > limit, items: views, unreadCount, version };
}

/** Marks specific items read, or everything up to now with `all`. Returns the new unread count. */
export async function markNotificationsRead(
  accountId: string,
  target: { all: true } | { ids: string[] },
  store: FeedRedis | null = defaultStore(),
  nowMs: number = Date.now(),
): Promise<number> {
  if (!store) {
    return 0;
  }

  if ("all" in target) {
    const [newest] = await store.zrevrange(feedKey(accountId), { count: 1 });
    if (newest) {
      await store.set(readCursorKey(accountId), newest.score, FEED_TTL_SECONDS);
    }
    await store.del(readIdsKey(accountId));
  } else {
    const ids = [...new Set(target.ids)].filter((id) => typeof id === "string" && id.length > 0 && id.length <= 300).slice(0, MAX_PAGE_SIZE);
    if (ids.length > 0) {
      await store.sadd(readIdsKey(accountId), ids);
      await store.expire(readIdsKey(accountId), ITEM_TTL_SECONDS);
    }
  }

  await store.incr(versionKey(accountId));
  return getUnreadCount(accountId, store, nowMs);
}
