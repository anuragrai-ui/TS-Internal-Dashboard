import { NextResponse } from "next/server";

import { getCurrentIdentity, startIdentitySession } from "@/lib/currentIdentity";
import { registerUserJiraToken } from "@/lib/userJiraTokens";

interface RegisterRequestBody {
  apiToken?: unknown;
  email?: unknown;
}

/* Only ever your own registration. This used to return every registered
   teammate's accountId and email to anyone - and the accountId alone was
   enough to impersonate them under the old cookie scheme. */
export async function GET(): Promise<NextResponse> {
  const identity = await getCurrentIdentity();

  if (!identity) {
    return NextResponse.json({ error: "Not identified." }, { status: 401 });
  }

  return NextResponse.json({ user: identity });
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

  // Registering just proved control of this Jira account (verified against
  // Jira's own /myself in registerUserJiraToken) - start a session for this
  // browser, same as a fresh sign-in. See src/lib/identitySession.ts.
  const response = NextResponse.json({ user: result.user });

  if (!(await startIdentitySession(response, result.user))) {
    return NextResponse.json(
      { error: "Your token was saved, but a browser session couldn't be started (Redis unavailable). Try again." },
      { status: 503 },
    );
  }

  return response;
}
