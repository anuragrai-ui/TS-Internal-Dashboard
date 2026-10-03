import { NextResponse } from "next/server";

import { runManualSync } from "@/lib/cases/jiraSync";
import { requireIdentity } from "@/lib/currentIdentity";

export const dynamic = "force-dynamic";
/* One tick stops starting new issues after ~40s; the rest is headroom for the issues already in flight. */
export const maxDuration = 60;

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Whether the request came from a page on this same host. The identity
 * cookie is SameSite=Lax, which already keeps it off cross-site POSTs; this
 * is the belt to that brace, since a sync spends Jira and database quota.
 * A missing Origin is refused too - every browser sends one on a fetch POST.
 */
function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) {
    return false;
  }
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/* The /cases "Sync now" button: one sync tick now (at most once every 30s across all browsers). Returns SyncTickResult. */
export async function POST(request: Request): Promise<NextResponse> {
  const auth = await requireIdentity();
  if (auth.response) {
    return auth.response;
  }

  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "Cross-origin request refused." }, { headers: NO_STORE, status: 403 });
  }

  const result = await runManualSync({ accountId: auth.identity.accountId, displayName: auth.identity.displayName });
  const status = result.ok ? 200 : result.skipped ? 503 : 502;
  return NextResponse.json(result, { headers: NO_STORE, status });
}
