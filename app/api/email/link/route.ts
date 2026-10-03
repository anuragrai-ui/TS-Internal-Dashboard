import { NextResponse } from "next/server";

import { rejectCrossOrigin } from "@/lib/actions/sameOrigin";
import { requireIdentity } from "@/lib/currentIdentity";
import { linkEmailCase } from "@/lib/email/inbox";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/* POST { caseId, jiraKey } -> { caseId, key, merged }: links an email case to an existing TS ticket (merging into its case when the store has it). */
export async function POST(request: Request): Promise<NextResponse> {
  const auth = await requireIdentity();
  if (auth.response) {
    return auth.response;
  }
  const crossOrigin = rejectCrossOrigin(request);
  if (crossOrigin) {
    return crossOrigin;
  }
  const body = (await request.json().catch(() => null)) as { caseId?: unknown; jiraKey?: unknown } | null;
  const result = await linkEmailCase(typeof body?.caseId === "string" ? body.caseId : "", body?.jiraKey, {
    accountId: auth.identity.accountId,
    displayName: auth.identity.displayName,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { headers: NO_STORE, status: result.status });
  }
  return NextResponse.json({ caseId: result.caseId, key: result.key, merged: result.merged }, { headers: NO_STORE });
}
