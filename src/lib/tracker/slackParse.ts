import type { SlackInboundEvent } from "@/lib/notifications/slack";
import type { SlackThreadMessage } from "@/lib/tracker/types";

/**
 * Pure parsing of Slack messages for the escalation tracker's Slack index
 * (src/lib/tracker/slackIndex.ts): which TS/CP tickets a message is about,
 * which Slack permalinks a piece of text holds, and whether the message
 * reads like someone escalating. No I/O here, so every rule is tested with
 * fixtures (scripts/test-tracker-slack.ts).
 *
 * Where ticket keys hide in a Slack message: ~90% of references are mrkdwn
 * Jira links whose label is the ticket summary, so the key is only in the
 * URL; Jira unfurls put it in attachments; rich_text blocks carry the link
 * URL separately from its label; and people glue keys to words
 * ("TS-116432Jira"). So keys are scanned in every text-bearing field, with a
 * leading guard but no trailing word boundary.
 */

/* No trailing \b on purpose: "TS-116432Jira" and "/browse/TS-123|label" must both match. */
const TICKET_KEY_PATTERN = /(?<![A-Z0-9])(?:TS|CP)-\d{2,7}/g;
export const MAX_INDEXED_KEYS = 20;

/* Slack message permalinks: https://<ws>.slack.com/archives/<C|G|D id>/p<10 digits><micro digits>[?thread_ts=...&cid=...]. */
const SLACK_PERMALINK_PATTERN = /https:\/\/([a-z0-9-]+(?:\.enterprise)?)\.slack\.com\/archives\/([CGD][A-Z0-9]{6,})\/p(\d{10})(\d{1,7})(\?[^\s|>"'<)\]]*)?/g;

const SLACK_CHANNEL_ID = /^[CGD][A-Z0-9]{6,}$/;
const SLACK_TS = /^\d{9,11}\.\d{1,6}$/;

/* The bot's own 2-day digest channel: every ticket is in it, and none of it is a conversation. */
const ALWAYS_EXCLUDED_CHANNELS = ["C091ENAGV1S"];

/* A person saying something: plain messages, thread broadcasts, file shares, /me. Joins, deletes and bot posts aren't. */
const INDEXED_SUBTYPES = new Set<string | undefined>([undefined, "file_share", "me_message", "thread_broadcast"]);

/* Words people use when they push a ticket up the queue. "escalat" covers escalate/escalated/escalation. */
const PRIORITY_WORDS = /\b(?:asap|urgent\w*|high[\s-]+priority|critical|blockers?|escalat\w*|prioriti[sz]\w*|by\s+eod)\b/i;
/* Any user-group mention (<!subteam^S08V9D2KXPU> is the TS group) is someone calling in a team. */
const GROUP_MENTION = /<!subteam\^[A-Z0-9]+/;
const USER_MENTION = /<@[UW][A-Z0-9]+/;

const SNIPPET_MAX_CHARS = 160;
export const CONVERSATION_SNIPPET_MAX_CHARS = 140;
const THREAD_MESSAGE_MAX_CHARS = 1000;

/* ---------------------------------------------------------------- basics */

export function isSlackChannelId(value: string): boolean {
  return SLACK_CHANNEL_ID.test(value);
}

export function isSlackTs(value: string): boolean {
  return SLACK_TS.test(value);
}

/** A Slack ts ("1727881200.000100") as epoch ms; null when it isn't one. */
export function slackTsToMs(ts: string | undefined): number | null {
  const seconds = Number(ts);
  return ts && Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null;
}

export function slackTsToIso(ts: string | undefined): string | null {
  const ms = slackTsToMs(ts);
  return ms === null ? null : new Date(ms).toISOString();
}

/** Channels never indexed: the bot digest channel plus SLACK_INDEX_EXCLUDE_CHANNELS (comma list). */
export function excludedChannels(envValue: string | undefined = process.env.SLACK_INDEX_EXCLUDE_CHANNELS): Set<string> {
  const extra = (envValue ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return new Set([...ALWAYS_EXCLUDED_CHANNELS, ...extra]);
}

/**
 * Whether a channel may be indexed and read back through the tracker: a real channel id, not a direct
 * message (the tracker is visible to every dashboard user) and not an excluded channel (the bot digest, env list).
 */
export function isTrackableChannel(channel: string, excluded: ReadonlySet<string> = excludedChannels()): boolean {
  return isSlackChannelId(channel) && !channel.startsWith("D") && !excluded.has(channel);
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

/* --------------------------------------------------------- the message */

export interface EffectiveMessage {
  channel: string;
  /* An edit (message_changed): indexed for new keys, but never counted as a reply. */
  isEdit: boolean;
  message: SlackInboundEvent;
}

/** The message an event is about: the event itself, or for an edit the edited message inside it. Null for anything else. */
export function effectiveMessage(event: SlackInboundEvent): EffectiveMessage | null {
  if (event.type !== "message" || !event.channel) {
    return null;
  }
  if (event.subtype === "message_changed") {
    return event.message ? { channel: event.channel, isEdit: true, message: event.message } : null;
  }
  return { channel: event.channel, isEdit: false, message: event };
}

/** A person's message worth indexing: no bot post (bot_id or bot_message), no join/delete/system subtype. */
export function isIndexableMessage(message: SlackInboundEvent): boolean {
  return !message.bot_id && message.subtype !== "bot_message" && INDEXED_SUBTYPES.has(message.subtype) && Boolean(message.user && message.ts);
}

/* Every string under rich_text blocks (text and link elements, including the link URL), section text and fields. */
function blockStrings(value: unknown, out: string[], depth = 0): void {
  if (depth > 8 || value === null || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => blockStrings(item, out, depth + 1));
    return;
  }
  for (const [field, inner] of Object.entries(value as Record<string, unknown>)) {
    if ((field === "text" || field === "url") && typeof inner === "string") {
      out.push(inner);
    } else if (typeof inner === "object") {
      blockStrings(inner, out, depth + 1);
    }
  }
}

export interface MessageTexts {
  /* What the person typed: the text and its rich_text blocks. */
  authored: string[];
  /* Unfurls and app attachments: titles, links and bodies. Never treated as the person's own words. */
  attached: string[];
}

export function messageTexts(message: SlackInboundEvent): MessageTexts {
  const authored = [message.text ?? ""];
  blockStrings(message.blocks ?? [], authored);

  const attached: string[] = [];
  for (const attachment of message.attachments ?? []) {
    for (const value of [
      attachment.title,
      attachment.title_link,
      attachment.text,
      attachment.fallback,
      attachment.pretext,
      attachment.from_url,
      attachment.original_url,
    ]) {
      if (typeof value === "string" && value) {
        attached.push(value);
      }
    }
  }

  return { authored: authored.filter(Boolean), attached };
}

/** Distinct TS/CP keys in some text, in order of first appearance. */
export function extractTicketKeysFromText(text: string | undefined, max = MAX_INDEXED_KEYS): string[] {
  return [...new Set(text?.match(TICKET_KEY_PATTERN) ?? [])].slice(0, max);
}

/** Distinct TS/CP keys anywhere in a message (text, rich_text blocks, attachments), capped. */
export function extractMessageTicketKeys(message: SlackInboundEvent, max = MAX_INDEXED_KEYS): string[] {
  const { attached, authored } = messageTexts(message);
  return extractTicketKeysFromText([...authored, ...attached].join("\n"), max);
}

/**
 * Whether a message reads like someone escalating: a user-group mention
 * (the TS group <!subteam^S08V9D2KXPU>), priority words, or a person tagged
 * together with a CP key. Only the person's own words count - a Jira unfurl
 * saying "Priority: Critical" is not an escalation.
 */
export function detectEscalationHint(message: SlackInboundEvent, keys: readonly string[]): boolean {
  const text = messageTexts(message).authored.join("\n");
  if (GROUP_MENTION.test(text) || PRIORITY_WORDS.test(text)) {
    return true;
  }
  return USER_MENTION.test(text) && keys.some((key) => key.startsWith("CP-"));
}

/* ------------------------------------------------------------ permalinks */

export interface ParsedSlackPermalink {
  channel: string;
  threadTs?: string;
  ts: string;
  url: string;
}

/** Every Slack message permalink in a piece of text, including inside <url|label> mrkdwn and &amp;-escaped queries. Deduped. */
export function extractSlackPermalinks(text: string): ParsedSlackPermalink[] {
  const out: ParsedSlackPermalink[] = [];
  const seen = new Set<string>();

  for (const match of text.matchAll(SLACK_PERMALINK_PATTERN)) {
    const [, workspace, channel, seconds, micros, rawQuery] = match;
    if (!workspace || !channel || !seconds || !micros) {
      continue;
    }
    const query = new URLSearchParams((rawQuery ?? "").replace(/&amp;/g, "&").replace(/^\?/, ""));
    const threadTs = query.get("thread_ts") ?? undefined;
    const ts = `${seconds}.${micros}`;
    const id = `${channel}:${ts}:${threadTs ?? ""}`;
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    out.push({
      channel,
      threadTs: threadTs && isSlackTs(threadTs) && threadTs !== ts ? threadTs : undefined,
      ts,
      url: buildSlackPermalink(`https://${workspace}.slack.com`, channel, ts, threadTs && isSlackTs(threadTs) ? threadTs : undefined),
    });
  }

  return out;
}

/** Slack's own permalink format, built locally once the workspace origin is known (saves a chat.getPermalink call). */
export function buildSlackPermalink(origin: string, channel: string, ts: string, threadTs?: string): string {
  const base = `${origin}/archives/${channel}/p${ts.replace(".", "")}`;
  return threadTs && threadTs !== ts ? `${base}?thread_ts=${threadTs}&cid=${channel}` : base;
}

/** "https://certifyos.slack.com" from any Slack permalink, or null. */
export function slackOriginFromPermalink(permalink: string): string | null {
  return /^https:\/\/[a-z0-9-]+(?:\.enterprise)?\.slack\.com(?=\/)/.exec(permalink)?.[0] ?? null;
}

/* ---------------------------------------------------------- thread reads */

export interface SlackHistoryMessage extends SlackInboundEvent {
  bot_profile?: { name?: string };
  username?: string;
}

/** User ids worth resolving for a thread read: authors plus people @-mentioned, capped. */
export function threadUserIds(messages: readonly SlackHistoryMessage[], max = 20): string[] {
  const ids = new Set<string>();
  for (const message of messages) {
    if (message.user) {
      ids.add(message.user);
    }
    for (const match of (message.text ?? "").matchAll(/<@([UW][A-Z0-9]+)/g)) {
      if (match[1]) {
        ids.add(match[1]);
      }
    }
  }
  return [...ids].slice(0, max);
}

/** conversations.replies messages as the detail panel shows them: plain text (clipped), names, a bot flag. */
export function toThreadMessages(messages: readonly SlackHistoryMessage[], names: ReadonlyMap<string, string>): SlackThreadMessage[] {
  return messages
    .filter((message) => message.ts && (INDEXED_SUBTYPES.has(message.subtype) || message.subtype === "bot_message"))
    .map((message) => {
      const isBot = Boolean(message.bot_id) || message.subtype === "bot_message";
      const userName =
        (message.user ? names.get(message.user) : undefined) ?? (isBot ? (message.bot_profile?.name ?? message.username ?? "Bot") : "Someone");
      return {
        at: slackTsToIso(message.ts) ?? new Date(0).toISOString(),
        isBot,
        text: slackTextToPlain(message.text ?? "", names, THREAD_MESSAGE_MAX_CHARS),
        ts: message.ts as string,
        userName,
      };
    });
}
