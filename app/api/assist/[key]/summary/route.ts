import { NextResponse } from "next/server";

import { getAssistSummary } from "@/lib/assist/summarize";
import { requireIdentity } from "@/lib/currentIdentity";

import type { AssistSummary } from "@/lib/workspace/types";

export const dynamic = "force-dynamic";
/* A cold ticket detail (~6 read-only Jira reads) plus one fast-model call with up to two 30s attempts. */
export const maxDuration = 90;

const NO_STORE = { "Cache-Control": "no-store" };
const TS_KEY = /^TS-\d+$/;

/* GET /api/assist/<KEY>/summary[?refresh=1] -> AssistSummary: 3-5 plain lines about the ticket, cached per Jira
   `updated` for an hour. refresh=1 writes a new one (counts against the 60-an-hour limit). Errors carry a `code`
   ("ai_not_configured", "rate_limited") the panel keys off. */
export async function GET(request: Request, { params }: { params: Promise<{ key: string }> }): Promise<NextResponse> {
  const auth = await requireIdentity();
  if (auth.response) {
    auth.response.headers.set("Cache-Control", "no-store");
    return auth.response;
  }

  const key = (await params).key.trim().toUpperCase();
  if (!TS_KEY.test(key)) {
    return NextResponse.json({ error: "Expected a TS ticket key like TS-123." }, { headers: NO_STORE, status: 400 });
  }

  const refresh = new URL(request.url).searchParams.get("refresh") === "1";
  const outcome = await getAssistSummary(key, auth.identity.accountId, { refresh });
  if (!outcome.ok) {
    const headers = outcome.retryAfterSeconds ? { ...NO_STORE, "Retry-After": String(outcome.retryAfterSeconds) } : NO_STORE;
    return NextResponse.json({ code: outcome.code, error: outcome.error }, { headers, status: outcome.status });
  }

  const body: AssistSummary = outcome.summary;
  return NextResponse.json(body, { headers: NO_STORE });
}
