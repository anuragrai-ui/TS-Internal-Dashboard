import { createHash } from "node:crypto";

import { getCache, setCache } from "@/lib/cache";
import { connectHint } from "@/lib/google/messages";
import { defaultGoogleDeps, getGoogleAccessToken, getGoogleConnectionStatus, invalidateGoogleAccessToken } from "@/lib/google/oauth";
import { fetchGoogleCalendarEvents, googleEventsToOccurrences } from "@/lib/oncall/googleCalendar";
import { calendarTimeZone, decodeIcsBytes, expandCalendar, parseIcs, pruneCalendar, resolveTimeZone } from "@/lib/oncall/ical";
import { buildShifts, normalizePersonName, parseRegionKeywords, regionOrder, selectOnCall } from "@/lib/oncall/shifts";
import { resolveSlackUserIds } from "@/lib/oncall/slackDirectory";

import type { GoogleCalendarFetch } from "@/lib/oncall/googleCalendar";
import type { EventOccurrence, IcsCalendar, IcsEvent } from "@/lib/oncall/ical";
import type { RegionKeywords } from "@/lib/oncall/shifts";
import type { GoogleConnectionState, OnCallPerson, OnCallResponse, OnCallShift } from "@/lib/workspace/types";

/**
 * Who is firefighter right now, read from the rotation's Google Calendar.
 *
 * Two sources, in this order:
 * 1. the Google Calendar API (src/lib/oncall/googleCalendar.ts), when the
 *    "calendar" Google sign-in exists (connected, or broken - then the
 *    error says to reconnect) and ONCALL_GOOGLE_CALENDAR_ID is set. This is
 *    the one for the certifyos.com calendar, which has no iCal address.
 * 2. the calendar's secret iCal address (ONCALL_CALENDAR_ICAL_URL).
 * Neither: configured=false, and the page shows how to connect.
 * Both go through the same cache, last-good fallback and failure backoff
 * below, and come out as the same shifts.
 *
 * The address is a secret - anyone holding it can read the calendar - so it
 * is never logged, never put in an error message and never sent to the
 * browser; even the Redis keys only carry a short hash of it.
 *
 * Caching, so a dozen open dashboards cost one download per ten minutes:
 * - oncall:cal:<hash>:fresh      the parsed, trimmed calendar, 10 minutes
 * - oncall:cal:<hash>:last_good  the same, 7 days - served (with the error)
 *                                when Google is down or the address breaks
 * - oncall:cal:<hash>:failure    the last error, 2 minutes - a broken address
 *                                isn't re-downloaded by every poll
 * - oncall:cal:<hash>:manual     30 seconds - throttles the Refresh button
 * The trimmed copy covers 3 days back to 30 ahead of the download, so a
 * week-old last-good copy still answers "now" and "next 14 days".
 */

const DAY_MS = 86_400_000;
const FETCH_TIMEOUT_MS = 10_000;
export const MAX_ICS_BYTES = 2 * 1024 * 1024;
const FRESH_SECONDS = 600;
const LAST_GOOD_SECONDS = 7 * 86_400;
const FAILURE_BACKOFF_SECONDS = 120;
const MANUAL_REFRESH_SECONDS = 30;
const KEEP_BACK_MS = 3 * DAY_MS;
const KEEP_AHEAD_MS = 30 * DAY_MS;
const WINDOW_BACK_MS = DAY_MS;
const WINDOW_AHEAD_MS = 14 * DAY_MS;
/* The Google path's cache keys start with this, so they never collide with an iCal address's hash. */
const GOOGLE_CACHE_PREFIX = "oncall:gcal";

/* What is cached: the calendar already trimmed to the weeks that matter. */
export interface StoredCalendar {
  calendarName?: string;
  events: IcsEvent[];
  fetchedAt: string;
  timeZone?: string;
}

export type IcsFetchResult = { bytes: Uint8Array; ok: true } | { error: string; ok: false };

export interface OnCallStore {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, ttlSeconds: number): Promise<void>;
}

/* What the Google path caches: the window's occurrences, already expanded by Google. */
export interface StoredGoogleCalendar {
  calendarName?: string;
  fetchedAt: string;
  occurrences: EventOccurrence[];
  timeZone?: string;
}

/* The Google Calendar API source - optional, so a deployment (or a test) without it reads iCal only. */
export interface GoogleCalendarSource {
  calendarId: string | undefined;
  /* The "calendar" sign-in's state (src/lib/google/oauth.ts). */
  connection: () => Promise<GoogleConnectionState>;
  fetchEvents: (calendarId: string, fromMs: number, toMs: number) => Promise<GoogleCalendarFetch>;
}

export interface OnCallDeps {
  /* Zone for floating times when the calendar names none. */
  defaultTimeZone?: string;
  fetchIcs: (url: string) => Promise<IcsFetchResult>;
  google?: GoogleCalendarSource;
  regionKeywords: RegionKeywords;
  resolvePeople: (people: OnCallPerson[]) => Promise<OnCallPerson[]>;
  store: OnCallStore;
  url: string | undefined;
}

export interface OnCallOptions {
  /* Download the calendar now instead of using the 10-minute copy (throttled to once per 30s). */
  refresh?: boolean;
}

/* -------------------------------------------------------------- download */

function statusMessage(status: number): string {
  if (status === 404 || status === 410) {
    return `Google Calendar says the address doesn't exist (HTTP ${status}). The secret address may have been reset - copy the new one into ONCALL_CALENDAR_ICAL_URL.`;
  }
  if (status === 401 || status === 403) {
    return `The calendar refused the request (HTTP ${status}). ONCALL_CALENDAR_ICAL_URL must be the calendar's secret iCal address, not its public one.`;
  }
  return `The calendar answered HTTP ${status}.`;
}

/** Whether a value is an absolute https:// URL. */
export function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Downloads the calendar: https only, 10 second timeout, at most 2 MB (read
 * as a stream, so an endless response is cut off rather than buffered).
 * Never throws, and never puts the URL in an error or a log line.
 */
export async function fetchIcs(url: string, fetchImpl: typeof fetch = fetch): Promise<IcsFetchResult> {
  if (!isHttpsUrl(url)) {
    return { error: "ONCALL_CALENDAR_ICAL_URL must be an https:// address.", ok: false };
  }
  try {
    const response = await fetchImpl(url, {
      cache: "no-store",
      headers: { Accept: "text/calendar, text/plain;q=0.8, */*;q=0.5" },
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (response.url && !response.url.startsWith("https://")) {
      await response.body?.cancel();
      return { error: "The calendar address redirected away from https.", ok: false };
    }
    if (!response.ok) {
      await response.body?.cancel();
      return { error: statusMessage(response.status), ok: false };
    }
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_ICS_BYTES) {
      await response.body?.cancel();
      return { error: "The calendar is larger than 2 MB - use a calendar that holds only the rotation.", ok: false };
    }
    if (!response.body) {
      return { bytes: new Uint8Array(await response.arrayBuffer()).slice(0, MAX_ICS_BYTES), ok: true };
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > MAX_ICS_BYTES) {
        await reader.cancel();
        return { error: "The calendar is larger than 2 MB - use a calendar that holds only the rotation.", ok: false };
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { bytes, ok: true };
  } catch (error) {
    const name = error instanceof Error ? error.name : "unknown";
    /* Only the error's name: a fetch failure's message or cause can carry the address. */
    console.warn(`On-call: calendar download failed (${name}).`);
    return {
      error: name === "TimeoutError" || name === "AbortError" ? "The calendar didn't answer within 10 seconds." : "Couldn't reach the calendar address.",
      ok: false,
    };
  }
}

/* --------------------------------------------------------------- caching */

interface CacheKeys {
  failure: string;
  fresh: string;
  lastGood: string;
  manual: string;
}

function cacheKeys(source: string, prefix = "oncall:cal"): CacheKeys {
  /* A short hash, so changing the address starts a new cache - and the key never holds the secret itself. */
  const id = createHash("sha256").update(source).digest("hex").slice(0, 16);
  return {
    failure: `${prefix}:${id}:failure`,
    fresh: `${prefix}:${id}:fresh`,
    lastGood: `${prefix}:${id}:last_good`,
    manual: `${prefix}:${id}:manual`,
  };
}

/** Parses a download and trims it to the weeks around `at`. Null when it isn't an iCal calendar at all. */
export function toStoredCalendar(text: string, at: Date, defaultTimeZone?: string): StoredCalendar | null {
  if (!/BEGIN:VCALENDAR/i.test(text)) {
    return null;
  }
  const parsed = parseIcs(text);
  const atMs = at.getTime();
  const pruned = pruneCalendar(parsed, atMs - KEEP_BACK_MS, atMs + KEEP_AHEAD_MS, { defaultTimeZone });
  if (parsed.warnings.length > 0) {
    console.warn(`On-call: ${parsed.warnings.length} calendar warning(s): ${parsed.warnings.slice(0, 3).join(" ")}`);
  }
  return {
    events: pruned.events,
    fetchedAt: at.toISOString(),
    ...(parsed.name ? { calendarName: parsed.name } : {}),
    ...(parsed.timeZone ? { timeZone: parsed.timeZone } : {}),
  };
}

interface Loaded<T> {
  calendar: T | null;
  error?: string;
}

/**
 * The cache dance both sources share: a fresh copy (10 min) wins; a recent
 * failure (2 min) serves the last good copy without asking again; otherwise
 * download, and on failure remember it and fall back to the last good copy.
 * A Refresh skips the fresh copy and the backoff, at most once per 30s.
 */
async function loadThroughCache<T>(
  store: OnCallStore,
  keys: CacheKeys,
  refresh: boolean,
  download: () => Promise<{ ok: true; value: T } | { error: string; ok: false }>,
): Promise<Loaded<T>> {
  let forced = false;
  if (refresh && !(await store.get<string>(keys.manual))) {
    await store.set(keys.manual, "1", MANUAL_REFRESH_SECONDS);
    forced = true;
  }

  if (!forced) {
    const fresh = await store.get<T>(keys.fresh);
    if (fresh) {
      return { calendar: fresh };
    }
    const recentFailure = await store.get<string>(keys.failure);
    if (recentFailure) {
      return { calendar: await store.get<T>(keys.lastGood), error: recentFailure };
    }
  }

  const fetched = await download();
  if (fetched.ok) {
    await Promise.all([store.set(keys.fresh, fetched.value, FRESH_SECONDS), store.set(keys.lastGood, fetched.value, LAST_GOOD_SECONDS)]);
    return { calendar: fetched.value };
  }
  await store.set(keys.failure, fetched.error, FAILURE_BACKOFF_SECONDS);
  return { calendar: await store.get<T>(keys.lastGood), error: fetched.error };
}

async function loadCalendar(deps: OnCallDeps, url: string, at: Date, refresh: boolean): Promise<Loaded<StoredCalendar>> {
  return loadThroughCache<StoredCalendar>(deps.store, cacheKeys(url), refresh, async () => {
    const fetched = await deps.fetchIcs(url);
    if (!fetched.ok) {
      return fetched;
    }
    const stored = toStoredCalendar(decodeIcsBytes(fetched.bytes), at, deps.defaultTimeZone);
    return stored
      ? { ok: true, value: stored }
      : { error: "The address didn't return an iCal calendar - ONCALL_CALENDAR_ICAL_URL must be the \"Secret address in iCal format\" (ends in .ics).", ok: false };
  });
}

/* Google answers with the window already expanded, so the cached copy holds occurrences over the same 3-days-back to 30-ahead span the iCal copy is trimmed to - a week-old last-good copy still answers "now" and "next 14 days". */
async function loadGoogleCalendar(source: GoogleCalendarSource, store: OnCallStore, calendarId: string, at: Date, refresh: boolean): Promise<Loaded<StoredGoogleCalendar>> {
  return loadThroughCache<StoredGoogleCalendar>(store, cacheKeys(calendarId, GOOGLE_CACHE_PREFIX), refresh, async () => {
    const atMs = at.getTime();
    const fetched = await source.fetchEvents(calendarId, atMs - KEEP_BACK_MS, atMs + KEEP_AHEAD_MS);
    if (!fetched.ok) {
      return { error: fetched.error, ok: false };
    }
    if (fetched.truncated) {
      console.warn(`On-call: the Google calendar returned more than ${fetched.events.length} events in the window; the rest were skipped.`);
    }
    return {
      ok: true,
      value: {
        fetchedAt: at.toISOString(),
        occurrences: googleEventsToOccurrences(fetched.events, fetched.timeZone),
        ...(fetched.calendarName ? { calendarName: fetched.calendarName } : {}),
        ...(fetched.timeZone ? { timeZone: fetched.timeZone } : {}),
      },
    };
  });
}

/* ------------------------------------------------------------------ build */

function personKey(person: OnCallPerson): string {
  return `${person.email ?? ""}\n${normalizePersonName(person.name)}`;
}

/* One directory lookup for everyone in the window, then each shift gets its people back with Slack ids. */
async function withSlackIds(shifts: OnCallShift[], resolve: OnCallDeps["resolvePeople"]): Promise<OnCallShift[]> {
  const unique = new Map<string, OnCallPerson>();
  for (const person of shifts.flatMap((shift) => shift.people)) {
    unique.set(personKey(person), person);
  }
  if (unique.size === 0) {
    return shifts;
  }
  const resolved = await resolve([...unique.values()]);
  const byKey = new Map<string, OnCallPerson>();
  [...unique.keys()].forEach((key, index) => {
    const person = resolved[index];
    if (person) {
      byKey.set(key, person);
    }
  });
  return shifts.map((shift) => ({ ...shift, people: shift.people.map((person) => byKey.get(personKey(person)) ?? person) }));
}

/* Occurrences -> shifts with Slack ids -> now / next / upcoming. Shared by both sources. */
async function selectFrom(deps: OnCallDeps, occurrences: EventOccurrence[], at: Date): Promise<Pick<OnCallResponse, "next" | "now" | "upcoming">> {
  const shifts = await withSlackIds(buildShifts(occurrences, deps.regionKeywords), deps.resolvePeople);
  return selectOnCall(shifts, at, { aheadMs: WINDOW_AHEAD_MS, backMs: WINDOW_BACK_MS, regions: regionOrder(deps.regionKeywords) });
}

async function googleSchedule(deps: OnCallDeps, source: GoogleCalendarSource, calendarId: string, at: Date, refresh: boolean): Promise<OnCallResponse> {
  const base: OnCallResponse = { at: at.toISOString(), configured: true, fetchedAt: null, next: [], now: [], source: "google", upcoming: [] };
  const { calendar, error } = await loadGoogleCalendar(source, deps.store, calendarId, at, refresh);
  if (!calendar) {
    return { ...base, error: error ?? "Couldn't read the on-call calendar." };
  }
  const atMs = at.getTime();
  const from = atMs - WINDOW_BACK_MS;
  const to = atMs + WINDOW_AHEAD_MS;
  const inWindow = calendar.occurrences.filter((occurrence) => occurrence.start < to && occurrence.end > from);
  return {
    ...base,
    ...(await selectFrom(deps, inWindow, at)),
    fetchedAt: calendar.fetchedAt,
    timeZone: resolveTimeZone(calendar.timeZone) ?? resolveTimeZone(deps.defaultTimeZone) ?? "UTC",
    ...(calendar.calendarName ? { calendarName: calendar.calendarName } : {}),
    ...(error ? { error } : {}),
  };
}

/** getOnCall with explicit deps - what the tests drive. */
export async function getOnCallWith(deps: OnCallDeps, at: Date, options: OnCallOptions = {}): Promise<OnCallResponse> {
  const base: OnCallResponse = { at: at.toISOString(), configured: true, fetchedAt: null, next: [], now: [], upcoming: [] };
  const calendarId = deps.google?.calendarId?.trim();
  let googleState: GoogleConnectionState | null = null;
  if (deps.google && calendarId) {
    googleState = await deps.google.connection();
    if (googleState === "connected" || googleState === "broken") {
      return googleSchedule(deps, deps.google, calendarId, at, options.refresh === true);
    }
  }

  const url = deps.url?.trim();
  if (!url) {
    if (googleState !== null) {
      /* The calendar is named but nobody has signed in (or the OAuth client isn't set up): say exactly that. */
      return {
        ...base,
        configured: false,
        error:
          googleState === "unconfigured"
            ? "ONCALL_GOOGLE_CALENDAR_ID is set, but Google sign-in isn't set up on the server (GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET)."
            : `ONCALL_GOOGLE_CALENDAR_ID is set, but nobody has connected Google yet. ${connectHint("calendar")}`,
      };
    }
    return { ...base, configured: false };
  }
  if (!isHttpsUrl(url)) {
    return { ...base, error: "ONCALL_CALENDAR_ICAL_URL must be an https:// address (Google Calendar's \"Secret address in iCal format\")." };
  }

  const { calendar, error } = await loadCalendar(deps, url, at, options.refresh === true);
  if (!calendar) {
    return { ...base, error: error ?? "Couldn't read the on-call calendar." };
  }

  const atMs = at.getTime();
  const ics: IcsCalendar = { events: calendar.events, name: calendar.calendarName, timeZone: calendar.timeZone, warnings: [] };
  const { occurrences } = expandCalendar(ics, {
    defaultTimeZone: deps.defaultTimeZone,
    from: atMs - WINDOW_BACK_MS,
    to: atMs + WINDOW_AHEAD_MS,
  });

  return {
    ...base,
    ...(await selectFrom(deps, occurrences, at)),
    ...(deps.google ? { source: "ical" as const } : {}),
    fetchedAt: calendar.fetchedAt,
    timeZone: calendarTimeZone(ics, deps.defaultTimeZone),
    ...(calendar.calendarName ? { calendarName: calendar.calendarName } : {}),
    ...(error ? { error } : {}),
  };
}

function defaultGoogleSource(): GoogleCalendarSource {
  return {
    calendarId: process.env.ONCALL_GOOGLE_CALENDAR_ID,
    connection: async () => (await getGoogleConnectionStatus(defaultGoogleDeps(), "calendar")).state,
    fetchEvents: (calendarId, fromMs, toMs) => {
      const google = defaultGoogleDeps();
      return fetchGoogleCalendarEvents({
        accessToken: () => getGoogleAccessToken(google, "calendar"),
        calendarId,
        onUnauthorized: () => invalidateGoogleAccessToken(google, "calendar"),
        timeMax: toMs,
        timeMin: fromMs,
      });
    },
  };
}

function defaultDeps(): OnCallDeps {
  return {
    fetchIcs: (url) => fetchIcs(url),
    google: defaultGoogleSource(),
    regionKeywords: parseRegionKeywords(process.env.ONCALL_REGION_KEYWORDS),
    resolvePeople: resolveSlackUserIds,
    store: {
      get: async <T>(key: string) => (await getCache<T>(key))?.value ?? null,
      set: (key, value, ttlSeconds) => setCache(key, value, ttlSeconds),
    },
    url: process.env.ONCALL_CALENDAR_ICAL_URL,
  };
}

/* Error text for a log line with anything URL-shaped removed - the calendar address is a secret. */
function safeErrorText(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return text.replace(/https?:\/\/\S+/gi, "<url>").slice(0, 200);
}

/** Who is on call at `now` (default: this moment), who is next, and the next 14 days. Never throws. */
export async function getOnCall(now: Date = new Date(), options: OnCallOptions = {}): Promise<OnCallResponse> {
  try {
    return await getOnCallWith(defaultDeps(), now, options);
  } catch (error) {
    console.warn(`On-call: couldn't build the schedule. ${safeErrorText(error)}`);
    return {
      at: now.toISOString(),
      configured: Boolean(process.env.ONCALL_CALENDAR_ICAL_URL?.trim() || process.env.ONCALL_GOOGLE_CALENDAR_ID?.trim()),
      error: "Couldn't read the on-call calendar.",
      fetchedAt: null,
      next: [],
      now: [],
      upcoming: [],
    };
  }
}

/** The shifts covering `now` - usually one per region. [] when not configured or unreadable. Never throws. */
export async function getCurrentOnCallShifts(now: Date = new Date()): Promise<OnCallShift[]> {
  try {
    const response = await getOnCall(now);
    return response.configured ? response.now : [];
  } catch {
    return [];
  }
}
