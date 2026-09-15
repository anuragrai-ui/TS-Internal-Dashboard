import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM encryption for secrets stored at rest (currently just
 * per-team-member Jira API tokens - see src/lib/userJiraTokens.ts). This is
 * the first place this codebase encrypts anything at rest, so the format is
 * deliberately simple and self-contained: base64(iv[12] || authTag[16] ||
 * ciphertext), one field, no external key-management dependency. The key
 * itself lives in TOKEN_ENCRYPTION_KEY (32 raw bytes, base64-encoded) - never
 * derived from anything else, so losing it means every stored token must be
 * re-registered rather than silently becoming readable by an attacker who
 * only has Redis access.
 */
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

function getKey(): Buffer {
  const raw = process.env.TOKEN_ENCRYPTION_KEY;

  if (!raw) {
    throw new Error(
      "TOKEN_ENCRYPTION_KEY is not set - required to store per-user Jira tokens. Generate one with: openssl rand -base64 32",
    );
  }

  const key = Buffer.from(raw, "base64");

  if (key.length !== 32) {
    throw new Error(
      `TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes (got ${key.length}) - generate one with: openssl rand -base64 32`,
    );
  }

  return key;
}

export function isTokenEncryptionConfigured(): boolean {
  return Boolean(process.env.TOKEN_ENCRYPTION_KEY);
}

export function encryptSecret(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([iv, authTag, ciphertext]).toString("base64");
}

export function decryptSecret(encrypted: string): string {
  const key = getKey();
  const raw = Buffer.from(encrypted, "base64");

  const iv = raw.subarray(0, IV_LENGTH);
  const authTag = raw.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = raw.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
