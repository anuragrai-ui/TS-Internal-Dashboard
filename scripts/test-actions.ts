import { executeJiraWrite, getTicketVersion, jiraErrorMessage, jiraWriteConfigFromEnv, MISSING_TOKEN_MESSAGE, plainTextToAdf } from "@/lib/actions/jiraWrites";
import { isSameOriginRequest } from "@/lib/actions/sameOrigin";
import {
  approveProposalWith,
  checkActionSafety,
  createProposalWith,
  executeActionWith,
  listTicketActionsWith,
  rejectProposalWith,
  sameVersion,
} from "@/lib/actions/service";
import { escapeSlackText, executeSlackWrite, firefighterText, onCallMentions, testModeReplyPrefix } from "@/lib/actions/slackWrites";
import { validateActionArgs } from "@/lib/actions/validate";

import type { JiraWriteConfig, JiraWriteResult } from "@/lib/actions/jiraWrites";
import type { ActionServiceDeps, TicketFacts } from "@/lib/actions/service";
import type { SlackWriteDeps, SlackWriteResult } from "@/lib/actions/slackWrites";
import type { ActionStore } from "@/lib/actions/store";
import type { JiraCredentials } from "@/lib/jiraClient";
import type { PostSlackMessageOptions } from "@/lib/slackApi";
import type { SlackConversationRef } from "@/lib/tracker/types";
import type { ActionActor, ActionArgs, ActionExecution, ExecuteActionRequest, OnCallShift } from "@/lib/workspace/types";

/**
 * Tests for the write-back action pipeline: argument validation, Jira and
 * Slack write classification, idempotency, the version check, the rate
 * limit, Slack linkage and test mode, #firefighters mentions and the
 * proposal lifecycle. Pure fakes only - no Jira, Slack or real Redis.
 *
 *   npx tsx scripts/test-actions.ts
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

/* ------------------------------------------------------------ in-memory store */

function memoryStore(): ActionStore & { raw: Map<string, unknown>; lists: Map<string, unknown[]> } {
  const raw = new Map<string, unknown>();
  const lists = new Map<string, unknown[]>();
  return {
    del: (key) => {
      raw.delete(key);
      lists.delete(key);
      return Promise.resolve();
    },
    get: <T>(key: string) => Promise.resolve(raw.has(key) ? (structuredClone(raw.get(key)) as T) : null),
    incr: (key) => {
      const next = (typeof raw.get(key) === "number" ? (raw.get(key) as number) : 0) + 1;
      raw.set(key, next);
      return Promise.resolve(next);
    },
    lists,
    mget: <T>(keys: string[]) => Promise.resolve(keys.map((key) => (raw.has(key) ? (structuredClone(raw.get(key)) as T) : null))),
    pushCapped: (key, value, keep) => {
      const list = [structuredClone(value), ...(lists.get(key) ?? [])].slice(0, keep);
      lists.set(key, list);
      return Promise.resolve();
    },
    range: <T>(key: string, count: number) => Promise.resolve((lists.get(key) ?? []).slice(0, count).map((value) => structuredClone(value) as T)),
    raw,
    set: (key, value) => {
      raw.set(key, structuredClone(value));
      return Promise.resolve();
    },
    setIfAbsent: (key, value) => {
      if (raw.has(key)) {
        return Promise.resolve(false);
      }
      raw.set(key, structuredClone(value));
      return Promise.resolve(true);
    },
  };
}

/* ------------------------------------------------------------------ fakes */

const ACTOR: ActionActor = { accountId: "acc-jane", displayName: "Jane Doe" };
const CREDS: JiraCredentials = { apiToken: "secret-token", email: "jane@certifyos.com" };
const CHANNEL = "C07U9C0EPEH";
const ROOT_TS = "1727881200.000100";
const FIREFIGHTERS = "C06LMNLJY82";
const TEST_CHANNEL = "C0TESTCHAN1";
const VERSION = "2026-10-03T10:00:00.000+0000";

function conversation(overrides: Partial<SlackConversationRef> = {}): SlackConversationRef {
  return {
    channel: CHANNEL,
    channelName: "technical-support",
    escalationHint: false,
    firstSeenAt: "2026-10-01T00:00:00.000Z",
    id: `${CHANNEL}:${ROOT_TS}`,
    lastActivityAt: "2026-10-02T00:00:00.000Z",
    participants: 2,
    permalink: "https://certifyos.slack.com/archives/C07U9C0EPEH/p1727881200000100",
    replyCount: 3,
    rootTs: ROOT_TS,
    source: "event",
    ticketKeys: ["CP-55"],
    ...overrides,
  };
}

interface FakeWorld {
  creds: JiraCredentials | null;
  facts: TicketFacts | null;
  invalidated: string[];
  jiraWrites: Array<{ args: ActionArgs; ticketKey: string }>;
  jiraResult: JiraWriteResult;
  liveVersion: string | null;
  slackWrites: ActionArgs[];
  slackResult: SlackWriteResult;
}

function world(overrides: Partial<FakeWorld> = {}): FakeWorld {
  return {
    creds: CREDS,
    facts: { cpKeys: ["CP-55"], priority: "High", summary: "Roster import fails", updated: VERSION },
    invalidated: [],
    jiraResult: { externalId: "10001", externalUrl: "https://certifyos.atlassian.net/browse/TS-1?focusedCommentId=10001", status: "succeeded" },
    jiraWrites: [],
    liveVersion: VERSION,
    slackResult: { externalId: `${CHANNEL}:1727900000.000200`, redirectedToTestChannel: false, status: "succeeded" },
    slackWrites: [],
    ...overrides,
  };
}

function deps(store: ActionStore | null, fake: FakeWorld, now: () => Date = () => new Date("2026-10-03T12:00:00.000Z")): ActionServiceDeps {
  let counter = 0;
  return {
    credentials: () => Promise.resolve(fake.creds),
    invalidate: (key) => {
      fake.invalidated.push(key);
      return Promise.resolve();
    },
    jira: {
      getVersion: () => Promise.resolve({ ok: true as const, version: fake.liveVersion }),
      userName: (accountId) =>
        Promise.resolve(accountId === "acc-unreachable" ? { error: "Jira timed out", ok: false as const } : { name: JIRA_USERS[accountId] ?? null, ok: true as const }),
      write: (ticketKey, args) => {
        fake.jiraWrites.push({ args, ticketKey });
        return Promise.resolve(fake.jiraResult);
      },
    },
    newId: () => `id-${String(++counter).padStart(4, "0")}-${Math.random().toString(36).slice(2, 8)}`,
    now,
    slack: {
      linkedConversation: (_ticketKey, cpKeys, channel, threadTs) =>
        Promise.resolve(cpKeys.includes("CP-55") && channel === CHANNEL && threadTs === ROOT_TS ? conversation() : null),
      write: (args) => {
        fake.slackWrites.push(args);
        return Promise.resolve(fake.slackResult);
      },
    },
    store,
    ticket: () => Promise.resolve(fake.facts),
  };
}

function request(args: ActionArgs, overrides: Partial<ExecuteActionRequest> = {}): ExecuteActionRequest {
  return { args, idempotencyKey: `key-${Math.random().toString(36).slice(2, 12)}`, ticketKey: "TS-1", ...overrides };
}

/* Who Jira says each account is - what an assignment proposal's label is checked against. */
const JIRA_USERS: Record<string, string> = { "acc-alice": "Alice Wong", "acc-bob": "Bob Stone" };

const NOTE: ActionArgs = { body: "Checked the logs - looks like a mapping issue.", operation: "jira_comment", visibility: "internal" };

/* --------------------------------------------------------------- validation */

function testValidation(): void {
  console.log("\n--- Test: validation per operation ---");
  const ok = (args: unknown): ActionArgs => {
    const result = validateActionArgs("TS-1", args);
    if (!result.ok) {
      throw new Error(`expected valid, got: ${result.error}`);
    }
    return result.args;
  };
  const bad = (args: unknown, contains: string, key = "TS-1"): void => {
    const result = validateActionArgs(key, args);
    assert(!result.ok, `rejects ${JSON.stringify(args)}`);
    if (!result.ok) {
      assert(result.error.includes(contains), `"${result.error}" mentions "${contains}"`);
    }
  };

  assertEqual(ok({ body: "  hello \n", operation: "jira_comment", visibility: "public" }), { body: "hello", operation: "jira_comment", visibility: "public" }, "comment trimmed");
  bad({ body: "   ", operation: "jira_comment", visibility: "public" }, "can't be empty");
  bad({ body: "x".repeat(10_001), operation: "jira_comment", visibility: "internal" }, "limit is 10,000");
  ok({ body: "x".repeat(10_000), operation: "jira_comment", visibility: "internal" });
  bad({ body: "hi", operation: "jira_comment", visibility: "everyone" }, "visibility");
  bad({ body: "hi", operation: "jira_comment" }, "Missing for jira_comment: visibility");
  bad({ body: "hi", operation: "jira_comment", sneaky: true, visibility: "public" }, "Unexpected field for jira_comment: sneaky");
  bad({ body: "hi", operation: "jira_comment", visibility: "public" }, "TS tickets", "CP-1");
  bad({ body: "hi", operation: "jira_comment", visibility: "public" }, "TS tickets", "ts-1");

  ok({ operation: "jira_transition", transitionId: "31", transitionName: "Start progress" });
  bad({ operation: "jira_transition", transitionId: "abc", transitionName: "Start" }, "numeric");
  bad({ operation: "jira_transition", transitionId: 31, transitionName: "Start" }, "numeric");

  assertEqual(ok({ accountId: null, displayName: "ignored", operation: "jira_assign" }), { accountId: null, operation: "jira_assign" }, "unassign drops the name");
  ok({ accountId: "712020:2c0f0b1e-aaaa-bbbb", displayName: "Bob", operation: "jira_assign" });
  bad({ accountId: "", operation: "jira_assign" }, "account id");
  bad({ accountId: "a b", operation: "jira_assign" }, "account id");

  ok({ operation: "jira_priority", priority: "Critical" });
  bad({ operation: "jira_priority", priority: "Urgent" }, "Critical, High, Medium, Low");

  assertEqual(ok({ cpKey: " cp-123 ", operation: "jira_link_cp" }), { cpKey: "CP-123", operation: "jira_link_cp" }, "CP key normalized");
  bad({ cpKey: "TS-123", operation: "jira_link_cp" }, "CP key");

  ok({ body: "On it", channel: CHANNEL, operation: "slack_thread_reply", threadTs: ROOT_TS });
  bad({ body: "On it", channel: "D0123ABCD", operation: "slack_thread_reply", threadTs: ROOT_TS }, "channel");
  bad({ body: "On it", channel: CHANNEL, operation: "slack_thread_reply", threadTs: "123" }, "ts");

  ok({ body: "Prod is down", mentionOnCall: true, operation: "firefighter_escalation" });
  bad({ body: "Prod is down", mentionOnCall: "yes", operation: "firefighter_escalation" }, "mentionOnCall");

  bad({ operation: "delete_ticket" }, 'Unknown operation "delete_ticket"');
  bad(null, "object");
  bad(["jira_comment"], "object");
  console.log("PASS");
}

function testSafetyAndVersions(): void {
  console.log("\n--- Test: safety check (own CPs allowed in Slack only) and version comparison ---");
  assert(checkActionSafety("See TS-1 for details", "TS-1", []).safe, "own key is fine");
  assert(!checkActionSafety("Same as TS-99", "TS-1", []).safe, "another ticket leaks");
  assert(!checkActionSafety("Engineering is on CP-55", "TS-1", []).safe, "a CP leaks into a public reply");
  assert(checkActionSafety("Engineering is on CP-55", "TS-1", ["CP-55"]).safe, "the ticket's own CP is fine in Slack");
  assert(!checkActionSafety("CP-555 and CP-55", "TS-1", ["CP-55"]).safe, "a longer key isn't mistaken for an allowed one");
  assert(!checkActionSafety("see https://certifyos.atlassian.net/wiki/x", "TS-1", []).safe, "wiki links leak");
  assert(!checkActionSafety("discussed in https://certify.slack.com/archives/C07U9C0EPEH/p1727881200000100", "TS-1", []).safe, "an internal Slack link leaks into a customer reply");
  assert(!checkActionSafety("details: https://ts-internal-dashboard.vercel.app/tracker?ticket=TS-1", "TS-1", []).safe, "a dashboard link leaks into a customer reply");
  assert(checkActionSafety("see https://certify.slack.com/archives/C07U9C0EPEH/p1727881200000100", "TS-1", [], true).safe, "Slack links are fine in an internal Slack post");

  assert(sameVersion("2026-10-03T10:00:00.000+0000", "2026-10-03T10:00:00.000Z"), "same instant, different spelling");
  assert(!sameVersion("2026-10-03T10:00:00.000+0000", "2026-10-03T10:00:01.000+0000"), "a second later is a change");
  console.log("PASS");
}

function testSameOrigin(): void {
  console.log("\n--- Test: cross-site guard ---");
  assert(isSameOriginRequest(new Headers({ host: "ts.example.com" })), "no Origin passes");
  assert(isSameOriginRequest(new Headers({ host: "ts.example.com", origin: "https://ts.example.com" })), "same host passes");
  assert(!isSameOriginRequest(new Headers({ host: "ts.example.com", origin: "https://evil.example" })), "another host is refused");
  assert(!isSameOriginRequest(new Headers({ host: "ts.example.com", origin: "null" })), "an opaque origin is refused");
  assert(isSameOriginRequest(new Headers({ host: "127.0.0.1:8000", origin: "http://127.0.0.1:8000" })), "local dev with a port passes");
  console.log("PASS");
}

/* ------------------------------------------------------------ Jira writes */

interface RecordedCall {
  body?: unknown;
  method: string;
  url: string;
}

function fakeFetch(responder: (call: RecordedCall) => Response | Error): { calls: RecordedCall[]; fetchImpl: typeof fetch } {
  const calls: RecordedCall[] = [];
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const call: RecordedCall = { method: init?.method ?? "GET", url, ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) as unknown } : {}) };
    calls.push(call);
    const outcome = responder(call);
    return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" }, status });
}

function timeoutError(): Error {
  const error = new Error("The operation was aborted due to timeout");
  error.name = "TimeoutError";
  return error;
}

const JIRA_BASE = "https://certifyos.atlassian.net";

async function testJiraWrites(): Promise<void> {
  console.log("\n--- Test: Jira writes - ADF, internal notes, transitions, links, error classification ---");

  assertEqual(
    plainTextToAdf("Hi there,\nthanks.\n\n\nSecond para\n"),
    {
      content: [
        { content: [{ text: "Hi there,", type: "text" }, { type: "hardBreak" }, { text: "thanks.", type: "text" }], type: "paragraph" },
        { content: [{ text: "Second para", type: "text" }], type: "paragraph" },
      ],
      type: "doc",
      version: 1,
    },
    "paragraphs on blank lines, hard breaks on single newlines",
  );

  assertEqual(jiraWriteConfigFromEnv({ JIRA_BASE_URL: "https://certifyos.atlassian.net/" }), { baseUrl: JIRA_BASE }, "base URL normalized");
  assertEqual(jiraWriteConfigFromEnv({ JIRA_BASE_URL: "http://certifyos.atlassian.net" }), null, "plain http refused");
  assertEqual(jiraWriteConfigFromEnv({}), null, "missing base URL");

  /* Internal note: properties + comment link. */
  const note = fakeFetch(() => json(201, { id: "10042" }));
  const noteResult = await executeJiraWrite("TS-1", NOTE, CREDS, { baseUrl: JIRA_BASE, fetchImpl: note.fetchImpl });
  assertEqual(noteResult, { externalId: "10042", externalUrl: `${JIRA_BASE}/browse/TS-1?focusedCommentId=10042`, status: "succeeded" }, "note result");
  assertEqual(note.calls[0]?.method, "POST", "comment is a POST");
  assertEqual(note.calls[0]?.url, `${JIRA_BASE}/rest/api/3/issue/TS-1/comment`, "comment URL");
  assertEqual((note.calls[0]?.body as { properties?: unknown }).properties, [{ key: "sd.public.comment", value: { internal: true } }], "internal property");

  const reply = fakeFetch(() => json(201, { id: "7" }));
  await executeJiraWrite("TS-1", { body: "Hello", operation: "jira_comment", visibility: "public" }, CREDS, { baseUrl: JIRA_BASE, fetchImpl: reply.fetchImpl });
  assert((reply.calls[0]?.body as { properties?: unknown }).properties === undefined, "a public reply has no internal property");

  /* Transition: the id must be on the person's live list; Jira's own error is surfaced. */
  const missing = fakeFetch(() => json(200, { transitions: [{ id: "11", name: "Close", to: { name: "Closed" } }] }));
  const missingResult = await executeJiraWrite("TS-1", { operation: "jira_transition", transitionId: "31", transitionName: "Start" }, CREDS, {
    baseUrl: JIRA_BASE,
    fetchImpl: missing.fetchImpl,
  });
  assertEqual(missingResult.status, "failed", "unavailable transition fails");
  assertEqual(missing.calls.length, 1, "...without a POST");

  const needsResolution = fakeFetch((call) =>
    call.method === "GET" ? json(200, { transitions: [{ id: "11", name: "Close", to: { name: "Closed" } }] }) : json(400, { errorMessages: [], errors: { resolution: "Resolution is required." } }),
  );
  const resolutionResult = await executeJiraWrite("TS-1", { operation: "jira_transition", transitionId: "11", transitionName: "Close" }, CREDS, {
    baseUrl: JIRA_BASE,
    fetchImpl: needsResolution.fetchImpl,
  });
  assertEqual(resolutionResult, { error: "resolution: Resolution is required.", status: "failed" }, "Jira's field error surfaced");

  const mislabelled = fakeFetch(() => json(200, { transitions: [{ id: "11", name: "Close", to: { name: "Closed" } }] }));
  const mislabelledResult = await executeJiraWrite("TS-1", { operation: "jira_transition", transitionId: "11", transitionName: "Add comment" }, CREDS, {
    baseUrl: JIRA_BASE,
    fetchImpl: mislabelled.fetchImpl,
  });
  assert(mislabelledResult.status === "failed" && mislabelledResult.error.includes('is "Close"'), "a label that names a different transition is refused");
  assertEqual(mislabelled.calls.length, 1, "...without a POST");
  const byStatus = fakeFetch((call) => (call.method === "GET" ? json(200, { transitions: [{ id: "11", name: "Close", to: { name: "Closed" } }] }) : new Response(null, { status: 204 })));
  assertEqual(
    (await executeJiraWrite("TS-1", { operation: "jira_transition", transitionId: "11", transitionName: "closed" }, CREDS, { baseUrl: JIRA_BASE, fetchImpl: byStatus.fetchImpl })).status,
    "succeeded",
    "the target status name is an accepted label",
  );

  /* Timeout on the write itself -> uncertain; on a pre-read -> failed. */
  const timedOut = fakeFetch(() => timeoutError());
  const timeoutResult = await executeJiraWrite("TS-1", NOTE, CREDS, { baseUrl: JIRA_BASE, fetchImpl: timedOut.fetchImpl });
  assertEqual(timeoutResult.status, "uncertain", "timeout on a write is uncertain");
  assert(timeoutResult.status === "uncertain" && timeoutResult.error.includes("Check Jira before retrying"), "uncertain says to check first");

  const serverError = fakeFetch(() => json(503, { errorMessages: ["Service unavailable"] }));
  assertEqual((await executeJiraWrite("TS-1", NOTE, CREDS, { baseUrl: JIRA_BASE, fetchImpl: serverError.fetchImpl })).status, "uncertain", "5xx on a write is uncertain");

  const readTimeout = fakeFetch(() => timeoutError());
  assertEqual(
    (await executeJiraWrite("TS-1", { operation: "jira_transition", transitionId: "11", transitionName: "Close" }, CREDS, { baseUrl: JIRA_BASE, fetchImpl: readTimeout.fetchImpl })).status,
    "failed",
    "timeout on the pre-read is a plain failure",
  );

  const forbidden = fakeFetch(() => json(403, { errorMessages: ["You do not have permission to edit issues in this project."] }));
  const forbiddenResult = await executeJiraWrite("TS-1", { operation: "jira_priority", priority: "Critical" }, CREDS, { baseUrl: JIRA_BASE, fetchImpl: forbidden.fetchImpl });
  assert(forbiddenResult.status === "failed" && forbiddenResult.error.includes("permission"), "403 fails with Jira's words");
  assertEqual(forbidden.calls[0]?.method, "PUT", "priority is a PUT");
  assertEqual(forbidden.calls[0]?.body, { fields: { priority: { name: "Critical" } } }, "priority body");

  /* Assign: PUT with null to unassign. */
  const assign = fakeFetch(() => new Response(null, { status: 204 }));
  assertEqual((await executeJiraWrite("TS-1", { accountId: null, operation: "jira_assign" }, CREDS, { baseUrl: JIRA_BASE, fetchImpl: assign.fetchImpl })).status, "succeeded", "unassign");
  assertEqual(assign.calls[0]?.body, { accountId: null }, "unassign body");

  /* Link CP: the CP must exist; then Relates with inward = ticket, outward = CP. */
  const noCp = fakeFetch(() => json(404, { errorMessages: ["Issue does not exist"] }));
  const noCpResult = await executeJiraWrite("TS-1", { cpKey: "CP-9", operation: "jira_link_cp" }, CREDS, { baseUrl: JIRA_BASE, fetchImpl: noCp.fetchImpl });
  assert(noCpResult.status === "failed" && noCpResult.error.includes("CP-9 doesn't exist"), "missing CP fails");
  assertEqual(noCp.calls.length, 1, "...without linking");

  const link = fakeFetch((call) => (call.method === "GET" ? json(200, { fields: { summary: "Fix" }, key: "CP-9" }) : new Response(null, { status: 201 })));
  assertEqual((await executeJiraWrite("TS-1", { cpKey: "CP-9", operation: "jira_link_cp" }, CREDS, { baseUrl: JIRA_BASE, fetchImpl: link.fetchImpl })).status, "succeeded", "link");
  assertEqual(link.calls[1]?.body, { inwardIssue: { key: "TS-1" }, outwardIssue: { key: "CP-9" }, type: { name: "Relates" } }, "link body");

  /* Version read. */
  const version = fakeFetch(() => json(200, { fields: { updated: VERSION } }));
  assertEqual(await getTicketVersion("TS-1", CREDS, { baseUrl: JIRA_BASE, fetchImpl: version.fetchImpl } satisfies JiraWriteConfig), { ok: true, version: VERSION }, "version");
  assert(version.calls[0]?.url.endsWith("/issue/TS-1?fields=updated") === true, "version reads only `updated`");

  assertEqual(jiraErrorMessage(401, "{}"), "Jira rejected your token (401) - re-register it on Jira Tokens.", "401 message");
  assert(!JSON.stringify([note.calls, timedOut.calls]).includes("secret-token"), "the token never appears in a recorded call body or URL");
  console.log("PASS");
}

/* ------------------------------------------------------------ Slack writes */

interface SlackHarness {
  deps: SlackWriteDeps;
  posts: Array<{ channel: string; options: PostSlackMessageOptions; text: string }>;
}

function slackHarness(overrides: Partial<SlackWriteDeps> = {}, shifts: OnCallShift[] = []): SlackHarness {
  const posts: SlackHarness["posts"] = [];
  return {
    deps: {
      appBaseUrl: "https://ts-internal-dashboard.vercel.app",
      botInChannel: () => Promise.resolve({ inChannel: true }),
      conversationsFor: (keys) => Promise.resolve(new Map(keys.includes("CP-55") ? [["CP-55", [conversation()]]] : [])),
      firefighterChannel: () => Promise.resolve(FIREFIGHTERS),
      hasToken: () => Promise.resolve(true),
      jiraBaseUrl: JIRA_BASE,
      onCallShifts: () => Promise.resolve(shifts),
      permalink: (channel, ts) => Promise.resolve(`https://certifyos.slack.com/archives/${channel}/p${ts.replace(".", "")}`),
      post: (channel, text, options) => {
        posts.push({ channel, options, text });
        return Promise.resolve({ channel, redirected: false, ts: "1727900000.000200" });
      },
      testChannel: () => null,
      ...overrides,
    },
    posts,
  };
}

const REPLY: ActionArgs = { body: "Fix is <deploying> now & <!channel>", channel: CHANNEL, operation: "slack_thread_reply", threadTs: ROOT_TS };

async function testSlackWrites(): Promise<void> {
  console.log("\n--- Test: Slack linkage, test-mode routing and attribution ---");
  const context = { actor: ACTOR, ticket: { cpKeys: ["CP-55"], priority: "High" as const, summary: "Roster import fails" }, ticketKey: "TS-1" };

  /* Not linked to the ticket or its CPs -> refused, nothing posted. */
  const unlinked = slackHarness();
  const unlinkedResult = await executeSlackWrite(REPLY, { ...context, ticket: { cpKeys: [], priority: "High", summary: null } }, unlinked.deps);
  assert(unlinkedResult.status === "failed" && unlinkedResult.error.includes("isn't linked"), "unlinked thread refused");
  assertEqual(unlinked.posts.length, 0, "nothing posted");

  /* Linked through its CP: a real thread reply, attributed and escaped. */
  const live = slackHarness();
  const liveResult = await executeSlackWrite(REPLY, context, live.deps);
  assertEqual(liveResult.status, "succeeded", "linked reply posts");
  assertEqual(live.posts[0]?.options, { threadTs: ROOT_TS }, "posted in the thread");
  assertEqual(live.posts[0]?.text, "*Jane Doe* via TS Dashboard:\nFix is &lt;deploying&gt; now &amp; &lt;!channel&gt;", "attributed, and the body can't ping or link");
  assert(liveResult.status === "succeeded" && liveResult.externalUrl?.startsWith("https://certifyos.slack.com/") === true, "permalink returned");

  /* Test mode: top-level in the test channel, prefixed, flagged. */
  const test = slackHarness({
    post: (channel, text, options) => {
      test.posts.push({ channel, options, text });
      return Promise.resolve({ channel: TEST_CHANNEL, redirected: true, ts: "1727900000.000300" });
    },
    testChannel: () => TEST_CHANNEL,
  });
  const testResult = await executeSlackWrite(REPLY, context, test.deps);
  assertEqual(test.posts[0]?.options, {}, "no threadTs in test mode");
  assert(test.posts[0]?.text.startsWith("[Test mode - would reply in <https://certifyos.slack.com/archives/C07U9C0EPEH/p1727881200000100|#technical-support> thread]\n*Jane Doe*") === true, "test-mode prefix");
  assert(testResult.status === "succeeded" && testResult.redirectedToTestChannel, "flagged as redirected");
  assertEqual(testModeReplyPrefix({ channel: CHANNEL }), `[Test mode - would reply in #${CHANNEL} thread]`, "prefix without a permalink");

  /* Bot not in the channel -> a definite failure, before posting. */
  const outside = slackHarness({ botInChannel: () => Promise.resolve({ inChannel: false, name: "technical-support" }) });
  const outsideResult = await executeSlackWrite(REPLY, context, outside.deps);
  assert(outsideResult.status === "failed" && outsideResult.error.includes("#technical-support"), "bot not in channel");
  assertEqual(outside.posts.length, 0, "nothing posted");

  /* Slack didn't confirm -> uncertain, never "failed". */
  const silent = slackHarness({ post: () => Promise.resolve(null) });
  assertEqual((await executeSlackWrite(REPLY, context, silent.deps)).status, "uncertain", "unconfirmed post is uncertain");

  const noToken = slackHarness({ hasToken: () => Promise.resolve(false) });
  assertEqual((await executeSlackWrite(REPLY, context, noToken.deps)).status, "failed", "no token is a definite failure");

  assertEqual(escapeSlackText("a<b>&c"), "a&lt;b&gt;&amp;c", "escape");
  console.log("PASS");
}

async function testFirefighterMentions(): Promise<void> {
  console.log("\n--- Test: #firefighters escalation and on-call mentions ---");
  const shift = (people: OnCallShift["people"], region = "US"): OnCallShift => ({
    allDay: false,
    end: "2026-10-03T23:00:00.000Z",
    id: `uid:${region}`,
    people,
    region,
    start: "2026-10-03T11:00:00.000Z",
    title: `${region} on call`,
  });
  const shifts = [shift([{ name: "Ann Lee", slackUserId: "U0ANN" }, { name: "Raj Patel" }]), shift([{ name: "Ann Lee", slackUserId: "U0ANN" }, { name: "Mo Chen", slackUserId: "U0MO" }], "Asia/Europe")];

  assertEqual(onCallMentions(shifts), { mentions: ["U0ANN", "U0MO"], unresolved: ["Raj Patel"] }, "each person once");

  const context = { actor: ACTOR, ticket: { cpKeys: ["CP-55"], priority: "Critical" as const, summary: "Roster <import> down" }, ticketKey: "TS-1" };
  const harness = slackHarness({}, shifts);
  const result = await executeSlackWrite({ body: "Prod roster imports failing for all clients", mentionOnCall: true, operation: "firefighter_escalation" }, context, harness.deps);
  assertEqual(result.status, "succeeded", "posted");
  const post = harness.posts[0];
  assertEqual(post?.channel, FIREFIGHTERS, "into #firefighters");
  assertEqual(post?.options, {}, "a new message, not a thread reply");
  const text = post?.text ?? "";
  assert(text.includes(`*Ticket:* <${JIRA_BASE}/browse/TS-1|TS-1> · Critical · Roster &lt;import&gt; down`), "ticket line with Jira link, priority, escaped summary");
  assert(text.includes("<https://ts-internal-dashboard.vercel.app/tracker?ticket=TS-1|Open in the TS Dashboard>"), "tracker link");
  assert(text.includes("*On call:* <@U0ANN>, <@U0MO>, Raj Patel (not found in Slack)"), "mentions plus the unresolved name");
  assert(text.endsWith("Raised by *Jane Doe* via TS Dashboard"), "attribution");

  const nobody = firefighterText({
    actorName: "Jane",
    appBaseUrl: "https://x.test",
    body: "Help",
    jiraBaseUrl: JIRA_BASE,
    onCall: { mentions: [], unresolved: [] },
    ticket: null,
    ticketKey: "TS-1",
  });
  assert(nobody.includes("couldn't tag anyone - nobody on the on-call calendar resolves to a Slack user right now"), "says so when nobody resolves");

  const untagged = slackHarness({}, shifts);
  await executeSlackWrite({ body: "FYI", mentionOnCall: false, operation: "firefighter_escalation" }, context, untagged.deps);
  assert(!(untagged.posts[0]?.text ?? "").includes("<@"), "no mentions when mentionOnCall is off");
  console.log("PASS");
}

/* ---------------------------------------------------------------- service */

async function testIdempotency(): Promise<void> {
  console.log("\n--- Test: idempotency - duplicate, in progress, released after a failure ---");
  const store = memoryStore();
  const fake = world();
  const d = deps(store, fake);
  const req = request(NOTE, { idempotencyKey: "same-key-0001" });

  const first = await executeActionWith(d, req, ACTOR);
  assert(first.ok && first.execution.status === "succeeded", "first send succeeds");
  assertEqual(fake.jiraWrites.length, 1, "one write");
  assertEqual(fake.invalidated, ["TS-1"], "detail invalidated on success");

  const second = await executeActionWith(d, req, ACTOR);
  assert(second.ok && second.execution.status === "duplicate", "resend is a duplicate");
  assert(second.ok && first.ok && second.execution.id === first.execution.id && second.execution.externalId === "10001", "duplicate carries the earlier result");
  assertEqual(fake.jiraWrites.length, 1, "still one write");

  const otherPerson = await executeActionWith(d, req, { accountId: "acc-bob", displayName: "Bob" });
  assert(otherPerson.ok && otherPerson.execution.status === "succeeded", "keys are per person");

  const reused = await executeActionWith(d, { ...req, args: { operation: "jira_priority", priority: "Low" } }, ACTOR);
  assert(!reused.ok && reused.status === 422, "a key reused for a different action is refused");

  /* In progress. */
  await store.set("actions:idem:acc-jane:busy-key-0001", { startedAt: "2026-10-03T11:59:30.000Z", state: "in_progress" }, 60);
  const busy = await executeActionWith(d, request(NOTE, { idempotencyKey: "busy-key-0001" }), ACTOR);
  assert(!busy.ok && busy.status === 409 && busy.error.includes("already in progress"), "in progress -> 409");

  await store.set("actions:idem:acc-jane:dead-key-0001", { startedAt: "2026-10-03T11:00:00.000Z", state: "in_progress" }, 60);
  const dead = await executeActionWith(d, request(NOTE, { idempotencyKey: "dead-key-0001" }), ACTOR);
  assert(!dead.ok && dead.status === 409 && dead.error.includes("never finished"), "a stale marker says it may have happened");

  /* A definite failure releases the key: nothing happened, so the same key may try again. */
  const failing = world({ jiraResult: { error: "Nope", status: "failed" } });
  const failStore = memoryStore();
  const failed = await executeActionWith(deps(failStore, failing), request(NOTE, { idempotencyKey: "retry-key-0001" }), ACTOR);
  assert(failed.ok && failed.execution.status === "failed", "failed");
  assert(!failStore.raw.has("actions:idem:acc-jane:retry-key-0001"), "key released after a failure");
  failing.jiraResult = { externalId: "1", status: "succeeded" };
  const retried = await executeActionWith(deps(failStore, failing), request(NOTE, { idempotencyKey: "retry-key-0001" }), ACTOR);
  assert(retried.ok && retried.execution.status === "succeeded", "the same key retries after a failure");

  const badKey = await executeActionWith(d, request(NOTE, { idempotencyKey: "short" }), ACTOR);
  assert(!badKey.ok && badKey.status === 400, "short idempotency key refused");

  const noRedis = await executeActionWith(deps(null, world()), request(NOTE), ACTOR);
  assert(!noRedis.ok && noRedis.status === 503, "no Redis, no writes");

  /* The audit trail. */
  assertEqual((store.lists.get("actions:log:TS-1") ?? []).length, 2, "two executions logged for TS-1 (duplicates aren't re-logged)");
  assertEqual((store.lists.get("actions:log:all") ?? []).length, 2, "global log");
  console.log("PASS");
}

async function testConflictAndForce(): Promise<void> {
  console.log("\n--- Test: version conflict, and force ---");
  const store = memoryStore();
  const fake = world({ liveVersion: "2026-10-03T11:30:00.000+0000" });
  const d = deps(store, fake);

  const conflict = await executeActionWith(d, request({ operation: "jira_priority", priority: "Critical" }, { expectedVersion: VERSION }), ACTOR);
  assert(conflict.ok && conflict.execution.status === "conflict", "stale version -> conflict");
  assertEqual(fake.jiraWrites.length, 0, "no write on conflict");
  assertEqual(fake.invalidated.length, 0, "nothing to invalidate");

  const forced = await executeActionWith(d, request({ operation: "jira_priority", priority: "Critical" }, { expectedVersion: VERSION, force: true }), ACTOR);
  assert(forced.ok && forced.execution.status === "succeeded", "force writes anyway");
  assertEqual(fake.jiraWrites.length, 1, "one write");

  const current = await executeActionWith(d, request({ operation: "jira_priority", priority: "High" }, { expectedVersion: "2026-10-03T11:30:00.000Z" }), ACTOR);
  assert(current.ok && current.execution.status === "succeeded", "the current version (any spelling) passes");

  const unchecked = await executeActionWith(d, request({ operation: "jira_priority", priority: "Low" }, { expectedVersion: null }), ACTOR);
  assert(unchecked.ok && unchecked.execution.status === "succeeded", "no expectedVersion, no check");

  /* Slack posts aren't version-checked. */
  const slack = await executeActionWith(d, request(REPLY_SAFE, { expectedVersion: VERSION }), ACTOR);
  assert(slack.ok && slack.execution.status === "succeeded", "Slack isn't version-checked");
  console.log("PASS");
}

const REPLY_SAFE: ActionArgs = { body: "Engineering is on CP-55, update soon", channel: CHANNEL, operation: "slack_thread_reply", threadTs: ROOT_TS };

async function testUncertainMissingCredsSafety(): Promise<void> {
  console.log("\n--- Test: uncertain on timeout, missing creds, leak check ---");
  const store = memoryStore();

  const timeout = world({ jiraResult: { error: "Jira didn't answer in time - the change may have happened. Check Jira before retrying.", status: "uncertain" } });
  const uncertain = await executeActionWith(deps(store, timeout), request(NOTE, { idempotencyKey: "timeout-key-01" }), ACTOR);
  assert(uncertain.ok && uncertain.execution.status === "uncertain", "uncertain recorded");
  const again = await executeActionWith(deps(store, timeout), request(NOTE, { idempotencyKey: "timeout-key-01" }), ACTOR);
  assert(again.ok && again.execution.status === "duplicate", "an uncertain result stays pinned to its key - no blind retry");
  assertEqual(timeout.jiraWrites.length, 1, "one write attempt");
  assertEqual(timeout.invalidated.length, 0, "uncertain doesn't invalidate");

  const noCreds = world({ creds: null });
  const missing = await executeActionWith(deps(store, noCreds), request(NOTE), ACTOR);
  assert(missing.ok && missing.execution.status === "failed" && missing.execution.error === MISSING_TOKEN_MESSAGE, "missing creds -> the re-register message");
  assertEqual(noCreds.jiraWrites.length, 0, "never falls back to another account");

  const leak = world();
  const leaked = await executeActionWith(deps(store, leak), request({ body: "This is the same bug as TS-77, see CP-55", operation: "jira_comment", visibility: "public" }), ACTOR);
  assert(leaked.ok && leaked.execution.status === "failed" && (leaked.execution.error ?? "").includes("TS-77"), "a public reply naming other tickets fails");
  assertEqual(leak.jiraWrites.length, 0, "nothing written");

  const internal = await executeActionWith(deps(store, leak), request({ body: "Same as TS-77", operation: "jira_comment", visibility: "internal" }), ACTOR);
  assert(internal.ok && internal.execution.status === "succeeded", "an internal note may name other tickets");

  const slackOk = await executeActionWith(deps(store, leak), request(REPLY_SAFE), ACTOR);
  assert(slackOk.ok && slackOk.execution.status === "succeeded", "Slack may name the ticket's own CP");
  const slackLeak = await executeActionWith(deps(store, leak), request({ ...REPLY_SAFE, body: "Also see TS-900" } as ActionArgs), ACTOR);
  assert(slackLeak.ok && slackLeak.execution.status === "failed", "Slack may not name an unrelated ticket");
  console.log("PASS");
}

async function testRateLimit(): Promise<void> {
  console.log("\n--- Test: 60 writes per person per hour ---");
  const store = memoryStore();
  const d = deps(store, world());
  for (let index = 0; index < 60; index += 1) {
    const result = await executeActionWith(d, request(NOTE), ACTOR);
    assert(result.ok, `write ${index + 1} allowed`);
  }
  const limited = await executeActionWith(d, request(NOTE), ACTOR);
  assert(!limited.ok && limited.status === 429, "61st refused");
  const bob = await executeActionWith(d, request(NOTE), { accountId: "acc-bob", displayName: "Bob" });
  assert(bob.ok, "another person isn't limited");

  const nextHour = deps(store, world(), () => new Date("2026-10-03T13:00:00.000Z"));
  assert((await executeActionWith(nextHour, request(NOTE), ACTOR)).ok, "a new hour resets the count");
  console.log("PASS");
}

/* -------------------------------------------------------------- proposals */

async function testProposals(): Promise<void> {
  console.log("\n--- Test: proposal lifecycle - create, expire, edit + approve, operation change refused, reject, cap ---");
  const store = memoryStore();
  const fake = world();
  let nowMs = Date.parse("2026-10-03T12:00:00.000Z");
  const d = deps(store, fake, () => new Date(nowMs));
  const assist = { runId: "run-123", type: "assist" } as const;

  /* Create: validated, Slack linkage checked now, version from the tracker. */
  const created = await createProposalWith(d, { args: NOTE, rationale: "  Summarize the findings  ", ticketKey: "ts-1" }, assist, ACTOR);
  assert(created.ok, "created");
  if (!created.ok) {
    return;
  }
  assertEqual(created.proposal.status, "pending", "pending");
  assertEqual(created.proposal.ticketKey, "TS-1", "key normalized");
  assertEqual(created.proposal.expectedVersion, VERSION, "expectedVersion from the snapshot row");
  assertEqual(created.proposal.expiresAt, "2026-10-04T12:00:00.000Z", "expires in 24h");
  assertEqual(created.proposal.rationale, "Summarize the findings", "rationale trimmed");
  assertEqual(fake.jiraWrites.length, 0, "creating writes nothing");

  const unlinked = await createProposalWith(d, { args: { ...REPLY_SAFE, threadTs: "1727000000.000001" } as ActionArgs, ticketKey: "TS-1" }, assist, ACTOR);
  assert(!unlinked.ok && unlinked.status === 400 && unlinked.error.includes("isn't linked"), "an unlinked Slack thread can't even be proposed");
  const invalid = await createProposalWith(d, { args: { operation: "jira_priority", priority: "Urgent" } as unknown as ActionArgs, ticketKey: "TS-1" }, assist, ACTOR);
  assert(!invalid.ok && invalid.status === 400, "invalid args refused");
  const badSource = await createProposalWith(d, { args: NOTE, ticketKey: "TS-1" }, { type: "approved" } as unknown as typeof assist, ACTOR);
  assert(!badSource.ok, "an unknown source refused");

  /* An assignment's label is Jira's name for the account, never the proposer's. */
  const lying = await createProposalWith(d, { args: { accountId: "acc-alice", displayName: "Bob Stone", operation: "jira_assign" }, ticketKey: "TS-9" }, assist, ACTOR);
  assert(lying.ok && lying.proposal.args.operation === "jira_assign" && lying.proposal.args.displayName === "Alice Wong", "label replaced with Jira's name");
  const ghost = await createProposalWith(d, { args: { accountId: "acc-nobody", operation: "jira_assign" }, ticketKey: "TS-9" }, assist, ACTOR);
  assert(!ghost.ok && ghost.status === 400, "an unknown account can't be proposed");
  const unreachable = await createProposalWith(d, { args: { accountId: "acc-unreachable", displayName: "Trust me", operation: "jira_assign" }, ticketKey: "TS-9" }, assist, ACTOR);
  assert(unreachable.ok && unreachable.proposal.args.operation === "jira_assign" && unreachable.proposal.args.displayName === undefined, "unverifiable label dropped");

  /* Edit that changes the operation -> refused, still pending. */
  const switched = await approveProposalWith(d, created.proposal.id, { args: { operation: "jira_priority", priority: "Low" }, idempotencyKey: "approve-key-01" }, ACTOR);
  assert(!switched.ok && switched.status === 400 && switched.error.includes("same kind of action"), "operation change refused");
  assertEqual(fake.jiraWrites.length, 0, "nothing written");

  /* Approve with an edited body -> executes the edit; the proposal keeps what was proposed. */
  const editedArgs: ActionArgs = { body: "Edited by Jane", operation: "jira_comment", visibility: "internal" };
  const approved = await approveProposalWith(d, created.proposal.id, { args: editedArgs, idempotencyKey: "approve-key-02" }, ACTOR);
  assert(approved.ok && approved.proposal.status === "approved" && approved.execution?.status === "succeeded", "approved and executed");
  assertEqual(fake.jiraWrites[0]?.args, editedArgs, "the edit is what was written");
  assert(approved.ok && approved.execution?.proposalId === created.proposal.id, "execution links the proposal");
  assert(approved.ok && approved.proposal.executionId === approved.execution?.id && approved.proposal.decidedBy === "Jane Doe", "decision recorded");
  const twice = await approveProposalWith(d, created.proposal.id, { idempotencyKey: "approve-key-03" }, ACTOR);
  assert(!twice.ok && twice.status === 409, "can't approve twice");

  /* Conflict keeps it pending; force then approves. */
  const stale = await createProposalWith(d, { args: { operation: "jira_priority", priority: "Critical" }, ticketKey: "TS-1" }, { type: "browser_agent" }, ACTOR);
  assert(stale.ok, "second proposal");
  fake.liveVersion = "2026-10-03T11:59:00.000+0000";
  if (stale.ok) {
    const conflicted = await approveProposalWith(d, stale.proposal.id, { idempotencyKey: "approve-key-04" }, ACTOR);
    assert(conflicted.ok && conflicted.execution?.status === "conflict" && conflicted.proposal.status === "pending", "conflict keeps it pending");
    assert(!JSON.stringify(conflicted).includes("lastError"), "internal bookkeeping never leaves the service");
    const forced = await approveProposalWith(d, stale.proposal.id, { force: true, idempotencyKey: "approve-key-05" }, ACTOR);
    assert(forced.ok && forced.proposal.status === "approved", "force approves");
  }

  /* Reject. */
  const toReject = await createProposalWith(d, { args: NOTE, ticketKey: "TS-1" }, assist, ACTOR);
  assert(toReject.ok, "third proposal");
  if (toReject.ok) {
    const rejected = await rejectProposalWith(d, toReject.proposal.id, { accountId: "acc-bob", displayName: "Bob" });
    assert(rejected.ok && rejected.proposal.status === "rejected" && rejected.proposal.decidedBy === "Bob", "rejected");
    const late = await approveProposalWith(d, toReject.proposal.id, { idempotencyKey: "approve-key-06" }, ACTOR);
    assert(!late.ok && late.status === 409, "a rejected proposal can't be approved");
  }

  /* Expiry. */
  const expiring = await createProposalWith(d, { args: NOTE, ticketKey: "TS-1" }, assist, ACTOR);
  assert(expiring.ok, "fourth proposal");
  nowMs += 25 * 3_600_000;
  const listed = await listTicketActionsWith(d, "TS-1");
  if (expiring.ok) {
    assertEqual(listed.proposals.find((proposal) => proposal.id === expiring.proposal.id)?.status, "expired", "listed as expired");
    const expired = await approveProposalWith(d, expiring.proposal.id, { idempotencyKey: "approve-key-07" }, ACTOR);
    assert(!expired.ok && expired.status === 410, "an expired proposal can't be approved");
  }
  assert(listed.executions.length >= 2 && listed.executions[0]?.args.operation === "jira_priority", "executions newest first");

  /* Pending first. */
  const fresh = await createProposalWith(d, { args: NOTE, ticketKey: "TS-1" }, assist, ACTOR);
  const ordered = await listTicketActionsWith(d, "TS-1");
  assert(fresh.ok && ordered.proposals[0]?.id === fresh.proposal.id && ordered.proposals[0].status === "pending", "pending first");
  assert(ordered.proposals.slice(1).every((proposal) => proposal.status !== "pending"), "then decided / expired");

  /* At most 20 pending per ticket. */
  const capStore = memoryStore();
  const capDeps = deps(capStore, world());
  for (let index = 0; index < 20; index += 1) {
    assert((await createProposalWith(capDeps, { args: NOTE, ticketKey: "TS-2" }, assist, ACTOR)).ok, `pending ${index + 1}`);
  }
  const capped = await createProposalWith(capDeps, { args: NOTE, ticketKey: "TS-2" }, assist, ACTOR);
  assert(!capped.ok && capped.status === 429, "the 21st pending proposal is refused");
  assert((await createProposalWith(capDeps, { args: NOTE, ticketKey: "TS-3" }, assist, ACTOR)).ok, "other tickets are unaffected");

  /* A proposal lock held by someone else blocks a concurrent decision. */
  const locked = await createProposalWith(capDeps, { args: NOTE, ticketKey: "TS-3" }, assist, ACTOR);
  if (locked.ok) {
    await capStore.setIfAbsent(`actions:proposal-lock:${locked.proposal.id}`, "acc-bob", 120);
    const blocked = await approveProposalWith(capDeps, locked.proposal.id, { idempotencyKey: "approve-key-08" }, ACTOR);
    assert(!blocked.ok && blocked.status === 409, "concurrent approval blocked");
  }
  console.log("PASS");
}

async function testExecutionShape(): Promise<void> {
  console.log("\n--- Test: the recorded execution ---");
  const store = memoryStore();
  const d = deps(store, world({ slackResult: { externalId: `${TEST_CHANNEL}:1.2`, externalUrl: "https://slack/x", redirectedToTestChannel: true, status: "succeeded" } }));
  const result = await executeActionWith(d, request(REPLY_SAFE, { idempotencyKey: "shape-key-001" }), ACTOR);
  assert(result.ok, "ok");
  if (!result.ok) {
    return;
  }
  const execution: ActionExecution = result.execution;
  assertEqual(
    { ...execution, id: "x" },
    {
      actorAccountId: "acc-jane",
      actorName: "Jane Doe",
      args: REPLY_SAFE,
      at: "2026-10-03T12:00:00.000Z",
      id: "x",
      idempotencyKey: "shape-key-001",
      status: "succeeded",
      ticketKey: "TS-1",
      externalId: `${TEST_CHANNEL}:1.2`,
      externalUrl: "https://slack/x",
      redirectedToTestChannel: true,
    },
    "execution fields",
  );
  assertEqual(store.raw.get(`actions:idem:acc-jane:shape-key-001`), { executionId: execution.id, state: "done" }, "idempotency record points at the execution");
  console.log("PASS");
}

async function main(): Promise<void> {
  testValidation();
  testSafetyAndVersions();
  testSameOrigin();
  await testJiraWrites();
  await testSlackWrites();
  await testFirefighterMentions();
  await testIdempotency();
  await testConflictAndForce();
  await testUncertainMissingCredsSafety();
  await testRateLimit();
  await testProposals();
  await testExecutionShape();
}

main()
  .then(() => {
    console.log("\nAll action tests passed.");
    process.exit(0);
  })
  .catch((error: unknown) => {
    console.error("\nAction test failed:", error);
    process.exit(1);
  });
