import { acknowledgeFromReaction } from "@/lib/escalation/acknowledge";
import { createReadOnlyJiraClient, readOnlyJiraConfigFromEnv } from "@/lib/escalation/readOnlyJira";
import { getPostedSlackMessage } from "@/lib/notifications/slackThreads";
import { addNotifications } from "@/lib/notifications/store";
import { isRedisConfigured } from "@/lib/redis";
import { getSlackPermalink, getSlackUserName } from "@/lib/slackApi";
import { listRegisteredJiraUsers } from "@/lib/userJiraTokens";

import type { PostedSlackMessage } from "@/lib/notifications/slackThreads";
import type { AppNotification } from "@/lib/notifications/types";
import type { SlackUserName } from "@/lib/slackApi";
import type { RegisteredJiraUser } from "@/lib/userJiraTokens";

/**
 * Slack's side of the notification center. Every message the dashboard
 * posts is remembered (src/lib/notifications/slackThreads.ts), and Slack
 * events forwarded by Vercel Connect are matched against that memory:
 * - a reply in one of those threads notifies the thread's audience
 * - a reaction on one of those messages notifies it too (and a ✅ on an
 *   escalation parent is the acknowledgement)
 * - a message anywhere the bot can read that mentions a TS/CP key notifies
 *   whoever owns that ticket
 */

/* Slack's own fields we read; everything else in the event is ignored. */
export interface SlackInboundEvent {
  bot_id?: string;
  channel?: string;
  item?: { channel?: string; ts?: string; type?: string };
  reaction?: string;
  subtype?: string;
  text?: string;
  thread_ts?: string;
  ts?: string;
  type?: string;
  user?: string;
}

const SNIPPET_MAX_CHARS = 160;
const MAX_MENTIONED_KEYS = 10;
const MAX_NAME_LOOKUPS = 5;
const TICKET_KEY_PATTERN = /\b(?:TS|CP)-\d+\b/g;
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
  return [...new Set(text?.match(TICKET_KEY_PATTERN) ?? [])].slice(0, MAX_MENTIONED_KEYS);
}

export function reactionGlyph(reaction: string | undefined): string {
  /* "+1::skin-tone-3" -> "+1" */
  const base = (reaction ?? "").split("::")[0] ?? "";
  return REACTION_GLYPHS[base] ?? `:${base}:`;
}

/** Slack mrkdwn to one readable line: mentions, channels, links and entities resolved, whitespace collapsed, clipped. */
export function slackTextToPlain(text: string, names: ReadonlyMap<string, string>, maxChars = SNIPPET_MAX_CHARS): string {
  const plain = text
    .replace(/<@([UW][A-Z0-9]+)(?:\|([^>]*))?>/g, (_match, id: string, label?: string) => `@${names.get(id) ?? label ?? "someone"}`)
    .replace(/<#[A-Z0-9]+\|([^>]*)>/g, (_match, name: string) => `#${name}`)
    .replace(/<#[A-Z0-9]+>/g, "#channel")
    .replace(/<!subteam\^[A-Z0-9]+(?:\|([^>]*))?>/g, (_match, label?: string) => label ?? "@group")
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, "@$1")
    .replace(/<((?:https?|mailto):[^|>]+)\|([^>]+)>/g, "$2")
    .replace(/<((?:https?|mailto):[^>]+)>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

  return plain.length > maxChars ? `${plain.slice(0, maxChars - 1).trimEnd()}…` : plain;
}

export interface SlackNotificationContext {
  actorName: string;
  /* Registered users the Slack actor appears to be - never notified about their own message. */
  actorAccountIds: ReadonlySet<string>;
  permalink?: string;
  snippet: string;
}

function slackInstant(ts: string | undefined): string {
  const seconds = Number(ts);
  return new Date(Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : Date.now()).toISOString();
}

export function replyNotification(
  event: SlackInboundEvent,
  posted: PostedSlackMessage,
  ctx: SlackNotificationContext,
): AppNotification | null {
  if (!event.channel || !event.ts) {
    return null;
  }
  const audience = posted.audience.filter((id) => !ctx.actorAccountIds.has(id));
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
  const audience = posted.audience.filter((id) => !ctx.actorAccountIds.has(id));
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
      title: `${ctx.actorName} mentioned ${key} in Slack`,
      url: ctx.permalink,
    });
  }
  return out;
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
  type Issue = { fields: { assignee?: { accountId?: string } | null; issuelinks?: Array<{ inwardIssue?: { key?: string }; outwardIssue?: { key?: string } }> }; key: string };

  const issues = await client.searchJql<Issue>(`key in (${keys.join(",")})`, ["assignee", "issuelinks"], { maxTotal: MAX_MENTIONED_KEYS });
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
    const tsIssues = await client.searchJql<Issue>(`key in (${linkedTs.join(",")}) AND statusCategory != Done`, ["assignee"], { maxTotal: 100 });
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

async function mentionNames(text: string | undefined): Promise<Map<string, string>> {
  const ids = [...new Set([...(text ?? "").matchAll(/<@([UW][A-Z0-9]+)/g)].map((match) => match[1] as string))].slice(0, MAX_NAME_LOOKUPS);
  const names = await Promise.all(ids.map(async (id) => [id, (await getSlackUserName(id))?.realName] as const));
  return new Map(names.filter((entry): entry is readonly [string, string] => Boolean(entry[1])));
}

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
    if (isHumanMessage(event)) {
      return await notifyFromMessage(event);
    }
    if (event.type === "reaction_added" && event.item?.type === "message") {
      return await notifyFromReaction(event);
    }
  } catch (error) {
    console.warn(`Could not turn a Slack ${event.type ?? "unknown"} event into notifications.`, error instanceof Error ? error.message : error);
  }
  return [];
}

async function notifyFromMessage(event: SlackInboundEvent): Promise<AppNotification[]> {
  const channel = event.channel as string;
  const ts = event.ts as string;
  const isReply = Boolean(event.thread_ts && event.thread_ts !== ts);
  const posted = isReply ? await getPostedSlackMessage(channel, event.thread_ts as string) : null;
  const keys = extractTicketKeys(event.text);

  if (!posted && keys.length === 0) {
    return [];
  }

  const [users, actor, names, permalink] = await Promise.all([
    listRegisteredJiraUsers(),
    getSlackUserName(event.user as string),
    mentionNames(event.text),
    getSlackPermalink(channel, ts),
  ]);
  const ctx: SlackNotificationContext = {
    actorAccountIds: matchRegisteredUsers(actor, users),
    actorName: actor?.realName || "Someone",
    permalink: permalink ?? undefined,
    snippet: slackTextToPlain(event.text ?? "", names),
  };

  const out: AppNotification[] = [];
  const reply = posted ? replyNotification(event, posted, ctx) : null;
  if (reply) {
    out.push(reply);
  }

  if (keys.length > 0) {
    /* Whoever already hears about this message as a thread reply isn't told twice. */
    const toldAlready = new Set(reply?.audience ?? []);
    const owners = await ticketOwners(keys, new Set(users.map((user) => user.accountId)));
    const fresh = new Map([...owners].map(([key, ids]) => [key, ids.filter((id) => !toldAlready.has(id))] as const));
    out.push(...mentionNotifications(event, fresh, ctx));
  }

  return addNotifications(out);
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
