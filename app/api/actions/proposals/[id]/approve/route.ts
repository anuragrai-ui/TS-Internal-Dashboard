import { NextResponse } from "next/server";

import { rejectCrossOrigin } from "@/lib/actions/sameOrigin";
import { approveProposal } from "@/lib/actions/service";
import { requireIdentity } from "@/lib/currentIdentity";

import type { ApproveProposalRequest, ProposalDecisionResponse } from "@/lib/workspace/types";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const NO_STORE = { "Cache-Control": "no-store" };

/* POST ApproveProposalRequest -> ProposalDecisionResponse. Executes the proposal (as edited) as the person approving it.
   A conflict or failure leaves it pending, with the execution saying why. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const auth = await requireIdentity();
  if (auth.response) {
    return auth.response;
  }
  const crossOrigin = rejectCrossOrigin(request);
  if (crossOrigin) {
    return crossOrigin;
  }

  let body: Partial<ApproveProposalRequest> | null;
  try {
    body = (await request.json()) as Partial<ApproveProposalRequest> | null;
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { headers: NO_STORE, status: 400 });
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Expected { idempotencyKey, args?, force? }." }, { headers: NO_STORE, status: 400 });
  }

  const { id } = await params;
  const result = await approveProposal(
    id,
    { ...(body.args !== undefined ? { args: body.args } : {}), force: body.force === true, idempotencyKey: body.idempotencyKey as string },
    { accountId: auth.identity.accountId, displayName: auth.identity.displayName },
  );
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { headers: NO_STORE, status: result.status });
  }

  const response: ProposalDecisionResponse = { ...(result.execution ? { execution: result.execution } : {}), proposal: result.proposal };
  return NextResponse.json(response, { headers: NO_STORE });
}
