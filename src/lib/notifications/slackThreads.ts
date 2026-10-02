import { getRedis, isRedisConfigured } from "@/lib/redis";

/**
 * Memory of every Slack message the dashboard posted: (channel, ts) -> the
 * tickets it is about and who should hear back. Replies and reactions that
 * Vercel Connect forwards later are matched against it
 * (src/lib/notifications/slack.ts), which is how a reply in a Slack thread
 * finds its way to the right person's notification bell.
 */

export type PostedSlackMessageKind = "escalation" | "sla_alert" | "test";

export interface PostedSlackMessage {
  /* Registered dashboard users (Jira accountIds) to tell about replies and reactions. */
  audience: string[];
  cpKey?: string;
  kind: PostedSlackMessageKind;
  /* How a notification names the thread: "the SLA-breach alert for TS-123". */
  label: string;
  postedAt: string;
  ticketKeys: string[];
  /* The thread this message belongs to: its own ts for a parent, the parent's ts for a reply. */
  threadTs: string;
}

const POSTED_TTL_SECONDS = 60 * 86_400;

function postedKey(channel: string, ts: string): string {
  return `slack:posted:${channel}:${ts}`;
}

export async function rememberPostedSlackMessage(channel: string, ts: string, info: Omit<PostedSlackMessage, "postedAt">): Promise<void> {
  if (!isRedisConfigured()) {
    return;
  }
  try {
    const record: PostedSlackMessage = { ...info, postedAt: new Date().toISOString() };
    await getRedis().set(postedKey(channel, ts), record, { ex: POSTED_TTL_SECONDS });
  } catch (error) {
    /* The post itself already succeeded; losing this only means its replies won't notify anyone. */
    console.warn(`Failed to remember Slack message ${channel}/${ts}; replies to it won't notify.`, error);
  }
}

export async function getPostedSlackMessage(channel: string, ts: string): Promise<PostedSlackMessage | null> {
  if (!isRedisConfigured()) {
    return null;
  }
  try {
    return await getRedis().get<PostedSlackMessage>(postedKey(channel, ts));
  } catch {
    return null;
  }
}
