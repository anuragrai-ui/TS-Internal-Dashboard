import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { IDENTITY_COOKIE } from "@/lib/currentIdentity";
import { getRegisteredJiraUser } from "@/lib/userJiraTokens";

/* Same lifetime as the cookie set on registration (app/api/settings/jira-tokens/route.ts) - this
   endpoint doesn't re-verify a token, it only lets a browser switch which
   *already-registered* account it's identified as, for a shared machine
   multiple teammates use. */
const IDENTITY_COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

interface SwitchIdentityRequestBody {
  accountId?: unknown;
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: SwitchIdentityRequestBody;

  try {
    body = (await request.json()) as SwitchIdentityRequestBody;
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  const accountId = typeof body.accountId === "string" ? body.accountId.trim() : "";

  if (!accountId) {
    return NextResponse.json({ error: "\"accountId\" is required." }, { status: 400 });
  }

  // Only allow switching to an account that has actually registered a token
  // - this endpoint trusts the existing registry, not the request body, so
  // it can't be used to "identify as" an arbitrary/unregistered accountId.
  const user = await getRegisteredJiraUser(accountId);

  if (!user) {
    return NextResponse.json({ error: "No registered Jira user with that account id." }, { status: 404 });
  }

  const response = NextResponse.json({ user });
  response.cookies.set(IDENTITY_COOKIE, user.accountId, {
    httpOnly: true,
    maxAge: IDENTITY_COOKIE_MAX_AGE_SECONDS,
    path: "/",
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });
  return response;
}

export async function DELETE(): Promise<NextResponse> {
  const store = await cookies();
  store.delete(IDENTITY_COOKIE);
  return NextResponse.json({ cleared: true });
}
