import { NextResponse } from "next/server";

import { slaBreachAlertCooldownKey } from "@/lib/followupAudit";
import { getRedis, isRedisConfigured } from "@/lib/redis";
import { postSlackMessage } from "@/lib/slackApi";

interface SendSlackAlertRequestBody {
  channel?: unknown;
  text?: unknown;
}

/* Separate, shorter-lived than the 24h Jira follow-up cooldown - this just
   stops an accidental double-click/double-post to Slack, not a cadence rule
   like the Jira send route's cooldown. */
const COOLDOWN_SECONDS = 24 * 3600;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ key: string }> },
): Promise<NextResponse> {
  const { key } = await params;

  let body: SendSlackAlertRequestBody;

  try {
    body = (await request.json()) as SendSlackAlertRequestBody;
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  const channel = typeof body.channel === "string" ? body.channel.trim() : "";
  const text = typeof body.text === "string" ? body.text : "";

  if (!channel || !text.trim()) {
    return NextResponse.json({ error: "Both \"channel\" and a non-empty \"text\" are required." }, { status: 400 });
  }

  if (isRedisConfigured()) {
    try {
      const existing = await getRedis().get(slaBreachAlertCooldownKey(key));

      if (existing) {
        return NextResponse.json(
          { cooldownActive: true, error: `An SLA-breach alert was already sent recently for ${key}.` },
          { status: 429 },
        );
      }
    } catch (error) {
      console.warn(`SLA-breach alert cooldown check failed for ${key}; proceeding without it.`, error);
    }
  }

  const posted = await postSlackMessage(channel, text);

  if (!posted) {
    return NextResponse.json(
      { error: "Failed to post the Slack alert - check that SLACK_BOT_TOKEN is configured and can post to that channel." },
      { status: 502 },
    );
  }

  if (isRedisConfigured()) {
    try {
      await getRedis().set(slaBreachAlertCooldownKey(key), new Date().toISOString(), { ex: COOLDOWN_SECONDS });
    } catch (error) {
      console.warn(`Failed to set the SLA-breach alert cooldown for ${key}.`, error);
    }
  }

  return NextResponse.json({ sent: true });
}
