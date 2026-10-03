import { createHash, randomBytes } from "node:crypto";

import { connectHint } from "@/lib/google/messages";
import { getRedis, isRedisConfigured } from "@/lib/redis";
import { decryptSecret, encryptSecret } from "@/lib/tokenCrypto";

import type { GoogleConnectErrorCode } from "@/lib/google/messages";
import type { GoogleConnectionState, GoogleConnectionStatus, GooglePurpose } from "@/lib/workspace/types";

/**
 * The dashboard's one-time Google sign-ins. The on-call calendar lives in
 * the certifyos.com Workspace with no public or secret iCal address, and the
 * support mailbox is a Workspace account too, so the server holds one
 * offline (refresh-token) grant per purpose:
 *
 * - "calendar": calendar.readonly - any certifyos.com account that can see
 *   the rotation calendar
 * - "mailbox":  gmail.readonly + gmail.send (the sync only reads; nothing is labelled or archived) - must be SUPPORT_MAILBOX_ADDRESS
 *   itself (Google's domain-wide delegation would need a service account
 *   and a Workspace admin; a one-time sign-in by whoever holds the mailbox
 *   needs neither)
 *
 * The flow is OAuth's web-server flow with PKCE, prompt=consent (so Google
 * always returns a refresh token) and hd=certifyos.com (so the account
 * picker only offers Workspace accounts - re-checked on the id_token, since
 * hd is a hint a person can edit). Only an identified dashboard user can
 * start one; the random `state` lives in Redis for 10 minutes bound to their
 * accountId and the purpose, is single-use, and the callback must come back
 * to the same identity.
 *
 * At rest (Redis, no expiry):
 * - google:conn:<purpose>    the refresh token (AES-GCM, tokenCrypto.ts),
 *                            who connected what and when, or "broken"
 * - google:access:<purpose>  the current access token (encrypted too),
 *                            until two minutes before Google expires it
 * - google:oauth:state:<s>   one pending sign-in, 10 minutes
 *
 * No token, code or verifier is ever logged or put in an error message.
 * Everything takes injectable deps (scripts/test-google.ts); the exported
 * functions never throw.
 */

export const GOOGLE_WORKSPACE_DOMAIN = "certifyos.com";
const DEFAULT_APP_BASE_URL = "https://ts-internal-dashboard.vercel.app";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const FETCH_TIMEOUT_MS = 10_000;
export const STATE_TTL_SECONDS = 600;
/* Refresh this long before Google's own expiry, so a token never dies mid-request. */
const ACCESS_TOKEN_MARGIN_MS = 2 * 60_000;
const VALID_ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);

const SCOPE = {
  calendar: "https://www.googleapis.com/auth/calendar.readonly",
  email: "email",
  gmailReadonly: "https://www.googleapis.com/auth/gmail.readonly",
  gmailSend: "https://www.googleapis.com/auth/gmail.send",
  openid: "openid",
};

/** Minimal scopes per purpose; openid + email identify the account that signed in. */
export const GOOGLE_SCOPES: Record<GooglePurpose, readonly string[]> = {
  calendar: [SCOPE.openid, SCOPE.email, SCOPE.calendar],
  mailbox: [SCOPE.openid, SCOPE.email, SCOPE.gmailReadonly, SCOPE.gmailSend],
};

export const GOOGLE_PURPOSES: readonly GooglePurpose[] = ["calendar", "mailbox"];

export function isGooglePurpose(value: unknown): value is GooglePurpose {
  return value === "calendar" || value === "mailbox";
}

/* ------------------------------------------------------------------ deps */

/** The slice of Redis the connection needs - throws on failure; callers turn that into a result. */
export interface GoogleKv {
  del(key: string): Promise<void>;
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, ttlSeconds?: number): Promise<void>;
  /* GETDEL - read and remove in one step, so a state can only be used once. */
  take<T>(key: string): Promise<T | null>;
}

export interface GoogleOAuthDeps {
  decrypt: (ciphertext: string) => string;
  encrypt: (plaintext: string) => string;
  env: Record<string, string | undefined>;
  fetchImpl: typeof fetch;
  /* null when Redis isn't configured - nothing can be stored, so nothing is connected. */
  kv: GoogleKv | null;
  now: () => number;
  randomBytes: (size: number) => Buffer;
}

export interface GoogleActor {
  accountId: string;
  displayName: string;
}

interface StoredConnection {
  connectedAt: string;
  connectedBy: string;
  connectedByAccountId: string;
  connectedEmail: string;
  /* Encrypted. */
  refreshToken: string;
  scopes: string[];
  state: "broken" | "connected";
  brokenAt?: string;
  brokenReason?: string;
}

interface StoredAccessToken {
  expiresAt: number;
  /* Encrypted. */
  token: string;
}

interface StoredState {
  accountId: string;
  createdAt: number;
  purpose: GooglePurpose;
  verifier: string;
}

const keys = {
  access: (purpose: GooglePurpose) => `google:access:${purpose}`,
  conn: (purpose: GooglePurpose) => `google:conn:${purpose}`,
  state: (state: string) => `google:oauth:state:${state}`,
};

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** The support mailbox's address, lower-cased, or null when SUPPORT_MAILBOX_ADDRESS is unset. Pure. */
export function supportMailboxAddress(env: Record<string, string | undefined> = process.env): string | null {
  return nonEmpty(env.SUPPORT_MAILBOX_ADDRESS)?.toLowerCase() ?? null;
}

/** Where Google sends the person back: APP_BASE_URL (or the production URL) + /api/google/callback. Pure. */
export function googleRedirectUri(env: Record<string, string | undefined> = process.env): string {
  return `${(nonEmpty(env.APP_BASE_URL) ?? DEFAULT_APP_BASE_URL).replace(/\/+$/, "")}/api/google/callback`;
}

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/** The OAuth client from env, or the env vars still missing. Pure. */
export function googleOAuthConfig(env: Record<string, string | undefined>): { config: GoogleOAuthConfig; ok: true } | { missing: string[]; ok: false } {
  const clientId = nonEmpty(env.GOOGLE_OAUTH_CLIENT_ID);
  const clientSecret = nonEmpty(env.GOOGLE_OAUTH_CLIENT_SECRET);
  if (!clientId || !clientSecret) {
    return { missing: [...(clientId ? [] : ["GOOGLE_OAUTH_CLIENT_ID"]), ...(clientSecret ? [] : ["GOOGLE_OAUTH_CLIENT_SECRET"])], ok: false };
  }
  return { config: { clientId, clientSecret, redirectUri: googleRedirectUri(env) }, ok: true };
}

/** Every env var a purpose still needs - shown on the setup cards. Pure. */
export function missingGoogleEnv(purpose: GooglePurpose, env: Record<string, string | undefined>, redisConfigured: boolean): string[] {
  const missing: string[] = [];
  const oauth = googleOAuthConfig(env);
  if (!oauth.ok) {
    missing.push(...oauth.missing);
  }
  if (!nonEmpty(env.TOKEN_ENCRYPTION_KEY)) {
    missing.push("TOKEN_ENCRYPTION_KEY");
  }
  if (!redisConfigured) {
    missing.push("UPSTASH_REDIS_REST_URL");
  }
  if (purpose === "calendar" && !nonEmpty(env.ONCALL_GOOGLE_CALENDAR_ID)) {
    missing.push("ONCALL_GOOGLE_CALENDAR_ID");
  }
  if (purpose === "mailbox" && !supportMailboxAddress(env)) {
    missing.push("SUPPORT_MAILBOX_ADDRESS");
  }
  return missing;
}

function base64Url(bytes: Buffer): string {
  return bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** RFC 7636 S256 challenge for a verifier. Pure. */
export function pkceChallenge(verifier: string): string {
  return base64Url(createHash("sha256").update(verifier).digest());
}

/** Google's consent URL for one purpose. Pure. */
export function buildGoogleAuthUrl(config: GoogleOAuthConfig, purpose: GooglePurpose, state: string, challenge: string, loginHint?: string | null): string {
  const params = new URLSearchParams({
    access_type: "offline",
    client_id: config.clientId,
    code_challenge: challenge,
    code_challenge_method: "S256",
    hd: GOOGLE_WORKSPACE_DOMAIN,
    /* No incremental auth: each purpose's grant holds exactly its own scopes. */
    include_granted_scopes: "false",
    prompt: "consent",
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: GOOGLE_SCOPES[purpose].join(" "),
    state,
  });
  if (loginHint) {
    params.set("login_hint", loginHint);
  }
  return `${AUTH_URL}?${params.toString()}`;
}

function errorText(error: unknown): string {
  /* Only the name and Google's error code ever reach a log line - never a body that might echo a token. */
  return error instanceof Error ? error.name : "unknown";
}

/* --------------------------------------------------------------- start */

export type StartResult = { ok: true; url: string } | { code: GoogleConnectErrorCode; ok: false };

/** Starts a sign-in for `actor`: stores a single-use state (10 min) and returns Google's consent URL. Never throws. */
export async function startGoogleConnection(deps: GoogleOAuthDeps, actor: GoogleActor, purpose: GooglePurpose): Promise<StartResult> {
  if (!isGooglePurpose(purpose)) {
    return { code: "bad_purpose", ok: false };
  }
  const oauth = googleOAuthConfig(deps.env);
  if (!oauth.ok || (purpose === "mailbox" && !supportMailboxAddress(deps.env))) {
    return { code: "unconfigured", ok: false };
  }
  if (!deps.kv) {
    return { code: "storage", ok: false };
  }
  const state = base64Url(deps.randomBytes(32));
  const verifier = base64Url(deps.randomBytes(48));
  try {
    const record: StoredState = { accountId: actor.accountId, createdAt: deps.now(), purpose, verifier };
    await deps.kv.set(keys.state(state), record, STATE_TTL_SECONDS);
  } catch (error) {
    console.warn(`Google: couldn't store a sign-in state (${errorText(error)}).`);
    return { code: "storage", ok: false };
  }
  /* The mailbox must be the support account itself - pre-select it in Google's account picker. */
  const hint = purpose === "mailbox" ? supportMailboxAddress(deps.env) : null;
  return { ok: true, url: buildGoogleAuthUrl(oauth.config, purpose, state, pkceChallenge(verifier), hint) };
}

/* ------------------------------------------------------------ callback */

export interface IdTokenClaims {
  aud?: unknown;
  email?: unknown;
  email_verified?: unknown;
  exp?: unknown;
  hd?: unknown;
  iss?: unknown;
}

/**
 * The id_token's claims. Its signature isn't checked: the token came
 * straight from Google's token endpoint over TLS in exchange for our own
 * client secret and PKCE verifier, which OpenID Connect Core 3.1.3.7 allows
 * in place of signature validation. Issuer, audience and expiry still are.
 * Pure.
 */
export function readIdToken(idToken: unknown, clientId: string, nowMs: number): IdTokenClaims | null {
  if (typeof idToken !== "string") {
    return null;
  }
  const payload = idToken.split(".")[1];
  if (!payload) {
    return null;
  }
  try {
    const claims = JSON.parse(Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")) as IdTokenClaims;
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (typeof claims.iss !== "string" || !VALID_ISSUERS.has(claims.iss) || !audiences.includes(clientId)) {
      return null;
    }
    if (typeof claims.exp !== "number" || claims.exp * 1000 <= nowMs) {
      return null;
    }
    return claims;
  } catch {
    return null;
  }
}

/**
 * Whether the signed-in Google account may hold this purpose's grant: a
 * verified certifyos.com address (and Workspace `hd`), and for the mailbox
 * the support address itself. Returns the lower-cased email. Pure.
 */
export function checkConnectedAccount(
  claims: IdTokenClaims,
  purpose: GooglePurpose,
  env: Record<string, string | undefined>,
): { email: string; ok: true } | { code: GoogleConnectErrorCode; ok: false } {
  const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
  if (!email) {
    return { code: "bad_id_token", ok: false };
  }
  if (claims.email_verified !== true && claims.email_verified !== "true") {
    return { code: "unverified_email", ok: false };
  }
  const domain = email.slice(email.lastIndexOf("@") + 1);
  if (domain !== GOOGLE_WORKSPACE_DOMAIN || (claims.hd !== undefined && (typeof claims.hd !== "string" || claims.hd.toLowerCase() !== GOOGLE_WORKSPACE_DOMAIN))) {
    return { code: "wrong_domain", ok: false };
  }
  if (purpose === "mailbox" && email !== supportMailboxAddress(env)) {
    return { code: "wrong_mailbox", ok: false };
  }
  return { email, ok: true };
}

async function postForm(deps: GoogleOAuthDeps, url: string, form: Record<string, string>): Promise<{ body: Record<string, unknown> | null; status: number } | null> {
  try {
    const response = await deps.fetchImpl(url, {
      body: new URLSearchParams(form).toString(),
      cache: "no-store",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    return { body, status: response.status };
  } catch (error) {
    console.warn(`Google: ${new URL(url).pathname} request failed (${errorText(error)}).`);
    return null;
  }
}

async function revokeToken(deps: GoogleOAuthDeps, token: string): Promise<boolean> {
  const result = await postForm(deps, GOOGLE_REVOKE_URL, { token });
  /* 400 invalid_token: already revoked or expired - as good as revoked. */
  return result !== null && (result.status === 200 || (result.status === 400 && result.body?.error === "invalid_token"));
}

export type CompleteResult = { email: string; ok: true; purpose: GooglePurpose } | { code: GoogleConnectErrorCode; ok: false; purpose?: GooglePurpose };

/**
 * Finishes a sign-in from Google's redirect: checks the state (exists,
 * unused, < 10 minutes, same dashboard user), exchanges the code with the
 * PKCE verifier, checks the account, and stores the refresh token
 * encrypted. Never throws.
 */
export async function completeGoogleConnection(
  deps: GoogleOAuthDeps,
  params: { code: string | null; error: string | null; state: string | null },
  actor: GoogleActor,
): Promise<CompleteResult> {
  const oauth = googleOAuthConfig(deps.env);
  if (!oauth.ok) {
    return { code: "unconfigured", ok: false };
  }
  if (!deps.kv) {
    return { code: "storage", ok: false };
  }
  if (!params.state || !/^[A-Za-z0-9_-]{20,100}$/.test(params.state)) {
    return { code: "bad_state", ok: false };
  }

  let stored: StoredState | null;
  try {
    stored = await deps.kv.take<StoredState>(keys.state(params.state));
  } catch (error) {
    console.warn(`Google: couldn't read the sign-in state (${errorText(error)}).`);
    return { code: "storage", ok: false };
  }
  if (!stored || !isGooglePurpose(stored.purpose)) {
    return { code: "bad_state", ok: false };
  }
  const purpose = stored.purpose;
  if (deps.now() - stored.createdAt > STATE_TTL_SECONDS * 1000) {
    return { code: "expired_state", ok: false, purpose };
  }
  if (stored.accountId !== actor.accountId) {
    return { code: "wrong_user", ok: false, purpose };
  }
  if (params.error) {
    return { code: "access_denied", ok: false, purpose };
  }
  if (!params.code) {
    return { code: "token_exchange", ok: false, purpose };
  }

  const exchange = await postForm(deps, GOOGLE_TOKEN_URL, {
    client_id: oauth.config.clientId,
    client_secret: oauth.config.clientSecret,
    code: params.code,
    code_verifier: stored.verifier,
    grant_type: "authorization_code",
    redirect_uri: oauth.config.redirectUri,
  });
  if (!exchange || exchange.status !== 200 || !exchange.body) {
    console.warn(`Google: code exchange for ${purpose} failed (HTTP ${exchange?.status ?? "none"}, ${typeof exchange?.body?.error === "string" ? exchange.body.error : "no error code"}).`);
    return { code: "token_exchange", ok: false, purpose };
  }
  const body = exchange.body;

  const claims = readIdToken(body.id_token, oauth.config.clientId, deps.now());
  if (!claims) {
    return { code: "bad_id_token", ok: false, purpose };
  }
  const account = checkConnectedAccount(claims, purpose, deps.env);
  const accessToken = typeof body.access_token === "string" ? body.access_token : null;
  const refreshToken = typeof body.refresh_token === "string" ? body.refresh_token : null;
  if (!account.ok) {
    /* Don't leave a grant for the wrong account lying around at Google either. */
    if (refreshToken ?? accessToken) {
      await revokeToken(deps, (refreshToken ?? accessToken) as string);
    }
    return { code: account.code, ok: false, purpose };
  }

  const granted = typeof body.scope === "string" ? body.scope.split(/\s+/).filter(Boolean) : [];
  /* Google's granular consent lets a person untick scopes; openid/email come back as userinfo.email etc., so only the API scopes are checked. */
  const needed = GOOGLE_SCOPES[purpose].filter((scope) => scope.startsWith("https://"));
  if (needed.some((scope) => !granted.includes(scope))) {
    if (refreshToken ?? accessToken) {
      await revokeToken(deps, (refreshToken ?? accessToken) as string);
    }
    return { code: "missing_scopes", ok: false, purpose };
  }
  if (!refreshToken) {
    return { code: "no_refresh_token", ok: false, purpose };
  }

  try {
    const previous = await deps.kv.get<StoredConnection>(keys.conn(purpose));
    const connection: StoredConnection = {
      connectedAt: new Date(deps.now()).toISOString(),
      connectedBy: actor.displayName,
      connectedByAccountId: actor.accountId,
      connectedEmail: account.email,
      refreshToken: deps.encrypt(refreshToken),
      scopes: granted,
      state: "connected",
    };
    await deps.kv.set(keys.conn(purpose), connection);
    await deps.kv.del(keys.access(purpose));
    if (accessToken && typeof body.expires_in === "number") {
      const cached: StoredAccessToken = { expiresAt: deps.now() + body.expires_in * 1000, token: deps.encrypt(accessToken) };
      const ttl = Math.floor((body.expires_in * 1000 - ACCESS_TOKEN_MARGIN_MS) / 1000);
      if (ttl > 0) {
        await deps.kv.set(keys.access(purpose), cached, ttl);
      }
    }
    if (previous?.refreshToken) {
      /* The replaced grant would otherwise stay valid at Google, unused, until someone revokes it by hand. */
      try {
        const old = deps.decrypt(previous.refreshToken);
        if (old !== refreshToken) {
          await revokeToken(deps, old);
        }
      } catch {
        /* Encrypted under an older key - nothing usable to revoke. */
      }
    }
  } catch (error) {
    console.warn(`Google: couldn't store the ${purpose} connection (${errorText(error)}).`);
    return { code: "storage", ok: false, purpose };
  }
  console.info(`Google: ${purpose} connected by ${actor.displayName}.`);
  return { email: account.email, ok: true, purpose };
}

/* -------------------------------------------------------- access tokens */

export type AccessTokenResult = { ok: true; token: string } | { error: string; ok: false; state: GoogleConnectionState };

/**
 * A usable access token for a purpose: the cached one while it has more
 * than two minutes left, else a fresh one from the refresh token. When
 * Google answers invalid_grant the stored sign-in is dead (revoked, the
 * account's password reset, an admin removed the app): the connection is
 * marked broken so the UI asks for a new sign-in. Never throws.
 */
export async function getGoogleAccessToken(deps: GoogleOAuthDeps, purpose: GooglePurpose): Promise<AccessTokenResult> {
  const oauth = googleOAuthConfig(deps.env);
  if (!oauth.ok || !deps.kv) {
    return { error: `Google sign-in isn't set up on the server (${oauth.ok ? "Redis" : oauth.missing.join(", ")}).`, ok: false, state: "unconfigured" };
  }
  const kv = deps.kv;
  try {
    const cached = await kv.get<StoredAccessToken>(keys.access(purpose));
    if (cached && cached.expiresAt - deps.now() > ACCESS_TOKEN_MARGIN_MS) {
      return { ok: true, token: deps.decrypt(cached.token) };
    }
    const connection = await kv.get<StoredConnection>(keys.conn(purpose));
    if (!connection) {
      return { error: `Google isn't connected. ${connectHint(purpose)}`, ok: false, state: "not_connected" };
    }
    if (connection.state === "broken") {
      return { error: `The Google sign-in stopped working${connection.brokenReason ? ` (${connection.brokenReason})` : ""}. ${connectHint(purpose)}`, ok: false, state: "broken" };
    }

    const refreshed = await postForm(deps, GOOGLE_TOKEN_URL, {
      client_id: oauth.config.clientId,
      client_secret: oauth.config.clientSecret,
      grant_type: "refresh_token",
      refresh_token: deps.decrypt(connection.refreshToken),
    });
    if (!refreshed) {
      return { error: "Couldn't reach Google to refresh the sign-in - try again in a moment.", ok: false, state: "connected" };
    }
    const errorCode = typeof refreshed.body?.error === "string" ? refreshed.body.error : null;
    if (errorCode === "invalid_grant") {
      const broken: StoredConnection = {
        ...connection,
        brokenAt: new Date(deps.now()).toISOString(),
        brokenReason: "Google revoked or expired the stored sign-in",
        state: "broken",
      };
      await kv.set(keys.conn(purpose), broken);
      await kv.del(keys.access(purpose));
      console.warn(`Google: the ${purpose} connection is broken (invalid_grant).`);
      return { error: `The Google sign-in was revoked or expired. ${connectHint(purpose)}`, ok: false, state: "broken" };
    }
    const token = typeof refreshed.body?.access_token === "string" ? refreshed.body.access_token : null;
    const expiresIn = typeof refreshed.body?.expires_in === "number" ? refreshed.body.expires_in : 3_600;
    if (refreshed.status !== 200 || !token) {
      console.warn(`Google: refreshing the ${purpose} token failed (HTTP ${refreshed.status}, ${errorCode ?? "no error code"}).`);
      return { error: `Google refused to refresh the sign-in (${errorCode ?? `HTTP ${refreshed.status}`}).`, ok: false, state: "connected" };
    }
    const ttl = Math.floor((expiresIn * 1000 - ACCESS_TOKEN_MARGIN_MS) / 1000);
    if (ttl > 0) {
      await kv.set(keys.access(purpose), { expiresAt: deps.now() + expiresIn * 1000, token: deps.encrypt(token) } satisfies StoredAccessToken, ttl);
    }
    return { ok: true, token };
  } catch (error) {
    console.warn(`Google: couldn't get a ${purpose} access token (${errorText(error)}).`);
    return { error: "Couldn't read the stored Google sign-in (Redis or TOKEN_ENCRYPTION_KEY).", ok: false, state: "connected" };
  }
}

/** Drops the cached access token (an API said 401), so the next call refreshes. Never throws. */
export async function invalidateGoogleAccessToken(deps: GoogleOAuthDeps, purpose: GooglePurpose): Promise<void> {
  try {
    await deps.kv?.del(keys.access(purpose));
  } catch (error) {
    console.warn(`Google: couldn't drop the cached ${purpose} token (${errorText(error)}).`);
  }
}

/* --------------------------------------------------- status, disconnect */

/** What the setup cards show for a purpose. Never throws. */
export async function getGoogleConnectionStatus(deps: GoogleOAuthDeps, purpose: GooglePurpose): Promise<GoogleConnectionStatus> {
  const missingEnv = missingGoogleEnv(purpose, deps.env, deps.kv !== null);
  const oauth = googleOAuthConfig(deps.env);
  if (!oauth.ok || !deps.kv || (purpose === "mailbox" && !supportMailboxAddress(deps.env))) {
    return { missingEnv, purpose, state: "unconfigured" };
  }
  try {
    const connection = await deps.kv.get<StoredConnection>(keys.conn(purpose));
    if (!connection) {
      return { missingEnv, purpose, state: "not_connected" };
    }
    return {
      connectedAt: connection.connectedAt,
      connectedBy: connection.connectedBy,
      connectedEmail: connection.connectedEmail,
      missingEnv,
      purpose,
      state: connection.state === "broken" ? "broken" : "connected",
      ...(connection.brokenAt ? { brokenAt: connection.brokenAt } : {}),
      ...(connection.brokenReason ? { brokenReason: connection.brokenReason } : {}),
    };
  } catch (error) {
    console.warn(`Google: couldn't read the ${purpose} connection (${errorText(error)}).`);
    return { missingEnv, purpose, state: "not_connected" };
  }
}

/** Revokes the stored grant at Google and forgets it. Forgets it even when Google can't be reached. Never throws. */
export async function disconnectGoogle(deps: GoogleOAuthDeps, purpose: GooglePurpose, actor: GoogleActor): Promise<{ ok: true; revoked: boolean } | { error: string; ok: false }> {
  if (!deps.kv) {
    return { error: "Redis isn't configured - there is no stored connection.", ok: false };
  }
  try {
    const connection = await deps.kv.get<StoredConnection>(keys.conn(purpose));
    let revoked = false;
    if (connection?.refreshToken) {
      try {
        revoked = await revokeToken(deps, deps.decrypt(connection.refreshToken));
      } catch {
        revoked = false;
      }
    }
    await deps.kv.del(keys.conn(purpose));
    await deps.kv.del(keys.access(purpose));
    console.info(`Google: ${purpose} disconnected by ${actor.displayName}${connection ? (revoked ? " (revoked at Google)" : " (Google revoke failed)") : " (nothing stored)"}.`);
    return { ok: true, revoked };
  } catch (error) {
    console.warn(`Google: disconnecting ${purpose} failed (${errorText(error)}).`);
    return { error: "Couldn't remove the stored connection - try again in a moment.", ok: false };
  }
}

/* --------------------------------------------------------------- wiring */

function redisKv(): GoogleKv {
  const redis = getRedis();
  return {
    del: async (key) => {
      await redis.del(key);
    },
    get: <T>(key: string) => redis.get<T>(key),
    set: async (key, value, ttlSeconds) => {
      if (ttlSeconds) {
        await redis.set(key, value, { ex: ttlSeconds });
      } else {
        await redis.set(key, value);
      }
    },
    take: <T>(key: string) => redis.getdel<T>(key),
  };
}

/** The real Redis, Google, clock and encryption. */
export function defaultGoogleDeps(): GoogleOAuthDeps {
  return {
    decrypt: decryptSecret,
    encrypt: encryptSecret,
    env: process.env,
    fetchImpl: fetch,
    kv: isRedisConfigured() ? redisKv() : null,
    now: Date.now,
    randomBytes,
  };
}
