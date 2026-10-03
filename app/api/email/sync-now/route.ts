import { NextResponse } from "next/server";

import { rejectCrossOrigin } from "@/lib/actions/sameOrigin";
import { requireIdentity } from "@/lib/currentIdentity";
import { runManualEmailSync } from "@/lib/email/gmailSync";

export const dynamic = "force-dynamic";
/* One tick stops starting new messages after ~35s; the rest is headroom. */
export const maxDuration = 60;

const NO_STORE = { "Cache-Control": "no-store" };

/* POST - the inbox's "Sync now": one Gmail intake tick now (at most once every 30s across all browsers). Returns EmailSyncResult. */
export async function POST(request: Request): Promise<NextResponse> {
  const auth = await requireIdentity();
  if (auth.response) {
    return auth.response;
  }
  const crossOrigin = rejectCrossOrigin(request);
  if (crossOrigin) {
    return crossOrigin;
  }
  const result = await runManualEmailSync();
  console.info(`Email intake: manual sync by ${auth.identity.displayName} (${result.skipped ?? (result.ok ? "ok" : "failed")}).`);
  const status = result.ok ? 200 : result.skipped ? 503 : 502;
  return NextResponse.json(result, { headers: NO_STORE, status });
}
