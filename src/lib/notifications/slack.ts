import { acknowledgeFromReaction } from "@/lib/escalation/acknowledge";
import { getCache, setCache } from "@/lib/cache";
import { createReadOnlyJiraClient, readOnlyJiraConfigFromEnv } from "@/lib/escalation/readOnlyJira";
import { searchByKeys } from "@/lib/escalation/sweep";
import { getPostedSlackMessage } from "@/lib/notifications/slackThreads";
import { addNotifications } from "@/lib/notifications/store";
import { isRedisConfigured } from "@/lib/redis";
import { getSlackChannelName, getSlackPermalink, getSlackUserName } from "@/lib/slackApi";
import { getTicketAudience } from "@/lib/tracker/audience";
import { recordSlackActivity } from "@/lib/tracker/slackIndex";
import { conversationPermalink } from "@/lib/tracker/slackEnrich";
import { extractMessageTicketKeys, extractTicketKeysFromText, slackTextToPlain } from "@/lib/tracker/slackParse";
import { listRegisteredJiraUsers } from "@/lib/userJiraTokens";

import type { PostedSlackMessage } from "@/lib/notifications/slackThreads";
import type { AppNotification } from "@/lib/notifications/types";
import type { SlackUserName } from "@/lib/slackApi";
import type { SlackActivityResult } from "@/lib/tracker/slackIndex";
import type { SlackConversationRef } from "@/lib/tracker/types";
import type { RegisteredJiraUser } from "@/lib/userJiraTokens";

export { slackTextToPlain } from "@/lib/tracker/slackParse";

/**
 * Slack's side of the notification center. Every message the dashboard
 * posts is remembered (src/lib/notifications/slackThreads.ts), and Slack
 * events forwarded by Vercel Connect are matched against that memory:
 * - a reply in one of those threads notifies the thread's audience
 * - a reaction on one of those messages notifies it too (and a ✅ on an
 *   escalation parent is the acknowledgement)
 * - a message anywhere the bot can read that mentions a TS/CP key notifies
 *   whoever owns that ticket
 * - a reply in any other Slack conversation the tracker has linked to
 *   tickets (src/lib/tracker/slackIndex.ts) notifies those tickets' audience
 *
 * Every message is indexed first (recordSlackActivity), then turned into at
 * most one notification per person.
 */

/* App attachments and link unfurls: Jira's unfurl carries the ticket key in its title and link. */
export interface SlackAttachment {
  fallback?: string;
  from_url?: string;
  original_url?: string;
  pretext?: string;
  text?: string;
  title?: string;
  title_link?: string;
}

/* Slack's own fields we read; everything else in the event is ignored. Also the shape of a conversations.history message. */
export interface SlackInboundEvent {
  attachments?: SlackAttachment[];
  /* Block Kit / rich_text blocks - walked for text and link URLs (src/lib/tracker/slackParse.ts). */
  blocks?: unknown[];
  bot_id?: string;
  channel?: string;
  item?: { channel?: string; ts?: string; type?: string };
  /* History only: the newest reply's ts. */
  latest_reply?: string;
  /* An edit (subtype message_changed) carries the edited message here. */
  message?: SlackInboundEvent;
  reaction?: string;
  /* History only: thread counts on a root message. */
  reply_count?: number;
  reply_users?: string[];
  reply_users_count?: number;
  subtype?: string;
  text?: string;
  thread_ts?: string;
  ts?: string;
  type?: string;
  user?: string;
}

const MAX_MENTIONED_KEYS = 10;
const MAX_NAME_LOOKUPS = 5;
/* Jira owner lookups per message, and how long each ticket's answer is reused - replies in a busy thread must not each cost searches. */
const MAX_OWNER_LOOKUP_KEYS = 12;
const OWNER_CACHE_SECONDS = 300;
/* A person saying something: plain messages, thread broadcasts, file shares. Edits, deletes, joins and bot posts aren't. */
const HUMAN_SUBTYPES = new Set<string | undefined>([undefined, "file_share", "me_message", "thread_broadcast"]);

/* A few common reactions shown as the emoji itself; anything else stays :name:. */
const REACTION_GLYPHS: Record<string, string> = {
  "+1": "👍",
  eyes: "👀",
  fire: "🔥",
  heavy_check_mark: "✔️",
  pray: "🙏",
  raised_hands: "🙌",
  rocket: "🚀",
  tada: "🎉",
  thumbsup: "👍",
  warning: "⚠️",
  white_check_mark: "✅",
  x: "❌",
};

/* ------------------------------------------------------------------ pure */

export function isHumanMessage(event: SlackInboundEvent): boolean {
  return event.type === "message" && !event.bot_id && HUMAN_SUBTYPES.has(event.subtype) && Boolean(event.user && event.ts && event.channel);
}

export function extractTicketKeys(text: string | undefined): string[] {
  return extractTicketKeysFromText(text, MAX_MENTIONED_KEYS);
}

export function reactionGlyph(reaction: string | undefined): string {
  /* "+1::skin-tone-3" -> "+1" */
  const base = (reaction ?? "").split("::")[0] ?? "";
  return REACTION_GLYPHS[base] ?? `:${base}:`;
}

export interface SlackNotificationContext {
  actorName: string;
  /* Registered users the Slack actor appears to be - never notified about their own message. */
  actorAccountIds: ReadonlySet<string>;
  /* "technical-support", when Slack told us; titles then say "in #technical-support" instead of "in Slack". */
  channelName?: string;
  permalink?: string;
  snippet: string;
}

function whereLabel(ctx: SlackNotificationContext): string {
  return ctx.channelName ? `#${ctx.channelName}` : "Slack";
}

function slackInstant(ts: string | undefined): string {
  const seconds = Number(ts);
  return new Date(Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : Date.now()).toISOString();
}

/* Nobody hears about their own reply - except on the Settings -> Slack test message, whose whole
   point is letting you check the loop by replying to it yourself. */
function listeners(posted: PostedSlackMessage, ctx: SlackNotificationContext): string[] {
  return posted.kind === "test" ? posted.audience : posted.audience.filter((id) => !ctx.actorAccountIds.has(id));
}

export function replyNotification(
  event: SlackInboundEvent,
  posted: PostedSlackMessage,
  ctx: SlackNotificationContext,
): AppNotification | null {
  if (!event.channel || !event.ts) {
    return null;
  }
  const audience = listeners(posted, ctx);
  if (audience.length === 0) {
    return null;
  }

  return {
    actor: ctx.actorName,
    at: slackInstant(event.ts),
    audience,
    cpKey: posted.cpKey,
    detail: ctx.snippet || undefined,
    id: `slack:${event.channel}:${event.ts}`,
    /* A human answering something the dashboard raised is exactly what the bell is for. */
    important: true,
    kind: "slack_reply",
    source: "slack",
    ticketKey: posted.ticketKeys[0],
    title: `${ctx.actorName} replied to ${posted.label}`,
    url: ctx.permalink,
  };
}

export function reactionNotification(
  event: SlackInboundEvent,
  posted: PostedSlackMessage,
  ctx: SlackNotificationContext,
): AppNotification | null {
  const channel = event.item?.channel;
  const ts = event.item?.ts;
  if (!channel || !ts || !event.user || !event.reaction) {
    return null;
  }
  const audience = listeners(posted, ctx);
  if (audience.length === 0) {
    return null;
  }

  return {
    actor: ctx.actorName,
    at: new Date().toISOString(),
    audience,
    cpKey: posted.cpKey,
    id: `slack:${channel}:${ts}:r:${event.user}:${event.reaction}`,
    important: false,
    kind: "slack_reaction",
    source: "slack",
    ticketKey: posted.ticketKeys[0],
    title: `${ctx.actorName} reacted ${reactionGlyph(event.reaction)} to ${posted.label}`,
    url: ctx.permalink,
  };
}

export function mentionNotifications(
  event: SlackInboundEvent,
  audienceByKey: ReadonlyMap<string, string[]>,
  ctx: SlackNotificationContext,
): AppNotification[] {
  if (!event.channel || !event.ts) {
    return [];
  }

  const out: AppNotification[] = [];
  for (const [key, owners] of audienceByKey) {
    const audience = owners.filter((id) => !ctx.actorAccountIds.has(id));
    if (audience.length === 0) {
      continue;
    }
    out.push({
      actor: ctx.actorName,
      at: slackInstant(event.ts),
      audience,
      cpKey: key.startsWith("CP-") ? key : undefined,
      detail: ctx.snippet || undefined,
      id: `slack:${event.channel}:${event.ts}:m:${key}`,
      important: false,
      kind: "slack_mention",
      source: "slack",
      ticketKey: key.startsWith("TS-") ? key : undefined,
      title: `${ctx.actorName} mentioned ${key} in ${whereLabel(ctx)}`,
      url: ctx.permalink,
    });
  }
  return out;
}

/** A reply in a Slack conversation the tracker linked to tickets (not one the dashboard posted): tells those tickets' audience. */
export function conversationReplyNotification(
  event: SlackInboundEvent,
  conversation: SlackConversationRef,
  audience: readonly string[],
  ctx: SlackNotificationContext,
): AppNotification | null {
  if (!event.channel || !event.ts) {
    return null;
  }
  const listeners = [...new Set(audience)].filter((id) => !ctx.actorAccountIds.has(id));
  if (listeners.length === 0) {
    return null;
  }

  /* Titles name the TS ticket when there is one - that's what TS owns; a CP-only thread names the CP. */
  const tsKey = conversation.ticketKeys.find((key) => key.startsWith("TS-"));
  const cpKey = conversation.ticketKeys.find((key) => key.startsWith("CP-"));
  const about = tsKey ?? cpKey ?? conversation.ticketKeys[0] ?? "a ticket";

  return {
    actor: ctx.actorName,
    at: slackInstant(event.ts),
    audience: listeners,
    cpKey,
    detail: ctx.snippet || undefined,
    /* Same id a bot-thread reply would get: one message, one notification. */
    id: `slack:${event.channel}:${event.ts}`,
    important: true,
    kind: "slack_reply",
    source: "slack",
    ticketKey: tsKey ?? cpKey,
    title: `${ctx.actorName} replied in ${whereLabel(ctx)} about ${about}`,
    url: ctx.permalink,
  };
}

/** Everyone in the audience of any of these tickets, once. */
export function audienceForKeys(keys: readonly string[], audienceByKey: ReadonlyMap<string, string[]>): string[] {
  return [...new Set(keys.flatMap((key) => audienceByKey.get(key) ?? []))];
}

/** Each person hears about one mentioned key at most - the first one they own - and not at all if already told about this message. */
export function oneMentionPerPerson(
  keys: readonly string[],
  audienceByKey: ReadonlyMap<string, string[]>,
  alreadyTold: ReadonlySet<string>,
): Map<string, string[]> {
  const assigned = new Set(alreadyTold);
  const out = new Map<string, string[]>();
  for (const key of keys) {
    const fresh = [...new Set(audienceByKey.get(key) ?? [])].filter((id) => !assigned.has(id));
    if (fresh.length > 0) {
      fresh.forEach((id) => assigned.add(id));
      out.set(key, fresh);
    }
  }
  return out;
}

export interface MessageNotificationInput {
  /* Who to tell per ticket key (snapshot audience, with the Jira owner lookup filling gaps for mentioned keys). */
  audienceByKey: ReadonlyMap<string, string[]>;
  /* The conversation this message replies in, when it was already linked to tickets. */
  conversation: SlackConversationRef | null;
  ctx: SlackNotificationContext;
  event: SlackInboundEvent;
  mentionedKeys: string[];
  /* The dashboard's own message this replies to, if any. */
  posted: PostedSlackMessage | null;
}

/**
 * Everything one Slack message should notify, with nobody told twice:
 * 1. a reply to one of the dashboard's own posts tells that post's audience,
 *    plus the audience of the tickets its conversation is about
 * 2. otherwise a reply in a linked conversation tells its tickets' audience
 * 3. then each mentioned key tells its owners - minus anyone already told
 */
export function planMessageNotifications(input: MessageNotificationInput): AppNotification[] {
  const { audienceByKey, conversation, ctx, event, mentionedKeys, posted } = input;
  const conversationAudience = conversation ? audienceForKeys(conversation.ticketKeys, audienceByKey) : [];

  let reply = posted ? replyNotification(event, posted, ctx) : null;
  if (reply) {
    const replyAudience = new Set(reply.audience);
    const extra = conversationAudience.filter((id) => !ctx.actorAccountIds.has(id) && !replyAudience.has(id));
    reply = extra.length > 0 ? { ...reply, audience: [...reply.audience, ...extra] } : reply;
  } else if (conversation) {
    reply = conversationReplyNotification(event, conversation, conversationAudience, ctx);
  }

  const mentions = mentionNotifications(event, oneMentionPerPerson(mentionedKeys, audienceByKey, new Set(reply?.audience ?? [])), ctx);
  return reply ? [reply, ...mentions] : mentions;
}

/**
 * Keys whose owners still have to be asked of Jira: every CP (the snapshot only knows TS assignees) and any TS key
 * the audience map doesn't cover (a Medium ticket, an unregistered assignee, no snapshot). Mentioned keys come first,
 * then the linked conversation's own keys - a bare reply that repeats no key still has to reach their owners.
 */
export function keysNeedingOwnerLookup(mentionedKeys: string[], conversationKeys: string[], audienceByKey: ReadonlyMap<string, string[]>): string[] {
  return [...new Set([...mentionedKeys, ...conversationKeys])]
    .filter((key) => !audienceByKey.has(key) || key.startsWith("CP-"))
    .slice(0, MAX_OWNER_LOOKUP_KEYS);
}

/** Registered users whose Jira name matches the Slack person's - only ever used to SKIP notifying someone about themself. */
export function matchRegisteredUsers(name: SlackUserName | null, users: RegisteredJiraUser[]): Set<string> {
  const candidates = new Set([name?.realName, name?.displayName].filter(Boolean).map((value) => (value as string).trim().toLowerCase()));
  return new Set(users.filter((user) => candidates.has(user.displayName.trim().toLowerCase())).map((user) => user.accountId));
}

/* -------------------------------------------------------------------- I/O */

/* Who owns each mentioned ticket: a TS key's assignee, or for a CP key the assignees of the TS tickets linked to it - registered users only. */
async function ticketOwners(keys: string[], registered: ReadonlySet<string>): Promise<Map<string, string[]>> {
  const owners = new Map<string, string[]>();
  if (keys.length === 0 || registered.size === 0) {
    return owners;
  }

  const client = createReadOnlyJiraClient(readOnlyJiraConfigFromEnv());
  type Issue = {
    fields: {
      assignee?: { accountId?: string } | null;
      issuelinks?: Array<{ inwardIssue?: { key?: string }; outwardIssue?: { key?: string } }>;
      status?: { statusCategory?: { key?: string } } | null;
    };
    key: string;
  };

  /* searchByKeys skips keys Jira won't resolve ("TS-2025" in a sentence, a deleted ticket) instead of failing them all. */
  const issues = await searchByKeys<Issue>(client, keys, ["assignee", "issuelinks"]);
  const cpLinks = new Map<string, string[]>();

  for (const issue of issues) {
    if (issue.key.startsWith("TS-")) {
      const owner = issue.fields.assignee?.accountId;
      if (owner && registered.has(owner)) {
        owners.set(issue.key, [owner]);
      }
    } else {
      const linked = (issue.fields.issuelinks ?? [])
        .map((link) => (link.inwardIssue ?? link.outwardIssue)?.key)
        .filter((key): key is string => typeof key === "string" && key.startsWith("TS-"));
      cpLinks.set(issue.key, linked);
    }
  }

  const linkedTs = [...new Set([...cpLinks.values()].flat())].slice(0, 100);
  if (linkedTs.length > 0) {
    const tsIssues = (await searchByKeys<Issue>(client, linkedTs, ["assignee", "status"])).filter(
      (issue) => issue.fields.status?.statusCategory?.key !== "done",
    );
    const ownerByTs = new Map(tsIssues.map((issue) => [issue.key, issue.fields.assignee?.accountId]));
    for (const [cpKey, tsKeys] of cpLinks) {
      const cpOwners = [...new Set(tsKeys.map((key) => ownerByTs.get(key)).filter((id): id is string => Boolean(id && registered.has(id))))];
      if (cpOwners.length > 0) {
        owners.set(cpKey, cpOwners);
      }
    }
  }

  return owners;
}

/* ticketOwners with a short per-ticket cache. Nothing is cached when Jira fails, so the next message retries. */
async function cachedTicketOwners(keys: string[], registered: ReadonlySet<string>): Promise<Map<string, string[]>> {
  const owners = new Map<string, string[]>();
  if (keys.length === 0 || registered.size === 0) {
    return owners;
  }

  const misses: string[] = [];
  await Promise.all(
    keys.map(async (key) => {
      const cached = await getCache<string[]>(`slack_owners:${key}`);
      if (!cached) {
        misses.push(key);
        return;
      }
      const stillRegistered = cached.value.filter((id) => registered.has(id));
      if (stillRegistered.length > 0) {
        owners.set(key, stillRegistered);
      }
    }),
  );

  if (misses.length > 0) {
    const fetched = await ticketOwners(misses, registered);
    for (const key of misses) {
      const found = fetched.get(key) ?? [];
      if (found.length > 0) {
        owners.set(key, found);
      }
      await setCache(`slack_owners:${key}`, found, OWNER_CACHE_SECONDS);
    }
  }
  return owners;
}

async function mentionNames(text: string | undefined): Promise<Map<string, string>> {
  const ids = [...new Set([...(text ?? "").matchAll(/<@([UW][A-Z0-9]+)/g)].map((match) => match[1] as string))].slice(0, MAX_NAME_LOOKUPS);
  const names = await Promise.all(ids.map(async (id) => [id, (await getSlackUserName(id))?.realName] as const));
  return new Map(names.filter((entry): entry is readonly [string, string] => Boolean(entry[1])));
}

/* The tracker's audience per ticket (snapshot-based, no Jira call). A failure just means falling back to the Jira lookup. */
async function snapshotAudience(keys: string[]): Promise<Map<string, string[]>> {
  if (keys.length === 0) {
    return new Map();
  }
  try {
    return await getTicketAudience(keys);
  } catch (error) {
    console.warn("Couldn't read the tracker's ticket audience; falling back to Jira owners.", error instanceof Error ? error.message : error);
    return new Map();
  }
}

const NO_ACTIVITY: SlackActivityResult = { conversation: null, newlyLinkedKeys: [], replyInLinkedConversation: false };

/**
 * Called (after the HTTP response) for every verified Slack event. Never
 * throws: a notification that can't be built is logged and dropped, and
 * Slack is never retried for it.
 */
export async function notifyFromSlackEvent(event: SlackInboundEvent | undefined): Promise<AppNotification[]> {
  if (!event || !isRedisConfigured()) {
    return [];
  }

  try {
    /* Index first (edits too): the tracker learns about every ticket conversation, whether or not anyone is notified. Never throws. */
    const activity = event.type === "message" ? await recordSlackActivity(event) : NO_ACTIVITY;
    if (isHumanMessage(event)) {
      return await notifyFromMessage(event, activity);
    }
    if (event.type === "reaction_added" && event.item?.type === "message") {
      return await notifyFromReaction(event);
    }
  } catch (error) {
    console.warn(`Could not turn a Slack ${event.type ?? "unknown"} event into notifications.`, error instanceof Error ? error.message : error);
  }
  return [];
}

async function notifyFromMessage(event: SlackInboundEvent, activity: SlackActivityResult): Promise<AppNotification[]> {
  const channel = event.channel as string;
  const ts = event.ts as string;
  const isReply = Boolean(event.thread_ts && event.thread_ts !== ts);
  const posted = isReply ? await getPostedSlackMessage(channel, event.thread_ts as string) : null;
  const keys = extractMessageTicketKeys(event, MAX_MENTIONED_KEYS);
  const conversation = activity.replyInLinkedConversation ? activity.conversation : null;

  if (!posted && keys.length === 0 && !conversation) {
    return [];
  }

  const [users, actor, names, permalink, channelName, audience] = await Promise.all([
    listRegisteredJiraUsers(),
    getSlackUserName(event.user as string),
    mentionNames(event.text),
    conversationPermalink(channel, ts, isReply ? event.thread_ts : undefined),
    activity.conversation?.channelName ?? getSlackChannelName(channel),
    snapshotAudience([...new Set([...(conversation?.ticketKeys ?? []), ...keys])]),
  ]);
  const ctx: SlackNotificationContext = {
    actorAccountIds: matchRegisteredUsers(actor, users),
    actorName: actor?.realName || "Someone",
    channelName,
    permalink,
    snippet: slackTextToPlain(event.text ?? "", names),
  };

  /* Tickets the tracker's audience doesn't cover still reach their Jira owner: keys it left out (a Medium ticket), and
     every CP - the snapshot only knows TS assignees, so for a CP it can return followers at most, while the CP's owners
     are the assignees of its linked TS tickets. That holds for the conversation's own keys too: a reply in a thread
     rooted on "CP-123 is broken" repeats no key. Owners are added to (never replace) the followers. */
  const audienceByKey = new Map(audience);
  const uncovered = keysNeedingOwnerLookup(keys, conversation?.ticketKeys ?? [], audienceByKey);
  if (uncovered.length > 0) {
    try {
      for (const [key, owners] of await cachedTicketOwners(uncovered, new Set(users.map((user) => user.accountId)))) {
        audienceByKey.set(key, [...new Set([...(audienceByKey.get(key) ?? []), ...owners])]);
      }
    } catch (error) {
      /* A Jira hiccup on the mention lookup must not cost the reply notifications. */
      console.warn("Couldn't resolve the owners of tickets mentioned in Slack; keeping the reply notification.", error instanceof Error ? error.message : error);
    }
  }

  return addNotifications(planMessageNotifications({ audienceByKey, conversation, ctx, event, mentionedKeys: keys, posted }));
}

async function notifyFromReaction(event: SlackInboundEvent): Promise<AppNotification[]> {
  const posted = await getPostedSlackMessage(event.item?.channel ?? "", event.item?.ts ?? "");
  if (!posted || !event.user) {
    return [];
  }

  const [users, actor, permalink] = await Promise.all([
    listRegisteredJiraUsers(),
    getSlackUserName(event.user),
    getSlackPermalink(event.item?.channel ?? "", event.item?.ts ?? ""),
  ]);
  const actorAccountIds = matchRegisteredUsers(actor, users);
  const actorName = actor?.realName || "Someone";
  const notification = reactionNotification(event, posted, { actorAccountIds, actorName, permalink: permalink ?? undefined, snippet: "" });

  /* A ✅ on an escalation thread's parent is its acknowledgement (src/lib/escalation/acknowledge.ts). */
  const ack = await acknowledgeFromReaction({
    actorAccountIds,
    actorName,
    channel: event.item?.channel ?? "",
    messageTs: event.item?.ts ?? "",
    posted,
    reaction: event.reaction,
    slackUserId: event.user,
  });

  return addNotifications([notification, ack].filter((item): item is AppNotification => item !== null));
}
