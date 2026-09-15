import { createHmac } from "node:crypto";

import { verifySlackSignature } from "@/lib/slackSignature";

const SIGNING_SECRET = "test-signing-secret";
const RAW_BODY = JSON.stringify({ event: { text: "Any update on TS-1234?", type: "message" } });

function assert(condition: boolean, label: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${label}`);
  }
}

function computeSignature(signingSecret: string, timestamp: string, rawBody: string): string {
  return `v0=${createHmac("sha256", signingSecret)
    .update(`v0:${timestamp}:${rawBody}`)
    .digest("hex")}`;
}

function freshTimestamp(): string {
  return String(Math.floor(Date.now() / 1000));
}

function testValidSignature(): void {
  console.log("\n--- Test: correctly-computed signature with a fresh timestamp ---");

  const timestamp = freshTimestamp();
  const signature = computeSignature(SIGNING_SECRET, timestamp, RAW_BODY);

  const result = verifySlackSignature({
    rawBody: RAW_BODY,
    signature,
    signingSecret: SIGNING_SECRET,
    timestamp,
  });

  assert(result === true, "a correctly-computed signature should verify");
  console.log("PASS: valid signature verifies.");
}

function testTamperedBody(): void {
  console.log("\n--- Test: tampered body fails verification ---");

  const timestamp = freshTimestamp();
  const signature = computeSignature(SIGNING_SECRET, timestamp, RAW_BODY);

  const result = verifySlackSignature({
    rawBody: `${RAW_BODY} extra`,
    signature,
    signingSecret: SIGNING_SECRET,
    timestamp,
  });

  assert(result === false, "a tampered body should fail verification");
  console.log("PASS: tampered body is rejected.");
}

function testTamperedSignature(): void {
  console.log("\n--- Test: tampered signature fails verification ---");

  const timestamp = freshTimestamp();
  const signature = computeSignature(SIGNING_SECRET, timestamp, RAW_BODY);
  const tamperedSignature = signature.slice(0, -1) + (signature.endsWith("a") ? "b" : "a");

  const result = verifySlackSignature({
    rawBody: RAW_BODY,
    signature: tamperedSignature,
    signingSecret: SIGNING_SECRET,
    timestamp,
  });

  assert(result === false, "a tampered signature should fail verification");
  console.log("PASS: tampered signature is rejected.");
}

function testStaleTimestamp(): void {
  console.log("\n--- Test: stale timestamp fails verification even with a correct signature ---");

  const staleTimestamp = String(Math.floor(Date.now() / 1000) - 301);
  const signature = computeSignature(SIGNING_SECRET, staleTimestamp, RAW_BODY);

  const result = verifySlackSignature({
    rawBody: RAW_BODY,
    signature,
    signingSecret: SIGNING_SECRET,
    timestamp: staleTimestamp,
  });

  assert(result === false, "a timestamp more than 5 minutes old should fail verification");
  console.log("PASS: stale timestamp is rejected.");
}

function testMismatchedLengthDoesNotThrow(): void {
  console.log("\n--- Test: a signature of a different length is rejected without throwing ---");

  const timestamp = freshTimestamp();

  let result: boolean | undefined;
  let threw = false;

  try {
    result = verifySlackSignature({
      rawBody: RAW_BODY,
      signature: "v0=tooshort",
      signingSecret: SIGNING_SECRET,
      timestamp,
    });
  } catch {
    threw = true;
  }

  assert(!threw, "a length-mismatched signature should not throw");
  assert(result === false, "a length-mismatched signature should return false");
  console.log("PASS: length-mismatched signature returns false without throwing.");
}

function main(): void {
  try {
    testValidSignature();
    testTamperedBody();
    testTamperedSignature();
    testStaleTimestamp();
    testMismatchedLengthDoesNotThrow();
    console.log("\nAll Slack signature tests passed.");
    process.exit(0);
  } catch (error) {
    console.error("\nSlack signature test failed:", error);
    process.exit(1);
  }
}

main();
