import { decryptSecret, encryptSecret, isTokenEncryptionConfigured } from "@/lib/tokenCrypto";
import {
  getJiraCredentialsForAccount,
  listRegisteredJiraUsers,
  registerUserJiraToken,
  removeUserJiraToken,
} from "@/lib/userJiraTokens";
import type { UserTokenStore } from "@/lib/userJiraTokens";

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

  try {
    return await fn();
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  }
}

// A real 32-byte key, base64-encoded, for test purposes only.
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");

async function testEncryptDecryptRoundTrip(): Promise<void> {
  console.log("\n--- Test: encryptSecret/decryptSecret round-trips the original plaintext ---");

  await withMockEnv({ TOKEN_ENCRYPTION_KEY: TEST_KEY }, () => {
    const plaintext = "ATATT3xFfGF0_a-real-looking-jira-api-token-1234567890";
    const encrypted = encryptSecret(plaintext);

    assert(encrypted !== plaintext, "the encrypted form should not equal the plaintext");
    assertEqual(decryptSecret(encrypted), plaintext, "decrypting should recover the exact original plaintext");

    console.log("PASS: a token survives an encrypt/decrypt round trip unchanged.");
  });
}

async function testEncryptionIsNotDeterministic(): Promise<void> {
  console.log("\n--- Test: encrypting the same plaintext twice produces different ciphertext (random IV) ---");

  await withMockEnv({ TOKEN_ENCRYPTION_KEY: TEST_KEY }, () => {
    const plaintext = "same-token-both-times";
    const first = encryptSecret(plaintext);
    const second = encryptSecret(plaintext);

    assert(first !== second, "two encryptions of the same plaintext should differ (fresh random IV each time)");
    assertEqual(decryptSecret(first), plaintext, "first ciphertext should still decrypt correctly");
    assertEqual(decryptSecret(second), plaintext, "second ciphertext should still decrypt correctly");

    console.log("PASS: encryption is non-deterministic but both results decrypt to the same plaintext.");
  });
}

async function testTamperedCiphertextFailsToDecrypt(): Promise<void> {
  console.log("\n--- Test: a tampered ciphertext is rejected, not silently decrypted into garbage ---");

  await withMockEnv({ TOKEN_ENCRYPTION_KEY: TEST_KEY }, () => {
    const encrypted = encryptSecret("a-real-token");
    const raw = Buffer.from(encrypted, "base64");
    raw[raw.length - 1] = (raw[raw.length - 1]! + 1) % 256; // flip the last ciphertext byte
    const tampered = raw.toString("base64");

    let threw = false;
    try {
      decryptSecret(tampered);
    } catch {
      threw = true;
    }

    assert(threw, "GCM's auth tag should catch tampering and throw, not return corrupted plaintext");

    console.log("PASS: a tampered ciphertext throws instead of returning corrupted data.");
  });
}

async function testMissingKeyThrowsClearError(): Promise<void> {
  console.log("\n--- Test: a missing TOKEN_ENCRYPTION_KEY fails loudly with a clear message, not silently ---");

  await withMockEnv({ TOKEN_ENCRYPTION_KEY: undefined }, () => {
    assertEqual(isTokenEncryptionConfigured(), false, "should report unconfigured when the env var is unset");

    let message = "";
    try {
      encryptSecret("anything");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    assert(message.includes("TOKEN_ENCRYPTION_KEY"), "the error should name the missing env var");

    console.log("PASS: encrypting without a configured key throws a clear, actionable error.");
  });
}

async function testWrongLengthKeyIsRejected(): Promise<void> {
  console.log("\n--- Test: a key that doesn't decode to exactly 32 bytes is rejected ---");

  await withMockEnv({ TOKEN_ENCRYPTION_KEY: Buffer.alloc(16, 1).toString("base64") }, () => {
    let threw = false;
    try {
      encryptSecret("anything");
    } catch {
      threw = true;
    }

    assert(threw, "a 16-byte key should be rejected outright rather than silently used (AES-256 needs 32 bytes)");

    console.log("PASS: an incorrectly-sized key is rejected before it can produce a false sense of security.");
  });
}

// --- userJiraTokens.ts (registration/lookup/list/remove, real Redis stubbed out) ---

/** Minimal in-memory stand-in for the Redis slice UserTokenStore needs - lets registration/lookup/list/remove be tested without a real Upstash instance. */
class FakeTokenStore implements UserTokenStore {
  private readonly sets = new Map<string, Set<string>>();
  private readonly values = new Map<string, unknown>();

  del(key: string): Promise<unknown> {
    this.values.delete(key);
    return Promise.resolve(1);
  }

  get<T>(key: string): Promise<T | null> {
    return Promise.resolve((this.values.get(key) as T | undefined) ?? null);
  }

  sadd(key: string, member: string): Promise<unknown> {
    const set = this.sets.get(key) ?? new Set<string>();
    set.add(member);
    this.sets.set(key, set);
    return Promise.resolve(1);
  }

  smembers(key: string): Promise<string[]> {
    return Promise.resolve(Array.from(this.sets.get(key) ?? []));
  }

  set(key: string, value: unknown): Promise<unknown> {
    this.values.set(key, value);
    return Promise.resolve("OK");
  }

  srem(key: string, member: string): Promise<unknown> {
    this.sets.get(key)?.delete(member);
    return Promise.resolve(1);
  }
}

const REDIS_ENABLED_ENV = { UPSTASH_REDIS_REST_TOKEN: "fake-token", UPSTASH_REDIS_REST_URL: "https://fake.upstash.io" };

async function testRegisterValidatesAgainstJiraFirst(): Promise<void> {
  console.log("\n--- Test: registration rejects a bad email/token pair without ever touching the store ---");

  await withMockEnv({ TOKEN_ENCRYPTION_KEY: TEST_KEY, ...REDIS_ENABLED_ENV }, async () => {
    const store = new FakeTokenStore();
    const rejectingVerify = () => Promise.reject(new Error("401 Unauthorized"));

    const result = await registerUserJiraToken("bad@example.com", "wrong-token", rejectingVerify, store);

    assertEqual(result.ok, false, "a token Jira itself rejects should not register");
    assertEqual(await store.smembers("jira_user_tokens:accounts"), [], "nothing should be written to the store on a rejected token");

    console.log("PASS: a bad credential pair is rejected before anything is stored.");
  });
}

async function testRegisterStoresEncryptedAndReturnsRealIdentity(): Promise<void> {
  console.log("\n--- Test: a valid token registers, storing the token encrypted and returning Jira's own identity ---");

  await withMockEnv({ TOKEN_ENCRYPTION_KEY: TEST_KEY, ...REDIS_ENABLED_ENV }, async () => {
    const store = new FakeTokenStore();
    const verify = () =>
      Promise.resolve({ account_id: "acc-123", display_name: "Aditi Sharma", email: "aditi@certifyos.com" });

    const result = await registerUserJiraToken("aditi@certifyos.com", "real-token-value", verify, store);

    assert(result.ok, "a token Jira accepts should register successfully");
    assert(result.ok && result.user.accountId === "acc-123", "should return the account id Jira itself reported, not a locally-generated one");
    assert(result.ok && result.user.displayName === "Aditi Sharma", "should return Jira's own display name");

    const stored = await store.get<{ encryptedApiToken: string }>("jira_user_tokens:token:acc-123");
    assert(Boolean(stored), "a record should be stored under the real account id");
    assert(stored!.encryptedApiToken !== "real-token-value", "the stored token must be encrypted, never the raw value");
    assertEqual(decryptSecret(stored!.encryptedApiToken), "real-token-value", "decrypting the stored value should recover the real token");

    console.log("PASS: registration stores the token encrypted, keyed by Jira's own account id.");
  });
}

async function testGetCredentialsForAccountRoundTrips(): Promise<void> {
  console.log("\n--- Test: getJiraCredentialsForAccount returns the same email+token that was registered ---");

  await withMockEnv({ TOKEN_ENCRYPTION_KEY: TEST_KEY, ...REDIS_ENABLED_ENV }, async () => {
    const store = new FakeTokenStore();
    const verify = () => Promise.resolve({ account_id: "acc-456", display_name: "Akshay", email: "akshay@certifyos.com" });
    await registerUserJiraToken("akshay@certifyos.com", "akshay-token", verify, store);

    const credentials = await getJiraCredentialsForAccount("acc-456", store);
    assert(credentials !== null, "should find the registered credentials for this account");
    assertEqual(credentials?.apiToken, "akshay-token", "should decrypt back to the exact token that was registered");
    assertEqual(credentials?.email, "akshay@certifyos.com", "should return the associated email for Basic auth");

    const missing = await getJiraCredentialsForAccount("acc-does-not-exist", store);
    assertEqual(missing, null, "an unregistered account should fall back to null (caller uses the shared account)");

    console.log("PASS: registered credentials round-trip correctly by account id; unregistered accounts return null.");
  });
}

async function testListAndRemove(): Promise<void> {
  console.log("\n--- Test: listRegisteredJiraUsers/removeUserJiraToken reflect the current registration set ---");

  await withMockEnv({ TOKEN_ENCRYPTION_KEY: TEST_KEY, ...REDIS_ENABLED_ENV }, async () => {
    const store = new FakeTokenStore();
    await registerUserJiraToken(
      "riona@certifyos.com",
      "riona-token",
      () => Promise.resolve({ account_id: "acc-r", display_name: "Riona", email: "riona@certifyos.com" }),
      store,
    );
    await registerUserJiraToken(
      "jayaraj@certifyos.com",
      "jayaraj-token",
      () => Promise.resolve({ account_id: "acc-j", display_name: "Jayaraj", email: "jayaraj@certifyos.com" }),
      store,
    );

    const listed = await listRegisteredJiraUsers(store);
    assertEqual(listed.length, 2, "both registered users should be listed");
    assert(
      listed.every((user) => !("encryptedApiToken" in user)),
      "the list must never expose the encrypted token field, only display metadata",
    );

    await removeUserJiraToken("acc-r", store);
    const afterRemoval = await listRegisteredJiraUsers(store);
    assertEqual(afterRemoval.length, 1, "removing one user should leave exactly the other");
    assertEqual(afterRemoval[0]?.accountId, "acc-j", "the remaining user should be the one not removed");

    const removedCredentials = await getJiraCredentialsForAccount("acc-r", store);
    assertEqual(removedCredentials, null, "a removed account's credentials should no longer be retrievable");

    console.log("PASS: list reflects registrations without leaking tokens; remove fully deletes an account's entry.");
  });
}

async function testGracefulWithoutRedisOrEncryptionConfigured(): Promise<void> {
  console.log("\n--- Test: every function degrades gracefully when Redis or encryption isn't configured ---");

  await withMockEnv(
    { TOKEN_ENCRYPTION_KEY: undefined, UPSTASH_REDIS_REST_TOKEN: undefined, UPSTASH_REDIS_REST_URL: undefined },
    async () => {
      const result = await registerUserJiraToken("x@example.com", "token", () =>
        Promise.resolve({ account_id: "acc-x" }),
      );
      assertEqual(result.ok, false, "registration should refuse cleanly, not throw, without Redis configured");

      assertEqual(await getJiraCredentialsForAccount("any-account"), null, "should return null, not throw, without config");
      assertEqual(await listRegisteredJiraUsers(), [], "should return an empty list, not throw, without config");

      console.log("PASS: the whole module degrades gracefully (no crash) when Redis/encryption aren't configured.");
    },
  );
}

async function main(): Promise<void> {
  try {
    await testEncryptDecryptRoundTrip();
    await testEncryptionIsNotDeterministic();
    await testTamperedCiphertextFailsToDecrypt();
    await testMissingKeyThrowsClearError();
    await testWrongLengthKeyIsRejected();
    await testRegisterValidatesAgainstJiraFirst();
    await testRegisterStoresEncryptedAndReturnsRealIdentity();
    await testGetCredentialsForAccountRoundTrips();
    await testListAndRemove();
    await testGracefulWithoutRedisOrEncryptionConfigured();
    console.log("\nAll user-jira-tokens tests passed.");
    process.exit(0);
  } catch (error) {
    console.error("\nUser-jira-tokens test failed:", error);
    process.exit(1);
  }
}

main();
