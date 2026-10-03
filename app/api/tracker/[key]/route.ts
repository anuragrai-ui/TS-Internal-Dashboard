import { NextResponse } from "next/server";

import { requireIdentity } from "@/lib/currentIdentity";
import { getTrackerDetail } from "@/lib/tracker/detail";

export const dynamic = "force-dynamic";
/* A cold detail is ~6 read-only Jira reads in parallel plus a few Redis reads. */
export const maxDuration = 60;

const NO_STORE = { "Cache-Control": "no-store" };
const TS_KEY = /^TS-\d+$/;

/* GET -> TrackerDetail for one TS ticket: the snapshot row, its live timeline and whether you follow it. */
export async function GET(_request: Request, { params }: { params: Promise<{ key: string }> }): Promise<NextResponse> {
  const auth = await requireIdentity();
  if (auth.response) {
    return auth.response;
  }

  const { key: rawKey } = await params;
  const key = rawKey.toUpperCase();
  if (!TS_KEY.test(key)) {
    return NextResponse.json({ error: "Expected a TS ticket key like TS-123." }, { headers: NO_STORE, status: 400 });
  }

  const result = await getTrackerDetail(key, auth.identity.accountId);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { headers: NO_STORE, status: result.reason === "not_found" ? 404 : 502 });
  }
  return NextResponse.json(result.detail, { headers: NO_STORE });
}
