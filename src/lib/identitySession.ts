import { createHash, randomBytes } from "node:crypto";

import { getRedis, isRedisConfigured } from "@/lib/redis";

/**
 * Server-side browser sessions backing src/lib/currentIdentity.ts.
 *
 * The identity cookie used to hold the raw Jira accountId. That isn't a
 * secret - it was even listed publicly by GET /api/settings/jira-tokens - so
 * anyone could set the cookie in their own browser and be treated as a
 * teammate, including sending under that teammate's personal Jira token.
 * Now the cookie holds a random 256-bit session id that only this server
 * ever hands out, and only right after Jira's own /myself verified that
 * person's email + API token (POST /api/settings/jira-tokens).
 *
 * Redis stores a SHA-256 hash of the id, never the id itself, so a Redis
 * dump or backup can't be replayed as a cookie.
 */
export const SESSION_COOKIE = "ts_identity_session";
/* The old raw-accountId cookie - never trusted any more, only cleared. */
export const LEGACY_IDENTITY_COOKIE = "ts_identity_account_id";
export const SESSION_TTL_SECONDS = 180 * 86_400;

const SESSION_KEY_PREFIX = "identity_session:";

interface StoredSession {
  accountId: string;
  createdAt: string;
  /* The registry record's registeredAt at the moment this session was
     issued. Re-registering (or removing then re-adding) a token writes a
     new registeredAt, which invalidates every session issued before it -
     see resolveSessionIdentity. */
  registeredAt: string;
}

export interface SessionIdentity {
  accountId: string;
  registeredAt: string;
}

/* The slice of the Redis client this module touches - injectable for tests, same DI pattern as userJiraTokens.ts. */
export interface SessionStore {
  del: (key: string) => Promise<unknown>;
  get: <T>(key: string) => Promise<T | null>;
  set: (key: string, value: unknown, opts: { ex: number }) => Promise<unknown>;
}

function sessionKey(sessionId: string): string {
  return `${SESSION_KEY_PREFIX}${createHash("sha256").update(sessionId).digest("hex")}`;
}

/* Base64url of 32 random bytes is exactly 43 characters - anything else can't be one of ours, so skip the Redis round-trip. */
function looksLikeSessionId(value: string | undefined): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

/** Returns the new session id to put in the cookie, or null if the session couldn't be persisted (Redis unconfigured or failing). */
export async function createIdentitySession(
  identity: SessionIdentity,
  store?: SessionStore,
): Promise<string | null> {
  if (!store && !isRedisConfigured()) {
    return null;
  }

  const sessionId = randomBytes(32).toString("base64url");
  const record: StoredSession = {
    accountId: identity.accountId,
    createdAt: new Date().toISOString(),
    registeredAt: identity.registeredAt,
  };

  try {
    await (store ?? getRedis()).set(sessionKey(sessionId), record, { ex: SESSION_TTL_SECONDS });
    return sessionId;
  } catch (error) {
    console.warn("Failed to persist a new identity session.", error);
    return null;
  }
}

/** What this session was issued for, or null for a missing, malformed, expired, or revoked session. */
export async function resolveIdentitySession(
  sessionId: string | undefined,
  store?: SessionStore,
): Promise<SessionIdentity | null> {
  if (!looksLikeSessionId(sessionId) || (!store && !isRedisConfigured())) {
    return null;
  }

  try {
    const record = await (store ?? getRedis()).get<StoredSession>(sessionKey(sessionId));
    /* A record without registeredAt can't be tied to a registration, so it can't be trusted. */
    return record?.accountId && record.registeredAt
      ? { accountId: record.accountId, registeredAt: record.registeredAt }
      : null;
  } catch (error) {
    console.warn("Identity session lookup failed; treating this browser as unidentified.", error);
    return null;
  }
}

/**
 * Session -> the live registry record it belongs to, or null. The session
 * must match the account's CURRENT registration: removing your token makes
 * every session resolve to nobody, and re-registering (new registeredAt)
 * permanently invalidates every session issued before it - so "remove,
 * then register again" really does sign out every other browser, and so
 * does rotating your token.
 */
export async function resolveSessionIdentity<T extends SessionIdentity>(
  sessionId: string | undefined,
  lookupRegistration: (accountId: string) => Promise<T | null>,
  store?: SessionStore,
): Promise<T | null> {
  const session = await resolveIdentitySession(sessionId, store);
  if (!session) {
    return null;
  }

  const record = await lookupRegistration(session.accountId);
  return record && record.registeredAt === session.registeredAt ? record : null;
}

export async function revokeIdentitySession(sessionId: string | undefined, store?: SessionStore): Promise<void> {
  if (!looksLikeSessionId(sessionId) || (!store && !isRedisConfigured())) {
    return;
  }

  try {
    await (store ?? getRedis()).del(sessionKey(sessionId));
  } catch (error) {
    console.warn("Failed to revoke an identity session.", error);
  }
}
