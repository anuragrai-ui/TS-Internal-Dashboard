import type { PageTool, PageToolAnnotations, PageToolResult, ToolInputSchema } from "@/lib/webmcp/tools";

/**
 * Registration of the workspace's page tools with WebMCP, Chrome's proposed
 * standard for letting a browser agent call a page's own JavaScript tools
 * instead of clicking through its UI.
 *
 * Shape implemented (Chrome docs, "WebMCP imperative API", read 2026-10-03):
 *
 *   await document.modelContext.registerTool(
 *     { name, description, inputSchema, annotations, execute(args, { signal }) },
 *     { signal },               // aborting it unregisters (in-flight runs finish)
 *   );
 *   annotations: { readOnlyHint, untrustedContentHint, consequentialHint }
 *   execute resolves to a string.
 *
 * Older builds and the early explainer put the same object on
 * `navigator.modelContext`, sometimes with `unregisterTool(name)` instead of
 * signal support, sometimes returning a `{ unregister() }` handle, and
 * expected MCP-style results (`{ content: [{ type: "text", text }] }`).
 * Both are feature-detected here so a browser agent on either sees the same
 * tools, and every path is a silent no-op where the API doesn't exist.
 *
 * Nothing in here throws: registration problems come back in the summary,
 * and a tool that blows up answers the agent with an error text instead of
 * rejecting.
 */

export type ModelContextSource = "document" | "navigator";

/* The only members this module touches; anything else on the object is ignored. */
interface ModelContextApi {
  registerTool: (tool: NativeToolDescriptor, options?: { signal?: AbortSignal }) => unknown;
  unregisterTool?: (name: string) => unknown;
}

export interface PageModelContext {
  api: ModelContextApi;
  /* Where it was found: decides the result format the browser expects. */
  source: ModelContextSource;
}

/** What is handed to registerTool - the page tool minus our own `run`, plus the browser-facing `execute`. */
export interface NativeToolDescriptor {
  annotations: PageToolAnnotations;
  description: string;
  execute: (input: unknown, client?: unknown) => Promise<NativeToolResult>;
  inputSchema: ToolInputSchema;
  name: string;
}

/* A plain string for document.modelContext; the MCP content shape for the navigator.modelContext builds. */
export type NativeToolResult = string | { content: Array<{ text: string; type: "text" }>; isError?: boolean };

export interface RegistrationSummary {
  failed: Array<{ error: string; name: string }>;
  registered: string[];
  /* False when the browser has no WebMCP API (or nothing to register into). */
  supported: boolean;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/* Property read that tolerates non-objects and throwing getters. */
function readProperty(target: unknown, name: string): unknown {
  if ((typeof target !== "object" && typeof target !== "function") || target === null) {
    return undefined;
  }
  try {
    return (target as Record<string, unknown>)[name];
  } catch {
    return undefined;
  }
}

function isModelContextApi(value: unknown): value is ModelContextApi {
  return typeof readProperty(value, "registerTool") === "function";
}

/**
 * The page's WebMCP entry point: `document.modelContext` (current Chrome),
 * else `navigator.modelContext` (older builds), else null. `scope` defaults
 * to globalThis and exists for tests. Never throws.
 */
export function getModelContext(scope: unknown = globalThis): PageModelContext | null {
  const fromDocument = readProperty(readProperty(scope, "document"), "modelContext");
  if (isModelContextApi(fromDocument)) {
    return { api: fromDocument, source: "document" };
  }
  const fromNavigator = readProperty(readProperty(scope, "navigator"), "modelContext");
  if (isModelContextApi(fromNavigator)) {
    return { api: fromNavigator, source: "navigator" };
  }
  return null;
}

/* The second execute argument is `{ signal }` in current Chrome; older builds passed a client object without one. */
function signalFrom(client: unknown): AbortSignal | undefined {
  const signal = readProperty(client, "signal");
  return typeof AbortSignal !== "undefined" && signal instanceof AbortSignal ? signal : undefined;
}

/** Runs a page tool and never rejects: an unexpected exception becomes an error result the agent can read. */
export async function runToolSafely(tool: PageTool, input: unknown, signal?: AbortSignal): Promise<PageToolResult> {
  try {
    return await tool.run(input, signal);
  } catch (error) {
    console.warn(`WebMCP: ${tool.name} failed unexpectedly.`, errorText(error));
    return { ok: false, text: `${tool.name} failed unexpectedly (${errorText(error)}). Nothing was changed; try again or use the page directly.` };
  }
}

/** Formats a result the way the browser that found the API expects it. */
export function toNativeResult(result: PageToolResult, source: ModelContextSource): NativeToolResult {
  if (source === "navigator") {
    return { content: [{ text: result.text, type: "text" }], ...(result.ok ? {} : { isError: true }) };
  }
  return result.ok ? result.text : `Error: ${result.text}`;
}

/** The descriptor registerTool receives for one page tool. */
export function toNativeTool(tool: PageTool, source: ModelContextSource): NativeToolDescriptor {
  return {
    annotations: { ...tool.annotations },
    description: tool.description,
    execute: async (input: unknown, client?: unknown) => toNativeResult(await runToolSafely(tool, input, signalFrom(client)), source),
    inputSchema: tool.inputSchema,
    name: tool.name,
  };
}

/* How to take one registration back on builds that don't honour the signal: the returned handle first, then unregisterTool(name). */
function undoFor(api: ModelContextApi, name: string, handle: unknown): () => void {
  const unregister = readProperty(handle, "unregister");
  if (typeof unregister === "function") {
    return () => {
      (unregister as () => unknown).call(handle);
    };
  }
  if (typeof api.unregisterTool === "function") {
    return () => {
      api.unregisterTool?.(name);
    };
  }
  /* Current Chrome: the signal passed to registerTool already unregisters it. */
  return () => undefined;
}

function runQuietly(undo: () => void, name: string): void {
  try {
    undo();
  } catch (error) {
    /* Usually "not registered" - the browser already dropped it via the signal. */
    console.warn(`WebMCP: couldn't unregister ${name}.`, errorText(error));
  }
}

/**
 * Registers `tools` with the page's model context until `signal` aborts.
 * Aborting unregisters every tool registered so far (the browser does it
 * from the signal; older builds via their handle or unregisterTool), and a
 * registration that only completes after the abort is taken back straight
 * away. Callers that re-register the same names must wait for the previous
 * call's promise first (WebMcpProvider chains them) so an old cleanup can
 * never remove a newer registration. Never throws.
 */
export async function registerPageTools(
  context: PageModelContext | null,
  tools: readonly PageTool[],
  signal: AbortSignal,
): Promise<RegistrationSummary> {
  const summary: RegistrationSummary = { failed: [], registered: [], supported: context !== null };
  if (!context || signal.aborted) {
    return summary;
  }

  const undos: Array<{ name: string; undo: () => void }> = [];
  const onAbort = (): void => {
    for (const { name, undo } of undos.splice(0).reverse()) {
      runQuietly(undo, name);
    }
  };
  signal.addEventListener("abort", onAbort, { once: true });

  for (const tool of tools) {
    if (signal.aborted) {
      break;
    }
    try {
      /* Called as a method: the native implementation needs its own `this`. */
      const handle: unknown = await context.api.registerTool(toNativeTool(tool, context.source), { signal });
      const undo = undoFor(context.api, tool.name, handle);
      if (signal.aborted) {
        /* Aborted while this one was in flight: onAbort already ran without it. */
        runQuietly(undo, tool.name);
        break;
      }
      undos.push({ name: tool.name, undo });
      summary.registered.push(tool.name);
    } catch (error) {
      /* A duplicate name (another tab's script, a hot reload) or a schema the browser rejects - the other tools still register. */
      console.warn(`WebMCP: couldn't register ${tool.name}.`, errorText(error));
      summary.failed.push({ error: errorText(error), name: tool.name });
    }
  }
  return summary;
}
