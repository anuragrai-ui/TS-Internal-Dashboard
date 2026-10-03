import { resolveTimeZone, zonedToUtc } from "@/lib/oncall/ical";

import type { AccessTokenResult } from "@/lib/google/oauth";
import type { EventOccurrence, IcsPerson } from "@/lib/oncall/ical";

/**
 * The on-call rotation read through the Google Calendar API (events.list),
 * for the certifyos.com calendar that has no iCal address to share. Google
 * expands recurring series itself (singleEvents=true), so what comes back is
 * already one item per occurrence; this turns them into the same
 * EventOccurrence shape the iCal path produces, and shifts.ts takes it from
 * there unchanged.
 *
 * Reads only: the grant behind it is calendar.readonly. The calendar id is
 * not a secret (it's an address-like name), so it may appear in an error
 * message - the access token never does.
 */

const API_BASE = "https://www.googleapis.com/calendar/v3";
const FETCH_TIMEOUT_MS = 10_000;
const PAGE_SIZE = 250;
/* A rotation calendar holds a handful of events a week; more than this means the wrong calendar. */
export const MAX_GOOGLE_EVENTS = 500;

/** The parts of a Google Calendar event this reads (https://developers.google.com/calendar/api/v3/reference/events). */
export interface GoogleCalendarEvent {
  attendees?: Array<{ displayName?: string; email?: string; organizer?: boolean; resource?: boolean; responseStatus?: string; self?: boolean }>;
  description?: string;
  end?: GoogleEventTime;
  iCalUID?: string;
  id?: string;
  organizer?: { displayName?: string; email?: string };
  recurringEventId?: string;
  start?: GoogleEventTime;
  /* "confirmed" | "tentative" | "cancelled". */
  status?: string;
  summary?: string;
}

export interface GoogleEventTime {
  /* All-day: "2026-10-05" (the end date is exclusive). */
  date?: string;
  /* Timed: RFC 3339 with an offset. */
  dateTime?: string;
  timeZone?: string;
}

interface EventsPage {
  items?: GoogleCalendarEvent[];
  nextPageToken?: string;
  summary?: string;
  timeZone?: string;
}

export type GoogleCalendarFetch =
  | { calendarName?: string; events: GoogleCalendarEvent[]; ok: true; timeZone?: string; truncated: boolean }
  | { error: string; ok: false; status?: number };

export interface GoogleCalendarFetchArgs {
  accessToken: () => Promise<AccessTokenResult>;
  calendarId: string;
  fetchImpl?: typeof fetch;
  /* Called on a 401 so the next attempt refreshes instead of reusing the same token. */
  onUnauthorized?: () => Promise<void>;
  timeMax: number;
  timeMin: number;
}

/* ------------------------------------------------------------- convert */

const PARTSTAT: Record<string, string> = { accepted: "ACCEPTED", declined: "DECLINED", needsAction: "NEEDS-ACTION", tentative: "TENTATIVE" };

/** A Google all-day date ("2026-10-05") as the instant midnight starts in `timeZone`, or null. Pure. */
export function allDayInstant(date: string, timeZone: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) {
    return null;
  }
  return zonedToUtc(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])), timeZone);
}

function eventInstant(time: GoogleEventTime | undefined, calendarZone: string): { allDay: boolean; ms: number } | null {
  if (time?.dateTime) {
    const ms = Date.parse(time.dateTime);
    return Number.isNaN(ms) ? null : { allDay: false, ms };
  }
  if (time?.date) {
    /* An all-day entry runs midnight to midnight where the calendar lives (a week of "FF US" is seven calendar days in its zone). */
    const ms = allDayInstant(time.date, calendarZone);
    return ms === null ? null : { allDay: true, ms };
  }
  return null;
}

function person(email: string | undefined, name: string | undefined): IcsPerson | null {
  const cleanEmail = email?.trim().toLowerCase() || undefined;
  const cleanName = name?.trim() || undefined;
  return cleanEmail || cleanName ? { ...(cleanEmail ? { email: cleanEmail } : {}), ...(cleanName ? { name: cleanName } : {}) } : null;
}

/**
 * Google events -> occurrences, in the calendar's time zone (Google's
 * `timeZone` on the events.list response). Cancelled ones are dropped (a
 * cancelled instance of a series is how Google says "not this week"); a
 * guest who declined or a room keeps its flags so shifts.ts leaves them out
 * just as it does for iCal. Pure.
 */
export function googleEventsToOccurrences(events: readonly GoogleCalendarEvent[], calendarTimeZone: string | undefined): EventOccurrence[] {
  const zone = resolveTimeZone(calendarTimeZone) ?? "UTC";
  const out: EventOccurrence[] = [];
  for (const event of events) {
    if (event.status === "cancelled") {
      continue;
    }
    const start = eventInstant(event.start, zone);
    const end = eventInstant(event.end, zone);
    if (!start) {
      continue;
    }
    /* No end: a timed event is a moment, an all-day one a single day. */
    const endMs = end && end.ms > start.ms ? end.ms : start.allDay ? (allDayInstant(nextDay(event.start?.date ?? ""), zone) ?? start.ms + 86_400_000) : start.ms;
    const attendees: IcsPerson[] = [];
    for (const attendee of event.attendees ?? []) {
      const base = person(attendee.email, attendee.displayName);
      if (!base) {
        continue;
      }
      const partstat = attendee.responseStatus ? PARTSTAT[attendee.responseStatus] : undefined;
      attendees.push({ ...base, cutype: attendee.resource ? "RESOURCE" : "INDIVIDUAL", ...(partstat ? { partstat } : {}) });
    }
    const organizer = person(event.organizer?.email, event.organizer?.displayName);
    out.push({
      allDay: start.allDay,
      attendees,
      ...(event.description ? { description: event.description } : {}),
      end: endMs,
      ...(organizer ? { organizer } : {}),
      recurring: Boolean(event.recurringEventId),
      start: start.ms,
      summary: event.summary ?? "",
      /* The series' iCalUID keeps shift ids stable across downloads; the id suffix tells instances apart via the start. */
      uid: event.iCalUID ?? event.recurringEventId ?? event.id ?? `${start.ms}`,
    });
  }
  return out.sort((a, b) => a.start - b.start);
}

function nextDay(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) {
    return "";
  }
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + 1)).toISOString().slice(0, 10);
}

/* --------------------------------------------------------------- fetch */

/** The message for a failed events.list, saying what to do about it. Pure. */
export function calendarErrorMessage(status: number, calendarId: string, reason?: string): string {
  if (status === 401) {
    return "Google rejected the calendar sign-in. Connect Google Calendar on /oncall again.";
  }
  if (status === 403 && (reason === "accessNotConfigured" || reason === "SERVICE_DISABLED")) {
    return "The Google Calendar API isn't enabled in the dashboard's Google Cloud project - enable it there (see the README).";
  }
  if (status === 404 || status === 403) {
    return `The connected account can't see calendar ${calendarId} - share the calendar with it, or connect an account that can (or fix ONCALL_GOOGLE_CALENDAR_ID).`;
  }
  if (status === 429) {
    return "Google Calendar is rate-limiting reads - it retries on its own in a few minutes.";
  }
  return `Google Calendar answered HTTP ${status} - it retries on its own in a few minutes.`;
}

function errorReason(body: unknown): string | undefined {
  const error = body && typeof body === "object" ? (body as { error?: { errors?: Array<{ reason?: unknown }>; details?: Array<{ reason?: unknown }> } }).error : undefined;
  const reason = error?.errors?.[0]?.reason ?? error?.details?.find((detail) => typeof detail.reason === "string")?.reason;
  return typeof reason === "string" ? reason : undefined;
}

/**
 * events.list over the window: singleEvents (Google expands recurrences),
 * ordered by start, every page up to MAX_GOOGLE_EVENTS. Never throws, and
 * never puts the token in a message or log line.
 */
export async function fetchGoogleCalendarEvents(args: GoogleCalendarFetchArgs): Promise<GoogleCalendarFetch> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const token = await args.accessToken();
  if (!token.ok) {
    return { error: token.error, ok: false };
  }

  const events: GoogleCalendarEvent[] = [];
  let pageToken: string | undefined;
  let timeZone: string | undefined;
  let calendarName: string | undefined;
  let truncated = false;
  try {
    do {
      const params = new URLSearchParams({
        maxResults: String(Math.min(PAGE_SIZE, MAX_GOOGLE_EVENTS - events.length)),
        orderBy: "startTime",
        showDeleted: "false",
        singleEvents: "true",
        timeMax: new Date(args.timeMax).toISOString(),
        timeMin: new Date(args.timeMin).toISOString(),
      });
      if (pageToken) {
        params.set("pageToken", pageToken);
      }
      const response = await fetchImpl(`${API_BASE}/calendars/${encodeURIComponent(args.calendarId)}/events?${params.toString()}`, {
        cache: "no-store",
        headers: { Accept: "application/json", Authorization: `Bearer ${token.token}` },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        if (response.status === 401) {
          await args.onUnauthorized?.();
        }
        return { error: calendarErrorMessage(response.status, args.calendarId, errorReason(body)), ok: false, status: response.status };
      }
      const page = (body ?? {}) as EventsPage;
      timeZone ??= page.timeZone;
      calendarName ??= page.summary;
      events.push(...(page.items ?? []));
      pageToken = page.nextPageToken;
      if (pageToken && events.length >= MAX_GOOGLE_EVENTS) {
        truncated = true;
        break;
      }
    } while (pageToken);
  } catch (error) {
    const name = error instanceof Error ? error.name : "unknown";
    console.warn(`On-call: Google Calendar read failed (${name}).`);
    return { error: name === "TimeoutError" || name === "AbortError" ? "Google Calendar didn't answer within 10 seconds." : "Couldn't reach Google Calendar.", ok: false };
  }
  return { events: events.slice(0, MAX_GOOGLE_EVENTS), ok: true, truncated, ...(timeZone ? { timeZone } : {}), ...(calendarName ? { calendarName } : {}) };
}
