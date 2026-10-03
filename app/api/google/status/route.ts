import { NextResponse } from "next/server";

import { requireIdentity } from "@/lib/currentIdentity";
import { defaultGoogleDeps, getGoogleConnectionStatus, isGooglePurpose } from "@/lib/google/oauth";

import type { GoogleConnectionStatus } from "@/lib/workspace/types";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/* GET ?purpose=calendar|mailbox -> GoogleConnectionStatus (who connected which account, or why it isn't). No token ever leaves the server. */
export async function GET(request: Request): Promise<NextResponse> {
  const auth = await requireIdentity();
  if (auth.response) {
    return auth.response;
  }
  const purpose = new URL(request.url).searchParams.get("purpose");
  if (!isGooglePurpose(purpose)) {
    return NextResponse.json({ error: "Expected ?purpose=calendar or ?purpose=mailbox." }, { headers: NO_STORE, status: 400 });
  }
  const status: GoogleConnectionStatus = await getGoogleConnectionStatus(defaultGoogleDeps(), purpose);
  return NextResponse.json(status, { headers: NO_STORE });
}
