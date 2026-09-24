import type { CommentAuthorship } from "@/lib/jiraClient";
import { computeReplyTracking } from "@/lib/replyTracking";
import { addDays, bucketByWeek, mondayOf } from "@/lib/weeklyClosures";
import type { ClosedTicket } from "@/lib/weeklyClosures";

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} failed: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

const REPORTER = "reporter-1";
const AGENT = "agent-1";

function comment(authorAccountId: string, daysAgo: number, authorAccountType = "atlassian"): CommentAuthorship {
  return { authorAccountId, authorAccountType, created: daysAgoIso(daysAgo) };
}

// --- computeReplyTracking (src/lib/replyTracking.ts) ---

function testCountsOurFollowUpsSinceReporterReply(): void {
  console.log("\n--- Test: counts our comments since the reporter's last reply ---");

  const tracking = computeReplyTracking(
    [comment(AGENT, 20), comment(REPORTER, 15), comment(AGENT, 9), comment(AGENT, 5)],
    REPORTER,
  );

  assertEqual(tracking.unansweredFollowUps, 2, "two follow-ups after the reporter's reply");
  assertEqual(Math.round(tracking.daysSinceLastFollowUp ?? -1), 5, "last follow-up 5 days ago");
  assertEqual(Math.round(tracking.daysSinceReporterReply ?? -1), 15, "reporter last replied 15 days ago");

  console.log("PASS");
}

function testReporterRepliedLast(): void {
  console.log("\n--- Test: reporter replied last -> 0 unanswered, but last follow-up still known ---");

  const tracking = computeReplyTracking([comment(AGENT, 6), comment(REPORTER, 2)], REPORTER);

  assertEqual(tracking.unansweredFollowUps, 0, "nothing unanswered");
  assertEqual(Math.round(tracking.daysSinceLastFollowUp ?? -1), 6, "our last comment is still reported");
  assertEqual(Math.round(tracking.daysSinceReporterReply ?? -1), 2, "reporter replied 2 days ago");

  console.log("PASS");
}

function testIgnoresAutomationAndCustomerAccounts(): void {
  console.log("\n--- Test: Jira automation ('app') comments don't count as follow-ups ---");

  const tracking = computeReplyTracking(
    [comment(REPORTER, 10), comment(AGENT, 8), comment("automation", 7, "app"), comment("automation", 1, "app")],
    REPORTER,
  );

  assertEqual(tracking.unansweredFollowUps, 1, "only the human follow-up counts");
  assertEqual(Math.round(tracking.daysSinceLastFollowUp ?? -1), 8, "automation doesn't reset the last follow-up date");

  console.log("PASS");
}

function testBurstOfCommentsIsOneFollowUp(): void {
  console.log("\n--- Test: a burst of comments within 24h counts as one follow-up round ---");

  const base = Date.now() - 10 * 86_400_000;
  const at = (hoursAfterBase: number, author: string): CommentAuthorship => ({
    authorAccountId: author,
    authorAccountType: "atlassian",
    created: new Date(base + hoursAfterBase * 3_600_000).toISOString(),
  });

  const tracking = computeReplyTracking(
    [at(0, REPORTER), at(1, AGENT), at(1.2, AGENT), at(1.5, AGENT), at(5, "agent-2"), at(72, AGENT)],
    REPORTER,
  );

  assertEqual(tracking.unansweredFollowUps, 2, "4 comments the same day + 1 three days later = 2 rounds");

  console.log("PASS");
}

function testReporterNeverCommented(): void {
  console.log("\n--- Test: reporter never commented -> every team comment is unanswered ---");

  const tracking = computeReplyTracking([comment(AGENT, 8), comment("agent-2", 4)], REPORTER);


  assertEqual(tracking.unansweredFollowUps, 2, "both teammates' follow-ups count");
  assertEqual(tracking.daysSinceReporterReply, null, "no reporter reply at all");

  const empty = computeReplyTracking([], REPORTER);
  assertEqual(empty.unansweredFollowUps, 0, "no comments -> nothing unanswered");
  assertEqual(empty.daysSinceLastFollowUp, null, "no comments -> no last follow-up");

  console.log("PASS");
}

// --- weekly bucketing (src/lib/weeklyClosures.ts) ---

function testMondayOf(): void {
  console.log("\n--- Test: mondayOf / addDays ---");

  assertEqual(mondayOf("2026-09-24"), "2026-09-21", "Thursday -> that week's Monday");
  assertEqual(mondayOf("2026-09-21"), "2026-09-21", "Monday is its own week start");
  assertEqual(mondayOf("2026-09-27"), "2026-09-21", "Sunday belongs to the week that started Monday");
  assertEqual(addDays("2026-09-21", -7), "2026-09-14", "addDays goes back a week");

  console.log("PASS");
}

function testBucketByWeek(): void {
  console.log("\n--- Test: bucketByWeek counts closed + from-Product per Monday-start week ---");

  const ticket = (closedAt: string, fromProduct: boolean): ClosedTicket => ({
    closedAt,
    fromProduct,
    key: `TS-${closedAt}`,
    reporter: "",
    url: "",
  });

  const buckets = bucketByWeek(
    [
      ticket("2026-09-22T10:00:00.000-0700", true),
      ticket("2026-09-24T08:21:39.541-0700", false),
      ticket("2026-09-15T09:00:00.000-0700", true),
      ticket("2026-08-01T09:00:00.000-0700", true), // before the window - ignored
      ticket("", true), // no close date - ignored
    ],
    "2026-09-07",
    3,
  );

  assertEqual(
    buckets.map((bucket) => [bucket.weekStart, bucket.closed, bucket.fromProduct]),
    [
      ["2026-09-07", 0, 0],
      ["2026-09-14", 1, 1],
      ["2026-09-21", 2, 1],
    ],
    "per-week counts, empty weeks kept as zero",
  );

  console.log("PASS");
}

function main(): void {
  try {
    testCountsOurFollowUpsSinceReporterReply();
    testReporterRepliedLast();
    testIgnoresAutomationAndCustomerAccounts();
    testBurstOfCommentsIsOneFollowUp();
    testReporterNeverCommented();
    testMondayOf();
    testBucketByWeek();
    console.log("\nAll reply-tracking / weekly-closure tests passed.");
    process.exit(0);
  } catch (error) {
    console.error("\nReply-tracking test failed:", error);
    process.exit(1);
  }
}

main();
