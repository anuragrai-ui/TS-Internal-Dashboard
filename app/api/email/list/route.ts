import { NextResponse } from "next/server";

import { requireIdentity } from "@/lib/currentIdentity";
import { getInboxOverview, isInboxFilter } from "@/lib/email/inbox";

import type { EmailInboxResponse } from "@/lib/workspace/types";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/* GET ?filter=all|unlinked|linked|open -> EmailInboxResponse: setup state (mailbox connection, missing env), sync status and the cases with email. */
export async function GET(request: Request): Promise<NextResponse> {
  const auth = await requireIdentity();
  if (auth.response) {
    return auth.response;
  }
  const filter = new URL(request.url).searchParams.get("filter") ?? "all";
  if (!isInboxFilter(filter)) {
    return NextResponse.json({ error: "Expected ?filter=all, unlinked, linked or open." }, { headers: NO_STORE, status: 400 });
  }
  const body: EmailInboxResponse = await getInboxOverview(filter);
  return NextResponse.json(body, { headers: NO_STORE });
}
