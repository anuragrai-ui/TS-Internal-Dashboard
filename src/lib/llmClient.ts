const OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const NVIDIA_ENDPOINT = "https://integrate.api.nvidia.com/v1/chat/completions";
const MISTRAL_ENDPOINT = "https://api.mistral.ai/v1/chat/completions";
const ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

export type LlmProvider = "anthropic" | "openrouter" | "nvidia" | "mistral";

/**
 * NVIDIA's shared free-tier NIM endpoint has been observed taking anywhere
 * from ~25s to 3+ minutes for the same model on the same key - unrelated to
 * model size or prompt content, just queue depth on their side. Trying
 * several independent models in order (each with a short timeout and no
 * retry, see CHAIN_TIMEOUT_MS/CHAIN_MAX_RETRIES below) means only one of
 * them needs to be having a good moment, instead of betting the whole page
 * load on one model's queue.
 */
const DEFAULT_NVIDIA_MODEL_CHAIN = [
  "nvidia/nemotron-3.5-lightning-30b-a3b",
  "deepseek-ai/deepseek-v4-flash-0731",
  "openai/gpt-oss-120b",
  "nvidia/nemotron-3-ultra-550b-a55b",
  "moonshotai/kimi-k3",
];

/* 529 is Anthropic's "overloaded" status - harmless to include for the other
   providers since they never emit it. */
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504, 529]);
const MAX_DELAY_MS = 10_000;

function parseIntEnv(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Escalation-risk triage's provider (immediate/watch/low scoring - see
 * openrouterEscalation.ts/mlEscalationModel.ts). Kept independent from
 * getDraftProvider() below: this axis has its own tuned-through-incidents
 * default (OpenRouter, after Mistral 429'd and NVIDIA's free tier proved too
 * slow - see .env.example) that switching draft/follow-up generation to
 * Claude has no bearing on.
 */
export function getProvider(): LlmProvider {
  const value = process.env.ESCALATION_PROVIDER?.toLowerCase();
  if (value === "openrouter") {
    return "openrouter";
  }
  if (value === "mistral") {
    return "mistral";
  }
  if (value === "anthropic") {
    return "anthropic";
  }
  return "nvidia";
}

/**
 * Follow-up/closure draft generation's provider (src/lib/followupDraft.ts,
 * cpEscalation.ts, productWaitFollowup.ts - anything that writes a message a
 * human or client will read). Defaults to Claude Haiku 4.5: cheap, fast, and
 * (via getDraftSystemCacheEnabled() / the systemPrompt option below) able to
 * reuse a cached system-prompt prefix across the many similar drafts one
 * cron batch generates, unlike the OpenAI-compatible providers here. Falls
 * back to the fixed hardcoded template exactly like a missing API key on any
 * other provider - see draftViaChain in followupDraft.ts - so leaving
 * ANTHROPIC_API_KEY unset is safe, not a crash.
 */
export function getDraftProvider(): LlmProvider {
  const value = process.env.DRAFT_PROVIDER?.toLowerCase();
  if (value === "openrouter") {
    return "openrouter";
  }
  if (value === "mistral") {
    return "mistral";
  }
  if (value === "nvidia") {
    return "nvidia";
  }
  return "anthropic";
}

function endpointFor(provider: LlmProvider): string {
  if (provider === "openrouter") {
    return OPENROUTER_ENDPOINT;
  }
  if (provider === "mistral") {
    return MISTRAL_ENDPOINT;
  }
  if (provider === "anthropic") {
    return ANTHROPIC_ENDPOINT;
  }
  return NVIDIA_ENDPOINT;
}

export function getEndpoint(): string {
  return endpointFor(getProvider());
}

function apiKeyFor(provider: LlmProvider): string | undefined {
  if (provider === "openrouter") {
    return process.env.OPENROUTER_API_KEY;
  }
  if (provider === "mistral") {
    return process.env.MISTRAL_API_KEY;
  }
  if (provider === "anthropic") {
    return process.env.ANTHROPIC_API_KEY;
  }
  return process.env.NVIDIA_API_KEY;
}

export function getApiKey(): string | undefined {
  return apiKeyFor(getProvider());
}

export function getDraftApiKey(): string | undefined {
  return apiKeyFor(getDraftProvider());
}

function getNvidiaModelChain(): string[] {
  const raw = process.env.NVIDIA_MODELS;

  if (raw) {
    const models = raw.split(",").map((model) => model.trim()).filter(Boolean);

    if (models.length > 0) {
      return models;
    }
  }

  return DEFAULT_NVIDIA_MODEL_CHAIN;
}

function modelChainFor(provider: LlmProvider): string[] {
  if (provider === "nvidia") {
    return getNvidiaModelChain();
  }

  if (provider === "mistral") {
    const primary = process.env.MISTRAL_MODEL ?? "mistral-small-2603";
    const fallback = process.env.MISTRAL_FALLBACK_MODEL ?? primary;
    return [...new Set([primary, fallback])];
  }

  if (provider === "anthropic") {
    const primary = process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001";
    const fallback = process.env.ANTHROPIC_FALLBACK_MODEL ?? primary;
    return [...new Set([primary, fallback])];
  }

  const primary = process.env.OPENROUTER_MODEL ?? "openai/gpt-oss-120b";
  const fallback = process.env.OPENROUTER_FALLBACK_MODEL ?? primary;
  return [...new Set([primary, fallback])];
}

/**
 * Every provider exposes an ordered list of models to try - length 1-2 for
 * OpenRouter/Mistral/Anthropic's primary+fallback, longer for NVIDIA's
 * multi-model chain. callChatCompletionChain() walks this list in order.
 */
export function getModelChain(): string[] {
  return modelChainFor(getProvider());
}

export function getDraftModelChain(): string[] {
  return modelChainFor(getDraftProvider());
}

export function isEscalationEnabled(): boolean {
  return process.env.OPENROUTER_ESCALATION_ENABLED === "true";
}

export function getMaxRetries(): number {
  return parseIntEnv(process.env.OPENROUTER_MAX_RETRIES, 4);
}

export function getRequestTimeoutMs(): number {
  return parseIntEnv(process.env.OPENROUTER_REQUEST_TIMEOUT_MS, 45000);
}

export function getBaseDelayMs(): number {
  return parseIntEnv(process.env.OPENROUTER_BASE_DELAY_MS, 500);
}

/** Per-model budget when walking a model chain - short and single-attempt on purpose, see DEFAULT_NVIDIA_MODEL_CHAIN. */
export function getChainTimeoutMs(): number {
  return parseIntEnv(process.env.NVIDIA_CHAIN_TIMEOUT_MS, 15000);
}

export function getChainMaxRetries(): number {
  return parseIntEnv(process.env.NVIDIA_CHAIN_MAX_RETRIES, 1);
}

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function jitteredDelay(attempt: number): number {
  const baseDelayMs = getBaseDelayMs();
  const base = Math.min(baseDelayMs * 2 ** (attempt - 1), MAX_DELAY_MS);
  const jitter = Math.random() * base * 0.5;

  return Math.round(base + jitter);
}

export interface ToolCall {
  function: {
    arguments: string;
    name: string;
  };
  id: string;
  type?: "function";
}

export interface ChatMessage {
  content: string | null;
  name?: string;
  role: "assistant" | "system" | "tool" | "user";
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

interface ChatCompletionChoice {
  message?: {
    content?: string | null;
    tool_calls?: ToolCall[];
  };
}

interface ChatCompletionResponse {
  choices?: ChatCompletionChoice[];
}

interface RawCompletionResult {
  content: string | null;
  tool_calls?: ToolCall[];
}

export interface CallChatCompletionOptions {
  /* Provider-specific request-body fields the caller wants merged in verbatim, e.g. OpenRouter's reasoning/response_format - this module stays agnostic to what they mean. Also where an OpenAI-shaped {tools, tool_choice} pair from toOpenAiTools() flows through - translated to Anthropic's tool shape automatically when provider is "anthropic". */
  extraBody?: Record<string, unknown>;
  maxRetries?: number;
  maxTokens?: number;
  model: string;
  /* Defaults to getProvider() (the escalation-triage axis) when omitted, for
     100% backward compatibility with every caller that predates the
     draft/triage provider split. Draft call sites pass getDraftProvider()
     explicitly. */
  provider?: LlmProvider;
  requestTimeoutMs?: number;
  /* A stable instruction preamble, sent as Anthropic's top-level `system`
     field with prompt caching enabled (cache_control: ephemeral) so the many
     similar drafts one cron batch generates - many CP escalations, many
     external product-wait follow-ups - reuse the cached prefix instead of
     paying full input price each time. For every other provider this is
     just prepended as a role:"system" message, unchanged behavior. */
  systemPrompt?: string;
  temperature?: number;
}

interface AnthropicTextBlock {
  text: string;
  type: "text";
}

interface AnthropicToolUseBlock {
  id: string;
  input: Record<string, unknown>;
  name: string;
  type: "tool_use";
}

interface AnthropicToolResultBlock {
  content: string;
  tool_use_id: string;
  type: "tool_result";
}

type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock | AnthropicToolResultBlock;

interface AnthropicMessage {
  content: AnthropicContentBlock[] | string;
  role: "assistant" | "user";
}

function parseToolArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Translates the OpenAI-shaped ChatMessage[] (the one internal currency
 * every caller in this codebase already builds) into Anthropic's message
 * format. role:"system" is dropped here - it's handled separately as the
 * top-level `system` field so it can carry cache_control. Consecutive
 * role:"tool" messages (Anthropic requires tool results to be user-turn
 * content blocks) are coalesced into a single user turn with multiple
 * tool_result blocks, matching how callChatCompletionWithTools's loop pushes
 * one "tool" message per call after a multi-tool-call assistant turn.
 */
function toAnthropicMessages(messages: ChatMessage[]): AnthropicMessage[] {
  const result: AnthropicMessage[] = [];

  for (const message of messages) {
    if (message.role === "system") {
      continue;
    }

    if (message.role === "tool") {
      const block: AnthropicToolResultBlock = {
        content: message.content ?? "",
        tool_use_id: message.tool_call_id ?? "",
        type: "tool_result",
      };
      const last = result[result.length - 1];

      if (last && last.role === "user" && Array.isArray(last.content)) {
        last.content.push(block);
      } else {
        result.push({ content: [block], role: "user" });
      }
      continue;
    }

    if (message.role === "assistant" && message.tool_calls && message.tool_calls.length > 0) {
      const blocks: AnthropicContentBlock[] = [];

      if (message.content) {
        blocks.push({ text: message.content, type: "text" });
      }
      for (const call of message.tool_calls) {
        blocks.push({
          id: call.id,
          input: parseToolArguments(call.function.arguments),
          name: call.function.name,
          type: "tool_use",
        });
      }
      result.push({ content: blocks, role: "assistant" });
      continue;
    }

    result.push({
      content: message.content ?? "",
      role: message.role === "assistant" ? "assistant" : "user",
    });
  }

  return result;
}

interface OpenAiToolSpec {
  function: { description: string; name: string; parameters: Record<string, unknown> };
}

function buildAnthropicBody(
  messages: ChatMessage[],
  opts: CallChatCompletionOptions,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    max_tokens: opts.maxTokens ?? 2048,
    messages: toAnthropicMessages(messages),
    model: opts.model,
    temperature: opts.temperature ?? 0.1,
  };

  const systemFromMessages = messages
    .filter((message) => message.role === "system" && message.content)
    .map((message) => message.content)
    .join("\n\n");
  const systemText = [opts.systemPrompt, systemFromMessages].filter(Boolean).join("\n\n");

  if (systemText) {
    body.system = [{ cache_control: { type: "ephemeral" }, text: systemText, type: "text" }];
  }

  const extraTools = (opts.extraBody as { tools?: OpenAiToolSpec[] } | undefined)?.tools;

  if (extraTools && extraTools.length > 0) {
    body.tools = extraTools.map((tool) => ({
      description: tool.function.description,
      input_schema: tool.function.parameters,
      name: tool.function.name,
    }));
    body.tool_choice = { type: "auto" };
  }

  return body;
}

interface AnthropicResponseBlock {
  id?: string;
  input?: Record<string, unknown>;
  name?: string;
  text?: string;
  type: string;
}

interface AnthropicResponse {
  content?: AnthropicResponseBlock[];
}

function parseAnthropicResponse(data: AnthropicResponse): RawCompletionResult {
  const blocks = data.content ?? [];
  const textParts: string[] = [];
  const toolCalls: ToolCall[] = [];

  for (const block of blocks) {
    if (block.type === "text" && typeof block.text === "string") {
      textParts.push(block.text);
    } else if (block.type === "tool_use" && block.id && block.name) {
      toolCalls.push({
        function: { arguments: JSON.stringify(block.input ?? {}), name: block.name },
        id: block.id,
        type: "function",
      });
    }
  }

  return {
    content: textParts.length > 0 ? textParts.join("\n").trim() : null,
    tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
  };
}

function buildOpenAiBody(messages: ChatMessage[], opts: CallChatCompletionOptions): Record<string, unknown> {
  const fullMessages: ChatMessage[] = opts.systemPrompt
    ? [{ content: opts.systemPrompt, role: "system" }, ...messages]
    : messages;

  return {
    max_tokens: opts.maxTokens ?? 2048,
    messages: fullMessages,
    model: opts.model,
    temperature: opts.temperature ?? 0.1,
    ...opts.extraBody,
  };
}

function parseOpenAiResponse(data: ChatCompletionResponse): RawCompletionResult {
  const message = data.choices?.[0]?.message;
  return {
    content: message?.content?.trim() ?? null,
    tool_calls: message?.tool_calls,
  };
}

/**
 * The actual HTTP call + retry/backoff loop, operating on a raw messages
 * array and returning the full message (content + any tool_calls) rather
 * than a plain string - callChatCompletion() and callChatCompletionWithTools()
 * both build on this. Returns null on the same conditions callChatCompletion
 * always has: no API key, a non-retryable status, or every retry exhausted.
 * Branches internally on opts.provider (defaulting to getProvider()) to
 * build either an OpenAI-compatible or an Anthropic Messages API request,
 * normalizing the response back to the same RawCompletionResult shape
 * either way - every caller above this stays provider-agnostic.
 */
export async function callChatCompletionRaw(
  messages: ChatMessage[],
  opts: CallChatCompletionOptions,
): Promise<RawCompletionResult | null> {
  const provider = opts.provider ?? getProvider();
  const apiKey = apiKeyFor(provider);

  if (!apiKey) {
    return null;
  }

  const endpoint = endpointFor(provider);
  const maxRetries = opts.maxRetries ?? getMaxRetries();
  const requestTimeoutMs = opts.requestTimeoutMs ?? getRequestTimeoutMs();

  const body = provider === "anthropic" ? buildAnthropicBody(messages, opts) : buildOpenAiBody(messages, opts);
  const headers: Record<string, string> =
    provider === "anthropic"
      ? { "anthropic-version": ANTHROPIC_VERSION, "content-type": "application/json", "x-api-key": apiKey }
      : { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };

  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      const response = await fetch(endpoint, {
        body: JSON.stringify(body),
        headers,
        method: "POST",
        signal: AbortSignal.timeout(requestTimeoutMs),
      });

      if (response.ok) {
        const data = (await response.json()) as AnthropicResponse & ChatCompletionResponse;
        return provider === "anthropic" ? parseAnthropicResponse(data) : parseOpenAiResponse(data);
      }

      if (!RETRYABLE_STATUSES.has(response.status)) {
        console.warn(
          `${provider} ${opts.model} returned non-retryable status ${response.status}; aborting.`,
        );
        return null;
      }

      console.warn(
        `${provider} ${opts.model} returned ${response.status} (attempt ${attempt}/${maxRetries}).`,
      );

      if (attempt < maxRetries) {
        await wait(jitteredDelay(attempt));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `${provider} ${opts.model} network error on attempt ${attempt}/${maxRetries}: ${message}`,
      );

      if (attempt < maxRetries) {
        await wait(jitteredDelay(attempt));
      }
    }
  }

  console.warn(`${provider} ${opts.model} exhausted all ${maxRetries} attempts.`);
  return null;
}

export async function callChatCompletion(
  prompt: string,
  opts: CallChatCompletionOptions,
): Promise<string | null> {
  const result = await callChatCompletionRaw([{ content: prompt, role: "user" }], opts);
  return result ? (result.content ?? "") : null;
}

export interface CallChatCompletionChainOptions {
  extraBody?: Record<string, unknown>;
  maxTokens?: number;
  models: string[];
  /* Per-model retry/timeout override. Only pass the fast getChainMaxRetries()/
     getChainTimeoutMs() values for a genuinely long list of interchangeable
     models (NVIDIA) - leave unset for a 1-2 item primary+fallback chain
     (OpenRouter/Mistral/Anthropic), where each entry should still get its
     full configured retry/backoff resilience against transient errors. */
  perModelMaxRetries?: number;
  perModelTimeoutMs?: number;
  provider?: LlmProvider;
  systemPrompt?: string;
  temperature?: number;
}

/**
 * Tries each model in `models` in order, returning the first non-empty
 * result. A model that exhausts its retries (or every attempt fails) is
 * skipped in favor of the next one in the list.
 */
export async function callChatCompletionChain(
  prompt: string,
  opts: CallChatCompletionChainOptions,
): Promise<string | null> {
  const provider = opts.provider ?? getProvider();

  if (!apiKeyFor(provider)) {
    return null;
  }

  for (const [index, model] of opts.models.entries()) {
    const text = await callChatCompletion(prompt, {
      extraBody: opts.extraBody,
      maxRetries: opts.perModelMaxRetries,
      maxTokens: opts.maxTokens,
      model,
      provider,
      requestTimeoutMs: opts.perModelTimeoutMs,
      systemPrompt: opts.systemPrompt,
      temperature: opts.temperature,
    });

    if (text) {
      return text;
    }

    if (index < opts.models.length - 1) {
      console.warn(`${model} returned no usable content; trying the next model in the chain.`);
    }
  }

  return null;
}

export interface ToolDefinition {
  description: string;
  handler: (args: Record<string, unknown>) => Promise<string>;
  name: string;
  parameters: Record<string, unknown>;
}

export interface CallChatCompletionWithToolsOptions {
  extraBody?: Record<string, unknown>;
  maxRounds?: number;
  maxTokens?: number;
  model: string;
  provider?: LlmProvider;
  systemPrompt?: string;
  temperature?: number;
  tools: ToolDefinition[];
}

export interface ToolCallResult {
  text: string | null;
  toolCallCount: number;
}

function toOpenAiTools(tools: ToolDefinition[]): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    function: {
      description: tool.description,
      name: tool.name,
      parameters: tool.parameters,
    },
    type: "function",
  }));
}

/**
 * Agentic tool-calling loop: sends `tools` with tool_choice "auto" so the
 * model can decide whether to look something up before answering. Each
 * round that returns tool_calls gets its results appended as "tool" role
 * messages and the conversation is re-sent; a round that returns plain
 * content ends the loop immediately (a straightforward prompt costs exactly
 * one call, same as callChatCompletionChain). The final allowed round omits
 * `tools` entirely so the model is forced to answer in text - this is what
 * guarantees the loop always terminates with real content rather than a
 * dangling tool request. A failing tool handler produces an error string as
 * that tool's result instead of throwing, so one bad lookup can't abort the
 * whole draft. Provider-agnostic: works unchanged for Anthropic because
 * callChatCompletionRaw translates the OpenAI-shaped tools/messages to and
 * from Anthropic's format internally - this loop only ever sees the one
 * ChatMessage/ToolCall currency.
 */
export async function callChatCompletionWithTools(
  prompt: string,
  opts: CallChatCompletionWithToolsOptions,
): Promise<ToolCallResult> {
  const maxRounds = opts.maxRounds ?? 3;
  const toolsByName = new Map(opts.tools.map((tool) => [tool.name, tool]));
  const messages: ChatMessage[] = [{ content: prompt, role: "user" }];
  let toolCallCount = 0;

  for (let round = 1; round <= maxRounds; round += 1) {
    const isFinalRound = round === maxRounds;

    const result = await callChatCompletionRaw(messages, {
      extraBody: {
        ...opts.extraBody,
        ...(isFinalRound ? {} : { tool_choice: "auto", tools: toOpenAiTools(opts.tools) }),
      },
      maxTokens: opts.maxTokens,
      model: opts.model,
      provider: opts.provider,
      systemPrompt: opts.systemPrompt,
      temperature: opts.temperature,
    });

    if (result === null) {
      return { text: null, toolCallCount };
    }

    if (!result.tool_calls || result.tool_calls.length === 0) {
      return { text: result.content ?? "", toolCallCount };
    }

    messages.push({ content: result.content, role: "assistant", tool_calls: result.tool_calls });

    for (const call of result.tool_calls) {
      toolCallCount += 1;
      const tool = toolsByName.get(call.function.name);
      console.log(`Tool call: ${call.function.name}(${call.function.arguments})`);
      let toolResultText: string;

      if (!tool) {
        toolResultText = `Error: unknown tool "${call.function.name}".`;
      } else {
        try {
          toolResultText = await tool.handler(parseToolArguments(call.function.arguments));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          toolResultText = `Error running ${call.function.name}: ${message}`;
        }
      }

      messages.push({
        content: toolResultText,
        name: call.function.name,
        role: "tool",
        tool_call_id: call.id,
      });
    }
  }

  return { text: null, toolCallCount };
}
