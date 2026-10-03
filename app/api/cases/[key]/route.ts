import { NextResponse } from "next/server";

import { getCaseByKey } from "@/lib/cases/read";
import { requireIdentity } from "@/lib/currentIdentity";
import { isDatabaseConfigured } from "@/lib/db/client";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
const TS_KEY = /^TS-\d+$/;

/* GET -> CaseDetail for one TS ticket from the case store (Postgres): the case, its messages, events, links and SLA clocks. */
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
  if (!isDatabaseConfigured()) {
    return NextResponse.json({ error: "The case store is not configured." }, { headers: NO_STORE, status: 503 });
  }

  const result = await getCaseByKey(key);
  if (!result.ok) {
    return NextResponse.json({ error: "The case store is unavailable right now." }, { headers: NO_STORE, status: 502 });
  }
  if (!result.value) {
    return NextResponse.json({ error: `${key} is not in the case store (yet).` }, { headers: NO_STORE, status: 404 });
  }
  return NextResponse.json(result.value, { headers: NO_STORE });
}
