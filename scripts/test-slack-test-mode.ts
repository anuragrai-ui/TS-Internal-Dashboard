import { applySlackTestMode, neutralizeMentions } from "@/lib/slackTestMode";

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} failed: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assert(condition: boolean, label: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${label}`);
  }
}

function testRedirectsEveryPost(): void {
  console.log("\n--- Test: with a test channel set, every post goes there with a banner ---");
  const result = applySlackTestMode("C08CUMU0F6G", "Hi team", "C0C65L7L23D");
  assertEqual(result.channel, "C0C65L7L23D", "redirected to the test channel");
  assert(result.redirected, "flagged as redirected");
  assert(result.text.includes("would have posted to <#C08CUMU0F6G>"), "banner names the real destination");
  assert(result.text.endsWith("Hi team"), "original text kept");
  console.log("PASS");
}

function testOffWhenUnset(): void {
  console.log("\n--- Test: without a test channel, posts are untouched ---");
  assertEqual(applySlackTestMode("C08CUMU0F6G", "Hi <@U123>", null), { channel: "C08CUMU0F6G", redirected: false, text: "Hi <@U123>" }, "unchanged");
  console.log("PASS");
}

function testDirectTestChannelPost(): void {
  console.log("\n--- Test: a post aimed at the test channel itself gets no banner but still never pings ---");
  const result = applySlackTestMode("C0C65L7L23D", "Shadow <@U0ABC> <!here>", "C0C65L7L23D");
  assertEqual(result.channel, "C0C65L7L23D", "stays in the test channel");
  assert(!result.redirected, "not a redirect");
  assert(!result.text.includes("would have posted"), "no redirect banner");
  assert(!/<@|<!/.test(result.text), `mentions still defused: ${result.text}`);
  console.log("PASS");
}

function testMentionsNeverPing(): void {
  console.log("\n--- Test: every kind of Slack mention is defused in test mode ---");
  const text = neutralizeMentions("cc <@U0ABC> <@U0DEF|saro> <!here> <!channel> <!everyone> <!subteam^S01|eng-leads> plain @name");
  assert(!/<@|<!/.test(text), `no live mention tokens remain: ${text}`);
  assert(text.includes("@saro (mention suppressed)"), "labelled user mention stays readable");
  assert(text.includes("@U0ABC (mention suppressed)"), "bare user mention stays readable");
  assert(text.includes("@eng-leads (group mention suppressed)"), "user-group mention defused");
  const redirected = applySlackTestMode("C1", "<@U9> <!here>", "C2");
  assert(!/<@|<!here>/.test(redirected.text), "redirected text carries no live mentions");
  console.log("PASS");
}

try {
  testRedirectsEveryPost();
  testOffWhenUnset();
  testDirectTestChannelPost();
  testMentionsNeverPing();
  console.log("\nAll Slack test-mode tests passed.");
  process.exit(0);
} catch (error) {
  console.error("\nSlack test-mode test failed:", error);
  process.exit(1);
}
