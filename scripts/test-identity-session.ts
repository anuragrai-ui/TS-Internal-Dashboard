import { createHash } from "node:crypto";

import {
  createIdentitySession,
  resolveIdentitySession,
  resolveSessionIdentity,
  revokeIdentitySession,
} from "@/lib/identitySession";
import type { SessionStore } from "@/lib/identitySession";

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

class FakeSessionStore implements SessionStore {
  readonly values = new Map<string, { ex: number; value: unknown }>();

  del(key: string): Promise<unknown> {
    this.values.delete(key);
    return Promise.resolve(1);
  }

  get<T>(key: string): Promise<T | null> {
    return Promise.resolve((this.values.get(key)?.value as T | undefined) ?? null);
  }

  set(key: string, value: unknown, opts: { ex: number }): Promise<unknown> {
    this.values.set(key, { ex: opts.ex, value });
    return Promise.resolve("OK");
  }
}

const ACCOUNT = "712020:c0bede50-504a-4050-9cfb-663b18068ef0";
const REGISTRATION = { accountId: ACCOUNT, registeredAt: "2026-10-02T08:00:00.000Z" };

async function testRoundTripAndHashedStorage(): Promise<void> {
  console.log("\n--- Test: a session resolves to its account, and Redis only ever sees a hash of the id ---");

  const store = new FakeSessionStore();
  const sessionId = await createIdentitySession(REGISTRATION, store);

  assert(sessionId !== null && sessionId.length === 43, "a 256-bit base64url session id should be issued");
  assertEqual(await resolveIdentitySession(sessionId!, store), REGISTRATION, "the session should resolve to its account and registration");

  const [key] = [...store.values.keys()];
  assert(!key!.includes(sessionId!), "the raw session id must never be stored");
  assertEqual(key, `identity_session:${createHash("sha256").update(sessionId!).digest("hex")}`, "stored under its SHA-256 hash");
  assert(store.values.get(key!)!.ex > 0, "sessions must expire");

  console.log("PASS");
}

async function testForgedCookieValuesDoNotResolve(): Promise<void> {
  console.log("\n--- Test: the old attack - setting the cookie to a known accountId - no longer identifies anyone ---");

  const store = new FakeSessionStore();
  await createIdentitySession(REGISTRATION, store);

  assertEqual(await resolveIdentitySession(ACCOUNT, store), null, "a raw accountId is not a session id");
  assertEqual(await resolveIdentitySession("A".repeat(43), store), null, "a well-formed but never-issued id resolves to nobody");
  assertEqual(await resolveIdentitySession(undefined, store), null, "no cookie resolves to nobody");
  assertEqual(await resolveIdentitySession("", store), null, "an empty cookie resolves to nobody");

  console.log("PASS");
}

async function testRevokeEndsTheSession(): Promise<void> {
  console.log("\n--- Test: revoking ends the session server-side, so a copied cookie stops working ---");

  const store = new FakeSessionStore();
  const first = await createIdentitySession(REGISTRATION, store);
  const second = await createIdentitySession(REGISTRATION, store);
  assert(first !== second, "every sign-in gets its own id");

  await revokeIdentitySession(first!, store);

  assertEqual(await resolveIdentitySession(first!, store), null, "the revoked session is gone");
  assertEqual(await resolveIdentitySession(second!, store), REGISTRATION, "another browser's session is unaffected");

  console.log("PASS");
}

async function testRemoveAndReRegisterEndsEveryOtherSession(): Promise<void> {
  console.log("\n--- Test: removing then re-registering a token signs out every older session (the reviewed attack) ---");

  const store = new FakeSessionStore();
  let registry: { accountId: string; displayName: string; registeredAt: string } | null = {
    ...REGISTRATION,
    displayName: "Anurag Rai",
  };
  const lookup = (accountId: string) => Promise.resolve(registry && registry.accountId === accountId ? registry : null);

  const sharedMachine = await createIdentitySession(REGISTRATION, store);
  assertEqual((await resolveSessionIdentity(sharedMachine!, lookup, store))?.accountId, ACCOUNT, "valid while the registration is current");

  registry = null; // Remove
  assertEqual(await resolveSessionIdentity(sharedMachine!, lookup, store), null, "removed token -> nobody");

  registry = { ...REGISTRATION, displayName: "Anurag Rai", registeredAt: "2026-10-02T09:30:00.000Z" }; // re-register
  const laptop = await createIdentitySession(registry, store);
  assertEqual(await resolveSessionIdentity(sharedMachine!, lookup, store), null, "the old shared-machine cookie must NOT come back after re-registering");
  assertEqual((await resolveSessionIdentity(laptop!, lookup, store))?.accountId, ACCOUNT, "the new session issued for the new registration works");

  console.log("PASS");
}

async function testRedisFailureOnCreateReturnsNull(): Promise<void> {
  console.log("\n--- Test: a Redis failure while creating a session returns null (clean 503), never throws ---");

  const failing = new FakeSessionStore();
  failing.set = () => Promise.reject(new Error("simulated Upstash timeout"));

  assertEqual(await createIdentitySession(REGISTRATION, failing), null, "no session id is handed out if it wasn't stored");

  console.log("PASS");
}

async function main(): Promise<void> {
  try {
    await testRoundTripAndHashedStorage();
    await testForgedCookieValuesDoNotResolve();
    await testRevokeEndsTheSession();
    await testRemoveAndReRegisterEndsEveryOtherSession();
    await testRedisFailureOnCreateReturnsNull();
    console.log("\nAll identity-session tests passed.");
    process.exit(0);
  } catch (error) {
    console.error("\nIdentity-session test failed:", error);
    process.exit(1);
  }
}

main();
