import { getCache, setCache } from "@/lib/cache";
import { getSlackBotToken } from "@/lib/slackConnect";

const SLACK_POST_MESSAGE_URL = "https://slack.com/api/chat.postMessage";
const SLACK_LOOKUP_BY_EMAIL_URL = "https://slack.com/api/users.lookupByEmail";

interface SlackPostMessageResponse {
  error?: string;
  ok: boolean;
}

/**
 * Outbound Slack posting. The token comes from the Vercel Connect Slack
 * connector at call time (src/lib/slackConnect.ts), or SLACK_BOT_TOKEN as a
 * local override. Gracefully no-ops with a warning if unconfigured, matching every
 * other optional-integration pattern in this codebase (Redis, OCR,
 * escalation AI) - the cron route still runs and prepares drafts even
 * without Slack set up, it just skips the notification.
 */
export async function postSlackMessage(channel: string, text: string): Promise<boolean> {
  const token = await getSlackBotToken();

  if (!token) {
    console.warn("No Slack token available (Vercel Connect / SLACK_BOT_TOKEN); skipping Slack notification.");
    return false;
  }

  try {
    const response = await fetch(SLACK_POST_MESSAGE_URL, {
      body: JSON.stringify({ channel, text }),
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      method: "POST",
      signal: AbortSignal.timeout(10_000),
    });

    const data = (await response.json()) as SlackPostMessageResponse;

    if (!data.ok) {
      console.warn(`Slack postMessage failed: ${data.error ?? "unknown error"}`);
      return false;
    }

    return true;
  } catch (error) {
    console.warn("Slack postMessage request failed.", error);
    return false;
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
