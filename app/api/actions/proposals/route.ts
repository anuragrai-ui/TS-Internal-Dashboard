import { NextResponse } from "next/server";

import { rejectCrossOrigin } from "@/lib/actions/sameOrigin";
import { createProposal } from "@/lib/actions/service";
import { requireIdentity } from "@/lib/currentIdentity";

import type { ActionProposal, CreateProposalRequest } from "@/lib/workspace/types";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/* POST CreateProposalRequest -> 201 { proposal }. The browser agent's (WebMCP) way to suggest a write: it only ever
   lands as a pending proposal a person reviews. AI Assist runs create theirs server-side. */
export async function POST(request: Request): Promise<NextResponse> {
  const auth = await requireIdentity();
  if (auth.response) {
    return auth.response;
  }
  const crossOrigin = rejectCrossOrigin(request);
  if (crossOrigin) {
    return crossOrigin;
  }

  let body: Partial<CreateProposalRequest> | null;
  try {
    body = (await request.json()) as Partial<CreateProposalRequest> | null;
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { headers: NO_STORE, status: 400 });
  }
  if (!body || typeof body !== "object" || !body.draft || typeof body.draft !== "object") {
    return NextResponse.json({ error: "Expected { draft: { ticketKey, args, rationale? } }." }, { headers: NO_STORE, status: 400 });
  }

  /* The source is fixed here: whatever the caller claims, this route only ever speaks for the browser agent. */
  const result = await createProposal(body.draft, { type: "browser_agent" }, { accountId: auth.identity.accountId, displayName: auth.identity.displayName });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { headers: NO_STORE, status: result.status });
  }

  const response: { proposal: ActionProposal } = { proposal: result.proposal };
  return NextResponse.json(response, { headers: NO_STORE, status: 201 });
}
