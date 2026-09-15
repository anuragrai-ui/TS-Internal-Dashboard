import { NextResponse } from "next/server";

import { truncateText } from "@/lib/jiraClient";
import { getRedis, isRedisConfigured } from "@/lib/redis";
import { verifySlackSignature } from "@/lib/slackSignature";

const TICKET_KEY_PATTERN = /\b(?:TS|CP)-\d+\b/g;
const MENTION_TTL_SECONDS = 30 * 24 * 60 * 60;
const MAX_MENTIONS_PER_TICKET = 10;

interface SlackEvent {
  bot_id?: string;
  channel?: string;
  subtype?: string;
  text?: string;
  ts?: string;
  type?: string;
}

interface SlackEventPayload {
  challenge?: string;
  event?: SlackEvent;
  type?: string;
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

export async function POST(request: Request): Promise<NextResponse> {
  const rawBody = await request.text();
  const signature = request.headers.get("x-slack-signature") ?? "";
  const timestamp = request.headers.get("x-slack-request-timestamp") ?? "";

  const verified = verifySlackSignature({
    rawBody,
    signature,
    signingSecret: process.env.SLACK_SIGNING_SECRET ?? "",
    timestamp,
  });

  if (!verified) {
    return NextResponse.json({ error: "Invalid Slack signature." }, { status: 401 });
  }

  const payload = JSON.parse(rawBody) as SlackEventPayload;

  if (payload.type === "url_verification") {
    return new NextResponse(payload.challenge ?? "", { status: 200 });
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
