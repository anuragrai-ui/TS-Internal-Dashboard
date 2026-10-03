import { after, NextResponse } from "next/server";

import { rejectCrossOrigin } from "@/lib/actions/sameOrigin";
import { AI_NOT_CONFIGURED_CODE, AI_NOT_CONFIGURED_MESSAGE, isAssistConfigured } from "@/lib/assist/config";
import { listRunsForTicket, runInvestigation, startInvestigation, toPublicRun } from "@/lib/assist/runs";
import { requireIdentity } from "@/lib/currentIdentity";
import { getTrackerDetail } from "@/lib/tracker/detail";

import type { AssistRunListResponse, AssistRunResponse } from "@/lib/workspace/types";

export const dynamic = "force-dynamic";
/* The response returns at once (202); the investigation runs after it, inside this budget (the agent keeps ~40s spare). */
export const maxDuration = 300;

const NO_STORE = { "Cache-Control": "no-store" };
const TS_KEY = /^TS-\d+$/;

async function ticketKey(params: Promise<{ key: string }>): Promise<string | null> {
  const key = (await params).key.trim().toUpperCase();
  return TS_KEY.test(key) ? key : null;
}

/* POST /api/assist/<KEY>/investigations -> 202 AssistRunResponse. Starts an investigation, or returns the one
   already in progress on this ticket. The agent only reads and proposes: its suggested actions become pending
   proposals a person approves in the panel. */
export async function POST(request: Request, { params }: { params: Promise<{ key: string }> }): Promise<NextResponse> {
  /* An investigation spends model tokens on the starter's behalf, so a cross-site page mustn't be able to start one. */
  const crossOrigin = rejectCrossOrigin(request);
  if (crossOrigin) {
    return crossOrigin;
  }
  const auth = await requireIdentity();
  if (auth.response) {
    auth.response.headers.set("Cache-Control", "no-store");
    return auth.response;
  }

  const key = await ticketKey(params);
  if (!key) {
    return NextResponse.json({ error: "Expected a TS ticket key like TS-123." }, { headers: NO_STORE, status: 400 });
  }
  if (!isAssistConfigured()) {
    return NextResponse.json({ code: AI_NOT_CONFIGURED_CODE, error: AI_NOT_CONFIGURED_MESSAGE }, { headers: NO_STORE, status: 503 });
  }

  /* A typo'd or unreadable ticket fails here, not as a failed run. Cached a minute, so the agent's own read is free. */
  const detail = await getTrackerDetail(key, auth.identity.accountId);
  if (!detail.ok) {
    return NextResponse.json({ error: detail.error }, { headers: NO_STORE, status: detail.reason === "not_found" ? 404 : 502 });
  }

  const started = await startInvestigation(key, { accountId: auth.identity.accountId, displayName: auth.identity.displayName });
  if (!started.ok) {
    const headers = started.retryAfterSeconds ? { ...NO_STORE, "Retry-After": String(started.retryAfterSeconds) } : NO_STORE;
    return NextResponse.json({ code: started.status === 429 ? "rate_limited" : undefined, error: started.error }, { headers, status: started.status });
  }

  if (started.started) {
    const runId = started.run.id;
    after(async () => {
      await runInvestigation(runId);
    });
  }

  const body: AssistRunResponse = { run: toPublicRun(started.run) };
  return NextResponse.json(body, { headers: NO_STORE, status: 202 });
}

/* GET /api/assist/<KEY>/investigations -> AssistRunListResponse: the ticket's recent runs, newest first. */
export async function GET(_request: Request, { params }: { params: Promise<{ key: string }> }): Promise<NextResponse> {
  const auth = await requireIdentity();
  if (auth.response) {
    auth.response.headers.set("Cache-Control", "no-store");
    return auth.response;
  }

  const key = await ticketKey(params);
  if (!key) {
    return NextResponse.json({ error: "Expected a TS ticket key like TS-123." }, { headers: NO_STORE, status: 400 });
  }

  const body: AssistRunListResponse = { runs: (await listRunsForTicket(key)).map(toPublicRun) };
  return NextResponse.json(body, { headers: NO_STORE });
}
