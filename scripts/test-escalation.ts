import { analyzeEscalationRisk } from "@/lib/openrouterEscalation";
import { getLocalHeuristicAnalysis } from "@/lib/escalationHeuristics";
import type { FormattedIssue, TicketCommentContext } from "@/lib/jiraClient";

function makeIssues(prefix: string): FormattedIssue[] {
  return [
  {
    action_date: "2026-07-01",
    assignee: "Anurag Rai",
    attachment_count: 2,
    comment_count: 3,
    components: ["Backend"],
    key: `${prefix}-101`,
    labels: ["urgent", "production"],
    latest_comment_created: "",
    priority: "Highest",
    priority_sort: 1,
    project: "TS",
    reporter: "Client A",
    severity: "Critical",
    status: "In Progress",
    subtask_count: 1,
    summary: "Production outage - urgent escalation required",
    updated: "2026-07-01T10:00:00.000Z",
    url: `https://certifyos.atlassian.net/browse/${prefix}-101`,
  },
  {
    action_date: "2026-07-02",
    assignee: "Anurag Rai",
    attachment_count: 0,
    comment_count: 1,
    components: ["Frontend"],
    key: `${prefix}-102`,
    labels: ["waiting"],
    latest_comment_created: "",
    priority: "Medium",
    priority_sort: 3,
    project: "TS",
    reporter: "Product Team",
    severity: "Minor",
    status: "Waiting for Product",
    subtask_count: 0,
    summary: "Need clarification on feature requirement",
    updated: "2026-07-02T09:00:00.000Z",
    url: `https://certifyos.atlassian.net/browse/${prefix}-102`,
  },
  {
    action_date: "2026-07-02",
    assignee: "Anurag Rai",
    attachment_count: 0,
    comment_count: 0,
    components: [],
    key: `${prefix}-103`,
    labels: [],
    latest_comment_created: "",
    priority: "Low",
    priority_sort: 5,
    project: "CP",
    reporter: "Internal",
    severity: "Trivial",
    status: "Todo",
    subtask_count: 0,
    summary: "Routine documentation update",
    updated: "2026-07-02T08:00:00.000Z",
    url: `https://certifyos.atlassian.net/browse/${prefix}-103`,
  },
  ];
}

function makeComments(prefix: string): Record<string, TicketCommentContext[]> {
  return {
    [`${prefix}-101`]: [
      {
        author: "Client A",
        body: "This is blocking our entire team. We need an ETA ASAP or we will escalate.",
        created: "2026-07-01T09:00:00.000Z",
      },
    ],
    [`${prefix}-102`]: [
      {
        author: "Product Team",
        body: "Can you follow up on the requirement we discussed?",
        created: "2026-07-02T08:00:00.000Z",
      },
    ],
    [`${prefix}-103`]: [],
  };
}

const makeMockGetComments = (prefix: string) => {
  const comments = makeComments(prefix);
  return (issueKey: string): Promise<TicketCommentContext[]> =>
    Promise.resolve(comments[issueKey] ?? []);
};

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

function requireThree<T>(items: T[]): [T, T, T] {
  if (items.length !== 3) {
    throw new Error(`Expected exactly 3 items, got ${items.length}`);
  }
  return [items[0]!, items[1]!, items[2]!];
}

function testHeuristics(): void {
  console.log("\n--- Test: Local heuristics on sample issues ---");

  const issues = makeIssues("HEUR");
  const comments = makeComments("HEUR");

  const [immediateIssue, watchIssue, normalIssue] = requireThree(issues);

  const immediate = getLocalHeuristicAnalysis(immediateIssue, comments["HEUR-101"]);
  assertEqual(immediate.risk_level, "immediate", "HEUR-101 should be immediate");
  assert(immediate.risk_score >= 65, "HEUR-101 score should be >= 65");

  const watch = getLocalHeuristicAnalysis(watchIssue, comments["HEUR-102"]);
  assertEqual(watch.risk_level, "watch", "HEUR-102 should be watch");
  assert(watch.risk_score >= 25, "HEUR-102 score should be >= 25");

  const normal = getLocalHeuristicAnalysis(normalIssue, comments["HEUR-103"]);
  assertEqual(normal.risk_level, "normal", "HEUR-103 should be normal");
  assert(normal.risk_score < 25, "HEUR-103 score should be < 25");

  console.log("PASS: Heuristic risk levels match expectations.");
}

async function testDisabledOpenRouter(): Promise<void> {
  console.log("\n--- Test: analyzeEscalationRisk with OpenRouter disabled ---");

  process.env.OPENROUTER_ESCALATION_ENABLED = "false";
  const prefix = "DISABLED";
  const issues = makeIssues(prefix);
  const analyses = await analyzeEscalationRisk(issues, 12, makeMockGetComments(prefix));

  assertEqual(analyses.length, 3, "Should return 3 analyses");
  const [disabledA, disabledB, disabledC] = requireThree(analyses);
  assertEqual(disabledA.risk_level, "immediate", `${prefix}-101 should be immediate`);
  assertEqual(disabledB.risk_level, "watch", `${prefix}-102 should be watch`);
  assertEqual(disabledC.risk_level, "normal", `${prefix}-103 should be normal`);
  assert(analyses.every((a) => a.key && a.next_action && a.reason), "Every analysis should have required fields");

  console.log("PASS: Disabled OpenRouter path returns heuristic analyses.");
}

async function testOpenRouter503Fallback(): Promise<void> {
  console.log("\n--- Test: OpenRouter 503 failure falls back to heuristics ---");

  process.env.OPENROUTER_ESCALATION_ENABLED = "true";
  process.env.OPENROUTER_API_KEY = "fake-key";
  process.env.OPENROUTER_MAX_RETRIES = "2";
  process.env.OPENROUTER_BASE_DELAY_MS = "50";
  process.env.OPENROUTER_REQUEST_TIMEOUT_MS = "1000";

  const originalFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(new Response(null, { status: 503, statusText: "Service Unavailable" }));

  try {
    const prefix = "503";
    const issues = makeIssues(prefix);
    const analyses = await analyzeEscalationRisk(issues, 12, makeMockGetComments(prefix));

    assertEqual(analyses.length, 3, "Should return 3 fallback analyses");
    const [fallbackA, fallbackB, fallbackC] = requireThree(analyses);
    assertEqual(fallbackA.risk_level, "immediate", `${prefix}-101 fallback should be immediate`);
    assertEqual(fallbackB.risk_level, "watch", `${prefix}-102 fallback should be watch`);
    assertEqual(fallbackC.risk_level, "normal", `${prefix}-103 fallback should be normal`);

    console.log("PASS: 503 errors gracefully fall back to local heuristics.");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testOpenRouterSuccess(): Promise<void> {
  console.log("\n--- Test: OpenRouter success path parses response ---");

  process.env.OPENROUTER_ESCALATION_ENABLED = "true";
  process.env.OPENROUTER_API_KEY = "fake-key";
  process.env.OPENROUTER_MAX_RETRIES = "2";
  process.env.OPENROUTER_BASE_DELAY_MS = "50";
  process.env.OPENROUTER_REQUEST_TIMEOUT_MS = "1000";

  const prefix = "OK";
  const originalFetch = globalThis.fetch;
  let fetchCalled = 0;
  const mockFetch: typeof fetch = () => {
    fetchCalled += 1;
    return Promise.resolve(new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify([
                {
                  key: `${prefix}-101`,
                  next_action: "Escalate to on-call immediately.",
                  reason: "Production outage reported by client.",
                  risk_level: "immediate",
                  risk_score: 95,
                },
                {
                  key: `${prefix}-102`,
                  next_action: "Ping product team for clarification.",
                  reason: "Waiting for product requirement details.",
                  risk_level: "watch",
                  risk_score: 45,
                },
                {
                  key: `${prefix}-103`,
                  next_action: "Handle in normal queue.",
                  reason: "Low priority routine task.",
                  risk_level: "normal",
                  risk_score: 5,
                },
              ]),
              reasoning_details: [],
            },
          },
        ],
      }),
      { status: 200, statusText: "OK" },
    ));
  };
  globalThis.fetch = mockFetch;

  try {
    const issues = makeIssues(prefix);
    const analyses = await analyzeEscalationRisk(issues, 12, makeMockGetComments(prefix));

    assert(fetchCalled > 0, "OpenRouter API should have been called");
    assertEqual(analyses.length, 3, "Should return 3 analyses");
    const [successA, successB, successC] = requireThree(analyses);
    assertEqual(successA.key, `${prefix}-101`, `${prefix}-101 key matches`);
    assertEqual(successA.risk_level, "immediate", `${prefix}-101 should be immediate`);
    assertEqual(successA.risk_score, 95, `${prefix}-101 score should be 95`);
    assertEqual(successB.risk_level, "watch", `${prefix}-102 should be watch`);
    assertEqual(successB.risk_score, 45, `${prefix}-102 score should be 45`);
    assertEqual(successC.risk_level, "normal", `${prefix}-103 should be normal`);
    assertEqual(successC.risk_score, 5, `${prefix}-103 score should be 5`);

    console.log("PASS: OpenRouter success path parses and returns analyses.");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function main(): Promise<void> {
  try {
    testHeuristics();
    await testDisabledOpenRouter();
    await testOpenRouter503Fallback();
    await testOpenRouterSuccess();
    console.log("\nAll escalation tests passed.");
    process.exit(0);
  } catch (error) {
    console.error("\nEscalation test failed:", error);
    process.exit(1);
  }
}

main();
