import { NextResponse } from "next/server";

import { getCurrentIdentity } from "@/lib/currentIdentity";
import { googleReturnPath } from "@/lib/google/messages";
import { completeGoogleConnection, defaultGoogleDeps } from "@/lib/google/oauth";

export const dynamic = "force-dynamic";

/**
 * GET /api/google/callback - where Google sends the person back. The
 * identity cookie is SameSite=Lax, which a top-level redirect from Google
 * still carries, so the state can be checked against the same dashboard
 * user who started the sign-in. Always ends in a redirect to the page the
 * connection is managed from, with ?google=connected or ?google_error=<code>
 * (a code, never Google's text or an address).
 */
export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const identity = await getCurrentIdentity();
  if (!identity) {
    return NextResponse.redirect(new URL("/settings/jira-tokens", url.origin), 303);
  }

  const result = await completeGoogleConnection(
    defaultGoogleDeps(),
    { code: url.searchParams.get("code"), error: url.searchParams.get("error"), state: url.searchParams.get("state") },
    { accountId: identity.accountId, displayName: identity.displayName },
  );
  const path = result.purpose ? googleReturnPath(result.purpose) : "/oncall";
  const target = new URL(path, url.origin);
  target.searchParams.set(result.ok ? "google" : "google_error", result.ok ? "connected" : result.code);
  const response = NextResponse.redirect(target, 303);
  response.headers.set("Cache-Control", "no-store");
  /* The callback URL carries the one-time code; don't hand it to whatever the next page links to. */
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}
