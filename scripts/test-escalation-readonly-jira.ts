import {
  ReadOnlyJiraError,
  ReadOnlyViolation,
  assertReadOnlyRequest,
  createReadOnlyJiraClient,
  readOnlyJiraConfigFromEnv,
} from "@/lib/escalation/readOnlyJira";
import type { ReadOnlyJiraClient, ReadOnlyJiraConfig } from "@/lib/escalation/readOnlyJira";

/* Nothing here touches the network: every client gets a fake fetch that
   records what it was asked to send, so "fetch was never called" is provable. */

const BASE_URL = "https://example.atlassian.net";
const EMAIL = "escalation-bot@example.com";
const TOKEN = "ATATT3xFfGF0-fake-token-must-never-leak-0123456789";
const AUTH_B64 = Buffer.from(`${EMAIL}:${TOKEN}`).toString("base64");
const SEARCH_PATH = "/rest/api/3/search/jql";
const COUNT_PATH = "/rest/api/3/search/approximate-count";

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

interface RecordedCall {
  body: string | null;
  /* Lower-cased header names. */
  headers: Record<string, string>;
  method: string;
  redirect: RequestRedirect | undefined;
  signal: AbortSignal | null;
  url: string;
}

type Responder = (call: RecordedCall) => Response | Promise<Response>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" }, status });
}

function makeFakeFetch(responder: Responder = () => jsonResponse({ ok: true })): {
  calls: RecordedCall[];
  fetchImpl: typeof fetch;
} {
  const calls: RecordedCall[] = [];

  const fetchImpl = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const call: RecordedCall = {
      body: typeof init?.body === "string" ? init.body : null,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      method: init?.method ?? "GET",
      redirect: init?.redirect,
      signal: init?.signal ?? null,
      url,
    };
    calls.push(call);
    return Promise.resolve(responder(call));
  };

  return { calls, fetchImpl };
}

function makeClient(fetchImpl: typeof fetch, overrides: Partial<ReadOnlyJiraConfig> = {}): ReadOnlyJiraClient {
  return createReadOnlyJiraClient({ apiToken: TOKEN, baseUrl: BASE_URL, email: EMAIL, fetchImpl, ...overrides });
}

async function expectRejects<E extends Error>(
  fn: () => Promise<unknown>,
  ErrorClass: new (...args: never[]) => E,
  label: string,
): Promise<E> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof ErrorClass) {
      return error;
    }

    throw new Error(`${label}: expected ${ErrorClass.name}, got ${String(error)}`);
  }

  throw new Error(`${label}: expected ${ErrorClass.name}, but the call resolved`);
}

function expectThrows(fn: () => unknown, label: string): Error {
  try {
    fn();
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }

    throw new Error(`${label}: threw a non-Error ${String(error)}`);
  }

  throw new Error(`${label}: expected a throw`);
}

function assertNoSecrets(text: string, label: string): void {
  assert(!text.includes(TOKEN), `${label}: must not contain the API token`);
  assert(!text.includes(TOKEN.slice(0, 12)), `${label}: must not contain a fragment of the API token`);
  assert(!text.includes(AUTH_B64), `${label}: must not contain the basic-auth credentials`);
}

/* Fake /search/jql over `total` issues keyed CP-1..CP-n, paging with opaque
   "tok-<offset>" tokens. Reads its inputs from the query string (GET) or the
   JSON body (POST) so the same fake covers both. */
function readSearchInput(call: RecordedCall): { maxResults: number; nextPageToken: string | null } {
  if (call.method === "POST") {
    const body = JSON.parse(call.body ?? "{}") as { maxResults?: number; nextPageToken?: string };
    return { maxResults: body.maxResults ?? 50, nextPageToken: body.nextPageToken ?? null };
  }

  const params = new URL(call.url).searchParams;
  return { maxResults: Number(params.get("maxResults") ?? "50"), nextPageToken: params.get("nextPageToken") };
}

function searchResponder(total: number, options: { ignoreMaxResults?: boolean } = {}): Responder {
  return (call) => {
    const { maxResults, nextPageToken } = readSearchInput(call);
    const start = nextPageToken ? Number(nextPageToken.replace("tok-", "")) : 0;
    const pageSize = options.ignoreMaxResults ? 100 : maxResults;
    const end = Math.min(total, start + pageSize);
    const issues = Array.from({ length: end - start }, (_, index) => ({ key: `CP-${start + index + 1}` }));
    const more = end < total;
    return jsonResponse({ issues, isLast: !more, ...(more ? { nextPageToken: `tok-${end}` } : {}) });
  };
}

// --- the guard: nothing that could write ever reaches fetch ---

async function testWriteMethodsNeverReachFetch(): Promise<void> {
  console.log("\n--- Test: PUT / DELETE / PATCH (and every other non-GET/POST spelling) never reach fetch ---");

  const { calls, fetchImpl } = makeFakeFetch();
  const client = makeClient(fetchImpl);
  const methods = ["PUT", "DELETE", "PATCH", "put", "delete", "patch", "Patch", "HEAD", "OPTIONS", "TRACE", "get", "post", ""];
  const paths = [
    "/rest/api/3/issue/TS-1",
    "/rest/api/3/myself",
    SEARCH_PATH,
    COUNT_PATH,
    "/rest/servicedeskapi/request/TS-1",
    "/rest/workinghours/1/api/calendar/30",
  ];

  for (const method of methods) {
    for (const path of paths) {
      await expectRejects(() => client.request(method, path), ReadOnlyViolation, `${method} ${path}`);
    }
  }

  assertEqual(calls.length, 0, "fetch must never be called");
  assertEqual(client.requestLog.length, 0, "refused requests are never logged as sent");

  console.log(`PASS: ${methods.length * paths.length} non-read requests refused before fetch.`);
}

async function testWritePostsNeverReachFetch(): Promise<void> {
  console.log("\n--- Test: POST anywhere except the two search endpoints is refused before fetch ---");

  const { calls, fetchImpl } = makeFakeFetch();
  const client = makeClient(fetchImpl);
  const paths = [
    "/rest/api/3/issue",
    "/rest/api/3/issue/TS-1/comment",
    "/rest/api/3/issue/TS-1/transitions",
    "/rest/api/3/issueLink",
    "/rest/api/3/issue/bulk",
    "/rest/api/3/search",
    "/rest/api/3/search/jql/",
    "/rest/api/3/search/JQL",
    "/rest/api/3/search/jql/x",
    "/rest/servicedeskapi/request",
    "/rest/servicedeskapi/request/TS-1/comment",
    "/rest/servicedesk/1/servicedesk/agent/TS/sla/metrics",
    "/rest/servicedesk/1/x",
    "/rest/workinghours/1/api/calendar",
    "/rest/workinghours/1/api/calendar/30",
  ];

  for (const path of paths) {
    await expectRejects(() => client.request("POST", path, { body: { jql: "x" } }), ReadOnlyViolation, `POST ${path}`);
  }

  assertEqual(calls.length, 0, "fetch must never be called");
  assertEqual(client.requestLog.length, 0, "nothing logged");

  console.log(`PASS: ${paths.length} write-shaped POSTs refused before fetch.`);
}

async function testPathTricksNeverReachFetch(): Promise<void> {
  console.log("\n--- Test: traversal / encoding / host tricks are refused before fetch ---");

  const { calls, fetchImpl } = makeFakeFetch();
  const client = makeClient(fetchImpl);
  const getPaths = [
    "/rest/api/3/../servicedesk/1/x",
    "/rest/api/3/./myself",
    "/rest/api/3/.../myself",
    "/rest/api/3/%2e%2e/x",
    "/rest/api/3/%2E%2E/x",
    "/rest/api/3/%252e%252e/x",
    "/rest/api/3/issue%2fTS-1",
    "/rest/api/3/issue%2FTS-1",
    "/rest/api/3/..%5cservicedesk",
    "/rest/api/3/..;/servicedesk/1/x",
    "/rest/api/3\\..\\servicedesk/1/x",
    "/rest/api/3/‥/servicedesk",
    "/rest/api/3/．．/servicedesk",
    "//evil.com/rest/api/3/x",
    "/rest/api//3/myself",
    "/rest/api/3/myself/",
    "https://evil.com/rest/api/3/myself",
    "http://example.atlassian.net/rest/api/3/myself",
    `${BASE_URL}/rest/api/3/myself`,
    "rest/api/3/myself",
    " /rest/api/3/myself",
    "/rest/api/3/myself ",
    "/rest/api/3/myself\n",
    "/rest/api/3/myself\u0000",
    "/rest/api/3/myself?expand=groups",
    "/rest/api/3/myself#x",
    "/rest/api/3/myself?_method=DELETE",
    "/rest/api/3",
    "/REST/api/3/myself",
    "/rest/API/3/myself",
    "/rest/api/2/issue/TS-1",
    "/rest/servicedesk/1/servicedesk/TS/sla",
    "/rest/servicedesk/1/x",
    "/rest/workinghours/1/admin",
    "/rest/workinghours/1/api/calendar/30/holidays",
    "/rest/workinghours/1/api/calendar/abc",
    "/rest/workinghours/1/api/calendar/",
    "/rest/workinghours/1/api/calendars",
    "",
    "/",
  ];

  for (const path of getPaths) {
    await expectRejects(() => client.get(path), ReadOnlyViolation, `get(${JSON.stringify(path)})`);
    await expectRejects(() => client.request("GET", path), ReadOnlyViolation, `GET ${JSON.stringify(path)}`);
  }

  const postPaths = [
    "/rest/api/3/search/jql/../../issue",
    "/rest/api/3/search/%2e%2e/issue",
    "/rest/api/3/search/jql?x=1",
    "//evil.com/rest/api/3/search/jql",
    "https://evil.com/rest/api/3/search/jql",
    "/rest/api/3/search/./jql",
    "/rest/api/3/search//jql",
  ];

  for (const path of postPaths) {
    await expectRejects(() => client.request("POST", path, { body: {} }), ReadOnlyViolation, `POST ${path}`);
  }

  /* JS callers can hand over anything; the guard can't assume a string. */
  for (const bogus of [undefined, null, 42, new URL(`${BASE_URL}/rest/api/3/myself`), ["/rest/api/3/myself"]]) {
    await expectRejects(() => client.get(bogus as unknown as string), ReadOnlyViolation, `non-string path ${String(bogus)}`);
  }

  assertEqual(calls.length, 0, "fetch must never be called");
  assertEqual(client.requestLog.length, 0, "nothing logged");

  console.log(`PASS: ${getPaths.length * 2 + postPaths.length + 5} trick requests refused before fetch.`);
}

async function testBodyAndParamMisuseRefused(): Promise<void> {
  console.log("\n--- Test: GET with a body, POST with a query string, method-override params are refused ---");

  const { calls, fetchImpl } = makeFakeFetch();
  const client = makeClient(fetchImpl);

  await expectRejects(
    () => client.request("GET", "/rest/api/3/myself", { body: { a: 1 } }),
    ReadOnlyViolation,
    "GET with body",
  );
  await expectRejects(
    () => client.request("POST", SEARCH_PATH, { body: { jql: "x" }, params: { _method: "DELETE" } }),
    ReadOnlyViolation,
    "POST with params",
  );
  await expectRejects(
    () => client.request("POST", COUNT_PATH, { params: { jql: "x" } }),
    ReadOnlyViolation,
    "POST count with params",
  );

  for (const key of ["_method", "_METHOD", "X-HTTP-Method-Override", "x-http-method", "X-Method-Override", ""]) {
    await expectRejects(
      () => client.get("/rest/api/3/issue/TS-1", { [key]: "DELETE" }),
      ReadOnlyViolation,
      `override param ${JSON.stringify(key)}`,
    );
  }

  assertEqual(calls.length, 0, "fetch must never be called");

  console.log("PASS: misuse of body/params is refused before fetch.");
}

function testAssertReadOnlyRequestDirectly(): void {
  console.log("\n--- Test: assertReadOnlyRequest is a pure allowlist check ---");

  assertEqual(assertReadOnlyRequest("GET", "/rest/api/3/myself"), { method: "GET", path: "/rest/api/3/myself" }, "GET api/3");
  assertEqual(assertReadOnlyRequest("POST", COUNT_PATH), { method: "POST", path: COUNT_PATH }, "POST count");
  assertEqual(
    assertReadOnlyRequest("GET", "/rest/workinghours/1/api/calendar/30"),
    { method: "GET", path: "/rest/workinghours/1/api/calendar/30" },
    "GET calendar 30",
  );

  const violation = expectThrows(() => assertReadOnlyRequest("DELETE", "/rest/api/3/issue/TS-1"), "DELETE");
  assert(violation instanceof ReadOnlyViolation, "DELETE throws ReadOnlyViolation");
  assertEqual(violation.name, "ReadOnlyViolation", "error name is set for logs");
  assert(violation.message.includes("DELETE"), "message names the refused method");
  /* A plain canonical path is still echoed in full - the refusal has to point at the bad call site. */
  assert(violation.message.includes('"/rest/api/3/issue/TS-1"'), `message names the refused path: ${violation.message}`);
  assert(!violation.message.includes("not shown"), "nothing withheld from a plain canonical path");

  console.log("PASS: allowlisted pairs pass through, everything else throws ReadOnlyViolation.");
}

// --- allowed reads go to the right place, with the right headers ---

async function testAllowedGetsHitTheRightUrl(): Promise<void> {
  console.log("\n--- Test: allowed GETs hit the right URL with auth, Accept, timeout and no redirects ---");

  const { calls, fetchImpl } = makeFakeFetch((call) => jsonResponse({ echoed: new URL(call.url).pathname }));
  const client = makeClient(fetchImpl);

  const myself = await client.get<{ echoed: string }>("/rest/api/3/myself");
  assertEqual(myself, { echoed: "/rest/api/3/myself" }, "parsed JSON body is returned");

  await client.get("/rest/api/3/issue/CP-123", { expand: "changelog", fields: "status,customfield_10165", skip: undefined });
  await client.get("/rest/servicedeskapi/request/TS-1/sla");
  await client.get("/rest/workinghours/1/api/calendar");
  await client.get("/rest/workinghours/1/api/calendar/30");

  assertEqual(
    calls.map((call) => call.url),
    [
      `${BASE_URL}/rest/api/3/myself`,
      `${BASE_URL}/rest/api/3/issue/CP-123?expand=changelog&fields=status%2Ccustomfield_10165`,
      `${BASE_URL}/rest/servicedeskapi/request/TS-1/sla`,
      `${BASE_URL}/rest/workinghours/1/api/calendar`,
      `${BASE_URL}/rest/workinghours/1/api/calendar/30`,
    ],
    "request URLs",
  );

  for (const call of calls) {
    assertEqual(call.method, "GET", `${call.url} method`);
    assertEqual(call.headers.authorization, `Basic ${AUTH_B64}`, `${call.url} basic auth`);
    assertEqual(call.headers.accept, "application/json", `${call.url} Accept`);
    assertEqual(call.headers["content-type"], undefined, `${call.url} has no Content-Type`);
    assertEqual(call.body, null, `${call.url} has no body`);
    assertEqual(call.redirect, "error", `${call.url} refuses redirects`);
    assert(call.signal instanceof AbortSignal, `${call.url} carries a timeout signal`);
  }

  assertEqual(
    client.requestLog,
    [
      { method: "GET", path: "/rest/api/3/myself" },
      { method: "GET", path: "/rest/api/3/issue/CP-123" },
      { method: "GET", path: "/rest/servicedeskapi/request/TS-1/sla" },
      { method: "GET", path: "/rest/workinghours/1/api/calendar" },
      { method: "GET", path: "/rest/workinghours/1/api/calendar/30" },
    ],
    "requestLog records method + path (no query string)",
  );

  console.log("PASS: GETs reach exactly the allowlisted URLs, query only via params.");
}

async function testTrailingSlashBaseUrlAndEmptyBody(): Promise<void> {
  console.log("\n--- Test: a trailing-slash base URL is accepted; an empty 2xx body resolves to undefined ---");

  const { calls, fetchImpl } = makeFakeFetch(() => new Response(null, { status: 204 }));
  const client = makeClient(fetchImpl, { baseUrl: `${BASE_URL}/` });

  const result = await client.get("/rest/api/3/myself");
  assertEqual(result, undefined, "204 resolves to undefined");
  assertEqual(calls[0]?.url, `${BASE_URL}/rest/api/3/myself`, "no double slash after the origin");

  console.log("PASS: base URL is normalized to its origin.");
}

async function testPostSearchesHitTheRightUrl(): Promise<void> {
  console.log("\n--- Test: the two allowed POST searches hit the right URL with a JSON body ---");

  const { calls, fetchImpl } = makeFakeFetch((call) =>
    new URL(call.url).pathname === COUNT_PATH ? jsonResponse({ count: 42 }) : jsonResponse({ issues: [] }),
  );
  const client = makeClient(fetchImpl);

  const count = await client.approximateCount("project = TS AND status = 10633");
  assertEqual(count, 42, "approximateCount returns Jira's count");

  await client.request("POST", SEARCH_PATH, { body: { jql: "project = CP", maxResults: 1 } });

  assertEqual(
    calls.map((call) => [call.method, call.url]),
    [
      ["POST", `${BASE_URL}${COUNT_PATH}`],
      ["POST", `${BASE_URL}${SEARCH_PATH}`],
    ],
    "POST URLs",
  );
  assertEqual(JSON.parse(calls[0]?.body ?? "null"), { jql: "project = TS AND status = 10633" }, "count body");
  assertEqual(JSON.parse(calls[1]?.body ?? "null"), { jql: "project = CP", maxResults: 1 }, "search body");

  for (const call of calls) {
    assertEqual(call.headers["content-type"], "application/json", "POST Content-Type");
    assertEqual(call.headers.authorization, `Basic ${AUTH_B64}`, "POST basic auth");
    assertEqual(call.redirect, "error", "POST refuses redirects");
  }

  assertEqual(
    client.requestLog,
    [
      { method: "POST", path: COUNT_PATH },
      { method: "POST", path: SEARCH_PATH },
    ],
    "requestLog",
  );

  const { fetchImpl: badFetch } = makeFakeFetch(() => jsonResponse({ total: "lots" }));
  await expectRejects(() => makeClient(badFetch).approximateCount("project = TS"), ReadOnlyJiraError, "bad count shape");

  console.log("PASS: approximate-count and POST search/jql are reachable, nothing else is.");
}

// --- searchJql pagination ---

async function testSearchJqlPaginates(): Promise<void> {
  console.log("\n--- Test: searchJql follows nextPageToken across pages ---");

  const { calls, fetchImpl } = makeFakeFetch(searchResponder(237));
  const client = makeClient(fetchImpl);

  const issues = await client.searchJql<{ key: string }>("project = TS AND status = 10633", ["key", "status"], {
    expand: "changelog",
  });

  assertEqual(issues.length, 237, "every issue is collected");
  assertEqual(issues[0]?.key, "CP-1", "first issue");
  assertEqual(issues[236]?.key, "CP-237", "last issue");
  assertEqual(new Set(issues.map((issue) => issue.key)).size, 237, "no duplicates");
  assertEqual(calls.length, 3, "three pages");

  const pageParams = calls.map((call) => {
    const url = new URL(call.url);
    return {
      expand: url.searchParams.get("expand"),
      fields: url.searchParams.get("fields"),
      jql: url.searchParams.get("jql"),
      maxResults: url.searchParams.get("maxResults"),
      method: call.method,
      nextPageToken: url.searchParams.get("nextPageToken"),
      path: url.pathname,
    };
  });
  /* Same key order as pageParams - assertEqual compares JSON. */
  const expectedPage = (nextPageToken: string | null) => ({
    expand: "changelog",
    fields: "key,status",
    jql: "project = TS AND status = 10633",
    maxResults: "100",
    method: "GET",
    nextPageToken,
    path: SEARCH_PATH,
  });
  assertEqual(pageParams, [expectedPage(null), expectedPage("tok-100"), expectedPage("tok-200")], "page requests");
  assertEqual(client.requestLog.length, 3, "one log entry per page");

  console.log("PASS: 237 issues over 3 GET pages, tokens followed in order.");
}

async function testSearchJqlRespectsMaxTotal(): Promise<void> {
  console.log("\n--- Test: searchJql stops at maxTotal (default 2000), even if Jira over-delivers ---");

  const capped = makeFakeFetch(searchResponder(1000));
  const cappedIssues = await makeClient(capped.fetchImpl).searchJql("project = CP", ["key"], { maxTotal: 150 });
  assertEqual(cappedIssues.length, 150, "maxTotal 150 returns 150");
  assertEqual(
    capped.calls.map((call) => new URL(call.url).searchParams.get("maxResults")),
    ["100", "50"],
    "the last page only asks for what's left",
  );

  const greedy = makeFakeFetch(searchResponder(1000, { ignoreMaxResults: true }));
  const greedyIssues = await makeClient(greedy.fetchImpl).searchJql("project = CP", ["key"], { maxTotal: 150 });
  assertEqual(greedyIssues.length, 150, "cap holds when Jira ignores maxResults");
  assertEqual(greedy.calls.length, 2, "and stops paging");

  const huge = makeFakeFetch(searchResponder(5000));
  const defaultCapped = await makeClient(huge.fetchImpl).searchJql("project = CP", ["key"]);
  assertEqual(defaultCapped.length, 2000, "default maxTotal is 2000");
  assertEqual(huge.calls.length, 20, "20 pages of 100");

  const exact = makeFakeFetch(searchResponder(100));
  const exactIssues = await makeClient(exact.fetchImpl).searchJql("project = CP", ["key"]);
  assertEqual(exactIssues.length, 100, "single full page");
  assertEqual(exact.calls.length, 1, "isLast stops after one page");

  const { fetchImpl } = makeFakeFetch(searchResponder(10));
  const client = makeClient(fetchImpl);
  await expectRejects(() => client.searchJql("project = CP", ["key"], { maxTotal: 0 }), Error, "maxTotal 0");
  await expectRejects(() => client.searchJql("project = CP", ["key"], { maxTotal: 1.5 }), Error, "maxTotal 1.5");
  await expectRejects(() => client.searchJql("   ", ["key"]), Error, "blank JQL");

  console.log("PASS: maxTotal caps results and page sizes.");
}

async function testSearchJqlFailsLoudlyOnBadPagination(): Promise<void> {
  console.log("\n--- Test: a repeated token or malformed page throws instead of looping or returning [] ---");

  const stuck = makeFakeFetch(() => jsonResponse({ issues: [{ key: "CP-1" }], isLast: false, nextPageToken: "same" }));
  const stuckError = await expectRejects(
    () => makeClient(stuck.fetchImpl).searchJql("project = CP", ["key"]),
    ReadOnlyJiraError,
    "repeated token",
  );
  assert(stuckError.message.includes("repeated"), "message explains the repeated token");
  assertEqual(stuck.calls.length, 2, "gives up on the first repeat");

  const malformed = makeFakeFetch(() => jsonResponse({ values: [] }));
  await expectRejects(
    () => makeClient(malformed.fetchImpl).searchJql("project = CP", ["key"]),
    ReadOnlyJiraError,
    "missing issues array",
  );

  const emptyWithToken = makeFakeFetch(() => jsonResponse({ issues: [], nextPageToken: "tok-x" }));
  const none = await makeClient(emptyWithToken.fetchImpl).searchJql("project = CP", ["key"]);
  assertEqual(none.length, 0, "an empty page ends the search");
  assertEqual(emptyWithToken.calls.length, 1, "without following its token");

  console.log("PASS: pagination problems surface as errors.");
}

async function testLongJqlFallsBackToPost(): Promise<void> {
  console.log("\n--- Test: JQL too long for a GET URL goes out as POST /search/jql, still paginated ---");

  const keys = Array.from({ length: 900 }, (_, index) => `CP-${index + 1}`);
  const jql = `key in (${keys.join(", ")})`;
  const { calls, fetchImpl } = makeFakeFetch(searchResponder(150));
  const client = makeClient(fetchImpl);

  const issues = await client.searchJql<{ key: string }>(jql, ["key", "status"]);

  assertEqual(issues.length, 150, "all issues collected over POST");
  assertEqual(
    calls.map((call) => [call.method, call.url]),
    [
      ["POST", `${BASE_URL}${SEARCH_PATH}`],
      ["POST", `${BASE_URL}${SEARCH_PATH}`],
    ],
    "POST to search/jql with no query string",
  );
  assertEqual(
    calls.map((call) => JSON.parse(call.body ?? "null") as unknown),
    [
      { fields: ["key", "status"], jql, maxResults: 100 },
      { fields: ["key", "status"], jql, maxResults: 100, nextPageToken: "tok-100" },
    ],
    "POST bodies carry jql, fields, page size and token",
  );

  console.log("PASS: long JQL uses the allowlisted POST search.");
}

// --- errors never leak the token ---

async function testErrorsNeverLeakToken(): Promise<void> {
  console.log("\n--- Test: non-2xx, network and timeout errors carry the status but never the token ---");

  const echoAuth = makeFakeFetch((call) =>
    jsonResponse({ errorMessages: [`Bad credentials: ${call.headers.authorization} (token ${TOKEN})`] }, 401),
  );
  const unauthorized = await expectRejects(
    () => makeClient(echoAuth.fetchImpl).get("/rest/api/3/myself"),
    ReadOnlyJiraError,
    "401",
  );
  assertEqual(unauthorized.status, 401, "status is exposed");
  assertEqual(unauthorized.path, "/rest/api/3/myself", "path is exposed");
  assert(unauthorized.message.includes("401"), "message names the status");
  assertNoSecrets(unauthorized.message, "401 message");
  assertNoSecrets(unauthorized.stack ?? "", "401 stack");
  assertNoSecrets(JSON.stringify(unauthorized), "401 serialized");

  const notFound = makeFakeFetch(() =>
    jsonResponse({ errorMessages: ["Issue does not exist or you do not have permission to see it."], errors: {} }, 404),
  );
  const missing = await expectRejects(
    () => makeClient(notFound.fetchImpl).get("/rest/api/3/issue/CP-404"),
    ReadOnlyJiraError,
    "404",
  );
  assertEqual(missing.status, 404, "404 status");
  assert(missing.message.includes("Issue does not exist"), "Jira's errorMessages are surfaced");

  /* The token straddles the 300-char truncation point: redaction must run first. */
  const straddle = makeFakeFetch(() => new Response(`${"x".repeat(290)}${TOKEN}`, { status: 500 }));
  const serverError = await expectRejects(
    () => makeClient(straddle.fetchImpl).get("/rest/api/3/myself"),
    ReadOnlyJiraError,
    "500",
  );
  assertEqual(serverError.status, 500, "500 status");
  assertNoSecrets(serverError.message, "truncated 500 message");

  const networkFetch = (() =>
    Promise.reject(
      new TypeError(`connect ECONNREFUSED with Authorization: Basic ${AUTH_B64}`, {
        cause: new Error(`socket closed, token=${TOKEN}`),
      }),
    )) as typeof fetch;
  const network = await expectRejects(
    () => makeClient(networkFetch).get("/rest/api/3/myself"),
    ReadOnlyJiraError,
    "network",
  );
  assertEqual(network.status, null, "no status without a response");
  assert(network.message.includes("ECONNREFUSED"), "network reason is kept");
  assert(network.message.includes("socket closed"), "cause reason is kept");
  assertNoSecrets(network.message, "network message");
  assertEqual(network.cause, undefined, "original error is not attached");

  /* AbortSignal.timeout's timer is unref'd, so with no real socket open Node
     would just exit mid-test with code 0. The ref'd fallback timer stands in
     for the socket - and fails the test if the abort never comes. */
  const hangingFetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const fallback = setTimeout(() => reject(new Error("fake fetch was never aborted")), 5_000);
      init?.signal?.addEventListener("abort", () => {
        clearTimeout(fallback);
        reject(init.signal?.reason instanceof Error ? init.signal.reason : new Error("aborted"));
      });
    })) as typeof fetch;
  const timeout = await expectRejects(
    () => makeClient(hangingFetch, { timeoutMs: 25 }).get("/rest/api/3/myself"),
    ReadOnlyJiraError,
    "timeout",
  );
  assert(timeout.message.includes("timed out after 25ms"), `timeout message: ${timeout.message}`);
  assertEqual(timeout.status, null, "timeout has no status");

  const notJson = makeFakeFetch(() => new Response("<html>login</html>", { status: 200 }));
  await expectRejects(() => makeClient(notJson.fetchImpl).get("/rest/api/3/myself"), ReadOnlyJiraError, "non-JSON");

  console.log("PASS: errors are useful (status, path, Jira's message) and token-free.");
}

async function testRefusalsNeverLeakToken(): Promise<void> {
  console.log("\n--- Test: ReadOnlyViolation messages never echo the token, even when the caller put it in the path ---");

  const { calls, fetchImpl } = makeFakeFetch();
  const client = makeClient(fetchImpl);
  /* The token starts at char 100 and runs past the 120-char echo cut, so a
     clip-then-redact order would leave a 20-char fragment behind. */
  const straddlingPath = `/rest/servicedesk/1/${"x".repeat(79)}/${TOKEN}`;
  const refusals: Array<[string, () => Promise<unknown>]> = [
    ["userinfo URL (reviewer probe)", () => client.get(`https://u:${TOKEN}@evil.com/rest/api/3/x`)],
    ["protocol-relative userinfo", () => client.get(`//${EMAIL}:${TOKEN}@evil.com/rest/api/3/x`)],
    ["token in a smuggled query", () => client.get(`/rest/api/3/myself?token=${TOKEN}`)],
    ["token in a fragment", () => client.get(`/rest/api/3/myself#${TOKEN}`)],
    ["token as a path segment of a refused POST", () => client.request("POST", `/rest/api/3/issue/${TOKEN}`)],
    ["token in a DELETE path", () => client.request("DELETE", `/rest/api/3/issue/${TOKEN}`)],
    ["token as the method", () => client.request(TOKEN, "/rest/api/3/myself")],
    ["basic-auth blob in the path", () => client.request("POST", `/rest/api/3/x/${AUTH_B64}`)],
    ["token straddling the echo cut", () => client.get(straddlingPath)],
    ["GET with body on a token path", () => client.request("GET", `/rest/api/3/issue/${TOKEN}`, { body: {} })],
    ["override param on a token path", () => client.get(`/rest/api/3/issue/${TOKEN}`, { _method: "DELETE" })],
  ];

  for (const [label, call] of refusals) {
    const refusal = await expectRejects(call, ReadOnlyViolation, label);
    assert(refusal.message.startsWith("Refused "), `${label}: still reads as a refusal: ${refusal.message}`);
    assertNoSecrets(refusal.message, `${label} message`);
    assertNoSecrets(refusal.stack ?? "", `${label} stack`);
    assertNoSecrets(JSON.stringify(refusal), `${label} serialized`);
  }

  assertEqual(calls.length, 0, "fetch must never be called");
  assertEqual(client.requestLog.length, 0, "nothing logged");

  /* The refusal still points at the call site: the safe part of a refused path is echoed. */
  const probe = await expectRejects(
    () => client.get(`https://u:${TOKEN}@evil.com/rest/api/3/x`),
    ReadOnlyViolation,
    "probe",
  );
  assert(probe.message.includes('"https" (+'), `userinfo URL is cut at the scheme: ${probe.message}`);
  const queried = await expectRejects(() => client.get(`/rest/api/3/myself?token=${TOKEN}`), ReadOnlyViolation, "query");
  assert(queried.message.includes('"/rest/api/3/myself" (+'), `query is withheld, path kept: ${queried.message}`);

  /* The pure guard has no token to redact against, so the canonical-prefix
     echo alone must keep userinfo, query and fragment secrets out. */
  const other = "otherEnvSecret-9f8e7d";
  for (const path of [
    `https://u:${other}@evil.com/rest/api/3/x`,
    `//u:${other}@evil.com/rest/api/3/x`,
    `/rest/api/3/myself?token=${other}`,
    `/rest/api/3/myself#${other}`,
    `/rest/api/3/myself;jsessionid=${other}`,
    `/rest/api/3/%2e%2e/${other}`,
  ]) {
    const pure = expectThrows(() => assertReadOnlyRequest("GET", path), `pure ${path}`);
    assert(pure instanceof ReadOnlyViolation, `pure ${path} is a ReadOnlyViolation`);
    assert(!pure.message.includes(other), `pure guard withholds the secret from ${JSON.stringify(path)}: ${pure.message}`);
    assert(pure.message.includes("chars not shown"), `pure guard says it withheld something: ${pure.message}`);
  }

  /* With a redactor (what the client passes), even a canonical path is cleaned. */
  const scrub = (text: string) => text.split(other).join("[redacted]");
  const redacted = expectThrows(
    () => assertReadOnlyRequest("POST", `/rest/api/3/issue/${other}`, scrub),
    "pure with redactor",
  );
  assert(!redacted.message.includes(other), `redactor applies to canonical paths: ${redacted.message}`);

  console.log(`PASS: ${refusals.length} refusals carrying the token stayed token-free, before fetch.`);
}

async function testSentPathNeverLeaksToken(): Promise<void> {
  console.log("\n--- Test: a token in an allowed GET path is redacted from ReadOnlyJiraError and the request log ---");

  /* The guard can't tell a token from an issue key, so this GET does go out -
     but our own error and log surfaces must still not repeat it. */
  const { calls, fetchImpl } = makeFakeFetch(() => jsonResponse({ errorMessages: ["Issue does not exist"] }, 404));
  const client = makeClient(fetchImpl);

  const error = await expectRejects(() => client.get(`/rest/api/3/issue/${TOKEN}`), ReadOnlyJiraError, "404");
  assertEqual(calls.length, 1, "an allowlisted GET reaches fetch");
  assertEqual(error.status, 404, "status survives redaction");
  assertEqual(error.path, "/rest/api/3/issue/[redacted]", "error.path is redacted");
  assertNoSecrets(error.message, "404 message");
  assertNoSecrets(JSON.stringify(error), "404 serialized");
  assertEqual(client.requestLog, [{ method: "GET", path: "/rest/api/3/issue/[redacted]" }], "requestLog is redacted");
  assertNoSecrets(JSON.stringify(client.requestLog), "requestLog");

  console.log("PASS: sent paths are redacted everywhere we report them.");
}

// --- configuration ---

function testConfigFromEnv(): void {
  console.log("\n--- Test: readOnlyJiraConfigFromEnv reads the three vars and names (never echoes) missing ones ---");

  const config = readOnlyJiraConfigFromEnv({
    JIRA_API_TOKEN: ` ${TOKEN}\n`,
    JIRA_BASE_URL: BASE_URL,
    JIRA_EMAIL: EMAIL,
  });
  assertEqual(config, { apiToken: TOKEN, baseUrl: BASE_URL, email: EMAIL }, "config from env (trimmed)");

  const noBase = expectThrows(() => readOnlyJiraConfigFromEnv({ JIRA_API_TOKEN: TOKEN, JIRA_EMAIL: EMAIL }), "no base");
  assert(noBase.message.includes("JIRA_BASE_URL"), "names JIRA_BASE_URL");
  assert(!noBase.message.includes("JIRA_EMAIL"), "does not name vars that are set");
  assertNoSecrets(noBase.message, "missing-var message");

  const blank = expectThrows(
    () => readOnlyJiraConfigFromEnv({ JIRA_API_TOKEN: "   ", JIRA_BASE_URL: BASE_URL }),
    "blank token",
  );
  assert(blank.message.includes("JIRA_EMAIL") && blank.message.includes("JIRA_API_TOKEN"), "names both missing vars");

  /* Default argument reads process.env at call time, not import time. */
  const saved = { base: process.env.JIRA_BASE_URL, email: process.env.JIRA_EMAIL, token: process.env.JIRA_API_TOKEN };
  try {
    process.env.JIRA_BASE_URL = BASE_URL;
    process.env.JIRA_EMAIL = EMAIL;
    process.env.JIRA_API_TOKEN = TOKEN;
    assertEqual(readOnlyJiraConfigFromEnv().email, EMAIL, "reads process.env by default");
  } finally {
    for (const [name, value] of [
      ["JIRA_BASE_URL", saved.base],
      ["JIRA_EMAIL", saved.email],
      ["JIRA_API_TOKEN", saved.token],
    ] as const) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }

  console.log("PASS: env config is read lazily with clear, value-free errors.");
}

function testClientConfigValidation(): void {
  console.log("\n--- Test: the client refuses a non-https or non-origin base URL, blank credentials, bad timeout ---");

  const { fetchImpl } = makeFakeFetch();
  const bad: Array<[string, Partial<ReadOnlyJiraConfig>]> = [
    ["http base URL", { baseUrl: "http://example.atlassian.net" }],
    ["base URL with a path", { baseUrl: `${BASE_URL}/jira` }],
    ["base URL with a query", { baseUrl: `${BASE_URL}/?x=1` }],
    ["base URL with userinfo", { baseUrl: `https://user:${TOKEN}@example.atlassian.net` }],
    ["not a URL", { baseUrl: "example.atlassian.net" }],
    ["blank token", { apiToken: "  " }],
    ["blank email", { email: "" }],
    ["zero timeout", { timeoutMs: 0 }],
    ["NaN timeout", { timeoutMs: Number.NaN }],
  ];

  for (const [label, overrides] of bad) {
    const error = expectThrows(() => makeClient(fetchImpl, overrides), label);
    assertNoSecrets(error.message, `${label} message`);
  }

  console.log(`PASS: ${bad.length} bad configs rejected without echoing secrets.`);
}

async function main(): Promise<void> {
  try {
    await testWriteMethodsNeverReachFetch();
    await testWritePostsNeverReachFetch();
    await testPathTricksNeverReachFetch();
    await testBodyAndParamMisuseRefused();
    testAssertReadOnlyRequestDirectly();
    await testAllowedGetsHitTheRightUrl();
    await testTrailingSlashBaseUrlAndEmptyBody();
    await testPostSearchesHitTheRightUrl();
    await testSearchJqlPaginates();
    await testSearchJqlRespectsMaxTotal();
    await testSearchJqlFailsLoudlyOnBadPagination();
    await testLongJqlFallsBackToPost();
    await testErrorsNeverLeakToken();
    await testRefusalsNeverLeakToken();
    await testSentPathNeverLeaksToken();
    testConfigFromEnv();
    testClientConfigValidation();
    console.log("\nAll read-only Jira client tests passed.");
    process.exit(0);
  } catch (error) {
    console.error("\nRead-only Jira client test failed:", error);
    process.exit(1);
  }
}

main();
