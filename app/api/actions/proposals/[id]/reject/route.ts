import { NextResponse } from "next/server";

import { rejectCrossOrigin } from "@/lib/actions/sameOrigin";
import { rejectProposal } from "@/lib/actions/service";
import { requireIdentity } from "@/lib/currentIdentity";

import type { ProposalDecisionResponse } from "@/lib/workspace/types";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/* POST -> ProposalDecisionResponse. Marks a pending proposal rejected; nothing is written anywhere. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const auth = await requireIdentity();
  if (auth.response) {
    return auth.response;
  }
  const crossOrigin = rejectCrossOrigin(request);
  if (crossOrigin) {
    return crossOrigin;
  }

  const { id } = await params;
  const result = await rejectProposal(id, { accountId: auth.identity.accountId, displayName: auth.identity.displayName });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { headers: NO_STORE, status: result.status });
  }

  const response: ProposalDecisionResponse = { proposal: result.proposal };
  return NextResponse.json(response, { headers: NO_STORE });
}
