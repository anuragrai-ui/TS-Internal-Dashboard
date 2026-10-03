import { after, NextResponse } from "next/server";

import { requireIdentity } from "@/lib/currentIdentity";
import { getFollowedKeys } from "@/lib/tracker/follow";
import { getFirstBuildFailure, getTrackerSnapshot, refreshTrackerSnapshot } from "@/lib/tracker/snapshot";

import type { TrackerListResponse } from "@/lib/tracker/types";

export const dynamic = "force-dynamic";
/* The response never waits on Jira; this covers the first-ever build that may follow it (~15s of read-only searches). */
export const maxDuration = 120;

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * The escalation tracker's list: GET -> TrackerListResponse from the cached
 * snapshot (the poll loop keeps it fresh - see maybeRefreshTrackerSnapshot
 * in app/api/notifications/route.ts). Before the very first build there is
 * nothing to show, so it starts one after responding and the page polls; if that build failed, the reason comes back in `errors` (with no tickets) until a short backoff passes.
 */
export async function GET(): Promise<NextResponse> {
  const auth = await requireIdentity();
  if (auth.response) {
    return auth.response;
  }

  const [snapshot, following] = await Promise.all([getTrackerSnapshot(), getFollowedKeys(auth.identity.accountId)]);

  /* A first build that just failed is reported (and not retried by every poll) until its short backoff passes. */
  const firstBuildFailure = snapshot ? null : await getFirstBuildFailure();

  if (!snapshot && !firstBuildFailure) {
    after(async () => {
      try {
        /* Lock-protected, so a dozen browsers opening the page at once still build it once. */
        await refreshTrackerSnapshot();
      } catch (error) {
        console.warn("Tracker: first build failed; the next request retries.", error instanceof Error ? error.message : error);
      }
    });
  }

  const body: TrackerListResponse = {
    builtAt: snapshot?.builtAt ?? null,
    errors: snapshot?.errors ?? (firstBuildFailure ? [firstBuildFailure] : []),
    following,
    jiraBaseUrl: (process.env.JIRA_BASE_URL ?? "").trim().replace(/\/+$/, ""),
    me: auth.identity.accountId,
    tickets: snapshot?.tickets ?? [],
  };
  return NextResponse.json(body, { headers: NO_STORE });
}
