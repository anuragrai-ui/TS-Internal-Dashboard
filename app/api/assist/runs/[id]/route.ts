import { NextResponse } from "next/server";

import { getRun, toPublicRun } from "@/lib/assist/runs";
import { requireIdentity } from "@/lib/currentIdentity";

import type { AssistRunResponse } from "@/lib/workspace/types";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/* GET /api/assist/runs/<id> -> AssistRunResponse. What the panel polls while an investigation runs; a run stuck
   in queued/running for over 6 minutes comes back as failed ("timed out"). */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const auth = await requireIdentity();
  if (auth.response) {
    auth.response.headers.set("Cache-Control", "no-store");
    return auth.response;
  }

  const id = (await params).id.trim().toLowerCase();
  if (!RUN_ID.test(id)) {
    return NextResponse.json({ error: "Not an investigation id." }, { headers: NO_STORE, status: 400 });
  }

  const run = await getRun(id);
  if (!run) {
    return NextResponse.json({ error: "That investigation doesn't exist (runs are kept for 14 days)." }, { headers: NO_STORE, status: 404 });
  }

  const body: AssistRunResponse = { run: toPublicRun(run) };
  return NextResponse.json(body, { headers: NO_STORE });
}
