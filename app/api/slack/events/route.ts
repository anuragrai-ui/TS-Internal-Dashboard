import { after, NextResponse } from "next/server";

import { truncateText } from "@/lib/jiraClient";
import { notifyFromSlackEvent } from "@/lib/notifications/slack";
import { getRedis, isRedisConfigured } from "@/lib/redis";
import { recordInboundSlackEvent } from "@/lib/slackInboundLog";
import { authenticateSlackRequest } from "@/lib/slackRequestAuth";

const TICKET_KEY_PATTERN = /\b(?:TS|CP)-\d+\b/g;
const MENTION_TTL_SECONDS = 30 * 24 * 60 * 60;
const MAX_MENTIONS_PER_TICKET = 10;

interface SlackEvent {
  bot_id?: string;
  channel?: string;
  item?: { channel?: string; ts?: string; type?: string };
  reaction?: string;
  user?: string;
  subtype?: string;
  text?: string;
  thread_ts?: string;
  ts?: string;
  type?: string;
}

interface SlackEventPayload {
  /* Interactivity payloads (block_actions etc.) carry these instead of `event`. */
  channel?: { id?: string };
  challenge?: string;
  event?: SlackEvent;
  type?: string;
  user?: { id?: string };
}

interface StoredSlackMention {
  channel_id: string;
  mentioned_at: string;
  message_ts: string;
  text_snippet?: string;
}

function mentionsKey(ticketKey: string): string {
  return `slack:mentions:${ticketKey}`;
}

function extractTicketKeys(text: string): string[] {
  const matches = text.match(TICKET_KEY_PATTERN) ?? [];
  return [...new Set(matches)];
}

async function recordMentions(event: SlackEvent): Promise<void> {
  if (!isRedisConfigured()) {
    return;
  }

  const ticketKeys = extractTicketKeys(event.text ?? "");

  if (ticketKeys.length === 0) {
    return;
  }

  const redis = getRedis();
  const score = Number(event.ts) || Date.now();
  const mention: StoredSlackMention = {
    channel_id: event.channel ?? "",
    mentioned_at: new Date().toISOString(),
    message_ts: event.ts ?? "",
    text_snippet: truncateText(event.text, 200),
  };

  await Promise.all(
    ticketKeys.map(async (ticketKey) => {
      const key = mentionsKey(ticketKey);

      await redis.zadd(key, { member: JSON.stringify(mention), score });
      await redis.zremrangebyrank(key, 0, -(MAX_MENTIONS_PER_TICKET + 1));
      await redis.expire(key, MENTION_TTL_SECONDS);
    }),
  );
}

/* Interactivity (button clicks, shortcuts) arrives form-encoded as payload=<json>,
   Events API as plain JSON. Unparseable bodies are acknowledged and ignored
   rather than 500ing, which would make Connect retry the delivery 3 times. */
function parsePayload(rawBody: string, contentType: string): SlackEventPayload | null {
  try {
    if (contentType.includes("application/x-www-form-urlencoded")) {
      const payload = new URLSearchParams(rawBody).get("payload");
      return payload ? (JSON.parse(payload) as SlackEventPayload) : null;
    }
    return JSON.parse(rawBody) as SlackEventPayload;
  } catch {
    return null;
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const rawBody = await request.text();
  const auth = await authenticateSlackRequest({
    authorization: request.headers.get("authorization"),
    rawBody,
    signature: request.headers.get("x-slack-signature"),
    timestamp: request.headers.get("x-slack-request-timestamp"),
  });

  if (!auth.ok) {
    return NextResponse.json({ error: auth.reason }, { status: auth.status });
  }

  const payload = parsePayload(rawBody, request.headers.get("content-type") ?? "");

  if (!payload) {
    console.warn(`Ignoring an unparseable Slack payload (via ${auth.via}).`);
    return NextResponse.json({ ok: true }, { status: 200 });
  }

  /* Diagnostic for the escalation pilot: tells us whether Connect forwards
     interactivity (an Acknowledge button) or only Events API events. */
  if (payload.type && payload.type !== "event_callback" && payload.type !== "url_verification") {
    console.info(`Slack ${payload.type} payload received via ${auth.via}.`);
  }

  if (payload.type === "url_verification") {
    return new NextResponse(payload.challenge ?? "", { status: 200 });
  }

  await recordInboundSlackEvent({
    at: new Date().toISOString(),
    channel: payload.event?.channel ?? payload.event?.item?.channel ?? payload.channel?.id,
    eventType: payload.event?.type,
    payloadType: payload.type ?? "unknown",
    reaction: payload.event?.reaction,
    user: payload.event?.user ?? payload.user?.id,
    via: auth.via,
  });

  /* Thread replies, reactions and ticket mentions -> the notification center (src/lib/notifications/slack.ts).
     Runs after the response so Slack/Connect get their 200 at once and never retry for a slow Jira lookup. */
  if (payload.type === "event_callback" && payload.event) {
    const event = payload.event;
    after(() => notifyFromSlackEvent(event));
  }

  if (payload.type === "event_callback" && payload.event?.type === "message") {
    const event = payload.event;

    if (!event.subtype && !event.bot_id) {
      try {
        await recordMentions(event);
      } catch (error) {
        console.warn("Failed to record Slack mention; continuing.", error);
      }
    }
  }

  return NextResponse.json({ ok: true }, { status: 200 });
}
