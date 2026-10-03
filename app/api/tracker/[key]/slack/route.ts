import { NextResponse } from "next/server";

import { requireIdentity } from "@/lib/currentIdentity";
import { invalidateTrackerDetail } from "@/lib/tracker/detail";
import { extractSlackPermalinks, linkConversation } from "@/lib/tracker/slackIndex";
import { isTrackableChannel } from "@/lib/tracker/slackParse";

import type { SlackConversationRef } from "@/lib/tracker/types";

const TICKET_KEY = /^(TS|CP)-\d+$/;

interface LinkSlackRequestBody {
  permalink?: unknown;
}

/* POST /api/tracker/<KEY>/slack {permalink} - "Link a Slack thread" on a ticket: attaches the conversation the
   pasted link points into (its thread root, even for a link to a reply). Nothing is read from or written to Slack. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ key: string }> },
): Promise<NextResponse> {
  const auth = await requireIdentity();
  if (auth.response) {
    return auth.response;
  }

  const key = (await params).key.trim().toUpperCase();
  if (!TICKET_KEY.test(key)) {
    return NextResponse.json({ error: "Not a TS or CP ticket key." }, { status: 400 });
  }

  let body: LinkSlackRequestBody;
  try {
    body = (await request.json()) as LinkSlackRequestBody;
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  const link = typeof body.permalink === "string" ? extractSlackPermalinks(body.permalink.slice(0, 2_000))[0] : undefined;
  if (!link) {
    return NextResponse.json({ error: "Paste a Slack message link (Copy link in Slack: https://<workspace>.slack.com/archives/...)." }, { status: 400 });
  }

  if (!isTrackableChannel(link.channel)) {
    return NextResponse.json({ error: "That channel can't be tracked (direct messages and excluded channels are never indexed)." }, { status: 400 });
  }

  const conversation = await linkConversation({ channel: link.channel, rootTs: link.threadTs ?? link.ts, source: "manual", ticketKeys: [key] });
  if (!conversation) {
    return NextResponse.json({ error: "Couldn't save the link - the conversation index is unavailable." }, { status: 503 });
  }

  /* The detail panel reloads right after this call; without this it would serve the minute-old copy without the new thread. */
  await invalidateTrackerDetail(key);

  const response: { conversation: SlackConversationRef } = { conversation };
  return NextResponse.json(response);
}
