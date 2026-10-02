import { createHmac } from "node:crypto";

import { authenticateSlackRequest } from "@/lib/slackRequestAuth";

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} failed: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const SECRET = "test-signing-secret";
const BODY = JSON.stringify({ event: { text: "TS-1", type: "message" }, type: "event_callback" });

function signed(body = BODY): { signature: string; timestamp: string } {
  const timestamp = String(Math.floor(Date.now() / 1000));
  return {
    signature: `v0=${createHmac("sha256", SECRET).update(`v0:${timestamp}:${body}`).digest("hex")}`,
    timestamp,
  };
}

const acceptOidc = () => Promise.resolve({});
const rejectOidc = () => Promise.reject(new Error("bad token"));

async function testConnectForwardedRequests(): Promise<void> {
  console.log("\n--- Test: Vercel Connect-forwarded requests are judged only on their OIDC token ---");

  const accepted = await authenticateSlackRequest(
    { authorization: "Bearer eyJ.valid.token", rawBody: BODY, signature: null, timestamp: null },
    { verifyOidcToken: acceptOidc },
  );
  assertEqual(accepted, { ok: true, via: "vercel_connect" }, "a valid Connect token is accepted");

  const { signature, timestamp } = signed();
  const rejected = await authenticateSlackRequest(
    { authorization: "Bearer eyJ.forged.token", rawBody: BODY, signature, timestamp },
    { signingSecret: SECRET, verifyOidcToken: rejectOidc },
  );
  assertEqual(rejected.ok, false, "an invalid bearer token is rejected even alongside a VALID Slack signature - no fallback");

  const malformed = await authenticateSlackRequest(
    { authorization: "Basic dXNlcjpwYXNz", rawBody: BODY, signature, timestamp },
    { signingSecret: SECRET, verifyOidcToken: acceptOidc },
  );
  assertEqual(malformed.ok, false, "a non-Bearer Authorization header is rejected");

  const realVerifierGarbage = await authenticateSlackRequest(
    { authorization: "Bearer not-a-jwt", rawBody: BODY, signature: null, timestamp: null },
    {},
  );
  assertEqual(realVerifierGarbage.ok, false, "the real @vercel/oidc verifier rejects a non-JWT");

  console.log("PASS");
}

async function testDirectSlackRequests(): Promise<void> {
  console.log("\n--- Test: direct Slack requests need a configured secret and a valid signature ---");

  const { signature, timestamp } = signed();

  const unconfigured = await authenticateSlackRequest({ authorization: null, rawBody: BODY, signature, timestamp }, {});
  assertEqual(unconfigured, { ok: false, reason: "Direct Slack requests are not configured on this server (no signing secret).", status: 503 }, "no secret -> 503, fail closed");

  const valid = await authenticateSlackRequest({ authorization: null, rawBody: BODY, signature, timestamp }, { signingSecret: SECRET });
  assertEqual(valid, { ok: true, via: "slack_signature" }, "a valid Slack signature is accepted");

  const tampered = await authenticateSlackRequest(
    { authorization: null, rawBody: `${BODY} `, signature, timestamp },
    { signingSecret: SECRET },
  );
  assertEqual(tampered.ok, false, "a tampered body is rejected");

  const unsigned = await authenticateSlackRequest({ authorization: null, rawBody: BODY, signature: null, timestamp: null }, { signingSecret: SECRET });
  assertEqual(unsigned.ok, false, "no signature at all is rejected");

  console.log("PASS");
}

async function main(): Promise<void> {
  try {
    await testConnectForwardedRequests();
    await testDirectSlackRequests();
    console.log("\nAll Slack request-auth tests passed.");
    process.exit(0);
  } catch (error) {
    console.error("\nSlack request-auth test failed:", error);
    process.exit(1);
  }
}

main();
