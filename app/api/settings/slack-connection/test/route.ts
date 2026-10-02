import { NextResponse } from "next/server";

import { requireIdentity } from "@/lib/currentIdentity";
import { postSlackMessage } from "@/lib/slackApi";
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

  const posted = await postSlackMessage(
    testChannel,
    `Test message sent by ${auth.identity.displayName} from Settings -> Slack in the TS dashboard. Add a reaction to this message to check that inbound events arrive - it will show up under "Recent events received".`,
  );

  return posted
    ? NextResponse.json({ channel: testChannel, sent: true })
    : NextResponse.json({ error: "Slack refused the message - check that the bot is invited to the test channel." }, { status: 502 });
}
