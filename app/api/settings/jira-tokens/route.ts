import { NextResponse } from "next/server";

import { IDENTITY_COOKIE } from "@/lib/currentIdentity";
import { listRegisteredJiraUsers, registerUserJiraToken } from "@/lib/userJiraTokens";

/* One year: this cookie just remembers which registered account a browser
   belongs to, not a security-sensitive session - re-registering or using the
   "identify as" switcher (see app/api/settings/identity/route.ts) overwrites
   it at any time. */
const IDENTITY_COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

interface RegisterRequestBody {
  apiToken?: unknown;
  email?: unknown;
}

export async function GET(): Promise<NextResponse> {
  const users = await listRegisteredJiraUsers();
  return NextResponse.json({ users });
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: RegisterRequestBody;

  try {
    body = (await request.json()) as RegisterRequestBody;
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  const email = typeof body.email === "string" ? body.email.trim() : "";
  const apiToken = typeof body.apiToken === "string" ? body.apiToken.trim() : "";

  if (!email || !apiToken) {
    return NextResponse.json({ error: "Both \"email\" and \"apiToken\" are required." }, { status: 400 });
  }

  const result = await registerUserJiraToken(email, apiToken);

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 422 });
  }

  const response = NextResponse.json({ user: result.user });
  // Registering just proved control of this Jira account (verified against
  // Jira's own /myself in registerUserJiraToken) - identify this browser as
  // that person from now on, same as a fresh sign-in.
  response.cookies.set(IDENTITY_COOKIE, result.user.accountId, {
    httpOnly: true,
    maxAge: IDENTITY_COOKIE_MAX_AGE_SECONDS,
    path: "/",
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });
  return response;
}
