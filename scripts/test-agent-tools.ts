import { callChatCompletionWithTools } from "@/lib/llmClient";
import type { ToolDefinition } from "@/lib/llmClient";
import { draftFollowUpMessage } from "@/lib/followupDraft";
import type { FormattedIssue, TicketCommentContext } from "@/lib/jiraClient";

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

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, statusText: "OK" });
}

function toolCallResponse(name: string, args: Record<string, unknown>): unknown {
  return {
    choices: [
      {
        message: {
          content: null,
          tool_calls: [{ function: { arguments: JSON.stringify(args), name }, id: "call_1", type: "function" }],
        },
      },
    ],
  };
}

function contentResponse(content: string): unknown {
  return { choices: [{ message: { content } }] };
}

async function withMockEnv<T>(
  env: Record<string, string>,
  fn: (requestBodies: Record<string, unknown>[]) => Promise<T>,
): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) {
    saved[key] = process.env[key];
    process.env[key] = env[key];
  }

  const originalFetch = globalThis.fetch;
  const requestBodies: Record<string, unknown>[] = [];

  try {
    return await fn(requestBodies);
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  }
}

function installMockFetch(
  requestBodies: Record<string, unknown>[],
  responder: (body: Record<string, unknown>, callIndex: number) => Response,
): void {
  let callIndex = 0;
  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    requestBodies.push(body);
    const response = responder(body, callIndex);
    callIndex += 1;
    return Promise.resolve(response);
  });
}

async function testToolCallTriggersSecondRound(): Promise<void> {
  console.log("\n--- Test: a tool_calls response executes the handler and triggers a second round ---");

  await withMockEnv(
    { ESCALATION_PROVIDER: "openrouter", OPENROUTER_API_KEY: "fake-key" },
    async (requestBodies) => {
      let handlerCalledWith: Record<string, unknown> | undefined;

      installMockFetch(requestBodies, (_body, callIndex) => {
        if (callIndex === 0) {
          return jsonResponse(toolCallResponse("lookup", { key: "TS-1" }));
        }
        return jsonResponse(contentResponse("Final answer using the lookup result."));
      });

      const tools: ToolDefinition[] = [
        {
          description: "test tool",
          handler: (args) => {
            handlerCalledWith = args;
            return Promise.resolve("lookup result: found it");
          },
          name: "lookup",
          parameters: { properties: { key: { type: "string" } }, type: "object" },
        },
      ];

      const result = await callChatCompletionWithTools("draft this", { model: "test-model", tools });

      assertEqual(requestBodies.length, 2, "should make exactly 2 requests");
      assertEqual(handlerCalledWith, { key: "TS-1" }, "handler should receive the parsed tool arguments");
      assertEqual(result.toolCallCount, 1, "toolCallCount should be 1");
      assertEqual(result.text, "Final answer using the lookup result.", "should return the second round's content");

      const secondRequestMessages = requestBodies[1]?.messages as Array<Record<string, unknown>>;
      const toolMessage = secondRequestMessages.find((message) => message.role === "tool");
      assert(Boolean(toolMessage), "second request should include the tool result message");
      assertEqual(toolMessage?.content, "lookup result: found it", "tool result message should carry the handler's return value");

      console.log("PASS: tool call executed, result fed back, second round produced the final answer.");
    },
  );
}

async function testNoToolCallReturnsImmediately(): Promise<void> {
  console.log("\n--- Test: a plain response (no tool_calls) returns immediately without looping ---");

  await withMockEnv(
    { ESCALATION_PROVIDER: "openrouter", OPENROUTER_API_KEY: "fake-key" },
    async (requestBodies) => {
      installMockFetch(requestBodies, () => jsonResponse(contentResponse("No lookup needed, here's the draft.")));

      const tools: ToolDefinition[] = [
        { description: "unused", handler: () => Promise.resolve("unused"), name: "lookup", parameters: { type: "object" } },
      ];

      const result = await callChatCompletionWithTools("draft this", { model: "test-model", tools });

      assertEqual(requestBodies.length, 1, "should make exactly 1 request when the model doesn't ask for a tool");
      assertEqual(result.toolCallCount, 0, "toolCallCount should be 0");
      assertEqual(result.text, "No lookup needed, here's the draft.", "should return the first round's content");

      console.log("PASS: no tool call means one request, same cost as a plain completion.");
    },
  );
}

async function testMaxRoundsForcesFinalAnswer(): Promise<void> {
  console.log("\n--- Test: hitting maxRounds forces a final tools-less call instead of looping forever ---");

  await withMockEnv(
    { ESCALATION_PROVIDER: "openrouter", OPENROUTER_API_KEY: "fake-key" },
    async (requestBodies) => {
      installMockFetch(requestBodies, (body) => {
        // A model that always wants to call a tool when tools are offered,
        // and can only answer in plain text once they're withheld.
        if (body.tools) {
          return jsonResponse(toolCallResponse("always_tool", {}));
        }
        return jsonResponse(contentResponse("Forced final answer."));
      });

      const tools: ToolDefinition[] = [
        {
          description: "always requested",
          handler: () => Promise.resolve("tool result"),
          name: "always_tool",
          parameters: { type: "object" },
        },
      ];

      const result = await callChatCompletionWithTools("draft this", { maxRounds: 2, model: "test-model", tools });

      assertEqual(requestBodies.length, 2, "should stop at exactly maxRounds requests, never loop indefinitely");
      assert(Boolean(requestBodies[0]?.tools), "first (non-final) request should offer tools");
      assert(!requestBodies[1]?.tools, "final request should omit tools, forcing a plain answer");
      assertEqual(result.text, "Forced final answer.", "should return the forced final answer");

      console.log("PASS: the loop terminates at maxRounds with a real answer instead of a dangling tool request.");
    },
  );
}

async function testFailingToolProducesErrorResult(): Promise<void> {
  console.log("\n--- Test: a throwing tool handler produces an error string instead of crashing ---");

  await withMockEnv(
    { ESCALATION_PROVIDER: "openrouter", OPENROUTER_API_KEY: "fake-key" },
    async (requestBodies) => {
      installMockFetch(requestBodies, (_body, callIndex) => {
        if (callIndex === 0) {
          return jsonResponse(toolCallResponse("broken_tool", {}));
        }
        return jsonResponse(contentResponse("Drafted despite the failed lookup."));
      });

      const tools: ToolDefinition[] = [
        {
          description: "always throws",
          handler: () => Promise.reject(new Error("simulated tool failure")),
          name: "broken_tool",
          parameters: { type: "object" },
        },
      ];

      const result = await callChatCompletionWithTools("draft this", { model: "test-model", tools });

      assertEqual(result.text, "Drafted despite the failed lookup.", "should still produce a final draft");

      const secondRequestMessages = requestBodies[1]?.messages as Array<Record<string, unknown>>;
      const toolMessage = secondRequestMessages.find((message) => message.role === "tool");
      assert(
        typeof toolMessage?.content === "string" && toolMessage.content.includes("simulated tool failure"),
        "tool result should be an error string mentioning the failure, not a thrown exception",
      );

      console.log("PASS: a failing tool produces an error-string result and the draft still completes.");
    },
  );
}

function makeTestIssue(): FormattedIssue {
  return {
    action_date: "2026-08-01",
    assignee: "Anurag Rai",
    attachment_count: 0,
    attachments: [],
    comment_count: 0,
    components: [],
    key: "TS-9001",
    labels: [],
    latest_comment_created: "",
    priority: "Medium",
    priority_sort: 3,
    project: "TS",
    reporter: "Some Client",
    reporter_is_external: true,
    severity: "Minor",
    status: "Waiting for Product",
    subtask_count: 0,
    summary: "Test ticket for agent-tools provider gating",
    updated: "2026-08-01T10:00:00.000Z",
    url: "https://certifyos.atlassian.net/browse/TS-9001",
  };
}

async function testNonOpenrouterProviderSkipsToolsPath(): Promise<void> {
  console.log("\n--- Test: a non-openrouter provider never requests tools, uses the plain chain unchanged ---");

  await withMockEnv(
    {
      DRAFT_PROVIDER: "mistral",
      MISTRAL_API_KEY: "fake-key",
      OPENROUTER_ESCALATION_ENABLED: "true",
    },
    async (requestBodies) => {
      installMockFetch(requestBodies, () => jsonResponse(contentResponse("Plain Mistral draft, no tools involved.")));

      const comments: TicketCommentContext[] = [];
      const result = await draftFollowUpMessage(makeTestIssue(), comments);

      assert(requestBodies.length > 0, "should have made at least one request");
      for (const body of requestBodies) {
        assert(!body.tools, "no request should include a tools field for a non-openrouter provider");
      }
      assertEqual(result.toolCallCount, 0, "toolCallCount should be 0 on the non-tool-calling path");
      assertEqual(result.text, "Plain Mistral draft, no tools involved.", "should return the plain chain's draft text");

      console.log("PASS: Mistral draft never offers tools and behaves exactly as before this change.");
    },
  );
}

async function main(): Promise<void> {
  try {
    await testToolCallTriggersSecondRound();
    await testNoToolCallReturnsImmediately();
    await testMaxRoundsForcesFinalAnswer();
    await testFailingToolProducesErrorResult();
    await testNonOpenrouterProviderSkipsToolsPath();
    console.log("\nAll agent-tools tests passed.");
    process.exit(0);
  } catch (error) {
    console.error("\nAgent-tools test failed:", error);
    process.exit(1);
  }
}

main();
