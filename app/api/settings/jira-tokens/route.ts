import { NextResponse } from "next/server";

import { listRegisteredJiraUsers, registerUserJiraToken } from "@/lib/userJiraTokens";

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

  return NextResponse.json({ user: result.user });
}
