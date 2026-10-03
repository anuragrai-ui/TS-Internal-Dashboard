import { NextResponse } from "next/server";

import { requireIdentity } from "@/lib/currentIdentity";
import { getFirstBuildFailure, refreshTrackerSnapshotManually } from "@/lib/tracker/snapshot";

export const dynamic = "force-dynamic";
/* A full build is ~12 read-only Jira searches plus up to 25 comment reads. */
export const maxDuration = 120;

const NO_STORE = { "Cache-Control": "no-store" };

/* The tracker's Refresh button: rebuild now (at most once every 30s across all browsers). Returns { builtAt, errors, throttled }. */
export async function POST(): Promise<NextResponse> {
  const auth = await requireIdentity();
  if (auth.response) {
    return auth.response;
  }

  try {
    const { snapshot, throttled } = await refreshTrackerSnapshotManually();
    /* No snapshot at all means the first build failed: say why instead of an empty list of errors. */
    const failure = snapshot ? null : await getFirstBuildFailure();
    return NextResponse.json(
      { builtAt: snapshot?.builtAt ?? null, errors: snapshot?.errors ?? (failure ? [failure] : []), throttled },
      { headers: NO_STORE },
    );
  } catch (error) {
    console.warn("Tracker: manual refresh failed.", error);
    return NextResponse.json({ builtAt: null, errors: ["Refresh failed; try again shortly."], throttled: false }, { headers: NO_STORE, status: 502 });
  }
}
