import { NextResponse } from "next/server";

import { getCurrentIdentity } from "@/lib/currentIdentity";
import { googleReturnPath } from "@/lib/google/messages";
import { defaultGoogleDeps, isGooglePurpose, startGoogleConnection } from "@/lib/google/oauth";

export const dynamic = "force-dynamic";

/**
 * GET /api/google/connect?purpose=calendar|mailbox - the "Connect" buttons
 * are plain links here; this redirects straight to Google's consent screen.
 * A GET is fine for starting (not finishing) a sign-in: all it does is store
 * a state bound to the caller's own identity, and nothing is connected until
 * that same person completes it at Google.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const purposeParam = url.searchParams.get("purpose");
  const purpose = isGooglePurpose(purposeParam) ? purposeParam : null;
  const back = (code: string): NextResponse =>
    NextResponse.redirect(new URL(`${purpose ? googleReturnPath(purpose) : "/oncall"}?google_error=${code}`, url.origin), 303);

  const identity = await getCurrentIdentity();
  if (!identity) {
    return NextResponse.redirect(new URL("/settings/jira-tokens", url.origin), 303);
  }
  if (!purpose) {
    return back("bad_purpose");
  }

  const result = await startGoogleConnection(defaultGoogleDeps(), { accountId: identity.accountId, displayName: identity.displayName }, purpose);
  if (!result.ok) {
    return back(result.code);
  }
  const response = NextResponse.redirect(result.url, 303);
  response.headers.set("Cache-Control", "no-store");
  return response;
}
