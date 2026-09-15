import { analyzeEscalationRisk } from "@/lib/openrouterEscalation";
import type { TicketEscalationAnalysis } from "@/lib/openrouterEscalation";
import { getLocalHeuristicAnalysis } from "@/lib/escalationHeuristics";
import { getFallbackAnalysis } from "@/lib/mlEscalationModel";
import type { FormattedIssue, TicketCommentContext } from "@/lib/jiraClient";

function makeIssues(prefix: string): FormattedIssue[] {
  return [
  {
    action_date: "2026-07-01",
    assignee: "Anurag Rai",
    attachment_count: 2,
    attachments: [],
    reporter_is_external: false,
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
    attachments: [],
    reporter_is_external: false,
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
    attachments: [],
    reporter_is_external: false,
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

async function captureWarnings<T>(fn: () => Promise<T>): Promise<{ result: T; warnings: string[] }> {
  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]): void => {
    warnings.push(args.map(String).join(" "));
    originalWarn(...args);
  };

  try {
    const result = await fn();
    return { result, warnings };
  } finally {
    console.warn = originalWarn;
  }
}

function assertValidAnalyses(
  analyses: TicketEscalationAnalysis[],
  issues: FormattedIssue[],
  label: string,
): void {
  assertEqual(analyses.length, issues.length, `${label}: analysis count should match issue count`);

  analyses.forEach((analysis, index) => {
    const issue = issues[index]!;
    assertEqual(analysis.key, issue.key, `${label}: ${issue.key} key should match`);
    assert(
      ["immediate", "watch", "normal", "unknown"].includes(analysis.risk_level),
      `${label}: ${issue.key} risk_level should be a known value, got ${analysis.risk_level}`,
    );
    assert(
      Number.isFinite(analysis.risk_score) && analysis.risk_score >= 0 && analysis.risk_score <= 100,
      `${label}: ${issue.key} risk_score should be within [0, 100], got ${analysis.risk_score}`,
    );
    assert(Boolean(analysis.next_action.trim()), `${label}: ${issue.key} next_action should be non-empty`);
    assert(Boolean(analysis.reason.trim()), `${label}: ${issue.key} reason should be non-empty`);
  });
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

async function testMlFallbackModel(): Promise<void> {
  console.log("\n--- Test: ML escalation model produces valid, input-sensitive output ---");
  console.log("(ML_ESCALATION_ENABLED is off by default in production; this test opts in locally to verify the model itself still loads and runs.)");

  const savedEnabled = process.env.ML_ESCALATION_ENABLED;
  process.env.ML_ESCALATION_ENABLED = "true";

  try {
    const prefix = "ML";
    const issues = makeIssues(prefix);
    const comments = makeComments(prefix);
    const [busyIssue, , quietIssue] = requireThree(issues);

    const { result: busyAnalysis, warnings: busyWarnings } = await captureWarnings(() =>
      getFallbackAnalysis(busyIssue, comments[`${prefix}-101`]),
    );
    const { result: quietAnalysis, warnings: quietWarnings } = await captureWarnings(() =>
      getFallbackAnalysis(quietIssue, comments[`${prefix}-103`]),
    );

    for (const [issueKey, warnings] of [
      [busyIssue.key, busyWarnings],
      [quietIssue.key, quietWarnings],
    ] as const) {
      assert(
        warnings.every((line) => !line.includes("ML escalation model unavailable")),
        `ML model should load and score ${issueKey} without falling back to heuristics (got: ${warnings.join(" | ") || "no warnings"})`,
      );
    }

    assertValidAnalyses([busyAnalysis, quietAnalysis], [busyIssue, quietIssue], "ML model");
    assert(
      busyAnalysis.risk_score !== quietAnalysis.risk_score,
      "ML model should score structurally different tickets differently, not return a constant",
    );

    console.log(
      `PASS: ML model scored ${busyIssue.key} -> ${busyAnalysis.risk_level} (${busyAnalysis.risk_score}), ` +
        `${quietIssue.key} -> ${quietAnalysis.risk_level} (${quietAnalysis.risk_score}).`,
    );
  } finally {
    if (savedEnabled === undefined) {
      delete process.env.ML_ESCALATION_ENABLED;
    } else {
      process.env.ML_ESCALATION_ENABLED = savedEnabled;
    }
  }
}

async function testMlDisabledByDefault(): Promise<void> {
  console.log("\n--- Test: ML model is off by default, fallback chain uses local heuristics ---");

  const savedEnabled = process.env.ML_ESCALATION_ENABLED;
  delete process.env.ML_ESCALATION_ENABLED;

  try {
    const prefix = "MLOFF";
    const issues = makeIssues(prefix);
    const comments = makeComments(prefix);
    const [immediateIssue, watchIssue, normalIssue] = requireThree(issues);

    const analyses = await Promise.all([
      getFallbackAnalysis(immediateIssue, comments[`${prefix}-101`]),
      getFallbackAnalysis(watchIssue, comments[`${prefix}-102`]),
      getFallbackAnalysis(normalIssue, comments[`${prefix}-103`]),
    ]);
    const [a, b, c] = requireThree(analyses);

    assertEqual(a.risk_level, "immediate", `${prefix}-101 should match the rule-based heuristic`);
    assertEqual(b.risk_level, "watch", `${prefix}-102 should match the rule-based heuristic`);
    assertEqual(c.risk_level, "normal", `${prefix}-103 should match the rule-based heuristic`);

    console.log("PASS: with ML_ESCALATION_ENABLED unset, fallback matches the rule-based heuristic exactly.");
  } finally {
    if (savedEnabled === undefined) {
      delete process.env.ML_ESCALATION_ENABLED;
    } else {
      process.env.ML_ESCALATION_ENABLED = savedEnabled;
    }
  }
}

async function testDisabledOpenRouter(): Promise<void> {
  console.log("\n--- Test: analyzeEscalationRisk with OpenRouter disabled ---");

  process.env.OPENROUTER_ESCALATION_ENABLED = "false";
  const prefix = "DISABLED";
  const issues = makeIssues(prefix);
  const analyses = await analyzeEscalationRisk(issues, 12, makeMockGetComments(prefix));

  assertValidAnalyses(analyses, issues, "Disabled OpenRouter path");
  // ML_ESCALATION_ENABLED is off by default, so this deterministically hits the
  // rule-based heuristic - safe to assert exact buckets here.
  const [disabledA, disabledB, disabledC] = requireThree(analyses);
  assertEqual(disabledA.risk_level, "immediate", `${prefix}-101 should be immediate`);
  assertEqual(disabledB.risk_level, "watch", `${prefix}-102 should be watch`);
  assertEqual(disabledC.risk_level, "normal", `${prefix}-103 should be normal`);

  console.log("PASS: Disabled OpenRouter path returns heuristic analyses.");
}

async function testOpenRouter503Fallback(): Promise<void> {
  console.log("\n--- Test: OpenRouter 503 failure falls back to heuristics ---");

  const savedProvider = process.env.ESCALATION_PROVIDER;
  process.env.ESCALATION_PROVIDER = "openrouter";
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

    assertValidAnalyses(analyses, issues, "503 fallback path");
    // ML_ESCALATION_ENABLED is off by default, so this deterministically hits the
    // rule-based heuristic - safe to assert exact buckets here.
    const [fallbackA, fallbackB, fallbackC] = requireThree(analyses);
    assertEqual(fallbackA.risk_level, "immediate", `${prefix}-101 fallback should be immediate`);
    assertEqual(fallbackB.risk_level, "watch", `${prefix}-102 fallback should be watch`);
    assertEqual(fallbackC.risk_level, "normal", `${prefix}-103 fallback should be normal`);

    console.log("PASS: 503 errors gracefully fall back to local heuristics.");
  } finally {
    globalThis.fetch = originalFetch;
    if (savedProvider === undefined) {
      delete process.env.ESCALATION_PROVIDER;
    } else {
      process.env.ESCALATION_PROVIDER = savedProvider;
    }
  }
}

async function testOpenRouterSuccess(): Promise<void> {
  console.log("\n--- Test: OpenRouter success path parses response ---");

  const savedProvider = process.env.ESCALATION_PROVIDER;
  process.env.ESCALATION_PROVIDER = "openrouter";
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
    if (savedProvider === undefined) {
      delete process.env.ESCALATION_PROVIDER;
    } else {
      process.env.ESCALATION_PROVIDER = savedProvider;
    }
  }
}

async function testMistralSuccess(): Promise<void> {
  console.log("\n--- Test: Mistral success path parses response ---");

  const prefix = "MST";
  const savedProvider = process.env.ESCALATION_PROVIDER;
  const originalFetch = globalThis.fetch;

  process.env.ESCALATION_PROVIDER = "mistral";
  process.env.OPENROUTER_ESCALATION_ENABLED = "true";
  process.env.MISTRAL_API_KEY = "fake-mistral-key";
  process.env.MISTRAL_MODEL = "mistral-small-2603";

  let capturedUrl = "";
  let capturedBody: Record<string, unknown> | undefined;
  const mockFetch: typeof fetch = (input, init) => {
    capturedUrl = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
    capturedBody =
      typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
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
                  risk_score: 90,
                },
                {
                  key: `${prefix}-102`,
                  next_action: "Ping product team for clarification.",
                  reason: "Waiting for product requirement details.",
                  risk_level: "watch",
                  risk_score: 40,
                },
                {
                  key: `${prefix}-103`,
                  next_action: "Handle in normal queue.",
                  reason: "Low priority routine task.",
                  risk_level: "normal",
                  risk_score: 5,
                },
              ]),
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

    assert(capturedUrl.includes("api.mistral.ai"), "Should call the Mistral endpoint");
    assert(capturedBody?.model === "mistral-small-2603", "Should send the configured Mistral model");
    assertEqual(analyses.length, 3, "Should return 3 analyses");
    const [a, b, c] = requireThree(analyses);
    assertEqual(a.risk_level, "immediate", `${prefix}-101 should be immediate`);
    assertEqual(b.risk_level, "watch", `${prefix}-102 should be watch`);
    assertEqual(c.risk_level, "normal", `${prefix}-103 should be normal`);

    console.log("PASS: Mistral success path parses and returns analyses.");
  } finally {
    globalThis.fetch = originalFetch;
    if (savedProvider === undefined) {
      delete process.env.ESCALATION_PROVIDER;
    } else {
      process.env.ESCALATION_PROVIDER = savedProvider;
    }
  }
}

async function testNvidiaChainFallback(): Promise<void> {
  console.log("\n--- Test: NVIDIA model chain switches quickly on failure ---");

  const prefix = "CHAIN";
  const savedProvider = process.env.ESCALATION_PROVIDER;
  const savedModels = process.env.NVIDIA_MODELS;
  const originalFetch = globalThis.fetch;

  process.env.ESCALATION_PROVIDER = "nvidia";
  process.env.OPENROUTER_ESCALATION_ENABLED = "true";
  process.env.NVIDIA_API_KEY = "fake-nvidia-key";
  process.env.NVIDIA_MODELS = "chain-model-a,chain-model-b";

  const calledModels: string[] = [];
  const mockFetch: typeof fetch = (_input, init) => {
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const model = String(body.model);
    calledModels.push(model);

    if (model === "chain-model-a") {
      // Simulate the first model in the chain being unavailable (network error,
      // timeout, or a non-2xx response) - the chain should move on immediately
      // rather than retrying this same model, per getChainMaxRetries()=1.
      return Promise.reject(new Error("simulated network failure"));
    }

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
                  risk_score: 90,
                },
                {
                  key: `${prefix}-102`,
                  next_action: "Ping product team for clarification.",
                  reason: "Waiting for product requirement details.",
                  risk_level: "watch",
                  risk_score: 40,
                },
                {
                  key: `${prefix}-103`,
                  next_action: "Handle in normal queue.",
                  reason: "Low priority routine task.",
                  risk_level: "normal",
                  risk_score: 5,
                },
              ]),
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

    assertEqual(calledModels, ["chain-model-a", "chain-model-b"], "Should try chain-model-a once, then move to chain-model-b");
    assertEqual(analyses.length, 3, "Should return 3 analyses from the second model");
    const [a, b, c] = requireThree(analyses);
    assertEqual(a.risk_level, "immediate", `${prefix}-101 should be immediate`);
    assertEqual(b.risk_level, "watch", `${prefix}-102 should be watch`);
    assertEqual(c.risk_level, "normal", `${prefix}-103 should be normal`);

    console.log("PASS: chain-model-a failed once and the chain switched to chain-model-b without retrying chain-model-a.");
  } finally {
    globalThis.fetch = originalFetch;
    if (savedProvider === undefined) {
      delete process.env.ESCALATION_PROVIDER;
    } else {
      process.env.ESCALATION_PROVIDER = savedProvider;
    }
    if (savedModels === undefined) {
      delete process.env.NVIDIA_MODELS;
    } else {
      process.env.NVIDIA_MODELS = savedModels;
    }
  }
}

async function main(): Promise<void> {
  try {
    testHeuristics();
    await testMlFallbackModel();
    await testMlDisabledByDefault();
    await testDisabledOpenRouter();
    await testOpenRouter503Fallback();
    await testOpenRouterSuccess();
    await testMistralSuccess();
    await testNvidiaChainFallback();
    console.log("\nAll escalation tests passed.");
    process.exit(0);
  } catch (error) {
    console.error("\nEscalation test failed:", error);
    process.exit(1);
  }
}

main();
