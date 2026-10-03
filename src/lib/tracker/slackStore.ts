import { getRedis, isRedisConfigured } from "@/lib/redis";
import { MAX_INDEXED_KEYS, slackTsToIso, slackTsToMs } from "@/lib/tracker/slackParse";

import type { SlackConversationRef, SlackConversationSource } from "@/lib/tracker/types";

/**
 * Redis-backed index of Slack conversations about tickets. Pointers and
 * counts only - message text is read live (loadConversationMessages) and
 * only ever cached for a minute.
 *
 * - slack:convo:<channel>:<rootTs>  the conversation (thread root): SlackConversationRef + participant ids + reply ts already counted
 * - slack:convos_for:<KEY>          sorted set of conversation ids about one ticket (score = last activity, ms)
 * - slack:index:channels            channels seen in live events - the history drip scans them too
 * - slack:index:tickets             every ticket key that has (had) a conversation - so a rebuild of ~400 tickets only
 *                                   reads the few dozen that do, instead of one sorted-set read per ticket
 *
 * Everything lives 90 days and is refreshed on activity, so a thread that
 * goes quiet ages out on its own.
 */

export const CONVERSATION_TTL_SECONDS = 90 * 86_400;
const MAX_CONVERSATIONS_PER_TICKET = 50;
export const MAX_CONVERSATIONS_READ_PER_TICKET = 20;
/* Enough to recognise a redelivered event in any realistic thread; the oldest are forgotten first. */
const MAX_SEEN_REPLY_TS = 300;
const MAX_PARTICIPANT_IDS = 100;
const MGET_CHUNK = 200;
const SEEN_CHANNELS_KEY = "slack:index:channels";
const LINKED_TICKETS_KEY = "slack:index:tickets";

/* Which source names a conversation when several found it: the bot's own thread beats a hand-pasted link beats live traffic. */
const SOURCE_RANK: Record<SlackConversationSource, number> = {
  backfill: 0,
  bot: 4,
  event: 2,
  jira_link: 1,
  manual: 3,
};

export interface StoredConversation extends SlackConversationRef {
  /* Slack user ids seen in it (root author + repliers), capped. */
  participantIds: string[];
  /* Reply ts already counted, so a redelivered event never counts twice (newest kept). */
  seenReplyTs: string[];
  /* The root author's Slack user id, when known. */
  startedBy?: string;
}

/** What one observation of a conversation says about it. Every field only ever adds to what is stored. */
export interface ConversationUpdate {
  /* When this activity happened (ISO); defaults to what is stored, else the root's own time. */
  at?: string;
  channel: string;
  channelName?: string;
  escalationHint?: boolean;
  participantIds?: string[];
  /* A known total (the history drip's reply_users_count + root author). */
  participants?: number;
  /* A known total (the history drip's reply_count). */
  replyCount?: number;
  /* One reply seen live - counted once per ts. */
  replyTs?: string;
  rootTs: string;
  snippet?: string;
  source: SlackConversationSource;
  startedBy?: string;
  ticketKeys: string[];
}

/* The operations the index needs, over the Upstash client - injectable so it can be tested in memory (scripts/test-tracker-slack.ts). */
export interface SlackIndexRedis {
  expire(key: string, seconds: number): Promise<void>;
  get<T>(key: string): Promise<T | null>;
  mget<T>(keys: string[]): Promise<Array<T | null>>;
  sadd(key: string, members: string[]): Promise<void>;
  set(key: string, value: unknown, ttlSeconds?: number): Promise<void>;
  /* SET NX EX - true only for the call that created the key. */
  setIfAbsent(key: string, value: unknown, ttlSeconds: number): Promise<boolean>;
  smembers(key: string): Promise<string[]>;
  zadd(key: string, entries: Array<{ member: string; score: number }>): Promise<void>;
  /* For each key, its `count` highest-scored members (one round trip). */
  zrevrangeMany(keys: string[], count: number): Promise<string[][]>;
  /* Keeps only the `keep` highest-scored members. */
  ztrim(key: string, keep: number): Promise<void>;
}

export function upstashSlackIndexRedis(): SlackIndexRedis {
  const redis = getRedis();

  return {
    expire: async (key, seconds) => {
      await redis.expire(key, seconds);
    },
    get: (key) => redis.get(key),
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
    smembers: async (key) => (await redis.smembers(key)).map(String),
    zadd: async (key, entries) => {
      const [first, ...rest] = entries;
      if (first !== undefined) {
        await redis.zadd(key, first, ...rest);
      }
    },
    zrevrangeMany: async (keys, count) => {
      if (keys.length === 0) {
        return [];
      }
      const pipeline = redis.pipeline();
      keys.forEach((key) => pipeline.zrange(key, 0, count - 1, { rev: true }));
      const results = await pipeline.exec<unknown[][]>();
      return results.map((members) => (Array.isArray(members) ? members.map(String) : []));
    },
    ztrim: async (key, keep) => {
      await redis.zremrangebyrank(key, 0, -(keep + 1));
    },
  };
}

export function defaultSlackIndexStore(): SlackIndexRedis | null {
  return isRedisConfigured() ? upstashSlackIndexRedis() : null;
}

export function conversationId(channel: string, rootTs: string): string {
  return `${channel}:${rootTs}`;
}

function conversationKey(id: string): string {
  return `slack:convo:${id}`;
}

function ticketConversationsKey(ticketKey: string): string {
  return `slack:convos_for:${ticketKey}`;
}

function laterIso(a: string | undefined, b: string | undefined): string | undefined {
  if (!a || !b) {
    return a ?? b;
  }
  return Date.parse(b) > Date.parse(a) ? b : a;
}

function earlierIso(a: string | undefined, b: string | undefined): string | undefined {
  if (!a || !b) {
    return a ?? b;
  }
  return Date.parse(b) < Date.parse(a) ? b : a;
}

/* ------------------------------------------------------------------ pure */

/**
 * Folds one observation into what is stored. Idempotent - the same update
 * twice gives the same record - and monotonic: keys are only added, counts
 * only grow, the escalation hint never clears, the earliest start and the
 * latest activity win.
 */
export function mergeConversation(
  existing: StoredConversation | null,
  update: ConversationUpdate,
  now: Date,
): { newlyLinkedKeys: string[]; record: StoredConversation } {
  const rootIso = slackTsToIso(update.rootTs) ?? now.toISOString();
  const knownKeys = new Set(existing?.ticketKeys ?? []);
  const newlyLinkedKeys = [...new Set(update.ticketKeys)].filter((key) => !knownKeys.has(key));
  const ticketKeys = [...(existing?.ticketKeys ?? []), ...newlyLinkedKeys].slice(0, MAX_INDEXED_KEYS);

  const participantIds = [...new Set([...(existing?.participantIds ?? []), ...(update.participantIds ?? [])])].slice(0, MAX_PARTICIPANT_IDS);
  const seen = existing?.seenReplyTs ?? [];
  const countsNewReply = Boolean(update.replyTs && update.replyTs !== update.rootTs && !seen.includes(update.replyTs));
  const seenReplyTs = countsNewReply ? [...seen, update.replyTs as string].slice(-MAX_SEEN_REPLY_TS) : seen;
  const replyCount = Math.max((existing?.replyCount ?? 0) + (countsNewReply ? 1 : 0), update.replyCount ?? 0);
  const participants = Math.max(existing?.participants ?? 0, participantIds.length, update.participants ?? 0);
  const source = existing && SOURCE_RANK[existing.source] >= SOURCE_RANK[update.source] ? existing.source : update.source;

  const record: StoredConversation = {
    channel: update.channel,
    channelName: update.channelName ?? existing?.channelName,
    escalationHint: Boolean(existing?.escalationHint || update.escalationHint),
    firstSeenAt: earlierIso(existing?.firstSeenAt, rootIso) ?? rootIso,
    id: conversationId(update.channel, update.rootTs),
    lastActivityAt: laterIso(laterIso(existing?.lastActivityAt, update.at), rootIso) ?? rootIso,
    participantIds,
    participants,
    permalink: existing?.permalink,
    replyCount,
    rootTs: update.rootTs,
    seenReplyTs,
    snippet: update.snippet || existing?.snippet,
    source,
    startedBy: existing?.startedBy ?? update.startedBy,
    startedByName: existing?.startedByName,
    ticketKeys,
  };

  return { newlyLinkedKeys: ticketKeys.filter((key) => newlyLinkedKeys.includes(key)), record };
}

/** What leaves the index: the contract's SlackConversationRef, without internal bookkeeping or empty fields. */
export function toConversationRef(stored: StoredConversation): SlackConversationRef {
  const ref: SlackConversationRef = {
    channel: stored.channel,
    channelName: stored.channelName,
    escalationHint: stored.escalationHint,
    firstSeenAt: stored.firstSeenAt,
    id: stored.id,
    lastActivityAt: stored.lastActivityAt,
    participants: stored.participants,
    permalink: stored.permalink,
    replyCount: stored.replyCount,
    rootTs: stored.rootTs,
    snippet: stored.snippet,
    source: stored.source,
    startedByName: stored.startedByName,
    ticketKeys: stored.ticketKeys,
  };
  for (const field of Object.keys(ref) as Array<keyof SlackConversationRef>) {
    if (ref[field] === undefined) {
      delete ref[field];
    }
  }
  return ref;
}

/* -------------------------------------------------------------------- I/O */

export async function readConversation(store: SlackIndexRedis, channel: string, rootTs: string): Promise<StoredConversation | null> {
  return store.get<StoredConversation>(conversationKey(conversationId(channel, rootTs)));
}

async function writeConversation(store: SlackIndexRedis, record: StoredConversation): Promise<void> {
  const score = Date.parse(record.lastActivityAt) || slackTsToMs(record.rootTs) || Date.now();
  await store.set(conversationKey(record.id), record, CONVERSATION_TTL_SECONDS);
  /* Before the per-ticket sets, so a half-finished write is never invisible to readConversationsForTickets. */
  await store.sadd(LINKED_TICKETS_KEY, record.ticketKeys);
  await store.expire(LINKED_TICKETS_KEY, CONVERSATION_TTL_SECONDS);
  await Promise.all(
    record.ticketKeys.map(async (ticketKey) => {
      const key = ticketConversationsKey(ticketKey);
      await store.zadd(key, [{ member: record.id, score }]);
      await store.ztrim(key, MAX_CONVERSATIONS_PER_TICKET);
      await store.expire(key, CONVERSATION_TTL_SECONDS);
    }),
  );
}

export interface UpsertOptions {
  /* Fills channel name / permalink / author name. Must not throw; a failure just leaves them empty. */
  enrich?: (record: StoredConversation) => Promise<StoredConversation>;
  /* Already read by the caller - saves a round trip. */
  existing?: StoredConversation | null;
  now?: Date;
}

/**
 * Merges an observation into the stored conversation and writes it back.
 * Null when there is nothing to store (no ticket keys at all). The
 * read-merge-write isn't atomic: two events on one thread at the same
 * instant can lose a reply count, never a ticket link they both carry.
 */
export async function upsertConversation(
  store: SlackIndexRedis,
  update: ConversationUpdate,
  options: UpsertOptions = {},
): Promise<{ newlyLinkedKeys: string[]; record: StoredConversation } | null> {
  const existing = options.existing !== undefined ? options.existing : await readConversation(store, update.channel, update.rootTs);
  if (!existing && update.ticketKeys.length === 0) {
    return null;
  }

  const merged = mergeConversation(existing, update, options.now ?? new Date());
  let record = merged.record;
  if (options.enrich) {
    try {
      record = await options.enrich(record);
    } catch {
      /* Names and links are nice to have; the link itself is what matters. */
    }
  }

  await writeConversation(store, record);
  return { newlyLinkedKeys: merged.newlyLinkedKeys, record };
}

/** Conversations per ticket key, most recent activity first. A handful of round trips whatever the number of keys. */
export async function readConversationsForTickets(store: SlackIndexRedis, keys: string[]): Promise<Map<string, StoredConversation[]>> {
  const out = new Map<string, StoredConversation[]>();
  const requested = [...new Set(keys)];
  if (requested.length === 0) {
    return out;
  }
  /* Most tickets have no Slack conversation: ask the index which ones do rather than reading a set for each. */
  const linked = new Set(await store.smembers(LINKED_TICKETS_KEY));
  const unique = requested.filter((key) => linked.has(key));
  if (unique.length === 0) {
    return out;
  }

  const idsPerKey = await store.zrevrangeMany(unique.map(ticketConversationsKey), MAX_CONVERSATIONS_READ_PER_TICKET);
  const ids = [...new Set(idsPerKey.flat())];
  const byId = new Map<string, StoredConversation>();

  for (let start = 0; start < ids.length; start += MGET_CHUNK) {
    const chunk = ids.slice(start, start + MGET_CHUNK);
    const records = await store.mget<StoredConversation>(chunk.map(conversationKey));
    records.forEach((record, index) => {
      const id = chunk[index];
      if (record && id) {
        byId.set(id, record);
      }
    });
  }

  unique.forEach((key, index) => {
    /* A conversation that expired leaves a dangling id until the set is trimmed - skipped here. */
    const conversations = (idsPerKey[index] ?? [])
      .map((id) => byId.get(id))
      .filter((record): record is StoredConversation => record !== undefined)
      .sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt));
    if (conversations.length > 0) {
      out.set(key, conversations);
    }
  });

  return out;
}

export async function rememberSeenChannel(store: SlackIndexRedis, channel: string): Promise<void> {
  await store.sadd(SEEN_CHANNELS_KEY, [channel]);
  await store.expire(SEEN_CHANNELS_KEY, CONVERSATION_TTL_SECONDS);
}

export async function listSeenChannels(store: SlackIndexRedis): Promise<string[]> {
  return store.smembers(SEEN_CHANNELS_KEY);
}
