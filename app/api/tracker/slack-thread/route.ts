import { NextResponse } from "next/server";

import { requireIdentity } from "@/lib/currentIdentity";
import { isIndexedConversation, loadConversationMessages } from "@/lib/tracker/slackIndex";

import type { SlackThreadResponse } from "@/lib/tracker/types";

const CHANNEL_ID = /^[CG][A-Z0-9]{6,}$/;
const SLACK_TS = /^\d{9,11}\.\d{1,6}$/;

/* GET /api/tracker/slack-thread?channel=&ts= - one Slack conversation's messages for the tracker's detail panel,
   read live (conversations.replies) and cached a minute. Only conversations the tracker has linked to a ticket
   are served, so this can't be used to read arbitrary channels the bot happens to be in. */
export async function GET(request: Request): Promise<NextResponse> {
  const auth = await requireIdentity();
  if (auth.response) {
    return auth.response;
  }

  const url = new URL(request.url);
  const channel = url.searchParams.get("channel") ?? "";
  const ts = url.searchParams.get("ts") ?? "";

  if (!CHANNEL_ID.test(channel) || !SLACK_TS.test(ts)) {
    return NextResponse.json({ error: "channel and ts must be a Slack channel id and message ts." }, { status: 400 });
  }

  if (!(await isIndexedConversation(channel, ts))) {
    return NextResponse.json({ error: "That Slack conversation isn't linked to any ticket.", messages: [] }, { status: 404 });
  }

  const thread: SlackThreadResponse = await loadConversationMessages(channel, ts);
  return NextResponse.json(thread);
}
