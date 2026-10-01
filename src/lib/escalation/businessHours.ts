import type { BusinessCalendar } from "@/lib/escalation/types";

/**
 * Business-time arithmetic over a JSM working-hours calendar.
 *
 * The engineering ladder needs its own clock because JSM's Time to
 * Resolution is paused in Waiting for product. To count the way Jira does,
 * working windows are LOCAL wall-clock times in the calendar's zone
 * (09:00-18:00 New York stays 09:00-18:00 across DST) and holidays are LOCAL
 * dates. No date library: Intl gives the zone's UTC offset at any instant,
 * which is all the local <-> UTC conversion needs.
 */

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

/* Day 0 of the Unix epoch (1970-01-01) was a Thursday. */
const EPOCH_WEEKDAY = 4;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

interface WorkingWindow {
  end: number;
  start: number;
}

interface NormalizedCalendar {
  fixedHolidays: Set<string>;
  recurringHolidays: Set<string>;
  timeZone: string;
  /* Index 0 = Sunday ... 6 = Saturday; validated to lie within one local day, sorted, merged. */
  windowsByWeekday: WorkingWindow[][];
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    /* Throws RangeError on an unknown zone - a misread calendar must fail loudly, not silently count UTC hours. */
    formatter = new Intl.DateTimeFormat("en-US", {
      day: "numeric",
      hour: "numeric",
      hourCycle: "h23",
      minute: "numeric",
      month: "numeric",
      second: "numeric",
      timeZone,
      year: "numeric",
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

/** Offset of `timeZone` from UTC at instant `utcMs`, in ms (local wall clock = utcMs + offset). */
function offsetAt(utcMs: number, timeZone: string): number {
  let year = 0;
  let month = 1;
  let day = 1;
  let hour = 0;
  let minute = 0;
  let second = 0;
  for (const { type, value } of formatterFor(timeZone).formatToParts(utcMs)) {
    if (type === "year") year = Number(value);
    else if (type === "month") month = Number(value);
    else if (type === "day") day = Number(value);
    else if (type === "hour") hour = Number(value);
    else if (type === "minute") minute = Number(value);
    else if (type === "second") second = Number(value);
  }
  /* `% 24`: some engines still print midnight as "24" despite h23. Intl drops
     milliseconds, so compare against the instant floored to the second. */
  const wallClockAsUtc = Date.UTC(year, month - 1, day, hour % 24, minute, second);
  return wallClockAsUtc - Math.floor(utcMs / 1000) * 1000;
}

/**
 * The UTC instant at which `timeZone` reads wall clock `localMs` (a local
 * date-time encoded as if it were UTC).
 *
 * Every real offset lies within [-12h, +14h], so the answer is within
 * [localMs - 14h, localMs + 12h]; offsets sampled just outside that range are
 * the ones on either side of the (at most one) transition inside it. DST is
 * resolved like Temporal's "compatible": a repeated wall time maps to its
 * first occurrence, a skipped one is pushed forward by the gap (02:30 -> 03:30).
 */
function localToUtc(localMs: number, timeZone: string): number {
  const before = offsetAt(localMs - 15 * HOUR_MS, timeZone);
  const after = offsetAt(localMs + 13 * HOUR_MS, timeZone);
  const viaBefore = localMs - before;
  if (before === after) return viaBefore;

  const viaAfter = localMs - after;
  const beforeFits = offsetAt(viaBefore, timeZone) === before;
  const afterFits = offsetAt(viaAfter, timeZone) === after;
  if (beforeFits && afterFits) return Math.min(viaBefore, viaAfter);
  if (afterFits) return viaAfter;
  /* Only the pre-transition offset fits, or neither does (a spring-forward gap): either way it's viaBefore. */
  return viaBefore;
}

/** Days since the epoch of the LOCAL calendar date `utcMs` falls on. */
function localDayNumber(utcMs: number, timeZone: string): number {
  return Math.floor((utcMs + offsetAt(utcMs, timeZone)) / DAY_MS);
}

function weekdayOf(dayNumber: number): number {
  return (((dayNumber + EPOCH_WEEKDAY) % 7) + 7) % 7;
}

function isHoliday(dayNumber: number, calendar: NormalizedCalendar): boolean {
  const isoDate = new Date(dayNumber * DAY_MS).toISOString().slice(0, 10);
  return calendar.fixedHolidays.has(isoDate) || calendar.recurringHolidays.has(isoDate.slice(5));
}

/** `isoDate` is a real calendar date written as YYYY-MM-DD (the regex alone accepts "2026-13-45"). */
function isRealIsoDate(isoDate: unknown): isoDate is string {
  if (typeof isoDate !== "string" || !ISO_DATE.test(isoDate)) return false;
  const [year, month, day] = isoDate.split("-").map(Number) as [number, number, number];
  const utc = new Date(Date.UTC(year, month - 1, day));
  /* setUTCFullYear because Date.UTC maps years 0-99 to 1900-1999. */
  utc.setUTCFullYear(year);
  return utc.toISOString().slice(0, 10) === isoDate;
}

/* Re-normalised on every call (a dozen holidays, a handful of windows) rather
   than cached, so a calendar object re-read from Jira can never go stale here.
   Every field is validated rather than skipped: a calendar mapped wrong from
   Jira (weekdays numbered 1..7, times in seconds, a missing zone) would
   otherwise read as near-zero or shifted hours and the ladder would quietly
   never fire. */
function normalize(calendar: BusinessCalendar): NormalizedCalendar {
  const { timezone } = calendar;
  /* An undefined timeZone makes Intl fall back to the MACHINE's zone instead of throwing. */
  if (typeof timezone !== "string" || timezone === "") {
    throw new RangeError(`Calendar ${calendar.id}: timezone ${JSON.stringify(timezone)} is not an IANA zone`);
  }
  /* Throws RangeError on an unknown zone, even when the span turns out to be empty. */
  formatterFor(timezone);

  const windowsByWeekday: WorkingWindow[][] = Array.from({ length: 7 }, () => []);
  for (const { endMs, startMs, weekday } of calendar.workingTimes) {
    /* Plain interpolation, not JSON.stringify, which would print NaN as null. */
    const label = `Calendar ${calendar.id}: working time {weekday: ${weekday}, startMs: ${startMs}, endMs: ${endMs}}`;
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
      throw new RangeError(`${label} has weekday outside 0 (Sunday) ... 6 (Saturday)`);
    }
    /* Within one local day, so windows of adjacent days can never overlap and
       double count; overnight shifts must arrive split across two weekdays. */
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || endMs > DAY_MS || startMs >= endMs) {
      throw new RangeError(`${label} is not a window 0 <= startMs < endMs <= ${DAY_MS} ms after local midnight`);
    }
    /* Jira working hours are minute-granular, so a sub-minute edge means the
       wrong unit (09:00 as 32_400 s reads as 32.4 seconds of work). */
    if (startMs % MINUTE_MS !== 0 || endMs % MINUTE_MS !== 0) {
      throw new RangeError(`${label} is not on whole minutes - startMs/endMs must be milliseconds`);
    }
    windowsByWeekday[weekday]?.push({ end: endMs, start: startMs });
  }
  for (const windows of windowsByWeekday) {
    windows.sort((a, b) => a.start - b.start);
    /* Overlapping or touching windows are merged so an hour is never counted twice. */
    let write = 0;
    for (let read = 1; read < windows.length; read += 1) {
      const current = windows[write];
      const next = windows[read];
      if (!current || !next) continue;
      if (next.start <= current.end) current.end = Math.max(current.end, next.end);
      else windows[++write] = next;
    }
    windows.length = Math.min(windows.length, write + 1);
  }

  const fixedHolidays = new Set<string>();
  const recurringHolidays = new Set<string>();
  for (const { isoDate, recurring } of calendar.holidays) {
    /* A date that cannot exist would never match a day: the holiday would silently count as working. */
    if (!isRealIsoDate(isoDate)) {
      throw new RangeError(`Calendar ${calendar.id}: holiday date ${JSON.stringify(isoDate)} is not a real YYYY-MM-DD date`);
    }
    /* Jira's "recurring" is the same month/day every year (it does not follow e.g. "4th Thursday"). */
    if (recurring) recurringHolidays.add(isoDate.slice(5));
    else fixedHolidays.add(isoDate);
  }

  return { fixedHolidays, recurringHolidays, timeZone: timezone, windowsByWeekday };
}

function assertFiniteInstant(ms: number, label: string): void {
  /* A NaN from Date.parse of a missing timestamp must not quietly read as "0 hours waited". */
  if (!Number.isFinite(ms)) throw new RangeError(`businessHours: ${label} is not a finite instant (${ms})`);
}

/**
 * Working milliseconds in [startMs, endMs) on `calendar` (0 if end <= start).
 * Throws RangeError on a non-finite instant or a malformed calendar (unknown
 * timezone, a working time off weekday 0-6 / outside one local day / not in
 * whole-minute ms, or a holiday that is not a real YYYY-MM-DD date).
 */
export function businessMsBetween(startMs: number, endMs: number, calendar: BusinessCalendar): number {
  assertFiniteInstant(startMs, "startMs");
  assertFiniteInstant(endMs, "endMs");
  /* Validated before the empty-span shortcut so a bad calendar fails on the
     first call (e.g. at WfP entry, 0 elapsed), not hours later. */
  const normalized = normalize(calendar);
  if (endMs <= startMs) return 0;

  const { timeZone } = normalized;
  const lastDay = localDayNumber(endMs, timeZone);
  let total = 0;

  /* Walk LOCAL dates, not UTC ones, and convert each window's wall-clock edges
     separately, so a DST change between start and end shifts only the days after it. */
  for (let day = localDayNumber(startMs, timeZone); day <= lastDay; day += 1) {
    const windows = normalized.windowsByWeekday[weekdayOf(day)];
    if (!windows || windows.length === 0 || isHoliday(day, normalized)) continue;

    const localMidnight = day * DAY_MS;
    for (const { end, start } of windows) {
      const from = Math.max(startMs, localToUtc(localMidnight + start, timeZone));
      const to = Math.min(endMs, localToUtc(localMidnight + end, timeZone));
      if (to > from) total += to - from;
    }
  }

  return total;
}

/** Whether instant `ms` falls inside the calendar's working hours (holidays excluded). */
export function isWithinBusinessHours(ms: number, calendar: BusinessCalendar): boolean {
  /* Defined through businessMsBetween so the two can never disagree at a window edge or DST change. */
  return businessMsBetween(ms, ms + 1, calendar) > 0;
}

/** Business hours (fractional) between two instants - convenience over businessMsBetween. */
export function businessHoursBetween(startMs: number, endMs: number, calendar: BusinessCalendar): number {
  return businessMsBetween(startMs, endMs, calendar) / 3_600_000;
}
