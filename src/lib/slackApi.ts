import { getCache, setCache } from "@/lib/cache";
import { getSlackBotToken } from "@/lib/slackConnect";
import { applySlackTestMode } from "@/lib/slackTestMode";

const SLACK_POST_MESSAGE_URL = "https://slack.com/api/chat.postMessage";
const SLACK_LOOKUP_BY_EMAIL_URL = "https://slack.com/api/users.lookupByEmail";
const SLACK_PERMALINK_URL = "https://slack.com/api/chat.getPermalink";
const SLACK_USER_INFO_URL = "https://slack.com/api/users.info";

interface SlackPostMessageResponse {
  channel?: string;
  error?: string;
  ok: boolean;
  ts?: string;
}

export interface PostedSlackMessageRef {
  /* Where it actually landed - the test channel while test mode is on. */
  channel: string;
  redirected: boolean;
  ts: string;
}

export interface PostSlackMessageOptions {
  /* Also show a thread reply in the channel (Slack's reply_broadcast). */
  broadcast?: boolean;
  /* Post as a reply in this thread (the parent message's ts, in the channel it actually landed in). */
  threadTs?: string;
}

/**
 * Outbound Slack posting. The token comes from the Vercel Connect Slack
 * connector at call time (src/lib/slackConnect.ts), or SLACK_BOT_TOKEN as a
 * local override. Gracefully no-ops with a warning if unconfigured, matching every
 * other optional-integration pattern in this codebase (Redis, OCR,
 * escalation AI) - the cron route still runs and prepares drafts even
 * without Slack set up, it just skips the notification.
 *
 * Returns where the message landed and its ts, so callers can remember the
 * thread (src/lib/notifications/slack.ts) and route its replies back to the
 * ticket - or null if nothing was posted.
 */
export async function postSlackMessageDetailed(
  requestedChannel: string,
  requestedText: string,
  options: PostSlackMessageOptions = {},
): Promise<PostedSlackMessageRef | null> {
  /* Test mode (SLACK_TEST_CHANNEL) redirects every post - see src/lib/slackTestMode.ts. A thread
     reply follows its parent there too: the parent was redirected the same way. */
  const { channel, redirected, text } = applySlackTestMode(requestedChannel, requestedText);
  const token = await getSlackBotToken();

  if (!token) {
    console.warn("No Slack token available (Vercel Connect / SLACK_BOT_TOKEN); skipping Slack notification.");
    return null;
  }

  try {
    const response = await fetch(SLACK_POST_MESSAGE_URL, {
      body: JSON.stringify({
        channel,
        text,
        ...(options.threadTs ? { thread_ts: options.threadTs } : {}),
        ...(options.threadTs && options.broadcast ? { reply_broadcast: true } : {}),
      }),
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      method: "POST",
      signal: AbortSignal.timeout(10_000),
    });

    const data = (await response.json()) as SlackPostMessageResponse;

    if (!data.ok || !data.ts) {
      console.warn(`Slack postMessage failed: ${data.error ?? "unknown error"}`);
      return null;
    }

    return { channel: data.channel ?? channel, redirected, ts: data.ts };
  } catch (error) {
    console.warn("Slack postMessage request failed.", error);
    return null;
  }
}

export async function postSlackMessage(requestedChannel: string, requestedText: string): Promise<boolean> {
  return (await postSlackMessageDetailed(requestedChannel, requestedText)) !== null;
}

/** A link that opens the message (or thread reply) in Slack; null if Slack won't say. Needs no extra scope. */
export async function getSlackPermalink(channel: string, messageTs: string): Promise<string | null> {
  const token = await getSlackBotToken();

  if (!token) {
    return null;
  }

  try {
    const url = new URL(SLACK_PERMALINK_URL);
    url.searchParams.set("channel", channel);
    url.searchParams.set("message_ts", messageTs);
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5_000) });
    const data = (await response.json()) as { ok: boolean; permalink?: string };
    return data.ok && data.permalink?.startsWith("https://") ? data.permalink : null;
  } catch {
    return null;
  }
}

export interface SlackUserName {
  displayName: string;
  realName: string;
}

/** A Slack user's name (users:read), cached a week. Null - never throws - when it can't be read. */
export async function getSlackUserName(userId: string): Promise<SlackUserName | null> {
  if (!/^[UW][A-Z0-9]{2,}$/.test(userId)) {
    return null;
  }

  const cacheKey = `slack_user_name:${userId}`;
  const cached = await getCache<SlackUserName | null>(cacheKey);

  if (cached) {
    return cached.value;
  }

  const token = await getSlackBotToken();

  if (!token) {
    return null;
  }

  try {
    const url = new URL(SLACK_USER_INFO_URL);
    url.searchParams.set("user", userId);
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5_000) });
    const data = (await response.json()) as {
      ok: boolean;
      user?: { name?: string; profile?: { display_name?: string; real_name?: string }; real_name?: string };
    };

    if (!data.ok || !data.user) {
      return null;
    }

    const realName = data.user.profile?.real_name || data.user.real_name || data.user.name || "";
    const name: SlackUserName = { displayName: data.user.profile?.display_name || realName, realName };
    await setCache<SlackUserName | null>(cacheKey, name, SLACK_USER_LOOKUP_TTL_SECONDS);
    return name;
  } catch {
    return null;
  }
}

/* Long TTL (7 days), same reasoning as findJiraUserByName's cache in
   jiraClient.ts - a person's Slack account doesn't change day to day, and
   this is called once per SLA-breach alert draft, not per ticket view. */
const SLACK_USER_LOOKUP_TTL_SECONDS = 7 * 86_400;

/**
 * Guesses a `firstname.lastname@certifyos.com` address from a Jira display
 * name (the org sheet only has names, not emails/Slack IDs - see
 * src/lib/podRouting.ts) - confirmed as the real pattern for two known
 * accounts (anurag.rai@, akshay.kumar@). A middle name is dropped (first +
 * last token only), which won't always be right; findSlackUserIdByName below
 * treats a failed guess as "no match," never a hard failure, so a wrong
 * guess just means the Slack alert falls back to a plain-text @name mention
 * instead of a real ping - not a broken message.
 */
function guessEmailFromDisplayName(displayName: string): string | null {
  const parts = displayName
    .trim()
    .split(/\s+/)
    .map((part) => part.toLowerCase().replace(/[^a-z]/g, ""))
    .filter(Boolean);

  if (parts.length < 2) {
    return null;
  }

  return `${parts[0]}.${parts[parts.length - 1]}@certifyos.com`;
}

/**
 * Resolves a Jira/org-chart display name to a real Slack user ID, via
 * Slack's own users.lookupByEmail (requires the users:read.email scope on
 * the Slack token) against the guessed email above. Returns null - never
 * throws - on a missing token, an unguessable name, no match, or a missing
 * scope, since this always backs a best-effort @-mention in an internal
 * alert, not something that should block the alert from being sent.
 */
export async function findSlackUserIdByName(displayName: string): Promise<string | null> {
  const cacheKey = `slack_user_lookup:${displayName.trim().toLowerCase()}`;
  const cached = await getCache<string | null>(cacheKey);

  if (cached) {
    return cached.value;
  }

  const email = guessEmailFromDisplayName(displayName);

  if (!email) {
    return null;
  }

  const token = await getSlackBotToken();

  if (!token) {
    return null;
  }

  try {
    const url = new URL(SLACK_LOOKUP_BY_EMAIL_URL);
    url.searchParams.set("email", email);

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });

    const data = (await response.json()) as { error?: string; ok: boolean; user?: { id?: string } };

    if (!data.ok || !data.user?.id) {
      console.warn(`Slack user lookup for "${displayName}" (guessed ${email}) failed: ${data.error ?? "no match"}`);
      await setCache<string | null>(cacheKey, null, SLACK_USER_LOOKUP_TTL_SECONDS);
      return null;
    }

    await setCache<string | null>(cacheKey, data.user.id, SLACK_USER_LOOKUP_TTL_SECONDS);
    return data.user.id;
  } catch (error) {
    console.warn(`Slack user lookup request failed for "${displayName}".`, error);
    return null;
  }
}

/* ------------------------------------------------------------- read-only */

/* The only Slack Web API methods the escalation tracker may call - all reads. Nothing here can post, react or join. */
export type SlackReadMethod =
  | "chat.getPermalink"
  | "conversations.history"
  | "conversations.info"
  | "conversations.replies"
  | "users.conversations"
  | "users.info"
  | "users.list";

export interface SlackReadResult<T> {
  data: T | null;
  /* Slack's error code ("not_in_channel", "missing_scope"...), or "no_token" / "request_failed". */
  error?: string;
  ok: boolean;
  /* Slack said "ratelimited" (HTTP 429). The Vercel-managed app may get only one history/replies call a minute. */
  rateLimited: boolean;
  retryAfterSeconds?: number;
}

/**
 * One read-only Slack Web API call. Never throws: a missing token, a
 * network failure, a 429 or Slack's own {ok:false} all come back as a
 * result the caller can degrade on - the tracker treats Slack as optional.
 */
export async function slackRead<T extends { error?: string; ok: boolean }>(
  method: SlackReadMethod,
  params: Record<string, string>,
): Promise<SlackReadResult<T>> {
  const token = await getSlackBotToken();

  if (!token) {
    return { data: null, error: "no_token", ok: false, rateLimited: false };
  }

  try {
    const url = new URL(`https://slack.com/api/${method}`);
    for (const [name, value] of Object.entries(params)) {
      url.searchParams.set(name, value);
    }
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
    const retryAfter = Number(response.headers.get("retry-after"));
    const retryAfterSeconds = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined;

    if (response.status === 429) {
      return { data: null, error: "ratelimited", ok: false, rateLimited: true, retryAfterSeconds: retryAfterSeconds ?? 60 };
    }

    const data = (await response.json()) as T;

    if (!data.ok) {
      const rateLimited = data.error === "ratelimited";
      return { data, error: data.error ?? "unknown", ok: false, rateLimited, retryAfterSeconds: rateLimited ? (retryAfterSeconds ?? 60) : undefined };
    }

    return { data, ok: true, rateLimited: false };
  } catch (error) {
    console.warn(`Slack ${method} request failed.`, error instanceof Error ? error.message : error);
    return { data: null, error: "request_failed", ok: false, rateLimited: false };
  }
}

/* A channel's name hardly ever changes; a day keeps conversations.info off the hot path of every event. */
const SLACK_CHANNEL_NAME_TTL_SECONDS = 86_400;

/** A channel's name (conversations.info), cached a day. Undefined - never throws - when Slack won't say (a private channel without groups:read). */
export async function getSlackChannelName(channel: string): Promise<string | undefined> {
  if (!/^[CGD][A-Z0-9]{6,}$/.test(channel)) {
    return undefined;
  }

  const cacheKey = `slack_channel_name:${channel}`;
  const cached = await getCache<string | null>(cacheKey);

  if (cached) {
    return cached.value ?? undefined;
  }

  const result = await slackRead<{ channel?: { name?: string }; error?: string; ok: boolean }>("conversations.info", { channel });

  if (result.rateLimited || result.error === "no_token" || result.error === "request_failed") {
    /* Transient - try again next time rather than remembering "no name" for a day. */
    return undefined;
  }

  const name = result.ok ? result.data?.channel?.name : undefined;
  await setCache<string | null>(cacheKey, name ?? null, SLACK_CHANNEL_NAME_TTL_SECONDS);
  return name;
}

export interface SlackBotChannel {
  id: string;
  name?: string;
}

/* Membership changes when someone invites the bot; an hour is fresh enough for the history drip. */
const SLACK_BOT_CHANNELS_TTL_SECONDS = 3_600;
const MAX_BOT_CHANNEL_PAGES = 5;

/** Public channels the bot is a member of (users.conversations), cached an hour. Empty - never throws - when Slack won't say. */
export async function listSlackBotChannels(): Promise<SlackBotChannel[]> {
  const cacheKey = "slack_bot_channels:public";
  const cached = await getCache<SlackBotChannel[]>(cacheKey);

  if (cached) {
    return cached.value;
  }

  type Page = { channels?: Array<{ id?: string; name?: string }>; error?: string; ok: boolean; response_metadata?: { next_cursor?: string } };
  const channels: SlackBotChannel[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < MAX_BOT_CHANNEL_PAGES; page += 1) {
    const result = await slackRead<Page>("users.conversations", {
      exclude_archived: "true",
      limit: "200",
      types: "public_channel",
      ...(cursor ? { cursor } : {}),
    });
    if (!result.ok || !result.data) {
      /* A partial list is still useful, but don't cache a failure as "no channels" for an hour. */
      return channels;
    }
    for (const channel of result.data.channels ?? []) {
      if (channel.id) {
        channels.push({ id: channel.id, name: channel.name });
      }
    }
    cursor = result.data.response_metadata?.next_cursor || undefined;
    if (!cursor) {
      break;
    }
  }

  await setCache(cacheKey, channels, SLACK_BOT_CHANNELS_TTL_SECONDS);
  return channels;
}
