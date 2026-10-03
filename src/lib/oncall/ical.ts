/**
 * A small, defensive iCalendar (RFC 5545) reader - just enough to turn the
 * firefighter rotation's shared Google Calendar (its secret iCal address)
 * into concrete event occurrences. Pure: no I/O and no clock, so every rule
 * is tested with fixtures (scripts/test-oncall.ts).
 *
 * Why hand-rolled: no new dependencies, and we need a narrow slice - events,
 * recurrence and time zones - done carefully:
 * - Times are kept as wall-clock "naive" milliseconds (Date.UTC of the
 *   written fields) plus the zone they belong to, and converted to UTC only
 *   at the end, with Intl. Recurrence is defined in wall-clock time, so a
 *   weekly 09:00 New York shift stays 09:00 across the November DST change
 *   instead of drifting to 08:00.
 * - VTIMEZONE blocks are ignored: Google writes IANA TZIDs, which Intl
 *   already knows (and knows better than a copied rule set).
 * - Anything unexpected degrades instead of throwing: an unknown TZID falls
 *   back to the calendar's zone, an unsupported RRULE part keeps just the
 *   first occurrence, a runaway rule stops at a step cap - all reported as
 *   warnings rather than errors.
 */

const DAY_MS = 86_400_000;
const DEFAULT_MAX_EVENTS = 5_000;
/* Recurrence periods (days, weeks, months or years) walked per series before giving up. */
export const MAX_RECURRENCE_STEPS = 5_000;
const MAX_OCCURRENCES = 2_000;
const WARNING_TITLE_CHARS = 60;

/* ------------------------------------------------------------------ types */

export interface IcsDateTime {
  /* VALUE=DATE (or 8 digits): a whole day, no time of day. */
  dateOnly: boolean;
  /* The written wall-clock fields as if they were UTC: Date.UTC(y, m - 1, d, h, mi, s). */
  naive: number;
  /* The TZID parameter as written; resolved against Intl when expanding. */
  tzid?: string;
  /* Trailing "Z": an absolute UTC time. */
  utc: boolean;
}

/* DURATION: whole days are nominal (wall-clock days), the rest exact. */
export interface IcsDuration {
  days: number;
  ms: number;
}

/* An ATTENDEE or ORGANIZER. */
export interface IcsPerson {
  /* INDIVIDUAL / GROUP / RESOURCE / ROOM / UNKNOWN. */
  cutype?: string;
  email?: string;
  /* The CN parameter. */
  name?: string;
  /* ACCEPTED / DECLINED / TENTATIVE / NEEDS-ACTION. */
  partstat?: string;
}

export interface IcsEvent {
  attendees: IcsPerson[];
  /* STATUS:CANCELLED - skipped, but a cancelled RECURRENCE-ID still removes its occurrence. */
  cancelled: boolean;
  description?: string;
  duration?: IcsDuration;
  end?: IcsDateTime;
  exdates: IcsDateTime[];
  organizer?: IcsPerson;
  /* Set on an override of one occurrence of a recurring series (same UID). */
  recurrenceId?: IcsDateTime;
  rrule?: string;
  sequence: number;
  start: IcsDateTime;
  summary: string;
  uid: string;
}

export interface IcsCalendar {
  events: IcsEvent[];
  /* X-WR-CALNAME. */
  name?: string;
  /* X-WR-TIMEZONE, as written. */
  timeZone?: string;
  warnings: string[];
}

export interface IcsProperty {
  name: string;
  /* Parameter names upper-cased; values unquoted. */
  params: Record<string, string>;
  value: string;
}

/* One concrete occurrence of an event, in UTC. */
export interface EventOccurrence {
  allDay: boolean;
  attendees: IcsPerson[];
  description?: string;
  /* UTC epoch ms. */
  end: number;
  organizer?: IcsPerson;
  /* Came from a recurring series (a generated instance or an override). */
  recurring: boolean;
  /* UTC epoch ms. */
  start: number;
  summary: string;
  uid: string;
}

export interface ExpandOptions {
  /* Zone for floating times and all-day dates when the calendar names none (X-WR-TIMEZONE). Default UTC. */
  defaultTimeZone?: string;
  /* Window (UTC ms): occurrences overlapping [from, to) are returned. */
  from: number;
  maxSteps?: number;
  to: number;
}

export interface ExpandResult {
  occurrences: EventOccurrence[];
  warnings: string[];
}

/* ---------------------------------------------------------------- reading */

/**
 * Raw bytes to text, unfolding at the byte level first: a fold may split a
 * multi-byte UTF-8 character (a name with an accent), which decoding first
 * would garble into replacement characters.
 */
export function decodeIcsBytes(bytes: Uint8Array): string {
  const out = new Uint8Array(bytes.length);
  let length = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index] ?? 0;
    const next = bytes[index + 1];
    const afterNext = bytes[index + 2];
    if (byte === 0x0d && next === 0x0a && (afterNext === 0x20 || afterNext === 0x09)) {
      index += 2;
      continue;
    }
    if (byte === 0x0a && (next === 0x20 || next === 0x09)) {
      index += 1;
      continue;
    }
    out[length] = byte;
    length += 1;
  }
  return new TextDecoder("utf-8").decode(out.subarray(0, length));
}

/** Content lines with folding undone (a line starting with a space or tab continues the previous one). Blank lines dropped. */
export function unfoldLines(text: string): string[] {
  const lines: string[] = [];
  for (const raw of text.split(/\r\n|\n|\r/)) {
    if ((raw.startsWith(" ") || raw.startsWith("\t")) && lines.length > 0) {
      lines[lines.length - 1] += raw.slice(1);
    } else if (raw.trim().length > 0) {
      lines.push(raw);
    }
  }
  return lines;
}

function splitOutsideQuotes(text: string, separator: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  for (const char of text) {
    if (char === '"') {
      quoted = !quoted;
      current += char;
    } else if (char === separator && !quoted) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts;
}

/* RFC 6868 caret escapes in parameter values: ^n newline, ^' double quote, ^^ caret. */
function unescapeParam(value: string): string {
  const trimmed = value.trim();
  const unquoted = trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed;
  return unquoted.replace(/\^([n'^])/g, (_match, char: string) => (char === "n" ? "\n" : char === "'" ? '"' : "^"));
}

/** NAME;PARAM=value;PARAM="quoted:value":VALUE -> its parts. Null for a line with no value. */
export function parseProperty(line: string): IcsProperty | null {
  let quoted = false;
  let colon = -1;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      quoted = !quoted;
    } else if (char === ":" && !quoted) {
      colon = index;
      break;
    }
  }
  if (colon <= 0) {
    return null;
  }

  const [rawName = "", ...rawParams] = splitOutsideQuotes(line.slice(0, colon), ";");
  const name = rawName.trim().toUpperCase();
  if (!name) {
    return null;
  }
  const params: Record<string, string> = {};
  for (const rawParam of rawParams) {
    const equals = rawParam.indexOf("=");
    if (equals > 0) {
      params[rawParam.slice(0, equals).trim().toUpperCase()] = unescapeParam(rawParam.slice(equals + 1));
    }
  }
  return { name, params, value: line.slice(colon + 1) };
}

/** TEXT value escapes: \n (or \N) newline, \, \; and \\. */
export function unescapeText(value: string): string {
  return value.replace(/\\([\\;,nN])/g, (_match, char: string) => (char === "n" || char === "N" ? "\n" : char));
}

const DATE_TIME = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/i;

/** "20261005", "20261005T090000", "20261005T090000Z" (with TZID / VALUE=DATE params). Null when it isn't a real date. */
export function parseIcsDateTime(value: string, params: Record<string, string> = {}): IcsDateTime | null {
  const match = DATE_TIME.exec(value.trim());
  if (!match) {
    return null;
  }
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, zulu] = match;
  const dateOnly = hourText === undefined || params.VALUE?.toUpperCase() === "DATE";
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = dateOnly ? 0 : Number(hourText);
  const minute = dateOnly ? 0 : Number(minuteText);
  /* A leap second (60) is read as :59 - nobody schedules a rotation on one. */
  const second = dateOnly ? 0 : Math.min(Number(secondText ?? "0"), 59);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) {
    return null;
  }
  const naive = Date.UTC(year, month - 1, day, hour, minute, second);
  if (new Date(naive).getUTCDate() !== day) {
    /* 30 February and friends. */
    return null;
  }
  const utc = !dateOnly && Boolean(zulu);
  const tzid = !dateOnly && !utc && params.TZID ? params.TZID : undefined;
  return { dateOnly, naive, utc, ...(tzid ? { tzid } : {}) };
}

/* EXDATE / RDATE style: one property line may hold a comma list. */
function parseDateList(value: string, params: Record<string, string>): IcsDateTime[] {
  return value
    .split(",")
    .map((part) => parseIcsDateTime(part, params))
    .filter((parsed): parsed is IcsDateTime => parsed !== null);
}

const DURATION = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i;

/** ISO 8601 / RFC 5545 duration ("P7D", "PT8H", "P1DT2H"). Null when malformed or empty. */
export function parseIcsDuration(value: string): IcsDuration | null {
  const trimmed = value.trim();
  const match = DURATION.exec(trimmed);
  if (!match || /^[+-]?PT?$/i.test(trimmed)) {
    return null;
  }
  const [, sign, weeks, days, hours, minutes, seconds] = match;
  const factor = sign === "-" ? -1 : 1;
  return {
    days: factor * (Number(weeks ?? 0) * 7 + Number(days ?? 0)),
    ms: factor * (Number(hours ?? 0) * 3_600_000 + Number(minutes ?? 0) * 60_000 + Number(seconds ?? 0) * 1_000),
  };
}

function parsePerson(property: IcsProperty): IcsPerson {
  const address = property.value.trim().replace(/^mailto:/i, "");
  const cn = property.params.CN?.trim();
  return {
    ...(property.params.CUTYPE ? { cutype: property.params.CUTYPE.toUpperCase() } : {}),
    ...(address.includes("@") ? { email: address.toLowerCase() } : {}),
    ...(cn ? { name: cn } : {}),
    ...(property.params.PARTSTAT ? { partstat: property.params.PARTSTAT.toUpperCase() } : {}),
  };
}

interface EventDraft {
  attendees: IcsPerson[];
  cancelled: boolean;
  description?: string;
  duration?: IcsDuration;
  end?: IcsDateTime;
  exdates: IcsDateTime[];
  organizer?: IcsPerson;
  recurrenceId?: IcsDateTime;
  rrule?: string;
  sequence: number;
  start?: IcsDateTime;
  summary: string;
  uid?: string;
}

function newDraft(): EventDraft {
  return { attendees: [], cancelled: false, exdates: [], sequence: 0, summary: "" };
}

function applyEventProperty(draft: EventDraft, property: IcsProperty): void {
  const { name, params, value } = property;
  switch (name) {
    case "UID":
      draft.uid = value.trim();
      break;
    case "SUMMARY":
      draft.summary = unescapeText(value).trim();
      break;
    case "DESCRIPTION":
      draft.description = unescapeText(value);
      break;
    case "DTSTART":
      draft.start = parseIcsDateTime(value, params) ?? undefined;
      break;
    case "DTEND":
      draft.end = parseIcsDateTime(value, params) ?? undefined;
      break;
    case "DURATION":
      draft.duration = parseIcsDuration(value) ?? undefined;
      break;
    case "RRULE":
      draft.rrule = value.trim();
      break;
    case "EXDATE":
      draft.exdates.push(...parseDateList(value, params));
      break;
    case "RECURRENCE-ID":
      draft.recurrenceId = parseIcsDateTime(value, params) ?? undefined;
      break;
    case "STATUS":
      draft.cancelled = value.trim().toUpperCase() === "CANCELLED";
      break;
    case "SEQUENCE":
      draft.sequence = Number.parseInt(value, 10) || 0;
      break;
    case "ATTENDEE":
      draft.attendees.push(parsePerson(property));
      break;
    case "ORGANIZER":
      draft.organizer = parsePerson(property);
      break;
    default:
      break;
  }
}

function clipTitle(summary: string): string {
  const title = summary || "(untitled)";
  return title.length > WARNING_TITLE_CHARS ? `${title.slice(0, WARNING_TITLE_CHARS - 1)}…` : title;
}

/**
 * Parses an iCalendar document. Never throws: malformed lines are skipped,
 * an event without DTSTART is dropped with a warning, and VALARM / VTIMEZONE
 * contents are ignored (only VCALENDAR and VEVENT properties are read).
 */
export function parseIcs(text: string, options: { maxEvents?: number } = {}): IcsCalendar {
  const maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
  const calendar: IcsCalendar = { events: [], warnings: [] };
  const stack: string[] = [];
  let draft: EventDraft | null = null;
  let anonymous = 0;
  let skippedNoStart = 0;
  let overCap = false;

  for (const line of unfoldLines(text)) {
    const property = parseProperty(line);
    if (!property) {
      continue;
    }

    if (property.name === "BEGIN") {
      const component = property.value.trim().toUpperCase();
      stack.push(component);
      if (component === "VEVENT") {
        draft = newDraft();
      }
      continue;
    }

    if (property.name === "END") {
      const component = property.value.trim().toUpperCase();
      /* Pop up to the matching BEGIN, so a missing END:VALARM can't swallow the rest of the file. */
      const at = stack.lastIndexOf(component);
      if (at >= 0) {
        stack.length = at;
      }
      if (component === "VEVENT" && draft) {
        if (!draft.start) {
          skippedNoStart += 1;
        } else if (calendar.events.length >= maxEvents) {
          overCap = true;
        } else {
          anonymous += draft.uid ? 0 : 1;
          calendar.events.push({
            attendees: draft.attendees,
            cancelled: draft.cancelled,
            exdates: draft.exdates,
            sequence: draft.sequence,
            start: draft.start,
            summary: draft.summary,
            uid: draft.uid || `no-uid-${anonymous}`,
            ...(draft.description ? { description: draft.description } : {}),
            ...(draft.duration ? { duration: draft.duration } : {}),
            ...(draft.end ? { end: draft.end } : {}),
            ...(draft.organizer ? { organizer: draft.organizer } : {}),
            ...(draft.recurrenceId ? { recurrenceId: draft.recurrenceId } : {}),
            ...(draft.rrule ? { rrule: draft.rrule } : {}),
          });
        }
        draft = null;
      }
      continue;
    }

    const top = stack[stack.length - 1];
    if (top === "VEVENT" && draft) {
      applyEventProperty(draft, property);
    } else if (top === "VCALENDAR") {
      if (property.name === "X-WR-CALNAME") {
        calendar.name = unescapeText(property.value).trim() || undefined;
      } else if (property.name === "X-WR-TIMEZONE") {
        calendar.timeZone = property.value.trim() || undefined;
      }
    }
  }

  if (skippedNoStart > 0) {
    calendar.warnings.push(`${skippedNoStart} event(s) without a start time were skipped.`);
  }
  if (overCap) {
    calendar.warnings.push(`Only the first ${maxEvents} events were read.`);
  }
  return calendar;
}

/* ------------------------------------------------------------- time zones */

const formatters = new Map<string, Intl.DateTimeFormat | null>();

function zoneFormatter(timeZone: string): Intl.DateTimeFormat | null {
  const cached = formatters.get(timeZone);
  if (cached !== undefined) {
    return cached;
  }
  let formatter: Intl.DateTimeFormat | null = null;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
      minute: "2-digit",
      month: "2-digit",
      second: "2-digit",
      timeZone,
      year: "numeric",
    });
  } catch {
    formatter = null;
  }
  formatters.set(timeZone, formatter);
  return formatter;
}

/* The few Windows zone names Outlook-made events carry; Google writes IANA names. */
const WINDOWS_ZONES: Record<string, string> = {
  "Central Standard Time": "America/Chicago",
  "Eastern Standard Time": "America/New_York",
  "GMT Standard Time": "Europe/London",
  "India Standard Time": "Asia/Kolkata",
  "Mountain Standard Time": "America/Denver",
  "Pacific Standard Time": "America/Los_Angeles",
  "W. Europe Standard Time": "Europe/Berlin",
};

/**
 * A TZID as written to a zone Intl knows, or null. Accepts IANA names,
 * vendor-prefixed ones ("/mozilla.org/20050126_1/America/New_York") and a
 * few Windows names.
 */
export function resolveTimeZone(tzid: string | undefined): string | null {
  const cleaned = tzid?.trim().replace(/^"|"$/g, "");
  if (!cleaned) {
    return null;
  }
  if (/^(?:utc|gmt|z|etc\/utc)$/i.test(cleaned)) {
    return "UTC";
  }
  if (zoneFormatter(cleaned)) {
    return cleaned;
  }
  const parts = cleaned.split("/").filter(Boolean);
  for (let index = 1; index < parts.length; index += 1) {
    const candidate = parts.slice(index).join("/");
    if (candidate.includes("/") && zoneFormatter(candidate)) {
      return candidate;
    }
  }
  return WINDOWS_ZONES[cleaned] ?? null;
}

/** A zone's offset at an instant: its wall clock (as naive ms) minus the instant. 0 for UTC or an unknown zone. */
export function zoneOffsetMs(instant: number, timeZone: string): number {
  if (timeZone === "UTC") {
    return 0;
  }
  const formatter = zoneFormatter(timeZone);
  if (!formatter) {
    return 0;
  }
  const fields: Record<string, number> = {};
  for (const part of formatter.formatToParts(new Date(instant))) {
    fields[part.type] = Number(part.value);
  }
  const wall = Date.UTC(fields.year ?? 1970, (fields.month ?? 1) - 1, fields.day ?? 1, (fields.hour ?? 0) % 24, fields.minute ?? 0, fields.second ?? 0);
  return wall - Math.floor(instant / 1_000) * 1_000;
}

/**
 * Wall-clock time (naive ms) in a zone to its UTC instant. Tries the offsets
 * in force a day before and a day after, and keeps whichever reproduces the
 * wall clock - so it is right on both sides of a DST change. As RFC 5545
 * says: an ambiguous fall-back time is its first (daylight) occurrence, and
 * a time skipped by a spring-forward is read with the offset from before the
 * jump (02:30 becomes 03:30).
 */
export function zonedToUtc(naive: number, timeZone: string): number {
  if (timeZone === "UTC" || !zoneFormatter(timeZone)) {
    return naive;
  }
  const before = naive - zoneOffsetMs(naive - DAY_MS, timeZone);
  const after = naive - zoneOffsetMs(naive + DAY_MS, timeZone);
  const fits = (instant: number): boolean => instant + zoneOffsetMs(instant, timeZone) === naive;
  const beforeFits = fits(before);
  const afterFits = fits(after);
  if (beforeFits && afterFits) {
    return Math.min(before, after);
  }
  if (afterFits) {
    return after;
  }
  return before;
}

/** The zone an expansion uses for floating times and all-day dates: X-WR-TIMEZONE if Intl knows it, else the fallback, else UTC. */
export function calendarTimeZone(calendar: Pick<IcsCalendar, "timeZone">, fallback = "UTC"): string {
  return resolveTimeZone(calendar.timeZone) ?? resolveTimeZone(fallback) ?? "UTC";
}

/* ------------------------------------------------------------- recurrence */

const WEEKDAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const UNSUPPORTED_PARTS = ["BYHOUR", "BYMINUTE", "BYSECOND", "BYSETPOS", "BYWEEKNO", "BYYEARDAY", "RSCALE", "SKIP"];

export interface RecurrenceRule {
  /* weekday 0 = Sunday (as Date#getUTCDay); ordinal 0 = every one, 1 = first, -1 = last. */
  byDay: Array<{ ordinal: number; weekday: number }>;
  byMonth: number[];
  byMonthDay: number[];
  count?: number;
  freq: "DAILY" | "MONTHLY" | "WEEKLY" | "YEARLY";
  interval: number;
  until?: IcsDateTime;
  wkst: number;
}

/** An RRULE value to a rule we can expand, or null plus the parts we can't (so the caller keeps only the first occurrence). */
export function parseRecurrenceRule(value: string): { rule: RecurrenceRule | null; unsupported: string[] } {
  const parts = new Map<string, string>();
  for (const piece of value.split(";")) {
    const equals = piece.indexOf("=");
    if (equals > 0) {
      parts.set(piece.slice(0, equals).trim().toUpperCase(), piece.slice(equals + 1).trim());
    }
  }

  const unsupported: string[] = [];
  const freq = parts.get("FREQ")?.toUpperCase();
  if (freq !== "DAILY" && freq !== "WEEKLY" && freq !== "MONTHLY" && freq !== "YEARLY") {
    return { rule: null, unsupported: [`FREQ=${freq ?? "(missing)"}`] };
  }

  const intervalText = parts.get("INTERVAL");
  const interval = intervalText === undefined ? 1 : Number.parseInt(intervalText, 10);
  if (!Number.isFinite(interval) || interval < 1) {
    unsupported.push(`INTERVAL=${intervalText ?? ""}`);
  }

  let count: number | undefined;
  const countText = parts.get("COUNT");
  if (countText !== undefined) {
    count = Number.parseInt(countText, 10);
    if (!Number.isFinite(count) || count < 1) {
      unsupported.push(`COUNT=${countText}`);
    }
  }

  let until: IcsDateTime | undefined;
  const untilText = parts.get("UNTIL");
  if (untilText !== undefined) {
    until = parseIcsDateTime(untilText) ?? undefined;
    if (!until) {
      unsupported.push(`UNTIL=${untilText}`);
    }
  }

  const byDay: RecurrenceRule["byDay"] = [];
  for (const entry of (parts.get("BYDAY") ?? "").split(",").filter(Boolean)) {
    const match = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/i.exec(entry.trim());
    if (!match) {
      unsupported.push(`BYDAY=${entry}`);
      continue;
    }
    byDay.push({ ordinal: match[1] ? Number.parseInt(match[1], 10) : 0, weekday: WEEKDAY_CODES.indexOf((match[2] ?? "").toUpperCase()) });
  }

  const numberList = (name: string, valid: (n: number) => boolean): number[] => {
    const out: number[] = [];
    for (const entry of (parts.get(name) ?? "").split(",").filter(Boolean)) {
      const parsed = Number.parseInt(entry, 10);
      if (Number.isFinite(parsed) && valid(parsed)) {
        out.push(parsed);
      } else {
        unsupported.push(`${name}=${entry}`);
      }
    }
    return out;
  };
  const byMonthDay = numberList("BYMONTHDAY", (n) => n !== 0 && n >= -31 && n <= 31);
  const byMonth = numberList("BYMONTH", (n) => n >= 1 && n <= 12);

  if ((freq === "DAILY" || freq === "WEEKLY") && byDay.some((entry) => entry.ordinal !== 0)) {
    unsupported.push("BYDAY with an ordinal in a daily/weekly rule");
  }
  if (freq === "YEARLY" && byDay.length > 0 && byMonth.length === 0) {
    unsupported.push("BYDAY in a yearly rule without BYMONTH");
  }
  for (const name of UNSUPPORTED_PARTS) {
    if (parts.has(name)) {
      unsupported.push(name);
    }
  }

  const wkstIndex = WEEKDAY_CODES.indexOf((parts.get("WKST") ?? "MO").toUpperCase());
  const rule: RecurrenceRule = {
    byDay,
    byMonth,
    byMonthDay,
    freq,
    interval: Math.max(1, interval || 1),
    wkst: wkstIndex >= 0 ? wkstIndex : 1,
    ...(count !== undefined ? { count } : {}),
    ...(until ? { until } : {}),
  };
  return { rule: unsupported.length > 0 ? null : rule, unsupported };
}

function dayStart(naive: number): number {
  return Math.floor(naive / DAY_MS) * DAY_MS;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/* The days of one month a MONTHLY (or YEARLY + BYMONTH) rule picks, ascending. */
function monthDays(rule: RecurrenceRule, year: number, month: number, fallbackDay: number): number[] {
  const length = daysInMonth(year, month);
  let days: number[] | null = null;
  if (rule.byMonthDay.length > 0) {
    days = rule.byMonthDay.map((day) => (day > 0 ? day : length + day + 1)).filter((day) => day >= 1 && day <= length);
  }
  if (rule.byDay.length > 0) {
    const firstWeekday = new Date(Date.UTC(year, month, 1)).getUTCDay();
    const picked: number[] = [];
    for (const { ordinal, weekday } of rule.byDay) {
      const matching: number[] = [];
      for (let day = 1 + ((weekday - firstWeekday + 7) % 7); day <= length; day += 7) {
        matching.push(day);
      }
      if (ordinal === 0) {
        picked.push(...matching);
      } else {
        const chosen = ordinal > 0 ? matching[ordinal - 1] : matching[matching.length + ordinal];
        if (chosen !== undefined) {
          picked.push(chosen);
        }
      }
    }
    days = days ? days.filter((day) => picked.includes(day)) : picked;
  }
  if (!days) {
    /* No BYMONTHDAY/BYDAY: DTSTART's day of month - a month without it (the 31st) is skipped, per RFC 5545. */
    days = fallbackDay <= length ? [fallbackDay] : [];
  }
  return [...new Set(days)].sort((a, b) => a - b);
}

interface StepBudget {
  exhausted: boolean;
  remaining: number;
}

function takeStep(budget: StepBudget): boolean {
  if (budget.remaining <= 0) {
    budget.exhausted = true;
    return false;
  }
  budget.remaining -= 1;
  return true;
}

/**
 * Candidate starts (naive, ascending) for a rule, period by period, from
 * the period holding DTSTART. `skipBefore` (naive) lets an unbounded daily
 * or weekly series jump whole periods straight to the window - only safe
 * without COUNT, which has to be counted from the start.
 */
function* recurrenceCandidates(rule: RecurrenceRule, startNaive: number, skipBefore: number | null, budget: StepBudget): Generator<number> {
  const firstDay = dayStart(startNaive);
  const timeOfDay = startNaive - firstDay;
  const first = new Date(firstDay);
  const monthAllowed = (naive: number): boolean => rule.byMonth.length === 0 || rule.byMonth.includes(new Date(naive).getUTCMonth() + 1);

  if (rule.freq === "DAILY") {
    const step = rule.interval * DAY_MS;
    let day = firstDay;
    if (skipBefore !== null && skipBefore > day) {
      day += Math.floor((skipBefore - day) / step) * step;
    }
    while (takeStep(budget)) {
      const date = new Date(day);
      const weekdayOk = rule.byDay.length === 0 || rule.byDay.some((entry) => entry.weekday === date.getUTCDay());
      const length = daysInMonth(date.getUTCFullYear(), date.getUTCMonth());
      const monthDayOk = rule.byMonthDay.length === 0 || rule.byMonthDay.some((value) => (value > 0 ? value : length + value + 1) === date.getUTCDate());
      if (monthAllowed(day) && weekdayOk && monthDayOk) {
        yield day + timeOfDay;
      }
      day += step;
    }
    return;
  }

  if (rule.freq === "WEEKLY") {
    const startWeekday = first.getUTCDay();
    let weekStart = firstDay - ((startWeekday - rule.wkst + 7) % 7) * DAY_MS;
    const weekdays = rule.byDay.length > 0 ? rule.byDay.map((entry) => entry.weekday) : [startWeekday];
    const offsets = [...new Set(weekdays.map((weekday) => (weekday - rule.wkst + 7) % 7))].sort((a, b) => a - b);
    const step = rule.interval * 7 * DAY_MS;
    if (skipBefore !== null && skipBefore > weekStart) {
      weekStart += Math.floor((skipBefore - weekStart) / step) * step;
    }
    while (takeStep(budget)) {
      for (const offset of offsets) {
        const day = weekStart + offset * DAY_MS;
        if (monthAllowed(day)) {
          yield day + timeOfDay;
        }
      }
      weekStart += step;
    }
    return;
  }

  if (rule.freq === "MONTHLY") {
    let year = first.getUTCFullYear();
    let month = first.getUTCMonth();
    while (takeStep(budget)) {
      if (rule.byMonth.length === 0 || rule.byMonth.includes(month + 1)) {
        for (const day of monthDays(rule, year, month, first.getUTCDate())) {
          yield Date.UTC(year, month, day) + timeOfDay;
        }
      }
      month += rule.interval;
      year += Math.floor(month / 12);
      month %= 12;
    }
    return;
  }

  /* YEARLY: BYMONTH months (or every month for a bare BYMONTHDAY, or DTSTART's month), then the days within each. */
  const months =
    rule.byMonth.length > 0
      ? [...new Set(rule.byMonth)].sort((a, b) => a - b).map((month) => month - 1)
      : rule.byMonthDay.length > 0
        ? Array.from({ length: 12 }, (_unused, index) => index)
        : [first.getUTCMonth()];
  let year = first.getUTCFullYear();
  while (takeStep(budget)) {
    for (const month of months) {
      for (const day of monthDays(rule, year, month, first.getUTCDate())) {
        yield Date.UTC(year, month, day) + timeOfDay;
      }
    }
    year += rule.interval;
  }
}

/* ------------------------------------------------------------- expansion */

interface ExpandContext {
  calendarZone: string;
  maxSteps: number;
  unknownZones: Set<string>;
  warnings: string[];
}

function zoneOf(value: IcsDateTime, ctx: ExpandContext): string {
  if (value.utc) {
    return "UTC";
  }
  if (value.dateOnly || !value.tzid) {
    /* All-day dates and floating times belong to the calendar's zone. */
    return ctx.calendarZone;
  }
  const zone = resolveTimeZone(value.tzid);
  if (zone) {
    return zone;
  }
  ctx.unknownZones.add(value.tzid);
  return ctx.calendarZone;
}

function instantOf(value: IcsDateTime, ctx: ExpandContext): number {
  return zonedToUtc(value.naive, zoneOf(value, ctx));
}

/** An IcsDateTime as a UTC instant, reading floating times and dates in `calendarZone`. */
export function icsInstant(value: IcsDateTime, calendarZone: string): number {
  return instantOf(value, { calendarZone, maxSteps: 0, unknownZones: new Set(), warnings: [] });
}

/* Where an occurrence starting at `startNaive` (wall clock in `zone`) ends, in UTC. */
function occurrenceEnd(event: IcsEvent, startNaive: number, zone: string, ctx: ExpandContext): number {
  const startUtc = zonedToUtc(startNaive, zone);
  let end: number;
  if (event.end) {
    const endZone = zoneOf(event.end, ctx);
    if (endZone === zone || event.start.dateOnly || event.end.dateOnly) {
      /* Same zone: the length is wall-clock ("until next Monday 09:00"), so DST doesn't move the end. */
      end = zonedToUtc(startNaive + (event.end.naive - event.start.naive), zone);
    } else {
      end = startUtc + (instantOf(event.end, ctx) - instantOf(event.start, ctx));
    }
  } else if (event.duration) {
    end = zonedToUtc(startNaive + event.duration.days * DAY_MS, zone) + event.duration.ms;
  } else {
    end = event.start.dateOnly ? zonedToUtc(startNaive + DAY_MS, zone) : startUtc;
  }
  if (event.start.dateOnly && end <= startUtc) {
    return zonedToUtc(startNaive + DAY_MS, zone);
  }
  return Math.max(end, startUtc);
}

/* EXDATE / RECURRENCE-ID values: a date matches its whole day, a date-time its exact instant. */
interface MomentSet {
  dates: Set<number>;
  instants: Set<number>;
}

function momentSet(values: IcsDateTime[], ctx: ExpandContext): MomentSet {
  const set: MomentSet = { dates: new Set(), instants: new Set() };
  for (const value of values) {
    if (value.dateOnly) {
      set.dates.add(dayStart(value.naive));
    } else {
      set.instants.add(instantOf(value, ctx));
    }
  }
  return set;
}

function inMomentSet(set: MomentSet, startNaive: number, startUtc: number): boolean {
  return set.instants.has(startUtc) || set.dates.has(dayStart(startNaive));
}

function toOccurrence(event: IcsEvent, start: number, end: number, recurring: boolean): EventOccurrence {
  return {
    allDay: event.start.dateOnly,
    attendees: event.attendees,
    end,
    recurring,
    start,
    summary: event.summary,
    uid: event.uid,
    ...(event.description ? { description: event.description } : {}),
    ...(event.organizer ? { organizer: event.organizer } : {}),
  };
}

function withinUntil(rule: RecurrenceRule, naive: number, zone: string): boolean {
  const { until } = rule;
  if (!until) {
    return true;
  }
  if (until.utc) {
    return zonedToUtc(naive, zone) <= until.naive;
  }
  if (until.dateOnly) {
    /* UNTIL=20261231 includes the whole day. */
    return dayStart(naive) <= until.naive;
  }
  return naive <= until.naive;
}

function expandSeries(master: IcsEvent, overridden: MomentSet, ctx: ExpandContext, window: { from: number; to: number }, out: EventOccurrence[]): void {
  const zone = zoneOf(master.start, ctx);
  const excluded = momentSet(master.exdates, ctx);
  const emit = (naive: number): void => {
    const start = zonedToUtc(naive, zone);
    if (inMomentSet(excluded, naive, start) || inMomentSet(overridden, naive, start)) {
      return;
    }
    const end = occurrenceEnd(master, naive, zone, ctx);
    /* A zero-length event still counts at its instant. */
    if (start < window.to && (end > window.from || (end === start && start >= window.from))) {
      out.push(toOccurrence(master, start, end, Boolean(master.rrule)));
    }
  };

  if (!master.rrule) {
    emit(master.start.naive);
    return;
  }

  const { rule, unsupported } = parseRecurrenceRule(master.rrule);
  /* DTSTART is always the first occurrence, whether or not it matches the rule (RFC 5545). */
  emit(master.start.naive);
  if (!rule) {
    ctx.warnings.push(`"${clipTitle(master.summary)}" repeats with ${unsupported.join(", ")}, which isn't supported - only its first occurrence is used.`);
    return;
  }

  let produced = 1;
  if (rule.count !== undefined && produced >= rule.count) {
    return;
  }
  const firstLength = Math.max(0, occurrenceEnd(master, master.start.naive, zone, ctx) - zonedToUtc(master.start.naive, zone));
  /* Naive and UTC differ by at most ~14h, so two days of slack keeps the skip safe. */
  const skipBefore = rule.count === undefined ? window.from - firstLength - 2 * DAY_MS : null;
  const budget: StepBudget = { exhausted: false, remaining: ctx.maxSteps };

  for (const naive of recurrenceCandidates(rule, master.start.naive, skipBefore, budget)) {
    if (naive <= master.start.naive) {
      continue;
    }
    if (!withinUntil(rule, naive, zone)) {
      break;
    }
    produced += 1;
    if (rule.count !== undefined && produced > rule.count) {
      break;
    }
    if (zonedToUtc(naive, zone) >= window.to) {
      break;
    }
    emit(naive);
  }

  if (budget.exhausted) {
    ctx.warnings.push(`Stopped expanding "${clipTitle(master.summary)}" after ${ctx.maxSteps} recurrence steps.`);
  }
}

/**
 * Every occurrence overlapping [from, to), sorted by start: recurring series
 * expanded (EXDATEs removed, RECURRENCE-ID overrides swapped in), cancelled
 * events and occurrences left out. Never throws.
 */
export function expandCalendar(calendar: IcsCalendar, options: ExpandOptions): ExpandResult {
  const ctx: ExpandContext = {
    calendarZone: calendarTimeZone(calendar, options.defaultTimeZone),
    maxSteps: options.maxSteps ?? MAX_RECURRENCE_STEPS,
    unknownZones: new Set(),
    warnings: [],
  };
  const window = { from: options.from, to: options.to };

  /* One series per UID: its master (the highest SEQUENCE wins a duplicate) and its overrides. */
  const series = new Map<string, { master?: IcsEvent; overrides: IcsEvent[] }>();
  for (const event of calendar.events) {
    const group = series.get(event.uid) ?? { overrides: [] };
    series.set(event.uid, group);
    if (event.recurrenceId) {
      group.overrides.push(event);
    } else if (!group.master || event.sequence >= group.master.sequence) {
      group.master = event;
    }
  }

  const occurrences: EventOccurrence[] = [];
  for (const { master, overrides } of series.values()) {
    const overridden = momentSet(
      overrides.map((override) => override.recurrenceId).filter((value): value is IcsDateTime => value !== undefined),
      ctx,
    );
    if (master && !master.cancelled) {
      expandSeries(master, overridden, ctx, window, occurrences);
    }
    for (const override of overrides) {
      if (override.cancelled) {
        continue;
      }
      const zone = zoneOf(override.start, ctx);
      const start = zonedToUtc(override.start.naive, zone);
      const end = occurrenceEnd(override, override.start.naive, zone, ctx);
      if (start < window.to && end > window.from) {
        occurrences.push(toOccurrence(override, start, end, true));
      }
    }
  }

  for (const zone of ctx.unknownZones) {
    ctx.warnings.push(`Unknown time zone "${zone}" - read as ${ctx.calendarZone}.`);
  }
  occurrences.sort((a, b) => a.start - b.start || a.uid.localeCompare(b.uid));
  if (occurrences.length > MAX_OCCURRENCES) {
    ctx.warnings.push(`Only the first ${MAX_OCCURRENCES} occurrences are used.`);
    occurrences.length = MAX_OCCURRENCES;
  }
  return { occurrences, warnings: ctx.warnings };
}

/**
 * The calendar trimmed to what can matter between `from` and `to`, so the
 * cached copy stays small: whole series (master + overrides) that produce an
 * occurrence there or override one there; descriptions clipped, long guest
 * lists capped.
 */
export function pruneCalendar(calendar: IcsCalendar, from: number, to: number, options: { defaultTimeZone?: string } = {}): IcsCalendar {
  const { occurrences } = expandCalendar(calendar, { defaultTimeZone: options.defaultTimeZone, from, to });
  const keep = new Set(occurrences.map((occurrence) => occurrence.uid));
  const zone = calendarTimeZone(calendar, options.defaultTimeZone);
  for (const event of calendar.events) {
    if (event.recurrenceId) {
      const instant = icsInstant(event.recurrenceId, zone);
      if (instant >= from - DAY_MS && instant < to + DAY_MS) {
        keep.add(event.uid);
      }
    }
  }
  return {
    ...calendar,
    events: calendar.events
      .filter((event) => keep.has(event.uid))
      .map((event) => ({
        ...event,
        attendees: event.attendees.slice(0, 25),
        ...(event.description ? { description: event.description.slice(0, 300) } : {}),
      })),
  };
}
