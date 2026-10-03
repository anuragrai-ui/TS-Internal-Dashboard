import { NextResponse } from "next/server";

import { getSyncStatus } from "@/lib/cases/read";
import { requireIdentity } from "@/lib/currentIdentity";
import { isDatabaseConfigured } from "@/lib/db/client";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/* GET -> SyncStatus: row counts, the sync's cursors / last tick / last error, and SLA parity against Jira. */
export async function GET(): Promise<NextResponse> {
  const auth = await requireIdentity();
  if (auth.response) {
    return auth.response;
  }

  if (!isDatabaseConfigured()) {
    return NextResponse.json({ configured: false }, { headers: NO_STORE });
  }
  const result = await getSyncStatus();
  if (!result.ok) {
    return NextResponse.json({ configured: true, error: "The case store is unavailable right now." }, { headers: NO_STORE, status: 502 });
  }
  return NextResponse.json({ configured: true, ...result.value }, { headers: NO_STORE });
}
