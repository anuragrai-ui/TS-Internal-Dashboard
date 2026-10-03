import { NextResponse } from "next/server";

import { requireIdentity } from "@/lib/currentIdentity";
import { getFirefighterFeed } from "@/lib/firefighters/feed";

import type { FirefighterFeedResponse } from "@/lib/workspace/types";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * The #firefighters channel feed (src/lib/firefighters/feed.ts): GET ->
 * FirefighterFeedResponse, cached a minute server-side because Slack allows
 * the app about one history read a minute. Slack trouble ("not_in_channel",
 * throttling) comes back in the body with a 200, so the page can say what
 * to do about it.
 */
export async function GET(): Promise<NextResponse> {
  const auth = await requireIdentity();
  if (auth.response) {
    return auth.response;
  }

  const body: FirefighterFeedResponse = await getFirefighterFeed();
  return NextResponse.json(body, { headers: NO_STORE });
}
