import { NextResponse } from "next/server";

import { requireIdentity } from "@/lib/currentIdentity";
import { probeSlackHistoryAccess } from "@/lib/tracker/slackBackfill";

import type { SlackHistoryProbeResult } from "@/lib/tracker/slackBackfill";

/* "Check Slack history access" on Settings -> Slack: two conversations.history calls back to back on one bot
   channel, to see whether this Slack app is throttled (1 call a minute, 15 messages a page) or gets full pages.
   Returns counts and status only - never message text. */
export async function POST(): Promise<NextResponse> {
  const auth = await requireIdentity();
  if (auth.response) {
    return auth.response;
  }

  const result: SlackHistoryProbeResult = await probeSlackHistoryAccess();
  return NextResponse.json(result);
}
