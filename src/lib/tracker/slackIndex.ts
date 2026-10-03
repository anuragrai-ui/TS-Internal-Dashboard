import { getCache, setCache } from "@/lib/cache";
import { getSlackUserName, slackRead } from "@/lib/slackApi";
import { slackBackfillTick as runSlackBackfillTick, USER_HISTORY_READ_KEY, USER_HISTORY_READ_SECONDS } from "@/lib/tracker/slackBackfill";
import { conversationPermalink, enrichConversation } from "@/lib/tracker/slackEnrich";
import {
  CONVERSATION_SNIPPET_MAX_CHARS,
  detectEscalationHint,
  effectiveMessage,
  excludedChannels,
  extractMessageTicketKeys,
  extractSlackPermalinks as parseSlackPermalinks,
  isIndexableMessage,
  isSlackTs,
  isTrackableChannel,
  slackTextToPlain,
  slackTsToIso,
  threadUserIds,
  toThreadMessages,
} from "@/lib/tracker/slackParse";
import {
  defaultSlackIndexStore,
  readConversation,
  readConversationsForTickets,
  rememberSeenChannel,
  toConversationRef,
  upsertConversation,
} from "@/lib/tracker/slackStore";

import type { SlackInboundEvent } from "@/lib/notifications/slack";
import type { SlackHistoryMessage } from "@/lib/tracker/slackParse";
import type { ConversationUpdate, SlackIndexRedis, StoredConversation } from "@/lib/tracker/slackStore";
import type { SlackConversationRef, SlackConversationSource, SlackThreadResponse } from "@/lib/tracker/types";

/**
 * The tracker's Slack conversation index: which Slack threads are about
 * which tickets. Four ways in, one store (src/lib/tracker/slackStore.ts):
 * - live events (recordSlackActivity, from the events route) - a key in a
 *   reply attaches to the thread's ROOT, because the CP usually arrives in a reply
 * - the dashboard's own posts (src/lib/notifications/slackThreads.ts)
 * - permalinks pasted into Jira comments or by hand (linkConversation)
 * - the 30-day history drip (src/lib/tracker/slackBackfill.ts)
 *
 * Read-only towards Slack: only history/replies/info/permalink/user reads.
 * Message text is never stored, only a ~140 char root snippet; a thread's
 * messages are read live for the detail panel and cached for a minute.
 */

export interface SlackPermalink {
  channel: string;
  /* The linked message's ts. */
  ts: string;
  /* Present when the link points at a thread reply (?thread_ts=...). */
  threadTs?: string;
  url: string;
}

export interface SlackActivityResult {
  conversation: SlackConversationRef | null;
  /* Ticket keys this event linked to the conversation for the first time. */
  newlyLinkedKeys: string[];
  /* A reply in a conversation that was already linked to tickets (even if it repeats no key). */
  replyInLinkedConversation: boolean;
}

const NOTHING: SlackActivityResult = { conversation: null, newlyLinkedKeys: [], replyInLinkedConversation: false };
const THREAD_CACHE_SECONDS = 60;
const THREAD_REPLIES_LIMIT = "50";

export interface SlackIndexDeps {
  enrich?: (record: StoredConversation) => Promise<StoredConversation>;
  excluded?: ReadonlySet<string>;
  now?: Date;
  store: SlackIndexRedis;
}

function defaultDeps(): SlackIndexDeps | null {
  const store = defaultSlackIndexStore();
  return store ? { enrich: enrichConversation, store } : null;
}

/** Every Slack message permalink in a piece of text (Jira comment, pasted link). */
export function extractSlackPermalinks(text: string): SlackPermalink[] {
  return parseSlackPermalinks(text);
}

/* -------------------------------------------------------------- linking */

export interface LinkConversationArgs {
  at?: string;
  channel: string;
  rootTs: string;
  snippet?: string;
  source: SlackConversationSource;
  /* The root author's Slack user id - or, failing that, a display name. */
  startedBy?: string;
  ticketKeys: string[];
}

/** linkConversation with an explicit store - what the tests drive. */
export async function linkConversationWith(args: LinkConversationArgs, deps: SlackIndexDeps): Promise<SlackConversationRef | null> {
  if (!isTrackableChannel(args.channel, deps.excluded) || !isSlackTs(args.rootTs)) {
    return null;
  }
  const isUserId = Boolean(args.startedBy && /^[UW][A-Z0-9]{2,}$/.test(args.startedBy));
  const update: ConversationUpdate = {
    at: args.at,
    channel: args.channel,
    rootTs: args.rootTs,
    snippet: args.snippet,
    source: args.source,
    startedBy: isUserId ? args.startedBy : undefined,
    ticketKeys: args.ticketKeys,
  };
  const result = await upsertConversation(deps.store, update, {
    enrich: async (record) => {
      const named = !isUserId && args.startedBy && !record.startedByName ? { ...record, startedByName: args.startedBy } : record;
      return deps.enrich ? deps.enrich(named) : named;
    },
    now: deps.now,
  });
  return result ? toConversationRef(result.record) : null;
}

/** Attach a Slack conversation (thread root) to tickets. Idempotent; never downgrades counts. Never throws. */
export async function linkConversation(args: LinkConversationArgs): Promise<SlackConversationRef | null> {
  try {
    const deps = defaultDeps();
    return deps ? await linkConversationWith(args, deps) : null;
  } catch (error) {
    console.warn(`Could not link Slack conversation ${args.channel}/${args.rootTs}.`, error instanceof Error ? error.message : error);
    return null;
  }
}

/** Conversations per ticket key, most recent activity first. Keys without any are left out. Never throws. */
export async function getConversationsForTickets(keys: string[]): Promise<Map<string, SlackConversationRef[]>> {
  try {
    const deps = defaultDeps();
    if (!deps || keys.length === 0) {
      return new Map();
    }
    const stored = await readConversationsForTickets(deps.store, keys);
    /* A channel excluded after its conversations were indexed disappears from the tracker too. */
    const excluded = excludedChannels();
    const visible = [...stored]
      .map(([key, records]) => [key, records.filter((record) => isTrackableChannel(record.channel, excluded)).map(toConversationRef)] as const)
      .filter(([, refs]) => refs.length > 0);
    return new Map(visible);
  } catch (error) {
    console.warn("Could not read the Slack conversation index.", error instanceof Error ? error.message : error);
    return new Map();
  }
}

/* --------------------------------------------------------- live events */

/** recordSlackActivity with an explicit store - what the tests drive. */
export async function recordSlackActivityWith(event: SlackInboundEvent, deps: SlackIndexDeps): Promise<SlackActivityResult> {
  const effective = effectiveMessage(event);
  if (!effective) {
    return NOTHING;
  }
  const { channel, isEdit, message } = effective;
  if (!isTrackableChannel(channel, deps.excluded) || !isIndexableMessage(message)) {
    return NOTHING;
  }

  const ts = message.ts as string;
  const rootTs = message.thread_ts ?? ts;
  const isRoot = rootTs === ts;
  if (!isSlackTs(rootTs)) {
    return NOTHING;
  }

  const keys = extractMessageTicketKeys(message);
  if (keys.length === 0 && isRoot) {
    /* Most traffic: a new message about nothing. Costs no Redis call at all (a root can't be linked without a key). */
    return NOTHING;
  }

  const existing = await readConversation(deps.store, channel, rootTs);
  const wasLinked = Boolean(existing && existing.ticketKeys.length > 0);
  if (keys.length === 0 && !wasLinked) {
    return NOTHING;
  }

  const result = await upsertConversation(
    deps.store,
    {
      /* An edit isn't new activity; the edited message keeps its original ts. */
      at: isEdit ? undefined : (slackTsToIso(ts) ?? undefined),
      channel,
      escalationHint: detectEscalationHint(message, keys),
      participantIds: message.user ? [message.user] : [],
      replyTs: !isRoot && !isEdit ? ts : undefined,
      rootTs,
      /* Only the root speaks for the conversation; a reply's text never becomes its snippet. */
      snippet: isRoot ? slackTextToPlain(message.text ?? "", new Map(), CONVERSATION_SNIPPET_MAX_CHARS) || undefined : undefined,
      source: "event",
      startedBy: isRoot ? message.user : undefined,
      ticketKeys: keys,
    },
    { enrich: deps.enrich, existing, now: deps.now },
  );

  if (!result) {
    return NOTHING;
  }
  /* So the history drip also walks channels it only knows about from traffic (private ones users.conversations doesn't list). */
  await rememberSeenChannel(deps.store, channel);
  return {
    conversation: toConversationRef(result.record),
    newlyLinkedKeys: result.newlyLinkedKeys,
    replyInLinkedConversation: !isRoot && !isEdit && wasLinked,
  };
}

/** Events-route hook for every verified Slack event: index it, and say which tickets it touched. Never throws. */
export async function recordSlackActivity(event: SlackInboundEvent): Promise<SlackActivityResult> {
  try {
    const deps = defaultDeps();
    return deps ? await recordSlackActivityWith(event, deps) : NOTHING;
  } catch (error) {
    console.warn("Could not index a Slack event; notifications carry on without it.", error instanceof Error ? error.message : error);
    return NOTHING;
  }
}

/* ---------------------------------------------------------- thread read */

type RepliesPage = { error?: string; has_more?: boolean; messages?: SlackHistoryMessage[]; ok: boolean };

function friendlyThreadError(error: string | undefined): string {
  switch (error) {
    case "not_in_channel":
    case "channel_not_found":
      return "The dashboard's Slack bot isn't in that channel - invite it there to read this conversation here.";
    case "thread_not_found":
    case "message_not_found":
      return "That Slack thread no longer exists.";
    case "missing_scope":
      return "The Slack connection lacks permission to read this channel's history.";
    case "no_token":
      return "Slack isn't connected (Settings -> Slack).";
    default:
      return "Couldn't read this conversation from Slack.";
  }
}

/** Live thread read (conversations.replies) for the detail panel. Cached a minute; never stored beyond that. Never throws. */
export async function loadConversationMessages(channel: string, rootTs: string): Promise<SlackThreadResponse> {
  if (!isTrackableChannel(channel) || !isSlackTs(rootTs)) {
    return { error: "Not a Slack conversation.", messages: [] };
  }

  try {
    const cacheKey = `slack_thread:${channel}:${rootTs}`;
    const cached = await getCache<SlackThreadResponse>(cacheKey);
    if (cached) {
      return cached.value;
    }

    const deps = defaultDeps();
    const stored = deps ? await readConversation(deps.store, channel, rootTs).catch(() => null) : null;
    const permalink = stored?.permalink ?? (await conversationPermalink(channel, rootTs));

    /* This read spends the (probably one-a-minute) history budget: tell the drip to sit the next tick out. */
    await deps?.store.set(USER_HISTORY_READ_KEY, "1", USER_HISTORY_READ_SECONDS).catch(() => undefined);

    const result = await slackRead<RepliesPage>("conversations.replies", { channel, limit: THREAD_REPLIES_LIMIT, ts: rootTs });
    if (result.rateLimited) {
      return {
        error: `Slack is throttling reads - try again in ${result.retryAfterSeconds ?? 60}s, or open it in Slack.`,
        messages: [],
        permalink,
        rateLimited: true,
      };
    }
    if (!result.ok || !result.data) {
      return { error: friendlyThreadError(result.error), messages: [], permalink };
    }

    const raw = result.data.messages ?? [];
    const ids = threadUserIds(raw);
    const names = new Map<string, string>();
    for (const [id, name] of await Promise.all(ids.map(async (id) => [id, (await getSlackUserName(id))?.realName] as const))) {
      if (name) {
        names.set(id, name);
      }
    }

    const response: SlackThreadResponse = { messages: toThreadMessages(raw, names), permalink, ...(result.data.has_more ? { truncated: true } : {}) };
    await setCache(cacheKey, response, THREAD_CACHE_SECONDS);
    return response;
  } catch (error) {
    console.warn(`Could not read Slack thread ${channel}/${rootTs}.`, error instanceof Error ? error.message : error);
    return { error: "Couldn't read this conversation from Slack.", messages: [] };
  }
}

/** Whether a conversation is in the index - the thread-read route only serves indexed conversations. */
export async function isIndexedConversation(channel: string, rootTs: string): Promise<boolean> {
  try {
    if (!isTrackableChannel(channel)) {
      return false;
    }
    const deps = defaultDeps();
    return deps ? (await readConversation(deps.store, channel, rootTs)) !== null : false;
  } catch {
    return false;
  }
}

/** One small step of the history backfill, run from the poll loop. Never throws. */
export async function slackBackfillTick(): Promise<void> {
  await runSlackBackfillTick();
}
