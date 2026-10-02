import { after, NextResponse } from "next/server";

import { requireIdentity } from "@/lib/currentIdentity";
import { maybeRunEscalations } from "@/lib/escalation/runner";
import { maybeSyncJiraNotifications } from "@/lib/notifications/jiraSync";
import { getFeedVersion, listNotifications } from "@/lib/notifications/store";

import type { FeedScope } from "@/lib/notifications/store";

export const dynamic = "force-dynamic";
/* The response goes out at once; this covers the Jira sync and escalation run that follow it (see below). */
export const maxDuration = 120;

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * The bell's poll: GET ?scope=mine|team&limit=&before=<score>&v=<version>.
 *
 * With `v` and no `before`, an unchanged feed answers { unchanged: true }
 * from one Redis read, which is what nearly every 30-second poll is.
 *
 * Every poll also offers to run the Jira notification sync (at most once a
 * minute across all browsers) and the escalation shadow run (at most once
 * every 10 minutes, only while it's switched on). Both run after the
 * response, so a poll never waits on Jira. That's what keeps things live on
 * Vercel Hobby, where cron runs only once a day.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const auth = await requireIdentity();
  if (auth.response) {
    return auth.response;
  }

  const params = new URL(request.url).searchParams;
  const scope: FeedScope = params.get("scope") === "team" ? "team" : "mine";
  const limit = Number(params.get("limit") ?? 20);
  const beforeRaw = params.get("before");
  const before = beforeRaw === null || beforeRaw === "" ? undefined : Number(beforeRaw);
  const knownVersion = params.get("v");

  after(async () => {
    try {
      await maybeSyncJiraNotifications();
    } catch (error) {
      console.warn("Jira notification sync failed; the next poll retries the same window.", error instanceof Error ? error.message : error);
    }
    try {
      await maybeRunEscalations();
    } catch (error) {
      console.warn("Escalation shadow run failed; the next one recomputes everything from Jira.", error instanceof Error ? error.message : error);
    }
  });

  try {
    if (knownVersion && before === undefined) {
      const version = await getFeedVersion(auth.identity.accountId, scope);
      if (version === knownVersion) {
        return NextResponse.json({ unchanged: true, version }, { headers: NO_STORE });
      }
    }

    const page = await listNotifications(auth.identity.accountId, {
      before: before !== undefined && Number.isFinite(before) ? before : undefined,
      limit: Number.isFinite(limit) ? limit : 20,
      scope,
    });
    return NextResponse.json(page, { headers: NO_STORE });
  } catch (error) {
    console.warn("Failed to read notifications.", error);
    return NextResponse.json({ error: "Notifications are unavailable right now." }, { headers: NO_STORE, status: 503 });
  }
}
