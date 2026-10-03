import { NextResponse } from "next/server";

import { requireIdentity } from "@/lib/currentIdentity";
import { getEmailCaseDetail, isCaseId } from "@/lib/email/inbox";

import type { EmailCaseDetail } from "@/lib/workspace/types";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/* GET ?id=<case uuid> -> EmailCaseDetail: the case's inbox row and its email thread (plain text only), oldest first. */
export async function GET(request: Request): Promise<NextResponse> {
  const auth = await requireIdentity();
  if (auth.response) {
    return auth.response;
  }
  const id = new URL(request.url).searchParams.get("id") ?? "";
  if (!isCaseId(id)) {
    return NextResponse.json({ error: "Expected ?id=<case id>." }, { headers: NO_STORE, status: 400 });
  }
  const result = await getEmailCaseDetail(id);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { headers: NO_STORE, status: 503 });
  }
  if (!result.value) {
    return NextResponse.json({ error: "No email case with that id." }, { headers: NO_STORE, status: 404 });
  }
  const body: EmailCaseDetail = result.value;
  return NextResponse.json(body, { headers: NO_STORE });
}
