import { getToken } from "@vercel/connect";

import { FALLBACK_SLACK_CHANNEL, POD_ROUTING } from "@/lib/podRouting";

/**
 * Slack credentials come from Vercel Connect: the team-level Slack connector
 * is attached to this project, and each deployment exchanges its own Vercel
 * OIDC token for a short-lived Slack token at the moment it needs one - no
 * Slack secret lives in this project's environment variables.
 *
 * SLACK_BOT_TOKEN still wins when set, as a local-development override
 * (Connect only issues tokens to Vercel deployments, or to a machine that
 * pulled a development OIDC token with `vercel env pull`).
 */
export const SLACK_CONNECTOR = process.env.SLACK_CONNECTOR || "slack/ts-internal-dashboard";

function canUseConnect(): boolean {
  /* On Vercel the OIDC token arrives per request; locally it's only present after `vercel env pull`. */
  return process.env.VERCEL === "1" || Boolean(process.env.VERCEL_OIDC_TOKEN);
}

/** A Slack token for Web API calls, or null (never throws) when none can be obtained - callers degrade gracefully. */
export async function getSlackBotToken(): Promise<string | null> {
  const override = process.env.SLACK_BOT_TOKEN;
  if (override) {
    return override;
  }
  if (!canUseConnect()) {
    return null;
  }

  try {
    return await getToken(SLACK_CONNECTOR, { subject: { type: "app" } });
  } catch (error) {
    console.warn(`Vercel Connect could not issue a Slack token for ${SLACK_CONNECTOR}.`, error instanceof Error ? error.message : error);
    return null;
  }
}

export interface SlackChannelCheck {
  channelId: string;
  error?: string;
  isArchived?: boolean;
  isMember?: boolean;
  isPrivate?: boolean;
  name?: string;
  usedBy: string[];
}

export interface SlackConnectionReport {
  botId?: string;
  channels: SlackChannelCheck[];
  connector: string;
  error?: string;
  /* Only the token's type prefix (e.g. "xoxb" = bot, "xoxp" = user) - never the token. */
  ok: boolean;
  scopes: string[];
  source: "connect" | "env_override" | "none";
  team?: string;
  teamId?: string;
  tokenType?: string;
  user?: string;
  userId?: string;
}

interface SlackAuthTest {
  bot_id?: string;
  error?: string;
  ok: boolean;
  team?: string;
  team_id?: string;
  user?: string;
  user_id?: string;
}

interface SlackConversationsInfo {
  channel?: { id?: string; is_archived?: boolean; is_member?: boolean; is_private?: boolean; name?: string };
  error?: string;
  ok: boolean;
}

/* Every channel the dashboard might post to, and which pods use it. */
function routedChannels(): Map<string, string[]> {
  const channels = new Map<string, string[]>();
  for (const [pod, route] of Object.entries(POD_ROUTING)) {
    channels.set(route.slackChannel, [...(channels.get(route.slackChannel) ?? []), pod]);
  }
  if (!channels.has(FALLBACK_SLACK_CHANNEL)) {
    channels.set(FALLBACK_SLACK_CHANNEL, ["fallback"]);
  }
  return channels;
}

/**
 * Read-only health check of the Slack connection: who the token belongs to
 * (auth.test), which scopes it carries (Slack's x-oauth-scopes header), and
 * whether the bot can see / is a member of every routed channel
 * (conversations.info). Never posts, joins, or returns the token.
 */
export async function checkSlackConnection(): Promise<SlackConnectionReport> {
  const source: SlackConnectionReport["source"] = process.env.SLACK_BOT_TOKEN ? "env_override" : canUseConnect() ? "connect" : "none";
  const base = { channels: [] as SlackChannelCheck[], connector: SLACK_CONNECTOR, scopes: [] as string[], source };
  const token = await getSlackBotToken();

  if (!token) {
    return { ...base, error: "No Slack token available (Connect did not issue one).", ok: false };
  }

  const headers = { Authorization: `Bearer ${token}` };
  const tokenType = token.split("-")[0];

  try {
    const authResponse = await fetch("https://slack.com/api/auth.test", {
      headers,
      method: "POST",
      signal: AbortSignal.timeout(10_000),
    });
    const scopes = (authResponse.headers.get("x-oauth-scopes") ?? "")
      .split(",")
      .map((scope) => scope.trim())
      .filter(Boolean)
      .sort();
    const auth = (await authResponse.json()) as SlackAuthTest;

    if (!auth.ok) {
      return { ...base, error: `auth.test failed: ${auth.error ?? "unknown"}`, ok: false, scopes, tokenType };
    }

    const channels = await Promise.all(
      [...routedChannels()].map(async ([channelId, usedBy]): Promise<SlackChannelCheck> => {
        const url = new URL("https://slack.com/api/conversations.info");
        url.searchParams.set("channel", channelId);
        const info = (await (await fetch(url, { headers, signal: AbortSignal.timeout(10_000) })).json()) as SlackConversationsInfo;
        return info.ok
          ? {
              channelId,
              isArchived: info.channel?.is_archived,
              isMember: info.channel?.is_member,
              isPrivate: info.channel?.is_private,
              name: info.channel?.name,
              usedBy,
            }
          : { channelId, error: info.error ?? "unknown", usedBy };
      }),
    );

    return {
      ...base,
      botId: auth.bot_id,
      channels,
      ok: true,
      scopes,
      team: auth.team,
      teamId: auth.team_id,
      tokenType,
      user: auth.user,
      userId: auth.user_id,
    };
  } catch (error) {
    return { ...base, error: `Slack request failed: ${error instanceof Error ? error.message : String(error)}`, ok: false, tokenType };
  }
}
