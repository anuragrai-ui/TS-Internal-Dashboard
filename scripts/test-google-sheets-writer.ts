import { appendFollowUpLogRow, appendFollowUpLogRows, isGoogleSheetsWriteConfigured } from "@/lib/googleSheetsWriter";

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} failed: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function withMockEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) {
    saved[key] = process.env[key];
    if (env[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = env[key];
    }
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

const TEST_ENV = { GOOGLE_SHEET_WEBHOOK_URL: "https://script.google.com/macros/s/fake-deployment-id/exec" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, status });
}

function testIsConfigured(): void {
  console.log("\n--- Test: isGoogleSheetsWriteConfigured reflects whether the webhook URL is set ---");

  const before = process.env.GOOGLE_SHEET_WEBHOOK_URL;
  delete process.env.GOOGLE_SHEET_WEBHOOK_URL;
  assertEqual(isGoogleSheetsWriteConfigured(), false, "should be false with no webhook URL set");
  process.env.GOOGLE_SHEET_WEBHOOK_URL = "https://script.google.com/macros/s/x/exec";
  assertEqual(isGoogleSheetsWriteConfigured(), true, "should be true once a webhook URL is set");
  if (before === undefined) {
    delete process.env.GOOGLE_SHEET_WEBHOOK_URL;
  } else {
    process.env.GOOGLE_SHEET_WEBHOOK_URL = before;
  }

  console.log("PASS: configuration state tracks the presence of GOOGLE_SHEET_WEBHOOK_URL.");
}

async function testGracefullyNoOpsWithoutConfig(): Promise<void> {
  console.log("\n--- Test: appendFollowUpLogRow returns false (not a throw) when unconfigured ---");

  await withMockEnv({ GOOGLE_SHEET_WEBHOOK_URL: undefined }, async () => {
    const result = await appendFollowUpLogRow({
      issueKey: "TS-1",
      jiraCommentId: "c1",
      kind: "manual",
      postedAt: new Date().toISOString(),
      postedText: "hi",
      status: "sent",
    });
    assertEqual(result, false, "should return false, not throw, when unconfigured");
  });

  console.log("PASS: no config -> graceful false, matching every other optional integration in this codebase.");
}

async function testSuccessfulAppendPostsCorrectRow(): Promise<void> {
  console.log("\n--- Test: a successful append POSTs the row to the webhook in the documented column order ---");

  await withMockEnv(TEST_ENV, async () => {
    const requests: Array<{ body: string; url: string }> = [];

    globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      requests.push({ body: typeof init?.body === "string" ? init.body : "", url });
      return Promise.resolve(jsonResponse({ ok: true }));
    };

    const result = await appendFollowUpLogRow({
      issueKey: "TS-42",
      jiraCommentId: "comment-99",
      kind: "sla_stage_1",
      postedAt: "2026-01-01T00:00:00.000Z",
      postedText: "Following up on this.",
      status: "sent",
    });

    assertEqual(result, true, "a successful append should return true");
    assertEqual(requests.length, 1, "should make exactly one request to the webhook");
    assertEqual(requests[0]?.url, TEST_ENV.GOOGLE_SHEET_WEBHOOK_URL, "should POST to the configured webhook URL");

    const body = JSON.parse(requests[0]?.body ?? "{}") as { values: string[][] };
    assertEqual(
      body.values[0],
      ["2026-01-01T00:00:00.000Z", "TS-42", "sla_stage_1", "sent", "comment-99", "Following up on this."],
      "the appended row should carry every field in the documented column order",
    );

    console.log("PASS: posts the row to the webhook URL with fields in the correct order.");
  });
}

async function testHttpFailureReturnsFalseNotThrow(): Promise<void> {
  console.log("\n--- Test: an HTTP failure from the webhook (e.g. deployment removed) returns false, not a throw ---");

  await withMockEnv(TEST_ENV, async () => {
    globalThis.fetch = () => Promise.resolve(new Response("Not Found", { status: 404 }));

    const result = await appendFollowUpLogRow({
      issueKey: "TS-1",
      jiraCommentId: "c1",
      kind: "manual",
      postedAt: new Date().toISOString(),
      postedText: "test",
      status: "sent",
    });

    assertEqual(result, false, "a non-2xx response should be reported as false, not thrown");

    console.log("PASS: an HTTP error from the webhook degrades to false, never throws.");
  });
}

async function testNonJsonResponseIsTreatedAsFailure(): Promise<void> {
  console.log("\n--- Test: a non-JSON 200 (e.g. a Google sign-in page) is treated as a failure, not a false success ---");

  await withMockEnv(TEST_ENV, async () => {
    globalThis.fetch = () =>
      Promise.resolve(
        new Response("<html><body>Sign in to continue</body></html>", {
          headers: { "content-type": "text/html" },
          status: 200,
        }),
      );

    const result = await appendFollowUpLogRow({
      issueKey: "TS-1",
      jiraCommentId: "c1",
      kind: "manual",
      postedAt: new Date().toISOString(),
      postedText: "test",
      status: "sent",
    });

    assertEqual(
      result,
      false,
      "a non-JSON 200 (wrong Apps Script deployment access level) must not be mistaken for a real success",
    );

    console.log("PASS: a non-JSON 200 response (misconfigured deployment access) is correctly treated as a failure.");
  });
}

async function testOkFalseInBodyIsTreatedAsFailure(): Promise<void> {
  console.log("\n--- Test: a JSON response without ok:true is treated as a failure ---");

  await withMockEnv(TEST_ENV, async () => {
    globalThis.fetch = () => Promise.resolve(jsonResponse({ error: "something went wrong in the script" }));

    const result = await appendFollowUpLogRow({
      issueKey: "TS-1",
      jiraCommentId: "c1",
      kind: "manual",
      postedAt: new Date().toISOString(),
      postedText: "test",
      status: "sent",
    });

    assertEqual(result, false, "a JSON 200 without ok:true should be treated as a failure");

    console.log("PASS: a script-side error reported in the JSON body is correctly treated as a failure.");
  });
}

async function testBatchAppendSendsAllRowsInOneCall(): Promise<void> {
  console.log("\n--- Test: appendFollowUpLogRows batches multiple rows into a single request (for backfilling) ---");

  await withMockEnv(TEST_ENV, async () => {
    let callCount = 0;
    let lastBody = "";

    globalThis.fetch = (_input: RequestInfo | URL, init?: RequestInit) => {
      callCount += 1;
      lastBody = typeof init?.body === "string" ? init.body : "";
      return Promise.resolve(jsonResponse({ ok: true }));
    };

    const result = await appendFollowUpLogRows([
      { issueKey: "TS-1", jiraCommentId: "c1", kind: "manual", postedAt: "t1", postedText: "one", status: "sent" },
      { issueKey: "TS-2", jiraCommentId: "c2", kind: "manual", postedAt: "t2", postedText: "two", status: "sent" },
      { issueKey: "TS-3", jiraCommentId: "c3", kind: "manual", postedAt: "t3", postedText: "three", status: "sent" },
    ]);

    assertEqual(result, true, "a batch of valid rows should succeed");
    assertEqual(callCount, 1, "all rows should be sent in a single request, not one per row");

    const body = JSON.parse(lastBody) as { values: string[][] };
    assertEqual(body.values.length, 3, "the single call should carry all three rows");

    console.log("PASS: batch append sends every row in one request - safe for backfilling many historical entries at once.");
  });
}

async function testEmptyBatchIsANoOp(): Promise<void> {
  console.log("\n--- Test: appendFollowUpLogRows with zero rows makes no network call ---");

  await withMockEnv(TEST_ENV, async () => {
    let called = false;
    globalThis.fetch = () => {
      called = true;
      return Promise.resolve(jsonResponse({ ok: true }));
    };

    const result = await appendFollowUpLogRows([]);

    assertEqual(result, false, "an empty batch should report false (nothing was written)");
    assertEqual(called, false, "an empty batch should never make a network call at all");

    console.log("PASS: an empty batch is a true no-op, no wasted call.");
  });
}

async function main(): Promise<void> {
  try {
    testIsConfigured();
    await testGracefullyNoOpsWithoutConfig();
    await testSuccessfulAppendPostsCorrectRow();
    await testHttpFailureReturnsFalseNotThrow();
    await testNonJsonResponseIsTreatedAsFailure();
    await testOkFalseInBodyIsTreatedAsFailure();
    await testBatchAppendSendsAllRowsInOneCall();
    await testEmptyBatchIsANoOp();
    console.log("\nAll google-sheets-writer tests passed.");
    process.exit(0);
  } catch (error) {
    console.error("\nGoogle-sheets-writer test failed:", error);
    process.exit(1);
  }
}

main();
