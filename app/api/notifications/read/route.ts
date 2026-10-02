import { NextResponse } from "next/server";

import { requireIdentity } from "@/lib/currentIdentity";
import { getFeedVersion, markNotificationsRead } from "@/lib/notifications/store";

interface MarkReadBody {
  all?: unknown;
  ids?: unknown;
}

/* POST { ids: [...] } marks those read; POST { all: true } marks everything in your feed read. Only ever your own read state. */
export async function POST(request: Request): Promise<NextResponse> {
  const auth = await requireIdentity();
  if (auth.response) {
    return auth.response;
  }

  let body: MarkReadBody;
  try {
    body = (await request.json()) as MarkReadBody;
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  const ids = Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === "string") : [];

  if (body.all !== true && ids.length === 0) {
    return NextResponse.json({ error: 'Send { "all": true } or a non-empty "ids" array.' }, { status: 400 });
  }

  try {
    const accountId = auth.identity.accountId;
    const unreadCount = await markNotificationsRead(accountId, body.all === true ? { all: true } : { ids });
    return NextResponse.json({ unreadCount, version: await getFeedVersion(accountId, "mine") });
  } catch (error) {
    console.warn("Failed to mark notifications read.", error);
    return NextResponse.json({ error: "Couldn't update read state right now." }, { status: 503 });
  }
}
