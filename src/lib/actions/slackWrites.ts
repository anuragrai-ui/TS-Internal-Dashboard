import { getSlackPermalink, postSlackMessageDetailed, slackRead } from "@/lib/slackApi";
import { getSlackBotToken } from "@/lib/slackConnect";
import { getSlackTestChannel } from "@/lib/slackTestMode";
import { getConversationsForTickets } from "@/lib/tracker/slackIndex";

import type { PostedSlackMessageRef, PostSlackMessageOptions } from "@/lib/slackApi";
import type { SlackConversationRef, TrackerPriority } from "@/lib/tracker/types";
import type { ActionActor, ActionArgs, OnCallShift } from "@/lib/workspace/types";

/**
 * Slack writes from the tracker. Both go out as the dashboard bot,
 * attributed to the person in the text, and both respect Slack test mode
 * (SLACK_TEST_CHANNEL) through postSlackMessageDetailed:
 *
 * - slack_thread_reply: a reply in a conversation the tracker has LINKED to
 *   this ticket or one of its CPs - never an arbitrary channel/thread, even
 *   if an agent asks for one. In test mode the thread doesn't exist in the
 *   test channel, so the reply goes there top-level with a line saying
 *   which thread it was meant for.
 * - firefighter_escalation: a new message in #firefighters with the ticket,
 *   its tracker link and (optionally) whoever is on call tagged.
 *
 * Text a person or an agent wrote is escaped (&, <, >) before posting, so
 * it can't smuggle in <!channel>, <@U...> or a disguised link; the only
 * markup in the message is the markup built here.
 */

const DEFAULT_APP_BASE_URL = "https://ts-internal-dashboard.vercel.app";

/* What the tracker already knows about the ticket - the snapshot row (src/lib/actions/service.ts). */
export interface SlackTicketFacts {
  cpKeys: string[];
  priority: TrackerPriority | null;
  summary: string | null;
}

export interface SlackWriteContext {
  actor: ActionActor;
  ticket: SlackTicketFacts | null;
  ticketKey: string;
}

export type SlackWriteResult =
  | { error: string; redirectedToTestChannel?: boolean; status: "failed" | "uncertain" }
  | { externalId: string; externalUrl?: string; redirectedToTestChannel: boolean; status: "succeeded" };

export interface SlackWriteDeps {
  appBaseUrl: string;
  /* Whether the bot can post in the channel: true / false, or null when Slack won't say (then just try). */
  botInChannel: (channel: string) => Promise<{ inChannel: boolean | null; name?: string }>;
  conversationsFor: (keys: string[]) => Promise<Map<string, SlackConversationRef[]>>;
  firefighterChannel: () => Promise<string>;
  hasToken: () => Promise<boolean>;
  jiraBaseUrl: string;
  onCallShifts: () => Promise<OnCallShift[]>;
  permalink: (channel: string, ts: string) => Promise<string | null>;
  post: (channel: string, text: string, options: PostSlackMessageOptions) => Promise<PostedSlackMessageRef | null>;
  testChannel: () => string | null;
}

/* ------------------------------------------------------------- pure text */

/** Slack's three control characters, so text shows as typed and can't form a mention or a link. Pure. */
export function escapeSlackText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/* A link label can't contain "|" or ">" without ending the link early. */
function linkLabel(text: string): string {
  return escapeSlackText(text).replace(/\|/g, "¦");
}

export function threadReplyText(actorName: string, body: string): string {
  return `*${escapeSlackText(actorName)}* via TS Dashboard:\n${escapeSlackText(body)}`;
}

/** Test mode: the line that says which thread a top-level test post stands in for. */
export function testModeReplyPrefix(conversation: Pick<SlackConversationRef, "channel" | "channelName" | "permalink">): string {
  const name = `#${conversation.channelName ?? conversation.channel}`;
  const where = conversation.permalink?.startsWith("https://") ? `<${conversation.permalink}|${linkLabel(name)}>` : escapeSlackText(name);
  return `[Test mode - would reply in ${where} thread]`;
}

export interface OnCallMentions {
  /* Slack user ids to tag. */
  mentions: string[];
  /* On-call people the Slack directory didn't resolve - named in plain text. */
  unresolved: string[];
}

/** Everyone on call right now, once each: Slack ids where known, names otherwise. Pure. */
export function onCallMentions(shifts: readonly OnCallShift[]): OnCallMentions {
  const mentions: string[] = [];
  const unresolved: string[] = [];
  for (const person of shifts.flatMap((shift) => shift.people)) {
    if (person.slackUserId && /^[UW][A-Z0-9]{2,}$/.test(person.slackUserId)) {
      if (!mentions.includes(person.slackUserId)) {
        mentions.push(person.slackUserId);
      }
    } else if (person.name.trim() && !unresolved.includes(person.name.trim())) {
      unresolved.push(person.name.trim());
    }
  }
  return { mentions, unresolved };
}

export interface FirefighterTextArgs {
  actorName: string;
  appBaseUrl: string;
  body: string;
  jiraBaseUrl: string;
  /* null = don't tag anyone (mentionOnCall off). */
  onCall: OnCallMentions | null;
  ticket: SlackTicketFacts | null;
  ticketKey: string;
}

/** The #firefighters escalation message. Pure. */
export function firefighterText(args: FirefighterTextArgs): string {
  const jiraLink = args.jiraBaseUrl ? `<${args.jiraBaseUrl}/browse/${args.ticketKey}|${args.ticketKey}>` : args.ticketKey;
  const ticketLine = [jiraLink, args.ticket?.priority ?? null, args.ticket?.summary ? escapeSlackText(args.ticket.summary) : null]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
  const trackerUrl = `${args.appBaseUrl.replace(/\/+$/, "")}/tracker?ticket=${encodeURIComponent(args.ticketKey)}`;

  const lines = [
    `:rotating_light: *Escalation: ${args.ticketKey}*`,
    escapeSlackText(args.body),
    "",
    `*Ticket:* ${ticketLine}`,
    `*Tracker:* <${trackerUrl}|Open in the TS Dashboard>`,
  ];

  if (args.onCall) {
    const tagged = args.onCall.mentions.map((id) => `<@${id}>`);
    const named = args.onCall.unresolved.map((name) => `${escapeSlackText(name)} (not found in Slack)`);
    lines.push(
      tagged.length > 0
        ? `*On call:* ${[...tagged, ...named].join(", ")}`
        : `*On call:* couldn't tag anyone - ${named.length > 0 ? `${named.join(", ")} ${named.length === 1 ? "is" : "are"} on call but not matched to a Slack user` : "nobody on the on-call calendar resolves to a Slack user right now"}.`,
    );
  }

  lines.push(`Raised by *${escapeSlackText(args.actorName)}* via TS Dashboard`);
  return lines.join("\n");
}

/* ----------------------------------------------------------------- linkage */

/** The linked conversation `channel`/`threadTs` names, if the tracker has linked it to the ticket or one of its CPs. Never throws. */
export async function findLinkedConversation(
  ticketKey: string,
  cpKeys: readonly string[],
  channel: string,
  threadTs: string,
  conversationsFor: SlackWriteDeps["conversationsFor"],
): Promise<SlackConversationRef | null> {
  try {
    const byKey = await conversationsFor([ticketKey, ...cpKeys]);
    for (const conversations of byKey.values()) {
      const match = conversations.find((conversation) => conversation.channel === channel && conversation.rootTs === threadTs);
      if (match) {
        return match;
      }
    }
    return null;
  } catch (error) {
    console.warn(`Actions: couldn't read the Slack index for ${ticketKey}.`, error instanceof Error ? error.message : String(error));
    return null;
  }
}

export function notLinkedMessage(ticketKey: string): string {
  return `That Slack thread isn't linked to ${ticketKey} or its CPs - link it first (Properties -> Link a Slack thread).`;
}

/* ----------------------------------------------------------------- posting */

const UNCONFIRMED =
  "Slack didn't confirm the message - it may not have been posted, or it may have gone through. Check the channel before retrying.";

async function postAndLink(
  deps: SlackWriteDeps,
  channel: string,
  text: string,
  options: PostSlackMessageOptions,
  redirectedHint: boolean,
): Promise<SlackWriteResult> {
  if (!(await deps.hasToken())) {
    return { error: "Slack isn't connected (no bot token) - nothing was posted.", status: "failed" };
  }

  /* postSlackMessageDetailed reports every failure as null, so the commonest definite one - the bot isn't in the
     channel - is checked first, where the message actually lands (the test channel while test mode is on). */
  const destination = deps.testChannel() ?? channel;
  const membership = await deps.botInChannel(destination);
  if (membership.inChannel === false) {
    return {
      error: `The dashboard bot isn't in ${membership.name ? `#${membership.name}` : "that channel"} - invite it (/invite) and try again. Nothing was posted.`,
      status: "failed",
    };
  }

  const posted = await deps.post(channel, text, options);
  if (!posted) {
    return { error: UNCONFIRMED, redirectedToTestChannel: redirectedHint, status: "uncertain" };
  }
  const permalink = await deps.permalink(posted.channel, posted.ts);
  return {
    externalId: `${posted.channel}:${posted.ts}`,
    ...(permalink ? { externalUrl: permalink } : {}),
    redirectedToTestChannel: posted.redirected || redirectedHint,
    status: "succeeded",
  };
}

/** Posts one Slack action for a ticket. Never throws. */
export async function executeSlackWrite(args: ActionArgs, context: SlackWriteContext, deps: SlackWriteDeps): Promise<SlackWriteResult> {
  try {
    if (args.operation === "slack_thread_reply") {
      const conversation = await findLinkedConversation(context.ticketKey, context.ticket?.cpKeys ?? [], args.channel, args.threadTs, deps.conversationsFor);
      if (!conversation) {
        return { error: notLinkedMessage(context.ticketKey), status: "failed" };
      }
      const text = threadReplyText(context.actor.displayName, args.body);
      const testChannel = deps.testChannel();
      if (testChannel && testChannel !== args.channel) {
        /* The real thread doesn't exist in the test channel: post top-level there, saying where it would have gone. */
        return await postAndLink(deps, args.channel, `${testModeReplyPrefix(conversation)}\n${text}`, {}, true);
      }
      return await postAndLink(deps, args.channel, text, { threadTs: args.threadTs }, false);
    }

    if (args.operation === "firefighter_escalation") {
      const onCall = args.mentionOnCall ? onCallMentions(await deps.onCallShifts()) : null;
      const text = firefighterText({
        actorName: context.actor.displayName,
        appBaseUrl: deps.appBaseUrl,
        body: args.body,
        jiraBaseUrl: deps.jiraBaseUrl,
        onCall,
        ticket: context.ticket,
        ticketKey: context.ticketKey,
      });
      return await postAndLink(deps, await deps.firefighterChannel(), text, {}, false);
    }

    return { error: `${args.operation} is a Jira action, not a Slack one.`, status: "failed" };
  } catch (error) {
    console.warn(`Actions: Slack ${args.operation} for ${context.ticketKey} threw.`, error instanceof Error ? error.message : String(error));
    return { error: UNCONFIRMED, status: "uncertain" };
  }
}

/* ------------------------------------------------------------------ wiring */

async function botInChannel(channel: string): Promise<{ inChannel: boolean | null; name?: string }> {
  const result = await slackRead<{ channel?: { is_member?: boolean; name?: string }; error?: string; ok: boolean }>("conversations.info", { channel });
  if (result.ok) {
    const info = result.data?.channel;
    return { inChannel: typeof info?.is_member === "boolean" ? info.is_member : null, ...(info?.name ? { name: info.name } : {}) };
  }
  /* A private channel the bot was never added to reads as channel_not_found. Rate limits and missing scopes say nothing. */
  return { inChannel: result.error === "channel_not_found" || result.error === "not_in_channel" ? false : null };
}

/** The real Slack, Slack index, on-call calendar and #firefighters channel. */
export function defaultSlackWriteDeps(jiraBaseUrl: string): SlackWriteDeps {
  return {
    appBaseUrl: process.env.APP_BASE_URL?.trim() || DEFAULT_APP_BASE_URL,
    botInChannel,
    conversationsFor: getConversationsForTickets,
    /* Loaded on first use: only a firefighter escalation needs the on-call calendar and the feed module. */
    firefighterChannel: async () => (await import("@/lib/firefighters/feed")).firefighterChannelId(),
    hasToken: async () => (await getSlackBotToken()) !== null,
    jiraBaseUrl,
    onCallShifts: async () => (await import("@/lib/oncall/schedule")).getCurrentOnCallShifts(),
    permalink: getSlackPermalink,
    post: postSlackMessageDetailed,
    testChannel: getSlackTestChannel,
  };
}
