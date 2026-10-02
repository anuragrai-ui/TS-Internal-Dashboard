import { NextResponse } from "next/server";

import { requireIdentity } from "@/lib/currentIdentity";
import { runEscalationsOnce } from "@/lib/escalation/runner";

export const dynamic = "force-dynamic";
/* A full sweep is ~70 read-only Jira calls plus a few Slack posts. */
export const maxDuration = 120;

/* "Run now" on the Escalations page: one shadow run right away (skips the 10-minute cadence, never the run lock). */
export async function POST(): Promise<NextResponse> {
  const auth = await requireIdentity();
  if (auth.response) {
    return auth.response;
  }

  const summary = await runEscalationsOnce("manual");
  return NextResponse.json({ summary }, { status: summary.error ? 502 : 200 });
}
