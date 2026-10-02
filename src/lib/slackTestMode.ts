/**
 * Slack test mode. While SLACK_TEST_CHANNEL is set, EVERY message the app
 * posts goes to that one channel instead of its real destination, with a
 * banner saying where it would have gone, and with every mention defused so
 * nobody is pinged. Lets the team click Send on real drafts (SLA-breach
 * alerts, the cron summary, later the escalation pilot) and see exactly what
 * a pod channel would receive. Unset it to go live.
 */
export function getSlackTestChannel(): string | null {
  const channel = process.env.SLACK_TEST_CHANNEL?.trim();
  return channel ? channel : null;
}

/* <@U123>, <@U123|name>, <!here>, <!channel>, <!everyone>, <!subteam^S123> -> visible text that notifies nobody. */
export function neutralizeMentions(text: string): string {
  return text
    .replace(/<@([A-Z0-9]+)(?:\|([^>]*))?>/g, (_match, id: string, label?: string) => `@${label || id} (mention suppressed)`)
    .replace(/<!subteam\^([A-Z0-9]+)(?:\|([^>]*))?>/g, (_match, id: string, label?: string) => `@${label || id} (group mention suppressed)`)
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, (_match, word: string) => `@${word} (suppressed)`);
}

export function applySlackTestMode(
  channel: string,
  text: string,
  testChannel: string | null = getSlackTestChannel(),
): { channel: string; redirected: boolean; text: string } {
  if (!testChannel) {
    return { channel, redirected: false, text };
  }

  /* Already aimed at the test channel (Settings -> Slack's test button, the escalation shadow run):
     nothing to redirect, but mentions stay defused. */
  if (channel === testChannel) {
    return { channel, redirected: false, text: neutralizeMentions(text) };
  }

  return {
    channel: testChannel,
    redirected: true,
    text: `:test_tube: *Test mode* - would have posted to <#${channel}>. Mentions are suppressed.\n\n${neutralizeMentions(text)}`,
  };
}
