const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_POST_MESSAGE_URL = "https://slack.com/api/chat.postMessage";

interface SlackPostMessageResponse {
  error?: string;
  ok: boolean;
}

/**
 * Outbound Slack posting - genuinely new capability. The existing Slack
 * integration (app/api/slack/events/route.ts) is inbound-webhook-only and
 * has no bot token; this needs a new SLACK_BOT_TOKEN with the chat:write
 * scope. Gracefully no-ops with a warning if unconfigured, matching every
 * other optional-integration pattern in this codebase (Redis, OCR,
 * escalation AI) - the cron route still runs and prepares drafts even
 * without Slack set up, it just skips the notification.
 */
export async function postSlackMessage(channel: string, text: string): Promise<boolean> {
  if (!SLACK_BOT_TOKEN) {
    console.warn("SLACK_BOT_TOKEN not configured; skipping Slack notification.");
    return false;
  }

  try {
    const response = await fetch(SLACK_POST_MESSAGE_URL, {
      body: JSON.stringify({ channel, text }),
      headers: {
        Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
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
