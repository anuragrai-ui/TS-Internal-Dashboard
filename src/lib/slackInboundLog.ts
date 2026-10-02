import { getRedis, isRedisConfigured } from "@/lib/redis";

/**
 * A short, privacy-light log of Slack requests that passed verification, so
 * Settings -> Slack can show that forwarded events (reactions, messages,
 * member joins, and - if Connect ever forwards them - button clicks) really
 * arrive, without anyone reading production logs. Stores ids and event
 * types only, never message text.
 */
const LOG_KEY = "slack:inbound_log";
const MAX_ENTRIES = 25;
const TTL_SECONDS = 7 * 86_400;

export interface InboundSlackEntry {
  at: string;
  channel?: string;
  eventType?: string;
  payloadType: string;
  reaction?: string;
  user?: string;
  via: "slack_signature" | "vercel_connect";
}

export async function recordInboundSlackEvent(entry: InboundSlackEntry): Promise<void> {
  if (!isRedisConfigured()) {
    return;
  }
  try {
    const redis = getRedis();
    await redis.lpush(LOG_KEY, JSON.stringify(entry));
    await redis.ltrim(LOG_KEY, 0, MAX_ENTRIES - 1);
    await redis.expire(LOG_KEY, TTL_SECONDS);
  } catch (error) {
    console.warn("Failed to record an inbound Slack event; continuing.", error);
  }
}

export async function getRecentInboundSlackEvents(): Promise<InboundSlackEntry[]> {
  if (!isRedisConfigured()) {
    return [];
  }
  try {
    const raw = await getRedis().lrange<string | InboundSlackEntry>(LOG_KEY, 0, MAX_ENTRIES - 1);
    return raw
      .map((item) => {
        try {
          return typeof item === "string" ? (JSON.parse(item) as InboundSlackEntry) : item;
        } catch {
          return null;
        }
      })
      .filter((item): item is InboundSlackEntry => item !== null);
  } catch (error) {
    console.warn("Failed to read the inbound Slack event log.", error);
    return [];
  }
}
