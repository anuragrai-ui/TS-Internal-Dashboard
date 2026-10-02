import { NextResponse } from "next/server";

import { requireIdentity } from "@/lib/currentIdentity";
import { checkSlackConnection } from "@/lib/slackConnect";

/* Read-only Slack connection check (identity, scopes, channel membership) for
   an identified teammate. Never posts anything and never returns the token. */
export async function GET(): Promise<NextResponse> {
  const auth = await requireIdentity();
  if (auth.response) {
    return auth.response;
  }

  return NextResponse.json(await checkSlackConnection());
}
