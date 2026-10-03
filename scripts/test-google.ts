import { createHash } from "node:crypto";

import {
  checkConnectedAccount,
  completeGoogleConnection,
  disconnectGoogle,
  getGoogleAccessToken,
  getGoogleConnectionStatus,
  googleRedirectUri,
  readIdToken,
  startGoogleConnection,
} from "@/lib/google/oauth";
import { googleConnectErrorMessage } from "@/lib/google/messages";
import { calendarErrorMessage, fetchGoogleCalendarEvents, googleEventsToOccurrences } from "@/lib/oncall/googleCalendar";
import { getOnCallWith } from "@/lib/oncall/schedule";
import { buildShifts, parseRegionKeywords } from "@/lib/oncall/shifts";

import type { GoogleKv, GoogleOAuthDeps } from "@/lib/google/oauth";
import type { GoogleCalendarEvent, GoogleCalendarFetch } from "@/lib/oncall/googleCalendar";
import type { OnCallDeps, OnCallStore } from "@/lib/oncall/schedule";
import type { GoogleConnectionState } from "@/lib/workspace/types";

/**
 * Tests for the Google connection (OAuth state binding and expiry, PKCE,
 * domain and mailbox checks, token refresh and invalid_grant, disconnect)
 * and the Google Calendar source of the on-call schedule (event conversion
 * with all-day dates, time zones, cancellations and declined guests, the
 * events.list paging and errors, and source priority in getOnCall). Fakes
 * only - no Google, no Redis.
 *
 *   npx tsx scripts/test-google.ts
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

/* ------------------------------------------------------------------ fakes */

function memoryKv(): GoogleKv & { raw: Map<string, unknown>; ttls: Map<string, number | undefined> } {
  const raw = new Map<string, unknown>();
  const ttls = new Map<string, number | undefined>();
  return {
    del: (key) => {
      raw.delete(key);
      return Promise.resolve();
    },
    get: <T>(key: string) => Promise.resolve(raw.has(key) ? (structuredClone(raw.get(key)) as T) : null),
    raw,
    set: (key, value, ttlSeconds) => {
      raw.set(key, structuredClone(value));
      ttls.set(key, ttlSeconds);
      return Promise.resolve();
    },
    take: <T>(key: string) => {
      const value = raw.has(key) ? (structuredClone(raw.get(key)) as T) : null;
      raw.delete(key);
      return Promise.resolve(value);
    },
    ttls,
  };
}

interface Call {
  body: URLSearchParams;
  url: string;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" }, status });
}

function urlOf(input: string | URL | Request): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

function fakeFetch(responder: (call: Call) => Response | Error): { calls: Call[]; fetchImpl: typeof fetch } {
  const calls: Call[] = [];
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const call = { body: new URLSearchParams(typeof init?.body === "string" ? init.body : ""), url: urlOf(input) };
    calls.push(call);
    const result = responder(call);
    return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const CLIENT_ID = "client-123.apps.googleusercontent.com";
const ENV = {
  GOOGLE_OAUTH_CLIENT_ID: CLIENT_ID,
  GOOGLE_OAUTH_CLIENT_SECRET: "client-secret",
  SUPPORT_MAILBOX_ADDRESS: "Support@CertifyOS.com",
  TOKEN_ENCRYPTION_KEY: "set",
};
const JANE = { accountId: "acc-jane", displayName: "Jane Doe" };
const T0 = Date.parse("2026-10-03T12:00:00.000Z");

function idToken(claims: Record<string, unknown>): string {
  const part = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "RS256" })}.${part({ aud: CLIENT_ID, exp: T0 / 1000 + 3600, iss: "https://accounts.google.com", ...claims })}.signature`;
}

function deps(kv: GoogleKv | null, fetchImpl: typeof fetch, now: () => number = () => T0, env: Record<string, string | undefined> = ENV): GoogleOAuthDeps {
  let counter = 0;
  return {
    /* Reversible but visibly not the plaintext - enough to prove nothing is stored in the clear. */
    decrypt: (value) => Buffer.from(value.replace(/^enc:/, ""), "base64").toString("utf8"),
    encrypt: (value) => `enc:${Buffer.from(value, "utf8").toString("base64")}`,
    env,
    fetchImpl,
    kv,
    now,
    randomBytes: (size) => Buffer.alloc(size, ++counter),
  };
}

function stateFrom(url: string): { challenge: string; params: URLSearchParams; state: string } {
  const params = new URL(url).searchParams;
  return { challenge: params.get("code_challenge") ?? "", params, state: params.get("state") ?? "" };
}

const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
const GMAIL_SCOPES = "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send";

function tokenResponse(email: string, scope: string, extra: Record<string, unknown> = {}): Response {
  return json(200, {
    access_token: "ya29.access-1",
    expires_in: 3599,
    id_token: idToken({ email, email_verified: true, hd: "certifyos.com" }),
    refresh_token: "1//refresh-1",
    scope: `openid https://www.googleapis.com/auth/userinfo.email ${scope}`,
    token_type: "Bearer",
    ...extra,
  });
}

/* ------------------------------------------------------------------ oauth */

async function testStartAndStateBinding(): Promise<void> {
  console.log("\n--- Test: start - consent URL, PKCE, state bound to the person and purpose ---");
  const kv = memoryKv();
  const { fetchImpl } = fakeFetch(() => new Error("no network"));
  const started = await startGoogleConnection(deps(kv, fetchImpl), JANE, "calendar");
  assert(started.ok, "starts");
  if (!started.ok) return;
  const { challenge, params, state } = stateFrom(started.url);
  assert(started.url.startsWith("https://accounts.google.com/o/oauth2/v2/auth?"), "Google's endpoint");
  assertEqual(
    [params.get("access_type"), params.get("prompt"), params.get("hd"), params.get("code_challenge_method"), params.get("response_type")],
    ["offline", "consent", "certifyos.com", "S256", "code"],
    "offline + consent + hd + PKCE",
  );
  assertEqual(params.get("scope"), `openid email ${CALENDAR_SCOPE}`, "calendar scopes only");
  assertEqual(params.get("redirect_uri"), "https://ts-internal-dashboard.vercel.app/api/google/callback", "default redirect URI");
  assertEqual(googleRedirectUri({ APP_BASE_URL: "https://preview.example.com/" }), "https://preview.example.com/api/google/callback", "APP_BASE_URL wins");
  assert(state.length >= 40, "random state");
  const stored = kv.raw.get(`google:oauth:state:${state}`) as { accountId: string; purpose: string; verifier: string };
  assertEqual([stored.accountId, stored.purpose], ["acc-jane", "calendar"], "state bound to accountId + purpose");
  assertEqual(kv.ttls.get(`google:oauth:state:${state}`), 600, "state lives 10 minutes");
  assertEqual(createHash("sha256").update(stored.verifier).digest("base64url"), challenge, "challenge = S256(verifier)");

  const mailbox = await startGoogleConnection(deps(kv, fetchImpl), JANE, "mailbox");
  assert(mailbox.ok && stateFrom(mailbox.url).params.get("login_hint") === "support@certifyos.com", "mailbox pre-selects the support address");
  assert(mailbox.ok && stateFrom(mailbox.url).params.get("scope") === `openid email ${GMAIL_SCOPES}`, "mailbox scopes: gmail.readonly + gmail.send");

  const unconfigured = await startGoogleConnection(deps(kv, fetchImpl, () => T0, { GOOGLE_OAUTH_CLIENT_ID: CLIENT_ID }), JANE, "calendar");
  assertEqual(unconfigured, { code: "unconfigured", ok: false }, "no client secret: refused");
  const noMailbox = await startGoogleConnection(deps(kv, fetchImpl, () => T0, { ...ENV, SUPPORT_MAILBOX_ADDRESS: "" }), JANE, "mailbox");
  assertEqual(noMailbox, { code: "unconfigured", ok: false }, "mailbox needs SUPPORT_MAILBOX_ADDRESS");
  const noRedis = await startGoogleConnection(deps(null, fetchImpl), JANE, "calendar");
  assertEqual(noRedis, { code: "storage", ok: false }, "no Redis: refused");
  console.log("PASS");
}

async function testCallback(): Promise<void> {
  console.log("\n--- Test: callback - state single-use, expiry, same person, code exchange ---");
  const kv = memoryKv();
  const { calls, fetchImpl } = fakeFetch((call) => (call.url.includes("/token") ? tokenResponse("jane@certifyos.com", CALENDAR_SCOPE) : json(200, {})));
  const d = deps(kv, fetchImpl);

  const started = await startGoogleConnection(d, JANE, "calendar");
  if (!started.ok) throw new Error("start failed");
  const { state } = stateFrom(started.url);
  const verifier = (kv.raw.get(`google:oauth:state:${state}`) as { verifier: string }).verifier;

  const wrongUser = await completeGoogleConnection(d, { code: "c", error: null, state }, { accountId: "acc-mallory", displayName: "Mallory" });
  assertEqual(wrongUser, { code: "wrong_user", ok: false, purpose: "calendar" }, "another dashboard user can't finish it");
  const reused = await completeGoogleConnection(d, { code: "c", error: null, state }, JANE);
  assertEqual(reused, { code: "bad_state", ok: false }, "a state is single-use (even after a failed attempt)");
  assertEqual(calls.length, 0, "nothing was exchanged");

  const again = await startGoogleConnection(d, JANE, "calendar");
  if (!again.ok) throw new Error("start failed");
  const late = await completeGoogleConnection(deps(kv, fetchImpl, () => T0 + 11 * 60_000), { code: "c", error: null, state: stateFrom(again.url).state }, JANE);
  assertEqual(late, { code: "expired_state", ok: false, purpose: "calendar" }, "older than 10 minutes: expired");

  const forged = await completeGoogleConnection(d, { code: "c", error: null, state: "x".repeat(43) }, JANE);
  assertEqual(forged, { code: "bad_state", ok: false }, "unknown state refused");

  const denied = await startGoogleConnection(d, JANE, "calendar");
  if (!denied.ok) throw new Error("start failed");
  assertEqual(await completeGoogleConnection(d, { code: null, error: "access_denied", state: stateFrom(denied.url).state }, JANE), { code: "access_denied", ok: false, purpose: "calendar" }, "consent cancelled");

  const good = await startGoogleConnection(d, JANE, "calendar");
  if (!good.ok) throw new Error("start failed");
  const goodState = stateFrom(good.url).state;
  const goodVerifier = (kv.raw.get(`google:oauth:state:${goodState}`) as { verifier: string }).verifier;
  assert(goodVerifier !== verifier, "each sign-in has its own verifier");
  const done = await completeGoogleConnection(d, { code: "auth-code", error: null, state: goodState }, JANE);
  assertEqual(done, { email: "jane@certifyos.com", ok: true, purpose: "calendar" }, "connected");
  const exchange = calls.find((call) => call.url === "https://oauth2.googleapis.com/token");
  assertEqual(
    [exchange?.body.get("grant_type"), exchange?.body.get("code"), exchange?.body.get("code_verifier"), exchange?.body.get("redirect_uri")],
    ["authorization_code", "auth-code", goodVerifier, "https://ts-internal-dashboard.vercel.app/api/google/callback"],
    "code exchanged with the PKCE verifier",
  );
  const conn = kv.raw.get("google:conn:calendar") as Record<string, unknown>;
  assertEqual([conn.connectedEmail, conn.connectedBy, conn.state], ["jane@certifyos.com", "Jane Doe", "connected"], "who connected what");
  assert(!JSON.stringify([...kv.raw.values()]).includes("1//refresh-1") && !JSON.stringify([...kv.raw.values()]).includes("ya29.access-1"), "tokens are only stored encrypted");
  assertEqual(kv.ttls.get("google:conn:calendar"), undefined, "the connection doesn't expire");

  const status = await getGoogleConnectionStatus(d, "calendar");
  assertEqual([status.state, status.connectedEmail, status.connectedBy, status.connectedAt], ["connected", "jane@certifyos.com", "Jane Doe", new Date(T0).toISOString()], "status for the UI");
  assert(!JSON.stringify(status).includes("refresh"), "status never carries a token");
  assertEqual((await getGoogleConnectionStatus(d, "mailbox")).state, "not_connected", "the other purpose is separate");
  assertEqual(googleConnectErrorMessage("wrong_mailbox")?.includes("support mailbox"), true, "error codes map to sentences");
  assertEqual(googleConnectErrorMessage("<script>"), null, "unknown codes show nothing");
  console.log("PASS");
}

async function testAccountChecks(): Promise<void> {
  console.log("\n--- Test: account checks - certifyos.com only, verified, the mailbox itself, scopes ---");
  assertEqual(checkConnectedAccount({ email: "Jane@CertifyOS.com", email_verified: true, hd: "certifyos.com" }, "calendar", ENV), { email: "jane@certifyos.com", ok: true }, "workspace account");
  assertEqual(checkConnectedAccount({ email: "jane@gmail.com", email_verified: true }, "calendar", ENV), { code: "wrong_domain", ok: false }, "consumer account refused");
  assertEqual(checkConnectedAccount({ email: "jane@certifyos.com.evil.io", email_verified: true }, "calendar", ENV), { code: "wrong_domain", ok: false }, "look-alike domain refused");
  assertEqual(checkConnectedAccount({ email: "jane@certifyos.com", email_verified: true, hd: "other.com" }, "calendar", ENV), { code: "wrong_domain", ok: false }, "hd must match too");
  assertEqual(checkConnectedAccount({ email: "jane@certifyos.com", email_verified: false }, "calendar", ENV), { code: "unverified_email", ok: false }, "unverified refused");
  assertEqual(checkConnectedAccount({ email: "jane@certifyos.com", email_verified: true }, "mailbox", ENV), { code: "wrong_mailbox", ok: false }, "mailbox: a person's own account refused");
  assertEqual(checkConnectedAccount({ email: "support@certifyos.com", email_verified: "true" }, "mailbox", ENV), { email: "support@certifyos.com", ok: true }, "mailbox: the support address");

  assert(readIdToken(idToken({ email: "a@certifyos.com" }), CLIENT_ID, T0) !== null, "valid id_token reads");
  assertEqual(readIdToken(idToken({ aud: "someone-else" }), CLIENT_ID, T0), null, "wrong audience refused");
  assertEqual(readIdToken(idToken({ iss: "https://evil.example" }), CLIENT_ID, T0), null, "wrong issuer refused");
  assertEqual(readIdToken(idToken({ exp: T0 / 1000 - 1 }), CLIENT_ID, T0), null, "expired refused");
  assertEqual(readIdToken("garbage", CLIENT_ID, T0), null, "garbage refused");

  for (const [label, response, code] of [
    ["personal account", tokenResponse("jane@gmail.com", CALENDAR_SCOPE), "wrong_domain"],
    ["unticked scope", tokenResponse("jane@certifyos.com", ""), "missing_scopes"],
  ] as const) {
    const kv = memoryKv();
    const { calls, fetchImpl } = fakeFetch((call) => (call.url.includes("/token") ? response.clone() : json(200, {})));
    const d = deps(kv, fetchImpl);
    const started = await startGoogleConnection(d, JANE, "calendar");
    if (!started.ok) throw new Error("start failed");
    const result = await completeGoogleConnection(d, { code: "c", error: null, state: stateFrom(started.url).state }, JANE);
    assertEqual(result, { code, ok: false, purpose: "calendar" }, label);
    assert(calls.some((call) => call.url === "https://oauth2.googleapis.com/revoke" && call.body.get("token") === "1//refresh-1"), `${label}: the grant is revoked at Google`);
    assert(!kv.raw.has("google:conn:calendar"), `${label}: nothing stored`);
  }

  const kv = memoryKv();
  const { fetchImpl } = fakeFetch((call) => (call.url.includes("/token") ? tokenResponse("jane@certifyos.com", GMAIL_SCOPES) : json(200, {})));
  const d = deps(kv, fetchImpl);
  const started = await startGoogleConnection(d, JANE, "mailbox");
  if (!started.ok) throw new Error("start failed");
  assertEqual(await completeGoogleConnection(d, { code: "c", error: null, state: stateFrom(started.url).state }, JANE), { code: "wrong_mailbox", ok: false, purpose: "mailbox" }, "mailbox signed in as a person: refused");

  const noRefresh = memoryKv();
  const { fetchImpl: noRefreshFetch } = fakeFetch(() => tokenResponse("jane@certifyos.com", CALENDAR_SCOPE, { refresh_token: undefined }));
  const d2 = deps(noRefresh, noRefreshFetch);
  const s2 = await startGoogleConnection(d2, JANE, "calendar");
  if (!s2.ok) throw new Error("start failed");
  assertEqual(await completeGoogleConnection(d2, { code: "c", error: null, state: stateFrom(s2.url).state }, JANE), { code: "no_refresh_token", ok: false, purpose: "calendar" }, "no refresh token: refused");
  console.log("PASS");
}

async function connected(kv: ReturnType<typeof memoryKv>, now: () => number): Promise<void> {
  const { fetchImpl } = fakeFetch(() => tokenResponse("jane@certifyos.com", CALENDAR_SCOPE));
  const d = deps(kv, fetchImpl, now);
  const started = await startGoogleConnection(d, JANE, "calendar");
  if (!started.ok) throw new Error("start failed");
  const done = await completeGoogleConnection(d, { code: "c", error: null, state: stateFrom(started.url).state }, JANE);
  if (!done.ok) throw new Error(`connect failed: ${done.code}`);
}

async function testAccessTokens(): Promise<void> {
  console.log("\n--- Test: access tokens - cached until near expiry, refreshed, invalid_grant marks broken ---");
  const kv = memoryKv();
  let now = T0;
  await connected(kv, () => now);
  assertEqual(kv.ttls.get("google:access:calendar"), 3599 - 120, "the first access token is cached until 2 minutes before expiry");

  const refreshes = fakeFetch((call) => (call.body.get("grant_type") === "refresh_token" ? json(200, { access_token: "ya29.access-2", expires_in: 3600 }) : json(500, {})));
  const d = deps(kv, refreshes.fetchImpl, () => now);
  assertEqual(await getGoogleAccessToken(d, "calendar"), { ok: true, token: "ya29.access-1" }, "cached token used");
  assertEqual(refreshes.calls.length, 0, "no refresh while fresh");

  now = T0 + 3_500_000;
  assertEqual(await getGoogleAccessToken(d, "calendar"), { ok: true, token: "ya29.access-2" }, "near expiry: refreshed");
  assertEqual([refreshes.calls[0]?.body.get("grant_type"), refreshes.calls[0]?.body.get("refresh_token")], ["refresh_token", "1//refresh-1"], "refresh uses the stored (decrypted) refresh token");
  assertEqual(await getGoogleAccessToken(d, "calendar"), { ok: true, token: "ya29.access-2" }, "the new one is cached");
  assertEqual(refreshes.calls.length, 1, "...so no second refresh");

  const transient = fakeFetch(() => json(503, { error: "backendError" }));
  kv.raw.delete("google:access:calendar");
  const flaky = await getGoogleAccessToken(deps(kv, transient.fetchImpl, () => now), "calendar");
  assert(!flaky.ok && flaky.state === "connected", "a 5xx is transient - the connection stays");

  const revoked = fakeFetch(() => json(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." }));
  const dead = await getGoogleAccessToken(deps(kv, revoked.fetchImpl, () => now), "calendar");
  assert(!dead.ok && dead.state === "broken" && dead.error.includes("Connect Google Calendar on /oncall"), "invalid_grant: broken, says how to fix");
  const status = await getGoogleConnectionStatus(deps(kv, revoked.fetchImpl, () => now), "calendar");
  assertEqual([status.state, status.connectedEmail], ["broken", "jane@certifyos.com"], "status shows broken (and whose)");
  const afterwards = await getGoogleAccessToken(deps(kv, revoked.fetchImpl, () => now), "calendar");
  assert(!afterwards.ok && afterwards.state === "broken" && revoked.calls.length === 1, "a broken connection isn't retried at Google");

  const none = await getGoogleAccessToken(deps(memoryKv(), revoked.fetchImpl), "mailbox");
  assert(!none.ok && none.state === "not_connected" && none.error.includes("/inbox"), "not connected: says where to connect");
  console.log("PASS");
}

async function testDisconnect(): Promise<void> {
  console.log("\n--- Test: disconnect - revoked at Google, forgotten even when Google is down ---");
  const kv = memoryKv();
  await connected(kv, () => T0);
  const ok = fakeFetch(() => json(200, {}));
  assertEqual(await disconnectGoogle(deps(kv, ok.fetchImpl), "calendar", JANE), { ok: true, revoked: true }, "revoked");
  assertEqual([ok.calls[0]?.url, ok.calls[0]?.body.get("token")], ["https://oauth2.googleapis.com/revoke", "1//refresh-1"], "the refresh token is revoked");
  assert(!kv.raw.has("google:conn:calendar") && !kv.raw.has("google:access:calendar"), "both keys gone");

  await connected(kv, () => T0);
  const down = fakeFetch(() => new Error("ECONNRESET"));
  assertEqual(await disconnectGoogle(deps(kv, down.fetchImpl), "calendar", JANE), { ok: true, revoked: false }, "Google down: still forgotten");
  assert(!kv.raw.has("google:conn:calendar"), "gone");
  console.log("PASS");
}

/* --------------------------------------------------------------- calendar */

const NY = "America/New_York";

function event(overrides: Partial<GoogleCalendarEvent>): GoogleCalendarEvent {
  return { iCalUID: "ff@google.com", id: "evt1", status: "confirmed", summary: "FF US - Martin Lee", ...overrides };
}

function testEventConversion(): void {
  console.log("\n--- Test: Google events -> occurrences (all-day in the calendar's zone, cancelled, guests) ---");
  const occurrences = googleEventsToOccurrences(
    [
      event({ end: { dateTime: "2026-10-03T17:00:00-04:00" }, id: "timed", start: { dateTime: "2026-10-03T09:00:00-04:00" } }),
      event({ end: { date: "2026-10-12" }, iCalUID: "ae@google.com", id: "allday", start: { date: "2026-10-05" }, summary: "FF Asia/Europe - Tarang Somani" }),
      event({ end: { date: "2026-10-04" }, id: "gone", start: { date: "2026-10-03" }, status: "cancelled" }),
      event({
        attendees: [
          { displayName: "Priya Nair", email: "Priya@CertifyOS.com", responseStatus: "accepted" },
          { displayName: "Bob Stone", email: "bob@certifyos.com", responseStatus: "declined" },
          { displayName: "Room 4", email: "room4@resource.calendar.google.com", resource: true },
        ],
        end: { dateTime: "2026-10-10T00:00:00Z" },
        iCalUID: "rot@google.com",
        id: "rot_20261003",
        recurringEventId: "rot",
        start: { dateTime: "2026-10-03T00:00:00Z" },
        summary: "Firefighter US",
      }),
    ],
    NY,
  );
  assertEqual(occurrences.length, 3, "cancelled dropped");
  const allDay = occurrences.find((occurrence) => occurrence.uid === "ae@google.com");
  assertEqual(
    [allDay?.allDay, new Date(allDay?.start ?? 0).toISOString(), new Date(allDay?.end ?? 0).toISOString()],
    [true, "2026-10-05T04:00:00.000Z", "2026-10-12T04:00:00.000Z"],
    "all-day: midnight to midnight New York time, end date exclusive",
  );
  const timed = occurrences.find((occurrence) => occurrence.summary === "FF US - Martin Lee");
  assertEqual([timed?.allDay, new Date(timed?.start ?? 0).toISOString()], [false, "2026-10-03T13:00:00.000Z"], "timed: the offset is honoured");
  const rotation = occurrences.find((occurrence) => occurrence.uid === "rot@google.com");
  assertEqual(rotation?.recurring, true, "an instance of a series is recurring");
  assertEqual(
    rotation?.attendees,
    [
      { email: "priya@certifyos.com", name: "Priya Nair", cutype: "INDIVIDUAL", partstat: "ACCEPTED" },
      { email: "bob@certifyos.com", name: "Bob Stone", cutype: "INDIVIDUAL", partstat: "DECLINED" },
      { email: "room4@resource.calendar.google.com", name: "Room 4", cutype: "RESOURCE" },
    ],
    "guests keep their response and type",
  );

  const shifts = buildShifts(occurrences, parseRegionKeywords(undefined));
  const usShift = shifts.find((shift) => shift.title === "Firefighter US");
  assertEqual(usShift?.people, [{ email: "priya@certifyos.com", name: "Priya Nair" }], "declined guests and rooms aren't on call (same rule as iCal)");
  assertEqual(shifts.find((shift) => shift.region === "Asia/Europe")?.people.map((person) => person.name), ["Tarang Somani"], "names from the title still work");

  const utc = googleEventsToOccurrences([event({ end: { date: "2026-10-06" }, start: { date: "2026-10-05" } })], "Not/AZone");
  assertEqual(new Date(utc[0]?.start ?? 0).toISOString(), "2026-10-05T00:00:00.000Z", "unknown zone falls back to UTC");
  const noEnd = googleEventsToOccurrences([event({ end: undefined, start: { date: "2026-10-05" } })], "UTC");
  assertEqual(new Date(noEnd[0]?.end ?? 0).toISOString(), "2026-10-06T00:00:00.000Z", "an all-day event without an end lasts one day");
  console.log("PASS");
}

async function testCalendarFetch(): Promise<void> {
  console.log("\n--- Test: events.list - singleEvents, paging, cap, errors that say what to do ---");
  const urls: string[] = [];
  const pages = [
    { items: [event({ id: "a", start: { dateTime: "2026-10-03T00:00:00Z" } })], nextPageToken: "p2", summary: "TS Firefighters", timeZone: NY },
    { items: [event({ id: "b", start: { dateTime: "2026-10-04T00:00:00Z" } })] },
  ];
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    urls.push(urlOf(input));
    assertEqual((init?.headers as Record<string, string>).Authorization, "Bearer tok", "bearer token sent");
    return Promise.resolve(json(200, pages.shift()));
  }) as typeof fetch;
  const result = await fetchGoogleCalendarEvents({
    accessToken: () => Promise.resolve({ ok: true, token: "tok" }),
    calendarId: "c_rota@group.calendar.google.com",
    fetchImpl,
    timeMax: Date.parse("2026-11-02T00:00:00Z"),
    timeMin: Date.parse("2026-09-30T00:00:00Z"),
  });
  assert(result.ok && result.events.length === 2 && result.timeZone === NY && result.calendarName === "TS Firefighters", "two pages joined, zone and name kept");
  const first = new URL(urls[0] ?? "");
  assertEqual(
    [first.pathname, first.searchParams.get("singleEvents"), first.searchParams.get("orderBy"), first.searchParams.get("timeMin"), first.searchParams.get("timeMax")],
    ["/calendar/v3/calendars/c_rota%40group.calendar.google.com/events", "true", "startTime", "2026-09-30T00:00:00.000Z", "2026-11-02T00:00:00.000Z"],
    "singleEvents, ordered by start, the window",
  );
  assertEqual(new URL(urls[1] ?? "").searchParams.get("pageToken"), "p2", "second page by token");

  let served = 0;
  const endless = (() => {
    served += 1;
    return Promise.resolve(json(200, { items: Array.from({ length: 250 }, (_, index) => event({ id: `e${served}-${index}` })), nextPageToken: "more" }));
  }) as typeof fetch;
  const capped = await fetchGoogleCalendarEvents({ accessToken: () => Promise.resolve({ ok: true, token: "tok" }), calendarId: "c", fetchImpl: endless, timeMax: 1, timeMin: 0 });
  assert(capped.ok && capped.events.length === 500 && capped.truncated && served === 2, "capped at 500 events");

  const notFound = await fetchGoogleCalendarEvents({
    accessToken: () => Promise.resolve({ ok: true, token: "tok" }),
    calendarId: "c_rota@group.calendar.google.com",
    fetchImpl: () => Promise.resolve(json(404, { error: { errors: [{ reason: "notFound" }] } })),
    timeMax: 1,
    timeMin: 0,
  });
  assert(!notFound.ok && notFound.error.includes("can't see calendar c_rota@group.calendar.google.com"), "404: the connected account can't see the calendar");
  let invalidated = 0;
  const unauthorized = await fetchGoogleCalendarEvents({
    accessToken: () => Promise.resolve({ ok: true, token: "tok" }),
    calendarId: "c",
    fetchImpl: () => Promise.resolve(json(401, {})),
    onUnauthorized: () => {
      invalidated += 1;
      return Promise.resolve();
    },
    timeMax: 1,
    timeMin: 0,
  });
  assert(!unauthorized.ok && unauthorized.error.includes("Connect Google Calendar on /oncall") && invalidated === 1, "401: cached token dropped, says reconnect");
  assert(calendarErrorMessage(403, "c", "accessNotConfigured").includes("Calendar API isn't enabled"), "API disabled is named");
  const noToken = await fetchGoogleCalendarEvents({
    accessToken: () => Promise.resolve({ error: "Google isn't connected. Connect Google Calendar on /oncall.", ok: false, state: "not_connected" }),
    calendarId: "c",
    timeMax: 1,
    timeMin: 0,
  });
  assert(!noToken.ok && noToken.error.includes("/oncall"), "no token: the connection's message");
  console.log("PASS");
}

/* -------------------------------------------------------- source priority */

function memoryStore(): OnCallStore & { raw: Map<string, unknown> } {
  const raw = new Map<string, unknown>();
  return {
    get: <T>(key: string) => Promise.resolve(raw.has(key) ? (structuredClone(raw.get(key)) as T) : null),
    raw,
    set: (key, value) => {
      raw.set(key, structuredClone(value));
      return Promise.resolve();
    },
  };
}

const AT = new Date("2026-10-06T15:00:00.000Z");
const ICS = [
  "BEGIN:VCALENDAR",
  "X-WR-CALNAME:From iCal",
  "X-WR-TIMEZONE:UTC",
  "BEGIN:VEVENT",
  "UID:ical-1",
  "DTSTART:20261006T000000Z",
  "DTEND:20261007T000000Z",
  "SUMMARY:FF US - Ical Person",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

function onCallDeps(store: OnCallStore, state: GoogleConnectionState, calendarId: string | undefined, url: string | undefined, counters: { google: number; ical: number }, googleResult?: GoogleCalendarFetch): OnCallDeps {
  return {
    fetchIcs: () => {
      counters.ical += 1;
      return Promise.resolve({ bytes: new TextEncoder().encode(ICS), ok: true as const });
    },
    google: {
      calendarId,
      connection: () => Promise.resolve(state),
      fetchEvents: (_id, fromMs, toMs) => {
        counters.google += 1;
        assert(fromMs === AT.getTime() - 3 * 86_400_000 && toMs === AT.getTime() + 30 * 86_400_000, "Google is asked for 3 days back to 30 ahead");
        return Promise.resolve(
          googleResult ?? {
            calendarName: "Rotation (Google)",
            events: [event({ end: { date: "2026-10-12" }, id: "g1", start: { date: "2026-10-05" }, summary: "FF US - Google Person" })],
            ok: true,
            timeZone: NY,
            truncated: false,
          },
        );
      },
    },
    regionKeywords: parseRegionKeywords(undefined),
    resolvePeople: (people) => Promise.resolve(people),
    store,
    url,
  };
}

async function testSourcePriority(): Promise<void> {
  console.log("\n--- Test: getOnCall source priority - Google API, else iCal, else not configured ---");
  const ICAL_URL = "https://calendar.google.com/calendar/ical/x/private-s3cr3t/basic.ics";

  let counters = { google: 0, ical: 0 };
  const store = memoryStore();
  const google = await getOnCallWith(onCallDeps(store, "connected", "c_rota@group.calendar.google.com", ICAL_URL, counters), AT);
  assertEqual([google.configured, google.source, google.calendarName, google.timeZone, google.error], [true, "google", "Rotation (Google)", NY, undefined], "connected + id: the Google API");
  assertEqual(google.now.map((shift) => shift.people.map((person) => person.name)), [["Google Person"]], "on call from the Google event");
  assertEqual(counters, { google: 1, ical: 0 }, "iCal not downloaded");
  await getOnCallWith(onCallDeps(store, "connected", "c_rota@group.calendar.google.com", ICAL_URL, counters), AT);
  assertEqual(counters.google, 1, "Google answer cached (10 minutes)");
  assert([...store.raw.keys()].every((key) => key.startsWith("oncall:gcal:") && !key.includes("c_rota")), "own cache keys, hashed id");

  counters = { google: 0, ical: 0 };
  const failing = memoryStore();
  await getOnCallWith(onCallDeps(failing, "connected", "c", undefined, counters), AT);
  failing.raw.forEach((_value, key) => key.endsWith(":fresh") && failing.raw.delete(key));
  const stale = await getOnCallWith(
    onCallDeps(failing, "connected", "c", undefined, counters, { error: "The connected account can't see calendar c - share the calendar with it.", ok: false, status: 404 }),
    AT,
  );
  assert(stale.error?.includes("can't see calendar c") === true && stale.now.length === 1, "Google failing: the error, over the last good copy");

  counters = { google: 0, ical: 0 };
  const broken = await getOnCallWith(
    onCallDeps(memoryStore(), "broken", "c", ICAL_URL, counters, { error: "The Google sign-in was revoked or expired. Connect Google Calendar on /oncall.", ok: false }),
    AT,
  );
  assert(broken.source === "google" && broken.error?.includes("Connect Google Calendar on /oncall") === true && counters.ical === 0, "broken connection: still the Google path, saying to reconnect");

  counters = { google: 0, ical: 0 };
  const ical = await getOnCallWith(onCallDeps(memoryStore(), "not_connected", "c", ICAL_URL, counters), AT);
  assertEqual([ical.configured, ical.source, ical.calendarName], [true, "ical", "From iCal"], "not connected but iCal set: iCal");
  assertEqual(counters, { google: 0, ical: 1 }, "Google not called");
  const noId = await getOnCallWith(onCallDeps(memoryStore(), "connected", "  ", ICAL_URL, counters), AT);
  assertEqual(noId.source, "ical", "connected but no calendar id: iCal");

  const nothing = await getOnCallWith(onCallDeps(memoryStore(), "not_connected", "c", undefined, counters), AT);
  assert(!nothing.configured && nothing.error?.includes("Connect Google Calendar on /oncall") === true, "id set, not connected, no iCal: configured=false, says to connect");
  const noClient = await getOnCallWith(onCallDeps(memoryStore(), "unconfigured", "c", undefined, counters), AT);
  assert(!noClient.configured && noClient.error?.includes("GOOGLE_OAUTH_CLIENT_ID") === true, "no OAuth client: says which env is missing");
  const bare = await getOnCallWith(onCallDeps(memoryStore(), "not_connected", undefined, undefined, counters), AT);
  assertEqual([bare.configured, bare.error], [false, undefined], "nothing set: plain configured=false");
  console.log("PASS");
}

async function main(): Promise<void> {
  await testStartAndStateBinding();
  await testCallback();
  await testAccountChecks();
  await testAccessTokens();
  await testDisconnect();
  testEventConversion();
  await testCalendarFetch();
  await testSourcePriority();
}

main()
  .then(() => {
    console.log("\nAll Google tests passed.");
    process.exit(0);
  })
  .catch((error: unknown) => {
    console.error("\nGoogle test failed:", error);
    process.exit(1);
  });
