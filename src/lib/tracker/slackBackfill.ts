import { listSlackBotChannels, slackRead } from "@/lib/slackApi";
import { enrichConversation } from "@/lib/tracker/slackEnrich";
import {
  CONVERSATION_SNIPPET_MAX_CHARS,
  detectEscalationHint,
  excludedChannels,
  extractMessageTicketKeys,
  isIndexableMessage,
  isSlackChannelId,
  slackTextToPlain,
  slackTsToIso,
} from "@/lib/tracker/slackParse";
import { CONVERSATION_TTL_SECONDS, defaultSlackIndexStore, listSeenChannels, upsertConversation } from "@/lib/tracker/slackStore";

import type { SlackBotChannel, SlackReadResult } from "@/lib/slackApi";
import type { SlackHistoryMessage } from "@/lib/tracker/slackParse";
import type { ConversationUpdate, SlackIndexRedis } from "@/lib/tracker/slackStore";

/**
 * The history drip: live events only cover what happens from now on, so
 * this walks the last 30 days of every channel the bot is in, one
 * conversations.history page per tick, and indexes every top-level message
 * that names a ticket. Counts come from the page itself (reply_count,
 * latest_reply, reply_users_count) - no conversations.replies fan-out.
 *
 * The Vercel-managed Slack app is probably held to one history/replies call
 * a minute and 15 messages a page, so: at most one tick every ~70s across
 * all servers (SET NX EX), a stored backoff whenever Slack says
 * "ratelimited", and a pause whenever someone just opened a thread in the
 * tracker - a person waiting on a thread read beats the drip.
 */

const LOCK_KEY = "slack:backfill:lock";
const LOCK_SECONDS = 70;
const STATE_KEY = "slack:backfill:state";
/* Set by loadConversationMessages when it spends the history budget on a person's thread read. */
export const USER_HISTORY_READ_KEY = "slack:history:user_read";
export const USER_HISTORY_READ_SECONDS = 65;
const HISTORY_WINDOW_MS = 30 * 86_400_000;
/* A finished channel is walked again (only the part since its last pass) this often, to catch threads events missed. */
const RESCAN_AFTER_MS = 6 * 3_600_000;
const PASS_OVERLAP_MS = 3_600_000;
const DEFAULT_RETRY_AFTER_SECONDS = 60;
const NO_TOKEN_RETRY_SECONDS = 300;
const HISTORY_PAGE_LIMIT = "200";
const PREFERRED_PROBE_CHANNEL = "C07U9C0EPEH";
/* Errors that won't fix themselves by retrying: the channel is skipped until the next pass. */
const FATAL_CHANNEL_ERRORS = new Set(["channel_not_found", "is_archived", "missing_scope", "not_in_channel"]);
/* A channel failing for any other reason this many times in a row is skipped until its next scheduled pass. */
const MAX_CONSECUTIVE_FAILURES = 5;
/* The cursor is dead (expired, or the pass window moved): start the pass again from its first page - upserts are idempotent. */
const RESTART_PASS_ERRORS = new Set(["invalid_cursor", "invalid_ts_oldest"]);

export interface SlackBackfillChannelState {
  channel: string;
  completedAt?: string;
  conversationsLinked: number;
  /* Where the pass in progress resumes (Slack's next_cursor). */
  cursor?: string;
  done: boolean;
  error?: string;
  /* Non-fatal failures since the last good page. */
  failures?: number;
  /* Messages in the last page - 15 on a full page means Slack is clamping pages. */
  lastPageSize?: number;
  lastScannedAt?: string;
  messagesScanned: number;
  name?: string;
  /* Slack ts lower bound of the pass in progress. */
  oldest?: string;
  passStartedAt?: string;
  passes: number;
}

export interface SlackBackfillState {
  backoffUntil?: string;
  channels: Record<string, SlackBackfillChannelState>;
  lastError?: string;
  lastTickAt?: string;
  nextIndex: number;
}

export interface SlackHistoryPage {
  error?: string;
  has_more?: boolean;
  messages?: SlackHistoryMessage[];
  ok: boolean;
  response_metadata?: { next_cursor?: string };
}

export interface BackfillDeps {
  botChannels: () => Promise<SlackBotChannel[]>;
  history: (channel: string, params: { cursor?: string; oldest: string }) => Promise<SlackReadResult<SlackHistoryPage>>;
  /* Stores one conversation; false when nothing was stored. */
  link: (update: ConversationUpdate) => Promise<boolean>;
  now: () => Date;
  store: SlackIndexRedis;
}

/* ------------------------------------------------------------------ pure */

export function emptyBackfillState(): SlackBackfillState {
  return { channels: {}, nextIndex: 0 };
}

function emptyChannelState(channel: string, name?: string): SlackBackfillChannelState {
  return { channel, conversationsLinked: 0, done: false, messagesScanned: 0, name, passes: 0 };
}

function msToSlackTs(ms: number): string {
  return (ms / 1000).toFixed(6);
}

/** Channels to walk, in a stable order: the bot's public channels plus any seen in events, minus excluded ones. */
export function backfillChannelList(bot: readonly SlackBotChannel[], seen: readonly string[], excluded: ReadonlySet<string>): SlackBotChannel[] {
  const byId = new Map<string, SlackBotChannel>();
  for (const channel of bot) {
    byId.set(channel.id, channel);
  }
  for (const id of seen) {
    if (!byId.has(id)) {
      byId.set(id, { id });
    }
  }
  return [...byId.values()].filter((channel) => isSlackChannelId(channel.id) && !channel.id.startsWith("D") && !excluded.has(channel.id)).sort((a, b) => (a.id < b.id ? -1 : 1));
}

function isEligible(state: SlackBackfillChannelState | undefined, nowMs: number): boolean {
  if (!state || !state.done) {
    return true;
  }
  return !state.completedAt || nowMs - Date.parse(state.completedAt) >= RESCAN_AFTER_MS;
}

/** Round-robin from where the last tick stopped: the next channel with work to do, or null when everything is fresh. */
export function pickBackfillChannel(state: SlackBackfillState, channels: readonly SlackBotChannel[], nowMs: number): { channel: SlackBotChannel; index: number } | null {
  for (let step = 0; step < channels.length; step += 1) {
    const index = (state.nextIndex + step) % channels.length;
    const channel = channels[index];
    if (channel && isEligible(state.channels[channel.id], nowMs)) {
      return { channel, index };
    }
  }
  return null;
}

/** A finished (or new) channel starts a pass: from 30 days back the first time, else from just before the previous pass began. */
export function startPassIfNeeded(state: SlackBackfillChannelState, nowMs: number): SlackBackfillChannelState {
  if (state.cursor && !state.done && state.oldest) {
    return state;
  }
  if (!state.done && state.oldest && !state.cursor && state.passStartedAt) {
    /* A pass started but its first page never landed (rate limited): keep its window. */
    return state;
  }
  const floor = nowMs - HISTORY_WINDOW_MS;
  const previousStart = state.passStartedAt ? Date.parse(state.passStartedAt) - PASS_OVERLAP_MS : floor;
  return {
    ...state,
    cursor: undefined,
    done: false,
    error: undefined,
    oldest: msToSlackTs(Math.max(floor, state.passes > 0 ? previousStart : floor)),
    passStartedAt: new Date(nowMs).toISOString(),
  };
}

/** One top-level message from a history page as a conversation observation, or null when it names no ticket (or isn't a person's). */
export function historyMessageToUpdate(channel: string, channelName: string | undefined, message: SlackHistoryMessage): ConversationUpdate | null {
  if (!message.ts || !isIndexableMessage(message) || (message.thread_ts && message.thread_ts !== message.ts)) {
    return null;
  }
  const keys = extractMessageTicketKeys(message);
  if (keys.length === 0) {
    return null;
  }
  const replyUsers = message.reply_users ?? [];
  const rootCounted = message.user && replyUsers.includes(message.user) ? 0 : 1;

  return {
    at: slackTsToIso(message.latest_reply ?? message.ts) ?? undefined,
    channel,
    channelName,
    escalationHint: detectEscalationHint(message, keys),
    participantIds: [...new Set([message.user, ...replyUsers].filter((id): id is string => Boolean(id)))],
    participants: (message.reply_users_count ?? 0) + rootCounted,
    replyCount: message.reply_count ?? 0,
    rootTs: message.ts,
    snippet: slackTextToPlain(message.text ?? "", new Map(), CONVERSATION_SNIPPET_MAX_CHARS) || undefined,
    source: "backfill",
    startedBy: message.user,
    ticketKeys: keys,
  };
}

/* -------------------------------------------------------------------- I/O */

async function loadState(store: SlackIndexRedis): Promise<SlackBackfillState> {
  const stored = await store.get<SlackBackfillState>(STATE_KEY);
  return stored && typeof stored === "object" && stored.channels ? stored : emptyBackfillState();
}

async function saveState(store: SlackIndexRedis, state: SlackBackfillState): Promise<void> {
  await store.set(STATE_KEY, state, CONVERSATION_TTL_SECONDS);
}

/** Records Slack's "slow down" so no server tries again before it says so. */
export async function recordSlackHistoryBackoff(store: SlackIndexRedis, retryAfterSeconds: number | undefined, now = new Date()): Promise<void> {
  const state = await loadState(store);
  state.backoffUntil = new Date(now.getTime() + (retryAfterSeconds ?? DEFAULT_RETRY_AFTER_SECONDS) * 1000).toISOString();
  state.lastError = "ratelimited";
  await saveState(store, state);
}

/** One tick: at most one conversations.history call. Exposed with injectable deps for tests; use slackBackfillTick in the app. */
export async function runBackfillTick(deps: BackfillDeps): Promise<void> {
  const { store } = deps;
  const now = deps.now();
  const nowMs = now.getTime();

  if (!(await store.setIfAbsent(LOCK_KEY, now.toISOString(), LOCK_SECONDS))) {
    return;
  }

  const state = await loadState(store);
  if (state.backoffUntil && Date.parse(state.backoffUntil) > nowMs) {
    return;
  }
  if (await store.get(USER_HISTORY_READ_KEY)) {
    /* Someone is reading a thread in the tracker right now - give them the budget. */
    return;
  }

  const [bot, seen] = await Promise.all([deps.botChannels(), listSeenChannels(store)]);
  const channels = backfillChannelList(bot, seen, excludedChannels());
  state.lastTickAt = now.toISOString();

  const pick = pickBackfillChannel(state, channels, nowMs);
  if (!pick) {
    await saveState(store, state);
    return;
  }

  const name = pick.channel.name ?? state.channels[pick.channel.id]?.name;
  let channelState = startPassIfNeeded({ ...(state.channels[pick.channel.id] ?? emptyChannelState(pick.channel.id)), name }, nowMs);
  state.nextIndex = pick.index + 1;

  const result = await deps.history(pick.channel.id, { cursor: channelState.cursor, oldest: channelState.oldest ?? msToSlackTs(nowMs - HISTORY_WINDOW_MS) });

  if (result.rateLimited) {
    state.backoffUntil = new Date(nowMs + (result.retryAfterSeconds ?? DEFAULT_RETRY_AFTER_SECONDS) * 1000).toISOString();
    state.lastError = "ratelimited";
    /* Don't advance the round-robin: this channel goes first once Slack allows. */
    state.nextIndex = pick.index;
    state.channels[pick.channel.id] = channelState;
    await saveState(store, state);
    return;
  }

  if (!result.ok || !result.data) {
    const error = result.error ?? "unknown";
    if (error === "no_token") {
      /* Slack isn't connected right now - nothing is wrong with this channel, so don't count it against it. */
      state.backoffUntil = new Date(nowMs + NO_TOKEN_RETRY_SECONDS * 1000).toISOString();
      state.lastError = error;
      state.nextIndex = pick.index;
      await saveState(store, state);
      return;
    }
    const failures = (channelState.failures ?? 0) + 1;
    channelState = { ...channelState, error, failures, lastScannedAt: now.toISOString() };
    if (FATAL_CHANNEL_ERRORS.has(error) || failures >= MAX_CONSECUTIVE_FAILURES) {
      channelState = { ...channelState, completedAt: now.toISOString(), cursor: undefined, done: true, failures: undefined };
    } else if (RESTART_PASS_ERRORS.has(error)) {
      channelState = { ...channelState, cursor: undefined };
    }
    state.lastError = error;
    state.channels[pick.channel.id] = channelState;
    await saveState(store, state);
    return;
  }

  const messages = result.data.messages ?? [];
  let linked = 0;
  for (const message of messages) {
    const update = historyMessageToUpdate(pick.channel.id, name, message);
    if (update && (await deps.link(update))) {
      linked += 1;
    }
  }

  const nextCursor = result.data.has_more ? result.data.response_metadata?.next_cursor || undefined : undefined;
  channelState = {
    ...channelState,
    conversationsLinked: channelState.conversationsLinked + linked,
    cursor: nextCursor,
    error: undefined,
    failures: undefined,
    lastPageSize: messages.length,
    lastScannedAt: now.toISOString(),
    messagesScanned: channelState.messagesScanned + messages.length,
  };
  if (!nextCursor) {
    channelState = { ...channelState, completedAt: now.toISOString(), done: true, passes: channelState.passes + 1 };
  }
  state.channels[pick.channel.id] = channelState;
  state.lastError = undefined;
  await saveState(store, state);
}

function defaultBackfillDeps(store: SlackIndexRedis): BackfillDeps {
  return {
    botChannels: listSlackBotChannels,
    history: (channel, { cursor, oldest }) =>
      slackRead<SlackHistoryPage>("conversations.history", {
        channel,
        limit: HISTORY_PAGE_LIMIT,
        oldest,
        ...(cursor ? { cursor } : {}),
      }),
    link: async (update) => (await upsertConversation(store, update, { enrich: enrichConversation })) !== null,
    now: () => new Date(),
    store,
  };
}

/** One small step of the history backfill. Never throws. */
export async function slackBackfillTick(): Promise<void> {
  try {
    const store = defaultSlackIndexStore();
    if (store) {
      await runBackfillTick(defaultBackfillDeps(store));
    }
  } catch (error) {
    console.warn("Slack history backfill tick failed; it will try again later.", error instanceof Error ? error.message : error);
  }
}

export interface SlackBackfillStatus {
  backoffUntil?: string;
  channels: SlackBackfillChannelState[];
  lastError?: string;
  lastTickAt?: string;
}

/** Progress for Settings -> Slack. Null when Redis isn't configured or can't be read. */
export async function getSlackBackfillStatus(): Promise<SlackBackfillStatus | null> {
  try {
    const store = defaultSlackIndexStore();
    if (!store) {
      return null;
    }
    const state = await loadState(store);
    return {
      backoffUntil: state.backoffUntil,
      channels: Object.values(state.channels).sort((a, b) => (a.name ?? a.channel).localeCompare(b.name ?? b.channel)),
      lastError: state.lastError,
      lastTickAt: state.lastTickAt,
    };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ probe */

export interface SlackHistoryProbeResult {
  channel: string;
  error?: string;
  firstCallCount: number;
  hasMore: boolean;
  retryAfterSeconds: number | null;
  secondCallRateLimited: boolean;
  verdict: "clamped" | "full" | "unknown";
}

/** Reads the probe's two calls: a 15-message page that says "more", or a refused second call, means the app is throttled. */
export function probeVerdict(firstCallCount: number, hasMore: boolean, secondCallRateLimited: boolean): SlackHistoryProbeResult["verdict"] {
  if (secondCallRateLimited || (hasMore && firstCallCount <= 15)) {
    return "clamped";
  }
  return firstCallCount > 15 ? "full" : "unknown";
}

/**
 * Settings -> Slack "Check Slack history access": two conversations.history
 * calls back to back on one bot channel. Returns counts and status only -
 * never message text. A throttled answer is recorded as the drip's backoff.
 */
export async function probeSlackHistoryAccess(): Promise<SlackHistoryProbeResult> {
  const bot = await listSlackBotChannels();
  const channel = bot.find((item) => item.id === PREFERRED_PROBE_CHANNEL)?.id ?? bot[0]?.id ?? PREFERRED_PROBE_CHANNEL;
  const params = { channel, limit: HISTORY_PAGE_LIMIT };
  const store = defaultSlackIndexStore();
  /* The probe spends the history budget too: the drip sits its next tick out. */
  await store?.set(USER_HISTORY_READ_KEY, "1", USER_HISTORY_READ_SECONDS).catch(() => undefined);

  const first = await slackRead<SlackHistoryPage>("conversations.history", params);
  if (!first.ok) {
    return {
      channel,
      error: first.error,
      firstCallCount: 0,
      hasMore: false,
      retryAfterSeconds: first.retryAfterSeconds ?? null,
      secondCallRateLimited: false,
      verdict: first.rateLimited ? "clamped" : "unknown",
    };
  }

  const second = await slackRead<SlackHistoryPage>("conversations.history", params);
  const firstCallCount = first.data?.messages?.length ?? 0;
  const hasMore = Boolean(first.data?.has_more);
  const retryAfterSeconds = second.rateLimited ? (second.retryAfterSeconds ?? null) : null;

  if (second.rateLimited && store) {
    await recordSlackHistoryBackoff(store, second.retryAfterSeconds).catch(() => undefined);
  }

  return {
    channel,
    error: !second.ok && !second.rateLimited ? second.error : undefined,
    firstCallCount,
    hasMore,
    retryAfterSeconds,
    secondCallRateLimited: second.rateLimited,
    verdict: probeVerdict(firstCallCount, hasMore, second.rateLimited),
  };
}
