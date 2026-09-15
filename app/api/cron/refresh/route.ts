import { NextResponse } from "next/server";

import { runScheduledJiraRefresh } from "@/lib/jiraRefreshScheduler";

export const maxDuration = 300;

export async function GET(request: Request): Promise<NextResponse> {
  const authHeader = request.headers.get("Authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const refreshed = await runScheduledJiraRefresh();
  return NextResponse.json({ ok: true, refreshed });
}
