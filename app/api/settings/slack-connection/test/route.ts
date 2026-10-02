import { NextResponse } from "next/server";

import { requireIdentity } from "@/lib/currentIdentity";
import { rememberPostedSlackMessage } from "@/lib/notifications/slackThreads";
import { postSlackMessageDetailed } from "@/lib/slackApi";
import { getSlackTestChannel } from "@/lib/slackTestMode";

/* "Send test message" on Settings -> Slack. Only ever posts while test mode
   is on, and only to the test channel - this button can never reach a real
   pod channel. */
export async function POST(): Promise<NextResponse> {
  const auth = await requireIdentity();
  if (auth.response) {
    return auth.response;
  }

  const testChannel = getSlackTestChannel();
  if (!testChannel) {
    return NextResponse.json(
      { error: "Test mode is off (SLACK_TEST_CHANNEL is not set), so the test button is disabled - it never posts to real channels." },
      { status: 409 },
    );
  }

  const posted = await postSlackMessageDetailed(
    testChannel,
    `Test message sent by ${auth.identity.displayName} from Settings -> Slack in the TS dashboard. Add a reaction to this message, or reply in its thread - both show up under "Recent events received" and in your notification bell.`,
  );

  if (!posted) {
    return NextResponse.json({ error: "Slack refused the message - check that the bot is invited to the test channel." }, { status: 502 });
  }

  /* So a reply or reaction on the test message lands in the sender's notification bell - an end-to-end check of the whole loop. */
  await rememberPostedSlackMessage(posted.channel, posted.ts, {
    audience: [auth.identity.accountId],
    kind: "test",
    label: "your Slack test message",
    ticketKeys: [],
    threadTs: posted.ts,
  });

  return NextResponse.json({ channel: testChannel, sent: true });
}
