import { getCache, setCache } from "@/lib/cache";
import { getSlackChannelName, getSlackPermalink, getSlackUserName } from "@/lib/slackApi";
import { buildSlackPermalink, slackOriginFromPermalink } from "@/lib/tracker/slackParse";

import type { StoredConversation } from "@/lib/tracker/slackStore";

/**
 * Best-effort names and links for indexed conversations: the channel's name
 * (conversations.info, cached a day), the thread's permalink and who
 * started it (users.info, cached a week). Every lookup degrades to
 * "unknown" - a private channel without groups:read just shows its id.
 *
 * Permalinks are built locally once the workspace origin is known: Slack's
 * format is stable (/archives/<channel>/p<ts without the dot>), and the
 * history drip would otherwise spend a chat.getPermalink call per thread.
 */

const ORIGIN_CACHE_KEY = "slack_workspace_origin";
const ORIGIN_TTL_SECONDS = 30 * 86_400;

/** A link to a message (or a reply in a thread). Never throws; undefined when Slack won't say. */
export async function conversationPermalink(channel: string, ts: string, threadTs?: string): Promise<string | undefined> {
  const origin = (await getCache<string>(ORIGIN_CACHE_KEY))?.value;
  if (origin) {
    return buildSlackPermalink(origin, channel, ts, threadTs);
  }

  const permalink = await getSlackPermalink(channel, ts);
  const learned = permalink ? slackOriginFromPermalink(permalink) : null;
  if (learned) {
    await setCache(ORIGIN_CACHE_KEY, learned, ORIGIN_TTL_SECONDS);
  }
  return permalink ?? undefined;
}

/** Fills whatever is missing of channel name, permalink and author name. Never throws. */
export async function enrichConversation(record: StoredConversation): Promise<StoredConversation> {
  try {
    const [channelName, permalink, startedByName] = await Promise.all([
      record.channelName ?? getSlackChannelName(record.channel),
      record.permalink ?? conversationPermalink(record.channel, record.rootTs),
      record.startedByName ?? (record.startedBy ? getSlackUserName(record.startedBy).then((name) => name?.realName || undefined) : undefined),
    ]);
    return { ...record, channelName, permalink, startedByName };
  } catch {
    return record;
  }
}
