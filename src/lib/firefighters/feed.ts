import { getCache, setCache } from "@/lib/cache";
import { getRedis, isRedisConfigured } from "@/lib/redis";
import { getSlackChannelName, getSlackPermalink, getSlackUserName, slackRead } from "@/lib/slackApi";
import { USER_HISTORY_READ_KEY, USER_HISTORY_READ_SECONDS } from "@/lib/tracker/slackBackfill";
import {
  buildSlackPermalink,
  extractMessageTicketKeys,
  messageTexts,
  slackOriginFromPermalink,
  slackTextToPlain,
  slackTsToIso,
  threadUserIds,
} from "@/lib/tracker/slackParse";
import { DEFAULT_FIREFIGHTER_CHANNEL } from "@/lib/workspace/types";

import type { SlackReadResult } from "@/lib/slackApi";
import type { SlackHistoryMessage } from "@/lib/tracker/slackParse";
import type { FirefighterFeedResponse, FirefighterMessage } from "@/lib/workspace/types";

/**
 * The live #firefighters feed for the on-call page: the channel's latest
 * top-level messages (thread replies stay in Slack), with authors, ticket
 * keys and links. Read-only - conversations.history plus the name and
 * permalink reads the tracker already uses.
 *
 * Budget: the Vercel-managed Slack app may only get about one history read a
 * minute, shared with the tracker's history drip. So the feed is cached 60
 * seconds across every browser, a read tells the drip to sit its next tick
 * out (as a tracker thread read does), and when Slack says "ratelimited" the
 * last good copy (kept a day) is served flagged rateLimited instead of an
 * empty page. Permalinks cost one chat.getPermalink per day: the workspace
 * origin is learned once and every other link is built locally.
 *
 * Message text is untrusted (anyone in the channel, plus an E2E-failure bot)
 * and is only ever rendered as text.
 */

const HISTORY_LIMIT = "30";
const FEED_CACHE_SECONDS = 60;
const LAST_GOOD_SECONDS = 86_400;
const ORIGIN_CACHE_KEY = "slack:workspace_origin";
const ORIGIN_CACHE_SECONDS = 7 * 86_400;
const TEXT_MAX_CHARS = 600;
const MAX_NAME_LOOKUPS = 25;
const SLACK_CHANNEL = /^[CG][A-Z0-9]{6,}$/;
/* A person or app saying something at the top level. Joins, topic changes, thread broadcasts (replies) and the like aren't. */
const FEED_SUBTYPES = new Set<string | undefined>([undefined, "bot_message", "file_share", "me_message"]);

/** #firefighters' channel id: FIREFIGHTER_SLACK_CHANNEL when it is a channel id, else the default. */
export function firefighterChannelId(): string {
  const configured = (process.env.FIREFIGHTER_SLACK_CHANNEL ?? "").trim();
  return SLACK_CHANNEL.test(configured) ? configured : DEFAULT_FIREFIGHTER_CHANNEL;
}

export interface HistoryPage {
  error?: string;
  messages?: SlackHistoryMessage[];
  ok: boolean;
}

export interface FeedStore {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, ttlSeconds: number): Promise<void>;
}

export interface FirefighterFeedDeps {
  channel: string;
  channelName: (channel: string) => Promise<string | undefined>;
  history: (channel: string) => Promise<SlackReadResult<HistoryPage>>;
  /* Tells the tracker's history drip that the shared read budget was just spent. */
  markHistoryRead: () => Promise<void>;
  now: () => Date;
  permalink: (channel: string, ts: string) => Promise<string | null>;
  store: FeedStore;
  userName: (userId: string) => Promise<string | null>;
}

/** A top-level message worth showing: not a thread reply, not a join/topic/system event. */
export function isFeedMessage(message: SlackHistoryMessage): boolean {
  if (!message.ts || !FEED_SUBTYPES.has(message.subtype)) {
    return false;
  }
  return !message.thread_ts || message.thread_ts === message.ts;
}

/* Bots often post only attachments or blocks: fall back to their readable text (not their URLs). */
function rawText(message: SlackHistoryMessage): string {
  if (message.text?.trim()) {
    return message.text;
  }
  const fromAttachments = (message.attachments ?? [])
    .map((attachment) => [attachment.pretext, attachment.title, attachment.text].filter(Boolean).join(" - ") || attachment.fallback || "")
    .filter(Boolean)
    .join(" ");
  if (fromAttachments) {
    return fromAttachments;
  }
  return messageTexts(message)
    .authored.slice(1)
    .filter((part) => !/^https?:\/\//i.test(part.trim()))
    .join(" ");
}

/**
 * conversations.history messages -> the feed (pure): top-level only, newest
 * first, plain text with mentions named, ticket keys, reply counts and links.
 */
export function toFirefighterMessages(
  messages: readonly SlackHistoryMessage[],
  names: ReadonlyMap<string, string>,
  permalinkFor: (ts: string) => string | undefined,
): FirefighterMessage[] {
  return messages
    .filter(isFeedMessage)
    .map((message) => {
      const ts = message.ts as string;
      const isBot = Boolean(message.bot_id) || message.subtype === "bot_message";
      const authorName =
        (message.user ? names.get(message.user) : undefined) ?? (isBot ? message.bot_profile?.name || message.username || "Bot" : "Someone");
      const lastReplyAt = message.reply_count ? slackTsToIso(message.latest_reply) : null;
      const permalink = permalinkFor(ts);
      return {
        at: slackTsToIso(ts) ?? new Date(0).toISOString(),
        authorName,
        isBot,
        replyCount: message.reply_count ?? 0,
        text: slackTextToPlain(rawText(message), names, TEXT_MAX_CHARS),
        ticketKeys: extractMessageTicketKeys(message),
        ts,
        ...(lastReplyAt ? { lastReplyAt } : {}),
        ...(permalink ? { permalink } : {}),
      };
    })
    .sort((a, b) => Number(b.ts) - Number(a.ts));
}

async function resolveNames(messages: readonly SlackHistoryMessage[], userName: FirefighterFeedDeps["userName"]): Promise<Map<string, string>> {
  const ids = threadUserIds(messages, MAX_NAME_LOOKUPS);
  const names = new Map<string, string>();
  for (const [id, name] of await Promise.all(ids.map(async (id) => [id, await userName(id)] as const))) {
    if (name) {
      names.set(id, name);
    }
  }
  return names;
}

/* The workspace's https://<ws>.slack.com origin: cached, else learned from one permalink. */
async function workspaceOrigin(deps: FirefighterFeedDeps, sampleTs: string | undefined): Promise<string | null> {
  const cached = await deps.store.get<string>(ORIGIN_CACHE_KEY);
  if (cached) {
    return cached;
  }
  if (!sampleTs) {
    return null;
  }
  const origin = slackOriginFromPermalink((await deps.permalink(deps.channel, sampleTs)) ?? "");
  if (origin) {
    await deps.store.set(ORIGIN_CACHE_KEY, origin, ORIGIN_CACHE_SECONDS);
  }
  return origin;
}

function feedKeys(channel: string): { fresh: string; lastGood: string } {
  return { fresh: `firefighters:feed:${channel}`, lastGood: `firefighters:feed_last:${channel}` };
}

/** getFirefighterFeed with explicit deps - what the tests drive. */
export async function getFirefighterFeedWith(deps: FirefighterFeedDeps): Promise<FirefighterFeedResponse> {
  const { channel } = deps;
  const keys = feedKeys(channel);
  const cached = await deps.store.get<FirefighterFeedResponse>(keys.fresh);
  if (cached) {
    return cached;
  }

  await deps.markHistoryRead();
  const [result, channelName] = await Promise.all([deps.history(channel), deps.channelName(channel)]);
  const name = channelName ?? "firefighters";
  const fetchedAt = deps.now().toISOString();

  if (!result.ok || !result.data) {
    const lastGood = await deps.store.get<FirefighterFeedResponse>(keys.lastGood);
    if (result.rateLimited) {
      /* Throttled: the last good copy (its own fetchedAt says how old), flagged, until Slack's retry-after passes. */
      const response: FirefighterFeedResponse = lastGood
        ? { ...lastGood, rateLimited: true }
        : { channel, channelName: name, error: "ratelimited", fetchedAt, messages: [], rateLimited: true };
      await deps.store.set(keys.fresh, response, Math.min(Math.max(result.retryAfterSeconds ?? FEED_CACHE_SECONDS, 30), 300));
      return response;
    }
    const error = result.error ?? "unknown";
    /* A blip (network, token refresh) keeps showing the last messages; a real answer (not_in_channel...) shows none. */
    const transient = error === "request_failed";
    const response: FirefighterFeedResponse =
      transient && lastGood ? { ...lastGood, error } : { channel, channelName: name, error, fetchedAt, messages: [] };
    await deps.store.set(keys.fresh, response, FEED_CACHE_SECONDS);
    return response;
  }

  const raw = (result.data.messages ?? []).filter(isFeedMessage);
  const [names, origin] = await Promise.all([resolveNames(raw, deps.userName), workspaceOrigin(deps, raw[0]?.ts)]);
  const messages = toFirefighterMessages(raw, names, (ts) => (origin ? buildSlackPermalink(origin, channel, ts) : undefined));
  const response: FirefighterFeedResponse = { channel, channelName: name, fetchedAt, messages };
  await Promise.all([deps.store.set(keys.fresh, response, FEED_CACHE_SECONDS), deps.store.set(keys.lastGood, response, LAST_GOOD_SECONDS)]);
  return response;
}

function defaultDeps(): FirefighterFeedDeps {
  return {
    channel: firefighterChannelId(),
    channelName: getSlackChannelName,
    history: (channel) => slackRead<HistoryPage>("conversations.history", { channel, limit: HISTORY_LIMIT }),
    markHistoryRead: async () => {
      if (isRedisConfigured()) {
        await getRedis()
          .set(USER_HISTORY_READ_KEY, "1", { ex: USER_HISTORY_READ_SECONDS })
          .catch(() => undefined);
      }
    },
    now: () => new Date(),
    permalink: getSlackPermalink,
    store: {
      get: async <T>(key: string) => (await getCache<T>(key))?.value ?? null,
      set: (key, value, ttlSeconds) => setCache(key, value, ttlSeconds),
    },
    userName: async (userId) => (await getSlackUserName(userId))?.realName || null,
  };
}

/** The latest top-level #firefighters messages, newest first. Never throws: Slack trouble comes back as `error` / `rateLimited`. */
export async function getFirefighterFeed(): Promise<FirefighterFeedResponse> {
  const channel = firefighterChannelId();
  try {
    return await getFirefighterFeedWith(defaultDeps());
  } catch (error) {
    console.warn("Firefighters: couldn't read the channel feed.", error instanceof Error ? error.message : error);
    return { channel, channelName: "firefighters", error: "request_failed", fetchedAt: new Date().toISOString(), messages: [] };
  }
}
