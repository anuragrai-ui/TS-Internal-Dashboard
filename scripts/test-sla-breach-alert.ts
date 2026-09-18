import { buildSlaBreachAlert, isEligibleForSlaBreachAlert } from "@/lib/slaBreachAlert";
import type { SlaFollowUpCandidate } from "@/lib/slaFollowup";
import type { FormattedIssue } from "@/lib/jiraClient";

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} failed: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function makeIssue(overrides: Partial<FormattedIssue> = {}): FormattedIssue {
  return {
    assignee: "Some Agent",
    attachment_count: 0,
    attachments: [],
    comment_count: 0,
    components: [],
    key: "TS-9001",
    labels: [],
    latest_comment_created: "",
    priority: "High",
    priority_sort: 2,
    project: "TS",
    reporter: "A Client",
    reporter_is_external: true,
    status: "Waiting for Client",
    status_category: "indeterminate",
    subtask_count: 0,
    summary: "Test issue",
    updated: new Date().toISOString(),
    url: "https://certifyos.atlassian.net/browse/TS-9001",
    ...overrides,
  };
}

function makeCandidate(overrides: Partial<SlaFollowUpCandidate> = {}): SlaFollowUpCandidate {
  return {
    daysSinceLastActivity: 6,
    isResolved: false,
    issue: makeIssue({ linked_cp_issue: { isDone: false, key: "CP-1", status: "Backlog" } }),
    missedSla: true,
    reason: "cp_not_worked",
    stage: 1,
    ...overrides,
  };
}

function testEligibleOnlyWhenMissedSlaAndCpNotWorked(): void {
  console.log("\n--- Test: eligible only when missedSla AND reason is cp_not_worked ---");

  assertEqual(isEligibleForSlaBreachAlert(makeCandidate()), true, "missedSla + cp_not_worked should be eligible");
  assertEqual(
    isEligibleForSlaBreachAlert(makeCandidate({ missedSla: false })),
    false,
    "not yet missed our own SLA - too early to alert Product",
  );
  assertEqual(
    isEligibleForSlaBreachAlert(makeCandidate({ reason: "no_reporter_response" })),
    false,
    "client silence has no Product-side fix - tagging a PM wouldn't help",
  );
  assertEqual(
    isEligibleForSlaBreachAlert(
      makeCandidate({ issue: makeIssue({ linked_cp_issue: undefined }), reason: "cp_not_worked" }),
    ),
    false,
    "no linked CP means nothing to route to a POD",
  );

  console.log("PASS: eligibility requires both conditions, not either alone.");
}

async function testBuildsAlertRoutedToLinkedCpsPod(): Promise<void> {
  console.log("\n--- Test: routes to the LINKED CP's pod, not the TS ticket's own pod ---");

  const candidate = makeCandidate({
    issue: makeIssue({ linked_cp_issue: { isDone: false, key: "CP-500", status: "Backlog" }, pod: "Outreach" }),
  });

  const getIssue = (key: string): Promise<FormattedIssue | null> =>
    Promise.resolve(key === "CP-500" ? makeIssue({ key: "CP-500", pod: "Credentialing", project: "CP" }) : null);
  const findSlackUserId = (): Promise<string | null> => Promise.resolve("U12345");

  const draft = await buildSlaBreachAlert(candidate, getIssue, findSlackUserId);

  assertEqual(draft?.podName, "Credentialing", "should route by the linked CP's pod (Credentialing), not the TS ticket's own pod (Outreach)");
  assertEqual(draft?.channel, "C08CUMU0F6G", "Credentialing's own channel should be used");
  assertEqual(draft?.pmDisplayName, "Prashanth Venkataraman", "Credentialing's PM should be tagged");
  assertEqual(draft?.text.includes("<@U12345>"), true, "a resolved Slack user id should become a real @-mention");

  console.log("PASS: alert routes to the blocking CP's own POD, with a real Slack mention when resolved.");
}

async function testFallsBackToPlainTextMentionWhenSlackLookupFails(): Promise<void> {
  console.log("\n--- Test: an unresolved Slack user degrades to a plain-text @name, not a broken message ---");

  const candidate = makeCandidate({
    issue: makeIssue({ linked_cp_issue: { isDone: false, key: "CP-500", status: "Backlog" } }),
  });

  const getIssue = (): Promise<FormattedIssue | null> =>
    Promise.resolve(makeIssue({ key: "CP-500", pod: "Credentialing", project: "CP" }));
  const findSlackUserId = (): Promise<string | null> => Promise.resolve(null);

  const draft = await buildSlaBreachAlert(candidate, getIssue, findSlackUserId);

  assertEqual(
    draft?.text.includes("@Prashanth Venkataraman"),
    true,
    "no Slack match should still name the PM as plain text, not silently drop them",
  );

  console.log("PASS: a failed Slack lookup never blocks the alert or produces a broken/empty mention.");
}

async function testUnmappedPodFallsBackToTechnicalSupportChannel(): Promise<void> {
  console.log("\n--- Test: a POD with no channel mapping falls back to the Technical Support channel ---");

  const candidate = makeCandidate({
    issue: makeIssue({ linked_cp_issue: { isDone: false, key: "CP-999", status: "Backlog" } }),
  });

  const getIssue = (): Promise<FormattedIssue | null> =>
    Promise.resolve(makeIssue({ key: "CP-999", pod: "Some Brand New Pod", project: "CP" }));
  const findSlackUserId = (): Promise<string | null> => Promise.resolve(null);

  const draft = await buildSlaBreachAlert(candidate, getIssue, findSlackUserId);

  assertEqual(draft?.channel, "C07U9C0EPEH", "an unrecognized pod should fall back to Technical Support");
  assertEqual(draft?.text.includes("@team") || draft?.text.includes("team could you"), true, "no PM known for this pod - should address the team generically, not invent a name");

  console.log("PASS: an unmapped POD still produces a postable alert via the fallback channel.");
}

async function main(): Promise<void> {
  try {
    testEligibleOnlyWhenMissedSlaAndCpNotWorked();
    await testBuildsAlertRoutedToLinkedCpsPod();
    await testFallsBackToPlainTextMentionWhenSlackLookupFails();
    await testUnmappedPodFallsBackToTechnicalSupportChannel();
    console.log("\nAll SLA-breach-alert tests passed.");
    process.exit(0);
  } catch (error) {
    console.error("\nSLA-breach-alert test failed:", error);
    process.exit(1);
  }
}

main();
