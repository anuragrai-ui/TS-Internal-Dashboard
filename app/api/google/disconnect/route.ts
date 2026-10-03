import { NextResponse } from "next/server";

import { rejectCrossOrigin } from "@/lib/actions/sameOrigin";
import { requireIdentity } from "@/lib/currentIdentity";
import { defaultGoogleDeps, disconnectGoogle, getGoogleConnectionStatus, isGooglePurpose } from "@/lib/google/oauth";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/* POST { purpose } - revokes the stored Google sign-in at Google and forgets it. Returns { status, revoked }. */
export async function POST(request: Request): Promise<NextResponse> {
  const auth = await requireIdentity();
  if (auth.response) {
    return auth.response;
  }
  const crossOrigin = rejectCrossOrigin(request);
  if (crossOrigin) {
    return crossOrigin;
  }

  const body = (await request.json().catch(() => null)) as { purpose?: unknown } | null;
  if (!isGooglePurpose(body?.purpose)) {
    return NextResponse.json({ error: 'Expected { purpose: "calendar" | "mailbox" }.' }, { headers: NO_STORE, status: 400 });
  }
  const deps = defaultGoogleDeps();
  const result = await disconnectGoogle(deps, body.purpose, { accountId: auth.identity.accountId, displayName: auth.identity.displayName });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { headers: NO_STORE, status: 503 });
  }
  return NextResponse.json({ revoked: result.revoked, status: await getGoogleConnectionStatus(deps, body.purpose) }, { headers: NO_STORE });
}
