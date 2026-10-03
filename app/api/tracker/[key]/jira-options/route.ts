import { NextResponse } from "next/server";

import { getJiraOptions } from "@/lib/actions/jiraOptions";
import { jiraWriteConfigFromEnv } from "@/lib/actions/jiraWrites";
import { TICKET_KEY_PATTERN } from "@/lib/actions/validate";
import { requireIdentity } from "@/lib/currentIdentity";
import { getJiraCredentialsForAccount } from "@/lib/userJiraTokens";

import type { JiraOptionsResponse } from "@/lib/workspace/types";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/* GET [?q=name] -> JiraOptionsResponse: the transitions, assignees (matching q) and priorities the action bar may
   offer, read with YOUR Jira token, plus the ticket's `updated` to send back as expectedVersion. */
export async function GET(request: Request, { params }: { params: Promise<{ key: string }> }): Promise<NextResponse> {
  const auth = await requireIdentity();
  if (auth.response) {
    return auth.response;
  }

  const key = (await params).key.trim().toUpperCase();
  if (!TICKET_KEY_PATTERN.test(key)) {
    return NextResponse.json({ error: "Expected a TS ticket key like TS-123." }, { headers: NO_STORE, status: 400 });
  }

  const query = new URL(request.url).searchParams.get("q") ?? "";
  const creds = await getJiraCredentialsForAccount(auth.identity.accountId);
  const result = await getJiraOptions(key, query, creds, jiraWriteConfigFromEnv());
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { headers: NO_STORE, status: result.status });
  }

  const response: JiraOptionsResponse = result.options;
  return NextResponse.json(response, { headers: NO_STORE });
}
