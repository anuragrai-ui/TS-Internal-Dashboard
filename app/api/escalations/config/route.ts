import { NextResponse } from "next/server";

import { requireIdentity } from "@/lib/currentIdentity";
import { getShadowChannel, setRunnerMode } from "@/lib/escalation/runnerStore";
import { isRedisConfigured } from "@/lib/redis";

/**
 * POST { mode: "shadow" | "off" } - starts or pauses the escalation shadow
 * run. Shadow mode can only post to the shadow channel (the Slack test
 * channel, from the environment), so this switch can never reach a pod
 * channel. Whoever switches it on is told about all escalation activity.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const auth = await requireIdentity();
  if (auth.response) {
    return auth.response;
  }

  let body: { mode?: unknown };
  try {
    body = (await request.json()) as { mode?: unknown };
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  if (body.mode !== "shadow" && body.mode !== "off") {
    return NextResponse.json({ error: 'mode must be "shadow" or "off".' }, { status: 400 });
  }
  if (!isRedisConfigured()) {
    return NextResponse.json({ error: "Redis is not configured, so the runner has nowhere to keep its state." }, { status: 503 });
  }
  if (body.mode === "shadow" && !getShadowChannel()) {
    return NextResponse.json(
      { error: "There's no shadow channel: set SLACK_TEST_CHANNEL (or ESCALATION_SHADOW_CHANNEL) in Vercel first. Shadow threads never go to pod channels." },
      { status: 409 },
    );
  }

  const config = await setRunnerMode(body.mode, auth.identity);
  return NextResponse.json({ config });
}
