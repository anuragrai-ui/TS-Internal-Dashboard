import { buildCommentAdfContent, MENTION_PLACEHOLDER } from "@/lib/jiraClient";

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} failed: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function testPlainTextNoMention(): void {
  console.log("\n--- Test: plain text with no mentionAccountId ---");

  const result = buildCommentAdfContent("Hi team, checking in.");

  assertEqual(result, [{ text: "Hi team, checking in.", type: "text" }], "plain text");
  console.log("PASS: plain text produces a single text node, unchanged.");
}

function testMentionInMiddle(): void {
  console.log("\n--- Test: placeholder in the middle of the text with a mentionAccountId ---");

  const text = `Hi ${MENTION_PLACEHOLDER}, could you take a look?`;
  const result = buildCommentAdfContent(text, "acc-123");

  assertEqual(
    result,
    [
      { text: "Hi ", type: "text" },
      { attrs: { id: "acc-123" }, type: "mention" },
      { text: ", could you take a look?", type: "text" },
    ],
    "mention in middle",
  );
  console.log("PASS: placeholder splits into text/mention/text with the correct accountId.");
}

function testMentionAtStart(): void {
  console.log("\n--- Test: placeholder at the very start of the text ---");

  const text = `${MENTION_PLACEHOLDER} following up on this.`;
  const result = buildCommentAdfContent(text, "acc-456");

  assertEqual(
    result,
    [
      { attrs: { id: "acc-456" }, type: "mention" },
      { text: " following up on this.", type: "text" },
    ],
    "mention at start",
  );
  console.log("PASS: no empty leading text node before the mention.");
}

function testPlaceholderWithoutMentionId(): void {
  console.log("\n--- Test: placeholder present but no mentionAccountId given ---");

  const text = `Hi ${MENTION_PLACEHOLDER}, checking in.`;
  const result = buildCommentAdfContent(text);

  assertEqual(
    result,
    [{ text, type: "text" }],
    "no accountId - falls back to plain text",
  );
  console.log("PASS: without an accountId, falls back to a single plain-text node (caller is responsible for not leaving a literal placeholder in the source text in this case).");
}

function main(): void {
  try {
    testPlainTextNoMention();
    testMentionInMiddle();
    testMentionAtStart();
    testPlaceholderWithoutMentionId();
    console.log("\nAll Jira comment ADF tests passed.");
    process.exit(0);
  } catch (error) {
    console.error("\nJira comment ADF test failed:", error);
    process.exit(1);
  }
}

main();
