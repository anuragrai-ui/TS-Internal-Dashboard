import { getModelContext, registerPageTools, runToolSafely, toNativeResult, toNativeTool } from "@/lib/webmcp/registry";
import { buildPageTools, CONTEXT_TIMELINE_ITEMS, normalizeTicketKey, parseConversationId, SEARCH_MAX_LIMIT } from "@/lib/webmcp/tools";
import { UI_EVENTS } from "@/lib/workspace/types";

import type { NativeToolDescriptor, PageModelContext } from "@/lib/webmcp/registry";
import type { CasePanelState, FetchJsonInit, FetchJsonResult, PageTool, PageToolDeps } from "@/lib/webmcp/tools";
import type { SlackConversationRef, TimelineItem, TrackerDetail, TrackerListResponse, TrackerSla, TrackerTicket } from "@/lib/tracker/types";
import type { ActionProposal, AssistRun, CreateProposalRequest, JiraOptionsResponse, OnCallResponse, PrepareReplyDetail } from "@/lib/workspace/types";

/**
 * Tests for the WebMCP page tools: registration and cleanup against fake
 * `document.modelContext` / `navigator.modelContext` objects, argument
 * validation, and what each tool fetches, dispatches and returns - with a
 * fake fetch and a recording dispatch. No browser, network, Jira, Slack or
 * Redis is touched.
 *
 *   npx tsx scripts/test-webmcp.ts
 */

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

/* --------------------------------------------------------------- fixtures */

const NOW = Date.parse("2026-10-03T12:00:00Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function iso(offsetMs: number): string {
  return new Date(NOW + offsetMs).toISOString();
}

const NO_SLA: TrackerSla = { breached: false, goalMs: null, remainingMs: null, state: "none" };

function running(remainingMs: number): TrackerSla {
  return { breached: remainingMs < 0, goalMs: 3 * DAY, remainingMs, state: "running" };
}

function ticket(key: string, overrides: Partial<TrackerTicket> = {}): TrackerTicket {
  return {
    account: "Acme Health",
    assignee: { accountId: "acc-me", name: "Anurag Rai" },
    botEscalation: null,
    cps: [],
    created: iso(-5 * DAY),
    escalated: false,
    firstResponse: NO_SLA,
    key,
    lastActivityAt: iso(-1 * HOUR),
    pod: "Alpha",
    priority: "High",
    reporterName: "Client Person",
    resolvedAt: null,
    signals: [],
    slack: { activeConversations: 0, conversations: 0, lastActivityAt: null },
    statusCategory: "indeterminate",
    statusId: "3",
    statusName: "In Progress",
    summary: `Summary of ${key}`,
    ttr: NO_SLA,
    updated: iso(-1 * HOUR),
    whoseMove: "on_ts",
    ...overrides,
  };
}

const TICKETS: TrackerTicket[] = [
  ticket("TS-1", { priority: "Critical", summary: "Provider roster import fails", ttr: running(-2 * HOUR) }),
  ticket("TS-2", { account: "Beta Clinics", assignee: null, summary: "Credentialing export slow", ttr: running(3 * HOUR) }),
  ticket("TS-3", { priority: "Medium", resolvedAt: iso(-2 * DAY), statusCategory: "done", statusName: "Resolved", summary: "Acme login loop", whoseMove: "closed" }),
  ticket("TS-4", {
    cps: [{ assigneeName: "Eng Person", key: "CP-55", outcome: "open", podName: "Alpha", statusName: "In Progress", summary: "Fix roster sync" }],
    summary: "Acme sync stuck",
    whoseMove: "on_engineering",
  }),
  ticket("TS-5", { account: "Gamma", priority: "Critical", summary: "Gamma outage", ttr: running(20 * HOUR) }),
];

const LIST: TrackerListResponse = { builtAt: iso(-2 * MINUTE), errors: [], following: [], jiraBaseUrl: "https://example.atlassian.net", me: "acc-me", tickets: TICKETS };

const CONVERSATION: SlackConversationRef = {
  channel: "C0TECHSUP",
  channelName: "technical-support",
  escalationHint: true,
  firstSeenAt: iso(-3 * HOUR),
  id: "C0TECHSUP:1727881200.000100",
  lastActivityAt: iso(-1 * HOUR),
  participants: 3,
  replyCount: 4,
  rootTs: "1727881200.000100",
  snippet: "Roster import is failing for Acme again",
  source: "event",
  startedByName: "Jane",
  ticketKeys: ["TS-1"],
};

function timelineItem(index: number, body: string): TimelineItem {
  return {
    actor: `Person ${index}`,
    at: iso(-(100 - index) * MINUTE),
    body,
    id: `item-${index}`,
    internal: index % 2 === 0,
    kind: "jira_comment",
    source: "jira",
    sourceLabel: "TS-1",
    title: `Comment ${index}`,
  };
}

function detail(timeline: TimelineItem[]): TrackerDetail {
  return { conversations: [CONVERSATION], errors: [], following: false, ticket: TICKETS[0] as TrackerTicket, timeline };
}

/* -------------------------------------------------------------- fake deps */

interface RecordedCall {
  body?: unknown;
  method: string;
  path: string;
}

type Route = (call: RecordedCall) => FetchJsonResult<unknown>;

interface Harness {
  announcements: string[];
  calls: RecordedCall[];
  deps: PageToolDeps;
  events: Array<{ detail: unknown; type: string }>;
  navigations: string[];
  setLocation: (pathname: string, openTicket: string | null) => void;
  tools: Map<string, PageTool>;
}

function okResult<T>(data: T, status = 200): FetchJsonResult<T> {
  return { data, ok: true, status };
}

/* Routes are matched on "METHOD /path?query"; anything unrouted is a 404 the test will notice. */
function harness(routes: Record<string, Route>, options: { caseState?: CasePanelState } = {}): Harness {
  const calls: RecordedCall[] = [];
  const events: Array<{ detail: unknown; type: string }> = [];
  const navigations: string[] = [];
  const announcements: string[] = [];
  let location = { openTicket: null as string | null, pathname: "/tracker" };

  const deps: PageToolDeps = {
    announce: (message) => announcements.push(message),
    dispatch: (type, detail) => events.push({ detail, type }),
    fetchJson: <T>(path: string, init: FetchJsonInit = {}): Promise<FetchJsonResult<T>> => {
      const call: RecordedCall = { method: init.method ?? "GET", path, ...(init.body === undefined ? {} : { body: structuredClone(init.body) }) };
      calls.push(call);
      const route = routes[`${call.method} ${path}`];
      return Promise.resolve((route ? route(call) : { error: "Not found.", ok: false, status: 404 }) as FetchJsonResult<T>);
    },
    location: () => location,
    navigate: (url) => navigations.push(url),
    now: () => NOW,
    waitForCase: () => Promise.resolve(options.caseState ?? "ready"),
  };
  return {
    announcements,
    calls,
    deps,
    events,
    navigations,
    setLocation: (pathname, openTicket) => {
      location = { openTicket, pathname };
    },
    tools: new Map(buildPageTools(deps).map((tool) => [tool.name, tool])),
  };
}

async function run(h: Harness, name: string, input: unknown): Promise<{ ok: boolean; text: string }> {
  const tool = h.tools.get(name);
  if (!tool) {
    throw new Error(`no tool ${name}`);
  }
  return runToolSafely(tool, input);
}

/* ------------------------------------------------------ fake model contexts */

/* Current Chrome: document.modelContext.registerTool(tool, { signal }); aborting the signal unregisters. */
function documentModelContext(): { api: { registerTool: (tool: NativeToolDescriptor, options?: { signal?: AbortSignal }) => Promise<void> }; tools: Map<string, NativeToolDescriptor> } {
  const tools = new Map<string, NativeToolDescriptor>();
  return {
    api: {
      registerTool: (tool, options) => {
        if (tools.has(tool.name)) {
          return Promise.reject(new Error(`A tool named ${tool.name} is already registered.`));
        }
        tools.set(tool.name, tool);
        options?.signal?.addEventListener("abort", () => tools.delete(tool.name), { once: true });
        return Promise.resolve();
      },
    },
    tools,
  };
}

/* Older builds: navigator.modelContext with unregisterTool(name), ignoring the signal. */
function legacyModelContext(): { api: { registerTool: (tool: NativeToolDescriptor) => void; unregisterTool: (name: string) => void }; tools: Map<string, NativeToolDescriptor> } {
  const tools = new Map<string, NativeToolDescriptor>();
  return {
    api: {
      registerTool: (tool) => {
        tools.set(tool.name, tool);
      },
      unregisterTool: (name) => {
        if (!tools.delete(name)) {
          throw new Error(`${name} is not registered`);
        }
      },
    },
    tools,
  };
}

/* ----------------------------------------------------------------- tests */

async function testRegistration(): Promise<void> {
  console.log("\n--- Test: every tool registers with a schema, annotations and a distinct description ---");
  const fake = documentModelContext();
  const context = getModelContext({ document: { modelContext: fake.api } });
  assertEqual(context?.source, "document", "document.modelContext is found");
  const h = harness({});
  const controller = new AbortController();
  const summary = await registerPageTools(context, buildPageTools(h.deps), controller.signal);

  const expected = ["search_cases", "open_case", "get_case_context", "get_oncall", "start_investigation", "get_investigation", "prepare_reply", "propose_action"];
  assertEqual(summary.registered, expected, "all eight tools registered, in order");
  assertEqual(summary.failed, [], "nothing failed");
  assertEqual([...fake.tools.keys()], expected, "the browser holds all eight");

  const descriptions = new Set<string>();
  for (const tool of fake.tools.values()) {
    assertEqual(tool.inputSchema.type, "object", `${tool.name}: object schema`);
    assertEqual(tool.inputSchema.additionalProperties, false, `${tool.name}: no extra properties`);
    for (const name of tool.inputSchema.required) {
      assert(name in tool.inputSchema.properties, `${tool.name}: required "${name}" is a declared property`);
    }
    for (const [name, property] of Object.entries(tool.inputSchema.properties)) {
      assert(property.description.length > 0, `${tool.name}.${name} is described`);
    }
    assert(tool.description.length > 40 && tool.description.length <= 500, `${tool.name}: description within the 500-char budget (${tool.description.length})`);
    assert(!descriptions.has(tool.description), `${tool.name}: description is distinct`);
    descriptions.add(tool.description);
    assertEqual(typeof tool.execute, "function", `${tool.name}: has execute`);
  }

  const annotations = Object.fromEntries([...fake.tools.values()].map((tool) => [tool.name, tool.annotations]));
  assertEqual(annotations.search_cases, { readOnlyHint: true }, "search_cases is read-only");
  assertEqual(annotations.get_case_context, { readOnlyHint: true, untrustedContentHint: true }, "get_case_context is read-only and untrusted");
  assertEqual(annotations.get_oncall, { readOnlyHint: true }, "get_oncall is read-only");
  assertEqual(annotations.start_investigation, { readOnlyHint: false }, "start_investigation is not read-only");
  assertEqual(annotations.get_investigation, { readOnlyHint: true, untrustedContentHint: true }, "get_investigation is read-only and untrusted");
  assertEqual(annotations.prepare_reply?.readOnlyHint, false, "prepare_reply is not read-only");
  assertEqual(annotations.propose_action, { consequentialHint: true, readOnlyHint: false }, "propose_action is consequential");
  assertEqual(fake.tools.get("search_cases")?.inputSchema.properties.limit?.maximum, SEARCH_MAX_LIMIT, "search limit capped in the schema");

  controller.abort();
  assertEqual(fake.tools.size, 0, "aborting the signal unregisters every tool");
  console.log("PASS");
}

async function testCleanupFlavours(): Promise<void> {
  console.log("\n--- Test: abort unregisters on older builds too (unregisterTool / returned handle), and late registrations are taken back ---");
  const tools = buildPageTools(harness({}).deps);

  const legacy = legacyModelContext();
  const legacyContext = getModelContext({ navigator: { modelContext: legacy.api } });
  assertEqual(legacyContext?.source, "navigator", "navigator.modelContext is the fallback");
  const legacyController = new AbortController();
  const legacySummary = await registerPageTools(legacyContext, tools, legacyController.signal);
  assertEqual(legacySummary.registered.length, 8, "legacy: all registered");
  legacyController.abort();
  assertEqual(legacy.tools.size, 0, "legacy: abort calls unregisterTool for each");

  const handles: string[] = [];
  const handleContext: PageModelContext = {
    api: {
      registerTool: (tool) => {
        handles.push(tool.name);
        return { unregister: () => handles.splice(handles.indexOf(tool.name), 1) };
      },
    },
    source: "navigator",
  };
  const handleController = new AbortController();
  await registerPageTools(handleContext, tools, handleController.signal);
  assertEqual(handles.length, 8, "handle style: all registered");
  handleController.abort();
  assertEqual(handles.length, 0, "handle style: abort calls each handle's unregister");

  /* Abort while the second registration is still pending: the first is undone by the abort, the second as soon as it lands. */
  const slow = legacyModelContext();
  let release: () => void = () => undefined;
  let callCount = 0;
  const slowContext: PageModelContext = {
    api: {
      registerTool: (tool: NativeToolDescriptor) => {
        callCount += 1;
        slow.api.registerTool(tool);
        return callCount === 2 ? new Promise<void>((resolve) => (release = resolve)) : undefined;
      },
      unregisterTool: slow.api.unregisterTool,
    },
    source: "navigator",
  };
  const slowController = new AbortController();
  const pending = registerPageTools(slowContext, tools, slowController.signal);
  await new Promise((resolve) => setTimeout(resolve, 0));
  slowController.abort();
  release();
  const slowSummary = await pending;
  assertEqual(slowSummary.registered, ["search_cases"], "only the one that finished before the abort counts");
  assertEqual(slow.tools.size, 0, "and nothing is left registered");
  assertEqual(callCount, 2, "no further tools are registered after the abort");

  const already = new AbortController();
  already.abort();
  const fresh = documentModelContext();
  const none = await registerPageTools(getModelContext({ document: { modelContext: fresh.api } }), tools, already.signal);
  assertEqual(none.registered, [], "an already-aborted signal registers nothing");
  assertEqual(fresh.tools.size, 0, "the browser is untouched");
  console.log("PASS");
}

async function testAbsentApi(): Promise<void> {
  console.log("\n--- Test: no WebMCP API -> a quiet no-op; broken APIs never throw ---");
  assertEqual(getModelContext({}), null, "nothing on document or navigator");
  assertEqual(getModelContext(undefined), null, "no scope at all");
  assertEqual(getModelContext({ document: { modelContext: {} } }), null, "modelContext without registerTool is ignored");
  const throwing = {
    get document(): unknown {
      throw new Error("blocked");
    },
  };
  assertEqual(getModelContext(throwing), null, "a throwing getter is tolerated");
  const realScope = getModelContext();
  assertEqual(realScope, null, "Node's globalThis has no modelContext");

  const tools = buildPageTools(harness({}).deps);
  const summary = await registerPageTools(null, tools, new AbortController().signal);
  assertEqual(summary, { failed: [], registered: [], supported: false }, "registerPageTools(null) is a no-op");

  const rejecting: PageModelContext = {
    api: {
      registerTool: (tool) => {
        if (tool.name === "open_case") {
          throw new Error("duplicate name");
        }
        return Promise.resolve();
      },
    },
    source: "document",
  };
  const partial = await registerPageTools(rejecting, tools, new AbortController().signal);
  assertEqual(partial.failed, [{ error: "duplicate name", name: "open_case" }], "a rejected tool is reported");
  assertEqual(partial.registered.length, 7, "the others still register");

  const exploding: PageTool = { ...tools[0]!, name: "boom", run: () => Promise.reject(new Error("kaboom")) };
  const nativeText = await toNativeTool(exploding, "document").execute({}, { signal: new AbortController().signal });
  assert(typeof nativeText === "string" && nativeText.startsWith("Error: boom failed unexpectedly (kaboom)"), "a crashing tool answers with an error string");
  const nativeMcp = await toNativeTool(exploding, "navigator").execute({});
  assert(typeof nativeMcp === "object" && nativeMcp.isError === true && (nativeMcp.content[0]?.text ?? "").includes("kaboom"), "navigator builds get an MCP error result");
  assertEqual(toNativeResult({ ok: true, text: "fine" }, "document"), "fine", "success is a plain string for document.modelContext");
  assertEqual(toNativeResult({ ok: true, text: "fine" }, "navigator"), { content: [{ text: "fine", type: "text" }] }, "and MCP content for navigator.modelContext");
  console.log("PASS");
}

async function testArgValidation(): Promise<void> {
  console.log("\n--- Test: arguments are validated in code with actionable errors ---");
  const h = harness({ "GET /api/tracker": () => okResult(LIST) });

  const limit = await run(h, "search_cases", { limit: 50 });
  assert(!limit.ok && limit.text.includes('"limit" must be a whole number from 1 to 20'), `limit over 20 rejected (${limit.text})`);
  const view = await run(h, "search_cases", { view: "everything" });
  assert(!view.ok && view.text.includes('"view" must be one of: needs_attention'), "unknown view rejected with the list");
  const unknown = await run(h, "search_cases", { ticket: "TS-1" });
  assert(!unknown.ok && unknown.text.includes('Unknown argument "ticket"') && unknown.text.includes("Allowed: limit, query, view"), "unknown argument named");
  const nulls = await run(h, "search_cases", { limit: null, query: null, view: null });
  assert(nulls.ok, "nulls count as omitted");
  const notObject = await run(h, "search_cases", [1, 2]);
  assert(!notObject.ok && notObject.text.includes("JSON object"), "an array is rejected");
  const asString = await run(h, "search_cases", '{"query":"acme","limit":"2"}');
  assert(asString.ok, "a JSON string of arguments is accepted");

  const badKey = await run(h, "open_case", { key: "PROJ-1" });
  assert(!badKey.ok && badKey.text.includes('"key" must be a TS ticket key like "TS-123"'), "non-TS key rejected");
  const missingKey = await run(h, "get_case_context", {});
  assert(!missingKey.ok && missingKey.text.startsWith('Missing required argument "key"'), "missing key named");

  const noConversation = await run(h, "prepare_reply", { body: "hi", key: "TS-1", target: "slack" });
  assert(!noConversation.ok && noConversation.text.includes('needs "conversation_id"'), "slack target needs a conversation");
  const badConversation = await run(h, "prepare_reply", { body: "hi", conversation_id: "general", key: "TS-1", target: "slack" });
  assert(!badConversation.ok && badConversation.text.includes('"conversation_id" must look like'), "malformed conversation id rejected");
  const strayConversation = await run(h, "prepare_reply", { body: "hi", conversation_id: CONVERSATION.id, key: "TS-1", target: "internal" });
  assert(!strayConversation.ok && strayConversation.text.includes('only applies to target "slack"'), "conversation id on a Jira target rejected");
  const emptyBody = await run(h, "prepare_reply", { body: "   ", key: "TS-1", target: "public" });
  assert(!emptyBody.ok && emptyBody.text.includes('Missing required argument "body"'), "blank body rejected");
  const badTarget = await run(h, "prepare_reply", { body: "hi", key: "TS-1", target: "email" });
  assert(!badTarget.ok && badTarget.text.includes('"target" must be one of: public, internal, slack'), "unknown target rejected");

  const noVisibility = await run(h, "propose_action", { body: "x", key: "TS-1", operation: "jira_comment" });
  assert(!noVisibility.ok && noVisibility.text.includes('needs "visibility"'), "comment without visibility rejected");
  const stray = await run(h, "propose_action", { body: "x", key: "TS-1", operation: "jira_priority", priority: "High" });
  assert(!stray.ok && stray.text.includes('"body" doesn\'t apply to jira_priority'), "a field for another operation is pointed out");
  const badOp = await run(h, "propose_action", { key: "TS-1", operation: "delete_ticket" });
  assert(!badOp.ok && badOp.text.includes('"operation" must be one of: jira_comment'), "unknown operation rejected");
  const badCp = await run(h, "propose_action", { cp_key: "TS-9", key: "TS-1", operation: "jira_link_cp" });
  assert(!badCp.ok && badCp.text.includes('"cp_key" must be a CP key'), "non-CP link rejected");
  const badRun = await run(h, "get_investigation", { run_id: "../../etc" });
  assert(!badRun.ok && badRun.text.includes("doesn't look like a run id"), "path-like run id rejected");

  assertEqual(normalizeTicketKey(" ts-42 "), "TS-42", "keys are trimmed and upper-cased");
  assertEqual(parseConversationId("C0TECHSUP:1727881200.000100"), { channel: "C0TECHSUP", threadTs: "1727881200.000100" }, "conversation ids split");
  assert(h.calls.every((call) => call.method === "GET"), "no validation failure ever POSTs");
  console.log("PASS");
}

async function testSearchCases(): Promise<void> {
  console.log("\n--- Test: search_cases selects with the tracker's own view, search and sort rules ---");
  const h = harness({ "GET /api/tracker": () => okResult(LIST) });

  const acme = await run(h, "search_cases", { query: "acme" });
  assert(acme.ok, "search succeeds");
  const parsed = JSON.parse(acme.text) as { cases: Array<Record<string, unknown>>; matched: number; shown: number; view: string };
  assertEqual(parsed.view, "All open", "defaults to All open");
  assertEqual(
    parsed.cases.map((row) => row.key),
    ["TS-1", "TS-4"],
    "open Acme tickets only (TS-3 is closed), breached SLA first",
  );
  const first = parsed.cases[0] ?? {};
  assertEqual(first.priority, "Critical", "priority");
  assertEqual(first.status, "In Progress", "status");
  assertEqual(first.whoseMove, "On TS", "whose move, as the UI labels it");
  assertEqual(first.sla, "Breached 2h", "SLA text");
  assert(Array.isArray(first.attention) && String((first.attention as string[])[0]).startsWith("SLA breached"), "attention reasons included");

  const critical = await run(h, "search_cases", { limit: 1, view: "critical" });
  const criticalParsed = JSON.parse(critical.text) as { cases: Array<{ key: string }>; matched: number; more?: string; shown: number };
  assertEqual(criticalParsed.matched, 2, "two open Critical tickets");
  assertEqual(criticalParsed.cases.map((row) => row.key), ["TS-1"], "limit 1 returns the most urgent");
  assert(typeof criticalParsed.more === "string", "and says more match");

  const unassigned = await run(h, "search_cases", { view: "unassigned" });
  const unassignedParsed = JSON.parse(unassigned.text) as { cases: Array<{ attention: string[]; key: string; sla: string }> };
  assertEqual(unassignedParsed.cases.map((row) => row.key), ["TS-2"], "unassigned view");
  assert(unassignedParsed.cases[0]?.attention.includes("Unassigned") === true, "with its Unassigned reason");
  assertEqual(unassignedParsed.cases[0]?.sla, "Due in 3h", "running SLA text");

  const closed = await run(h, "search_cases", { query: "login", view: "closed_recent" });
  assertEqual((JSON.parse(closed.text) as { cases: Array<{ key: string }> }).cases.map((row) => row.key), ["TS-3"], "closed view finds the resolved ticket");

  const nothing = await run(h, "search_cases", { query: "zzz" });
  const nothingParsed = JSON.parse(nothing.text) as { hint?: string; matched: number };
  assertEqual(nothingParsed.matched, 0, "no match");
  assert(typeof nothingParsed.hint === "string", "with a hint");

  const building = harness({ "GET /api/tracker": () => okResult({ ...LIST, builtAt: null, tickets: [] }) });
  const notYet = await run(building, "search_cases", {});
  assert(!notYet.ok && notYet.text.includes("still being built"), "first build in progress is explained");

  const many = harness({
    "GET /api/tracker": () => okResult({ ...LIST, tickets: Array.from({ length: 40 }, (_, index) => ticket(`TS-${100 + index}`, { summary: "x".repeat(300) })) }),
  });
  const big = await run(many, "search_cases", { limit: 20 });
  assert(big.text.length <= 4_000, `search output stays within budget (${big.text.length})`);
  const bigParsed = JSON.parse(big.text) as { cases: Array<{ summary: string }> };
  assert(bigParsed.cases.every((row) => row.summary.length <= 120), "summaries are clipped");

  const denied = harness({ "GET /api/tracker": () => ({ error: "Identify yourself first.", ok: false, status: 401 }) });
  const deniedResult = await run(denied, "search_cases", {});
  assert(!deniedResult.ok && deniedResult.text.includes("no longer identified"), "a 401 says how to fix it");
  console.log("PASS");
}

async function testOpenCaseAndContext(): Promise<void> {
  console.log("\n--- Test: open_case dispatches (or navigates), get_case_context is compact and clipped ---");
  const timeline = Array.from({ length: 40 }, (_, index) => timelineItem(index, `${"word ".repeat(200)}end ${index}`));
  const h = harness({ "GET /api/tracker/TS-1": () => okResult(detail(timeline)) });

  const opened = await run(h, "open_case", { key: "ts-1" });
  assert(opened.ok, "open succeeds");
  assertEqual(h.events, [{ detail: { key: "TS-1" }, type: UI_EVENTS.openCase }], "openCase dispatched with the normalized key");
  assertEqual(h.calls.length, 0, "opening fetches nothing");

  h.setLocation("/escalations", null);
  const away = await run(h, "open_case", { key: "TS-1" });
  assert(away.ok, "off the tracker still succeeds");
  assertEqual(h.navigations, ["/tracker?ticket=TS-1"], "navigates to the tracker with the ticket open");
  h.setLocation("/tracker", null);

  const context = await run(h, "get_case_context", { key: "TS-1" });
  assert(context.ok, "context loads");
  assert(context.text.length <= 12_000, `context within budget (${context.text.length})`);
  const parsed = JSON.parse(context.text) as {
    case: { key: string; sla: string };
    conversations: Array<{ conversation_id: string }>;
    timeline: Array<{ body?: string; title: string }>;
    timelineShown: number;
    timelineTotal: number;
  };
  assertEqual(parsed.case.key, "TS-1", "the case");
  assertEqual(parsed.conversations[0]?.conversation_id, CONVERSATION.id, "conversation ids are given for Slack replies");
  assertEqual(parsed.timelineTotal, 40, "total reported");
  assert(parsed.timelineShown <= CONTEXT_TIMELINE_ITEMS && parsed.timelineShown > 0, `at most ${CONTEXT_TIMELINE_ITEMS} items (${parsed.timelineShown})`);
  assertEqual(parsed.timeline.at(-1)?.title, "Comment 39", "the newest item is kept");
  assert(parsed.timeline.every((item) => (item.body ?? "").length <= 400), "bodies are clipped");

  const small = harness({ "GET /api/tracker/TS-1": () => okResult(detail(Array.from({ length: 35 }, (_, index) => timelineItem(index, "short")))) });
  const smallParsed = JSON.parse((await run(small, "get_case_context", { key: "TS-1" })).text) as { timeline: Array<{ title: string }>; timelineShown: number };
  assertEqual(smallParsed.timelineShown, CONTEXT_TIMELINE_ITEMS, "short items: exactly the newest 30");
  assertEqual(smallParsed.timeline[0]?.title, "Comment 5", "starting at the 30th newest");

  const missing = await run(harness({}), "get_case_context", { key: "TS-999" });
  assert(!missing.ok && missing.text.includes("isn't in the tracker"), "404 explained");
  console.log("PASS");
}

async function testPrepareReply(): Promise<void> {
  console.log("\n--- Test: prepare_reply opens the case, dispatches the draft and never POSTs ---");
  const h = harness({ "GET /api/tracker/TS-1": () => okResult(detail([])) });

  const internal = await run(h, "prepare_reply", { body: "Checked the logs, looks like the import job.", key: "TS-1", target: "internal" });
  assert(internal.ok && internal.text.startsWith("Draft placed in the composer; the person must review and press Send."), `internal draft placed (${internal.text})`);
  assertEqual(
    h.events,
    [
      { detail: { key: "TS-1" }, type: UI_EVENTS.openCase },
      { detail: { body: "Checked the logs, looks like the import job.", target: "internal", ticketKey: "TS-1" }, type: UI_EVENTS.prepareReply },
    ],
    "opens the case, then fills the composer",
  );

  h.events.length = 0;
  h.setLocation("/tracker", "TS-1");
  const slack = await run(h, "prepare_reply", { body: "Looking now", conversation_id: CONVERSATION.id, key: "TS-1", target: "slack" });
  assert(slack.ok, "slack draft placed");
  const expected: PrepareReplyDetail = { body: "Looking now", channel: "C0TECHSUP", target: "slack", threadTs: "1727881200.000100", ticketKey: "TS-1" };
  assertEqual(h.events, [{ detail: expected, type: UI_EVENTS.prepareReply }], "already open: only the draft, split into channel and threadTs");

  h.events.length = 0;
  const unlinked = await run(h, "prepare_reply", { body: "x", conversation_id: "C0OTHER:1727881299.000200", key: "TS-1", target: "slack" });
  assert(!unlinked.ok && unlinked.text.includes("isn't linked to TS-1") && unlinked.text.includes(CONVERSATION.id), "an unlinked thread is refused with the linked ones listed");
  assertEqual(h.events.length, 0, "and nothing is dispatched");

  const slow = harness({}, { caseState: "timeout" });
  const loading = await run(slow, "prepare_reply", { body: "x", key: "TS-1", target: "public" });
  assert(loading.ok && loading.text.includes("still loading"), "a slow panel is reported honestly");
  assertEqual(slow.events.at(-1)?.type, UI_EVENTS.prepareReply, "but the draft is still dispatched");

  const untracked = harness({}, { caseState: "not_tracked" });
  const noComposer = await run(untracked, "prepare_reply", { body: "x", key: "TS-77", target: "internal" });
  assert(!noComposer.ok && noComposer.text.includes("isn't in the tracker"), "a ticket outside the tracker has no composer: not a fake success");
  assertEqual(untracked.events.map((event) => event.type), [UI_EVENTS.openCase], "it was opened, but no draft was dispatched");

  const away = harness({});
  away.setLocation("/", null);
  const navigating = await run(away, "prepare_reply", { body: "x", key: "TS-1", target: "public" });
  assert(navigating.ok && navigating.text.includes("prepare_reply again once the page has loaded"), "off the tracker: navigate first");
  assertEqual(away.navigations, ["/tracker?ticket=TS-1"], "to the ticket");
  assertEqual(away.events.length, 0, "no draft into a page that is leaving");

  for (const recorder of [h, slow, untracked, away]) {
    assert(
      recorder.calls.every((call) => call.method === "GET"),
      "prepare_reply never POSTs",
    );
  }
  console.log("PASS");
}

async function testProposeAction(): Promise<void> {
  console.log("\n--- Test: propose_action files a proposal, refreshes the panel, never executes ---");
  const proposals: CreateProposalRequest[] = [];
  const options: JiraOptionsResponse = {
    assignees: [
      { accountId: "557058:11111111-2222-3333-4444-555555555555", displayName: "Jane Doe" },
      { accountId: "557058:66666666-7777-8888-9999-000000000000", displayName: "Jane Smith" },
      { accountId: "5b10ac8d82e05b22cc7d4ef5", displayName: "Raj Kumar" },
    ],
    priorities: ["Critical", "High", "Medium", "Low"],
    transitions: [
      { id: "31", name: "Waiting for customer", toStatus: "Waiting for customer" },
      { id: "41", name: "Escalate to product", toStatus: "Waiting for product" },
    ],
    version: iso(-1 * HOUR),
  };
  const proposal = (request: CreateProposalRequest): ActionProposal => ({
    args: request.draft.args,
    createdAt: iso(0),
    createdBy: "acc-me",
    expectedVersion: iso(-1 * HOUR),
    expiresAt: iso(DAY),
    id: `prop-${proposals.length}`,
    source: { type: "browser_agent" },
    status: "pending",
    ticketKey: request.draft.ticketKey,
  });
  const h = harness({
    "GET /api/tracker/TS-1": () => okResult(detail([])),
    "GET /api/tracker/TS-1/jira-options": () => okResult(options),
    "GET /api/tracker/TS-1/jira-options?q=jane": () => okResult({ ...options, assignees: options.assignees.slice(0, 2) }),
    "GET /api/tracker/TS-1/jira-options?q=raj": () => okResult({ ...options, assignees: options.assignees.slice(2) }),
    "POST /api/actions/proposals": (call) => {
      const request = call.body as CreateProposalRequest;
      proposals.push(request);
      return okResult({ proposal: proposal(request) }, 201);
    },
  });

  const comment = await run(h, "propose_action", { body: "We found the cause.", key: "TS-1", operation: "jira_comment", rationale: "Customer asked for an update", visibility: "public" });
  assert(comment.ok && comment.text.startsWith("Proposal prop-1 is waiting for approval in the ticket panel"), `proposal filed (${comment.text})`);
  assertEqual(
    proposals[0],
    { draft: { args: { body: "We found the cause.", operation: "jira_comment", visibility: "public" }, rationale: "Customer asked for an update", ticketKey: "TS-1" } },
    "POSTed exactly the draft",
  );
  assertEqual(
    h.events,
    [
      { detail: { key: "TS-1" }, type: UI_EVENTS.openCase },
      { detail: { ticketKey: "TS-1" }, type: UI_EVENTS.proposalsChanged },
    ],
    "opens the case and tells the proposals list to refetch",
  );

  await run(h, "propose_action", { key: "TS-1", operation: "jira_transition", transition: "waiting for product" });
  assertEqual(proposals[1]?.draft.args, { operation: "jira_transition", transitionId: "41", transitionName: "Escalate to product" }, "transition resolved by target status");
  const badTransition = await run(h, "propose_action", { key: "TS-1", operation: "jira_transition", transition: "Done" });
  assert(!badTransition.ok && badTransition.text.includes('"Waiting for customer" -> Waiting for customer (id 31)'), "unknown transition lists the available ones");

  const ambiguous = await run(h, "propose_action", { assignee: "jane", key: "TS-1", operation: "jira_assign" });
  assert(!ambiguous.ok && ambiguous.text.includes("matches several people") && ambiguous.text.includes("Jane Smith"), "ambiguous assignee lists candidates");
  await run(h, "propose_action", { assignee: "raj", key: "TS-1", operation: "jira_assign" });
  assertEqual(proposals[2]?.draft.args, { accountId: "5b10ac8d82e05b22cc7d4ef5", displayName: "Raj Kumar", operation: "jira_assign" }, "unique partial name resolved");
  await run(h, "propose_action", { assignee: "Unassigned", key: "TS-1", operation: "jira_assign" });
  assertEqual(proposals[3]?.draft.args, { accountId: null, operation: "jira_assign" }, "unassign");

  await run(h, "propose_action", { key: "TS-1", operation: "jira_priority", priority: "critical" });
  assertEqual(proposals[4]?.draft.args, { operation: "jira_priority", priority: "Critical" }, "priority normalized");
  await run(h, "propose_action", { cp_key: "cp-55", key: "TS-1", operation: "jira_link_cp" });
  assertEqual(proposals[5]?.draft.args, { cpKey: "CP-55", operation: "jira_link_cp" }, "CP key normalized");
  await run(h, "propose_action", { body: "On it", conversation_id: CONVERSATION.id, key: "TS-1", operation: "slack_thread_reply" });
  assertEqual(proposals[6]?.draft.args, { body: "On it", channel: "C0TECHSUP", operation: "slack_thread_reply", threadTs: "1727881200.000100" }, "slack reply split");
  await run(h, "propose_action", { body: "Need eyes on TS-1", key: "TS-1", mention_on_call: true, operation: "firefighter_escalation" });
  assertEqual(proposals[7]?.draft.args, { body: "Need eyes on TS-1", mentionOnCall: true, operation: "firefighter_escalation" }, "firefighter escalation");

  const refused = harness({ "POST /api/actions/proposals": () => ({ error: "Body is over Jira's limit.", ok: false, status: 400 }) });
  const refusedResult = await run(refused, "propose_action", { key: "TS-1", operation: "jira_priority", priority: "High" });
  assert(!refusedResult.ok && refusedResult.text.includes("Body is over Jira's limit."), "server validation errors are passed through");
  assertEqual(refused.events.length, 0, "a refused proposal dispatches nothing");

  const everyCall = [...h.calls, ...refused.calls];
  assert(!everyCall.some((call) => call.path === "/api/actions" || call.path.startsWith("/api/actions?")), "never calls POST /api/actions (execute)");
  assert(everyCall.filter((call) => call.method === "POST").every((call) => call.path === "/api/actions/proposals"), "the only POST is the proposal");
  console.log("PASS");
}

async function testInvestigationAndOnCall(): Promise<void> {
  console.log("\n--- Test: start/get investigation and get_oncall ---");
  const baseRun: AssistRun = { createdAt: iso(0), id: "run-1", kind: "investigation", model: "agent", startedBy: "acc-me", status: "queued", ticketKey: "TS-1", toolCalls: 0 };
  let runs: AssistRun[] = [];
  const h = harness({
    "GET /api/assist/TS-1/investigations": () => okResult({ runs }),
    "GET /api/assist/runs/run-1": () => okResult({ run: { ...baseRun, status: "running" } }),
    "GET /api/assist/runs/run-2": () =>
      okResult({
        run: {
          ...baseRun,
          finishedAt: iso(2 * MINUTE),
          id: "run-2",
          result: {
            customerDraft: "We're on it.",
            facts: [{ sources: [{ kind: "jira_comment", label: "TS-1 comment by Jane" }], text: "The import fails on row 12." }],
            hypotheses: ["Bad NPI format"],
            missing: ["Which file version"],
            nextStep: "Ask for the file",
            proposedActions: [{ args: { body: "x", operation: "jira_comment", visibility: "internal" }, proposalId: "prop-9", rationale: "Log findings", ticketKey: "TS-1" }],
            summary: "Roster import fails on a malformed row.",
          },
          status: "succeeded",
          toolCalls: 7,
        },
      }),
    "POST /api/assist/TS-1/investigations": () => okResult({ run: baseRun }, 202),
  });

  const started = await run(h, "start_investigation", { key: "TS-1" });
  assert(started.ok && started.text.includes('run_id "run-1"'), "returns the run id");
  assertEqual(h.calls.map((call) => `${call.method} ${call.path}`), ["GET /api/assist/TS-1/investigations", "POST /api/assist/TS-1/investigations"], "checks for a running one, then starts");

  runs = [{ ...baseRun, id: "run-0", status: "running" }];
  h.calls.length = 0;
  const reused = await run(h, "start_investigation", { key: "TS-1" });
  assert(reused.ok && reused.text.includes('already running: run_id "run-0"'), "an active run is returned instead");
  assert(!h.calls.some((call) => call.method === "POST"), "without starting another");

  const pending = JSON.parse((await run(h, "get_investigation", { run_id: "run-1" })).text) as { hint?: string; status: string };
  assertEqual(pending.status, "running", "running status");
  assert(typeof pending.hint === "string", "with a when-to-poll hint");
  const done = JSON.parse((await run(h, "get_investigation", { run_id: "run-2" })).text) as {
    facts: Array<{ sources: string[]; text: string }>;
    proposedActions: Array<{ proposalId: string }>;
    summary: string;
  };
  assertEqual(done.summary, "Roster import fails on a malformed row.", "summary");
  assertEqual(done.facts[0]?.sources, ["TS-1 comment by Jane"], "facts keep their sources");
  assertEqual(done.proposedActions[0]?.proposalId, "prop-9", "proposal ids surfaced");

  const notConfigured: OnCallResponse = { at: iso(0), configured: false, fetchedAt: null, next: [], now: [], upcoming: [] };
  const off = await run(harness({ "GET /api/oncall": () => okResult(notConfigured) }), "get_oncall", {});
  assert(off.ok && off.text.includes("isn't connected yet"), "unconfigured calendar explained");

  const shift = (id: string, region: string, startOffset: number): OnCallResponse["now"][number] => ({
    allDay: false,
    end: iso(startOffset + 12 * HOUR),
    id,
    people: [{ name: `${region} Person`, slackUserId: "U123" }],
    region,
    start: iso(startOffset),
    title: `${region} on call`,
  });
  const schedule: OnCallResponse = {
    at: iso(0),
    configured: true,
    fetchedAt: iso(-MINUTE),
    next: [shift("b", "US", 6 * HOUR)],
    now: [shift("a", "Asia/Europe", -6 * HOUR)],
    timeZone: "UTC",
    upcoming: [shift("a", "Asia/Europe", -6 * HOUR), shift("b", "US", 6 * HOUR)],
  };
  const on = JSON.parse((await run(harness({ "GET /api/oncall": () => okResult(schedule) }), "get_oncall", {})).text) as {
    now: Array<{ people: Array<{ name: string }>; region: string }>;
    upcoming: unknown[];
  };
  assertEqual(on.now[0]?.region, "Asia/Europe", "current region");
  assertEqual(on.now[0]?.people[0]?.name, "Asia/Europe Person", "who is on call");
  assertEqual(on.upcoming.length, 1, "upcoming leaves out the current shift");
  console.log("PASS");
}

async function main(): Promise<void> {
  await testRegistration();
  await testCleanupFlavours();
  await testAbsentApi();
  await testArgValidation();
  await testSearchCases();
  await testOpenCaseAndContext();
  await testPrepareReply();
  await testProposeAction();
  await testInvestigationAndOnCall();
}

main()
  .then(() => {
    console.log("\nAll WebMCP tests passed.");
    process.exit(0);
  })
  .catch((error: unknown) => {
    console.error("\nWebMCP test failed:", error);
    process.exit(1);
  });
