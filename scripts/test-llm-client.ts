import {
  callChatCompletion,
  callChatCompletionWithTools,
  getDraftProvider,
  getProvider,
} from "@/lib/llmClient";
import type { ToolDefinition } from "@/lib/llmClient";
import { pickVariant } from "@/lib/textVariety";

function assert(condition: boolean, label: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${label}`);
  }
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} failed: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function withMockEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) {
    saved[key] = process.env[key];
    process.env[key] = env[key];
  }
  const originalFetch = globalThis.fetch;

  try {
    return await fn();
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

interface CapturedRequest {
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

function installMockFetch(
  requests: CapturedRequest[],
  responder: (body: Record<string, unknown>, callIndex: number) => unknown,
): void {
  let callIndex = 0;
  globalThis.fetch = (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const rawHeaders = (init?.headers ?? {}) as Record<string, string>;
    requests.push({ body, headers: rawHeaders });
    const responseBody = responder(body, callIndex);
    callIndex += 1;
    return Promise.resolve(new Response(JSON.stringify(responseBody), { status: 200 }));
  };
}

function expectRequest(requests: CapturedRequest[], index: number): CapturedRequest {
  const request = requests[index];
  if (!request) {
    throw new Error(`Expected a captured request at index ${index}, but only ${requests.length} were made.`);
  }
  return request;
}

async function testAnthropicRequestShapeAndCaching(): Promise<void> {
  console.log("\n--- Test: an Anthropic call builds the Messages API shape with a cached system block ---");

  await withMockEnv({ ANTHROPIC_API_KEY: "fake-key" }, async () => {
    const requests: CapturedRequest[] = [];
    installMockFetch(requests, () => ({ content: [{ text: "Sure thing.", type: "text" }] }));

    const result = await callChatCompletion("Draft a follow-up for TS-1.", {
      maxTokens: 512,
      model: "claude-haiku-4-5-20251001",
      provider: "anthropic",
      systemPrompt: "You are a support engineer.",
      temperature: 0.7,
    });

    assertEqual(result, "Sure thing.", "should return the text block's content");
    assertEqual(requests.length, 1, "should have made exactly one request");

    const { body, headers } = expectRequest(requests, 0);
    assertEqual(headers["x-api-key"], "fake-key", "should authenticate via x-api-key, not Bearer");
    assert(!("Authorization" in headers), "should not send an OpenAI-style Authorization header");
    assertEqual(headers["anthropic-version"], "2023-06-01", "should send the Anthropic API version header");

    const system = body.system as Array<{ cache_control?: { type: string }; text: string; type: string }>;
    assert(Array.isArray(system), "system should be an array of content blocks, not a plain string");
    assertEqual(system[0]?.text, "You are a support engineer.", "system block should carry the given systemPrompt");
    assertEqual(system[0]?.cache_control?.type, "ephemeral", "system block should be marked for ephemeral prompt caching");

    const messages = body.messages as Array<{ content: unknown; role: string }>;
    assertEqual(messages.length, 1, "the user prompt should be the only message (system is separate)");
    assertEqual(messages[0]?.role, "user", "the sole message should be a user turn");
    assertEqual(messages[0]?.content, "Draft a follow-up for TS-1.", "the user message should carry the prompt text verbatim");

    console.log("PASS: Anthropic requests use x-api-key auth and a cached system content block.");
  });
}

async function testOpenAiCompatibleShapeUnchanged(): Promise<void> {
  console.log("\n--- Test: an OpenRouter call still uses the plain OpenAI-compatible shape (regression guard) ---");

  await withMockEnv({ OPENROUTER_API_KEY: "fake-key" }, async () => {
    const requests: CapturedRequest[] = [];
    installMockFetch(requests, () => ({ choices: [{ message: { content: "OK." } }] }));

    const result = await callChatCompletion("Draft a follow-up.", {
      model: "openai/gpt-oss-120b",
      provider: "openrouter",
      systemPrompt: "You are a support engineer.",
    });

    assertEqual(result, "OK.", "should parse choices[0].message.content as before");

    const { body, headers } = expectRequest(requests, 0);
    assertEqual(headers.Authorization, "Bearer fake-key", "should still authenticate via Bearer for OpenRouter");
    assert(!("system" in body), "should not add an Anthropic-style top-level system field");

    const messages = body.messages as Array<{ content: unknown; role: string }>;
    assertEqual(messages.length, 2, "systemPrompt should be prepended as a role:system message for OpenAI-shaped providers");
    assertEqual(messages[0]?.role, "system", "first message should be the system prompt");
    assertEqual(messages[1]?.role, "user", "second message should be the actual user prompt");

    console.log("PASS: OpenRouter/Mistral/NVIDIA requests are unaffected by the Anthropic addition.");
  });
}

async function testAnthropicToolCallRoundTrip(): Promise<void> {
  console.log("\n--- Test: Anthropic tool-calling round-trips through the same ToolDefinition/ToolCall shapes as OpenAI ---");

  await withMockEnv({ ANTHROPIC_API_KEY: "fake-key" }, async () => {
    const requests: CapturedRequest[] = [];
    let handlerArgs: Record<string, unknown> | undefined;

    installMockFetch(requests, (_body, callIndex) => {
      if (callIndex === 0) {
        return {
          content: [{ id: "toolu_1", input: { key: "TS-1" }, name: "get_jira_issue", type: "tool_use" }],
        };
      }
      return { content: [{ text: "Here is the final answer.", type: "text" }] };
    });

    const tools: ToolDefinition[] = [
      {
        description: "Get a Jira issue by key.",
        handler: (args) => {
          handlerArgs = args;
          return Promise.resolve("TS-1: some ticket");
        },
        name: "get_jira_issue",
        parameters: { properties: { key: { type: "string" } }, required: ["key"], type: "object" },
      },
    ];

    const result = await callChatCompletionWithTools("Look up TS-1 and summarize it.", {
      model: "claude-haiku-4-5-20251001",
      provider: "anthropic",
      tools,
    });

    assertEqual(result.text, "Here is the final answer.", "should return the second round's text content");
    assertEqual(result.toolCallCount, 1, "should count exactly one tool call");
    assertEqual(handlerArgs, { key: "TS-1" }, "the tool handler should receive the parsed input object, not a JSON string");
    assertEqual(requests.length, 2, "should have made two requests: the tool-use round and the follow-up round");

    const secondBody = expectRequest(requests, 1).body;
    const secondMessages = secondBody.messages as Array<{ content: unknown; role: string }>;
    const toolResultTurn = secondMessages.find(
      (m) => Array.isArray(m.content) && (m.content as Array<{ type: string }>).some((b) => b.type === "tool_result"),
    );
    assert(Boolean(toolResultTurn), "the second request should include a user turn carrying a tool_result block");

    const toolResultBlock = (toolResultTurn?.content as Array<{ tool_use_id?: string; type: string }>).find(
      (b) => b.type === "tool_result",
    );
    assertEqual(toolResultBlock?.tool_use_id, "toolu_1", "the tool_result should reference the original tool_use's id");

    console.log("PASS: Anthropic tool-calling round-trips correctly through the provider-agnostic loop.");
  });
}

function testDraftAndTriageProvidersAreIndependent(): void {
  console.log("\n--- Test: getDraftProvider() and getProvider() read independent env vars ---");

  const savedEscalation = process.env.ESCALATION_PROVIDER;
  const savedDraft = process.env.DRAFT_PROVIDER;

  try {
    delete process.env.ESCALATION_PROVIDER;
    delete process.env.DRAFT_PROVIDER;
    assertEqual(getDraftProvider(), "anthropic", "getDraftProvider() should default to anthropic when unset");
    assertEqual(getProvider(), "nvidia", "getProvider() should keep its own unrelated default when unset");

    process.env.DRAFT_PROVIDER = "openrouter";
    assertEqual(getDraftProvider(), "openrouter", "getDraftProvider() should honor DRAFT_PROVIDER");
    assertEqual(getProvider(), "nvidia", "getProvider() should be unaffected by DRAFT_PROVIDER");

    process.env.ESCALATION_PROVIDER = "mistral";
    assertEqual(getProvider(), "mistral", "getProvider() should honor ESCALATION_PROVIDER");
    assertEqual(getDraftProvider(), "openrouter", "getDraftProvider() should be unaffected by ESCALATION_PROVIDER");

    console.log("PASS: the escalation-triage and draft-generation provider axes are fully independent.");
  } finally {
    if (savedEscalation === undefined) {
      delete process.env.ESCALATION_PROVIDER;
    } else {
      process.env.ESCALATION_PROVIDER = savedEscalation;
    }
    if (savedDraft === undefined) {
      delete process.env.DRAFT_PROVIDER;
    } else {
      process.env.DRAFT_PROVIDER = savedDraft;
    }
  }
}

function testPickVariantIsDeterministicAndSpreads(): void {
  console.log("\n--- Test: pickVariant is stable per seed and spreads across different seeds ---");

  const variants = ["a", "b", "c"] as const;

  assertEqual(pickVariant("TS-100", variants), pickVariant("TS-100", variants), "the same seed should always pick the same variant");

  const seen = new Set<string>();
  for (let i = 0; i < 50; i += 1) {
    seen.add(pickVariant(`TS-${i}`, variants));
  }
  assert(seen.size > 1, "a spread of different seeds should land on more than one variant");

  console.log(`PASS: same seed is stable; ${seen.size}/3 variants were hit across 50 different seeds.`);
}

async function main(): Promise<void> {
  try {
    await testAnthropicRequestShapeAndCaching();
    await testOpenAiCompatibleShapeUnchanged();
    await testAnthropicToolCallRoundTrip();
    testDraftAndTriageProvidersAreIndependent();
    testPickVariantIsDeterministicAndSpreads();
    console.log("\nAll llm-client tests passed.");
    process.exit(0);
  } catch (error) {
    console.error("\nLLM-client test failed:", error);
    process.exit(1);
  }
}

main();
