import { NextResponse } from "next/server";

import { requireIdentity } from "@/lib/currentIdentity";
import { getFollowedKeys, isTrackerKey, MAX_FOLLOWED_PER_PERSON, setFollowing } from "@/lib/tracker/follow";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

interface FollowBody {
  follow?: unknown;
}

/* POST { follow: true | false } - follow or unfollow a TS/CP key for yourself. Returns { following, keys }. */
export async function POST(request: Request, { params }: { params: Promise<{ key: string }> }): Promise<NextResponse> {
  const auth = await requireIdentity();
  if (auth.response) {
    return auth.response;
  }

  const { key: rawKey } = await params;
  const key = rawKey.toUpperCase();
  if (!isTrackerKey(key)) {
    return NextResponse.json({ error: "Expected a ticket key like TS-123 or CP-45." }, { headers: NO_STORE, status: 400 });
  }

  let body: FollowBody;
  try {
    body = (await request.json()) as FollowBody;
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { headers: NO_STORE, status: 400 });
  }
  if (typeof body.follow !== "boolean") {
    return NextResponse.json({ error: 'Send { "follow": true } or { "follow": false }.' }, { headers: NO_STORE, status: 400 });
  }

  try {
    const accountId = auth.identity.accountId;
    const changed = await setFollowing(accountId, key, body.follow);
    if (!changed) {
      return NextResponse.json(
        { error: body.follow ? `You can follow at most ${MAX_FOLLOWED_PER_PERSON} tickets.` : "Following is unavailable right now." },
        { headers: NO_STORE, status: 409 },
      );
    }
    const keys = await getFollowedKeys(accountId);
    return NextResponse.json({ following: keys.includes(key), keys }, { headers: NO_STORE });
  } catch (error) {
    console.warn("Tracker: follow update failed.", error);
    return NextResponse.json({ error: "Couldn't update following right now." }, { headers: NO_STORE, status: 503 });
  }
}
