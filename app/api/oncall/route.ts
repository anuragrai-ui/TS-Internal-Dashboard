import { NextResponse } from "next/server";

import { requireIdentity } from "@/lib/currentIdentity";
import { getOnCall } from "@/lib/oncall/schedule";

import type { OnCallResponse } from "@/lib/workspace/types";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Who is firefighter now, who is next, and the next 14 days, from the
 * rotation's Google Calendar (src/lib/oncall/schedule.ts): GET ->
 * OnCallResponse. `?refresh=1` re-downloads the calendar instead of using
 * the 10-minute copy (at most once every 30s across all browsers). The
 * calendar's secret address never leaves the server.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const auth = await requireIdentity();
  if (auth.response) {
    return auth.response;
  }

  const refresh = new URL(request.url).searchParams.get("refresh") === "1";
  const body: OnCallResponse = await getOnCall(new Date(), { refresh });
  return NextResponse.json(body, { headers: NO_STORE });
}
