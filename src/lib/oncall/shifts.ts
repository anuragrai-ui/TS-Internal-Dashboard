import type { EventOccurrence, IcsPerson } from "@/lib/oncall/ical";
import type { OnCallPerson, OnCallResponse, OnCallShift } from "@/lib/workspace/types";

/**
 * Calendar occurrences -> on-call shifts: which region (Asia/Europe, US) and
 * who. Pure, so the title heuristics are tested against the many ways people
 * type a rotation into a calendar (scripts/test-oncall.ts).
 *
 * Nobody fixed a title format for the firefighter calendar, so this reads it
 * defensively. The #firefighters posts it replaces looked like
 * "Asia/Europe - <name> / US - <name>", so expect two regions, week-long
 * shifts, and titles such as "FF Asia/Europe - Tarang Somani",
 * "US: Martin & Priya", or both regions in one event. People come from the
 * event's guests when there are any (a real address beats a typed name),
 * else from the title once region and rota words are stripped.
 */

export type RegionKeywords = Record<string, string[]>;

/* Matched case-insensitively on word boundaries. "Asia/Europe" contains a "/", so regions are removed before names are split. */
export const DEFAULT_REGION_KEYWORDS: Readonly<Record<string, readonly string[]>> = {
  "Asia/Europe": ["asia", "apac", "emea", "europe", "eu", "india", "ist"],
  US: ["us", "usa", "america", "americas", "amer", "na", "est", "pst"],
};

/* The region of an event that names none. */
export const UNKNOWN_REGION = "On call";

const TITLE_MAX_CHARS = 200;
const DAY_MS = 86_400_000;
/* Back-to-back shifts for the same people closer than this are one shift ("until" means the real handover). */
const MERGE_GAP_MS = 60_000;

/* Words that say "this is a rota entry" rather than who is on it. */
const NOISE_PATTERNS = [
  "fire\\s*fight(?:ers?|ing)",
  "ff",
  "on[\\s-]*call",
  "rotations?",
  "rota",
  "shifts?",
  "schedules?",
  "primary",
  "secondary",
  "backup",
  "cover(?:age|ing)?",
  "duty",
  "weekly",
  "weekend",
  "week",
  "this",
  "next",
  "for",
  "the",
  "of",
  "is",
  "region",
  "team",
  "ts",
  "support",
  "pager",
  "hours?",
  "time\\s*zone",
  "tz",
  "am",
  "pm",
  "utc",
  "gmt",
  "et",
  "pt",
  "ct",
  "edt",
  "pdt",
  "cst",
  "cdt",
  "mst",
  "cet",
  "cest",
  "bst",
  "sgt",
  "jst",
  "aest",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];
const NOISE = new RegExp(`(?<![\\p{L}\\p{N}])(?:${NOISE_PATTERNS.join("|")})(?![\\p{L}\\p{N}])`, "giu");
/* "Mon-Fri", "Sat–Sun": a day range, not two people called Mon and Fri. */
const DAY_RANGE = /(?<![\p{L}])(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?\s*[-–—]\s*(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?(?![\p{L}])/giu;
/* "Oct 5", "5th October": a date. */
const MONTH = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?";
const DATE_PHRASE = new RegExp(`(?<![\\p{L}])(?:${MONTH}\\s*\\d{1,2}(?:st|nd|rd|th)?|\\d{1,2}(?:st|nd|rd|th)?\\s*${MONTH})(?![\\p{L}])`, "giu");
const HAS_DIGIT = /\S*\d\S*/g;
/* Between names: , & + ; | / \ : brackets, quotes, dashes that aren't inside a word, "and", "with". */
const PEOPLE_SEPARATORS = /\s*(?:[,&+;|/\\:()[\]{}<>"“”]|(?<!\p{L})-|-(?!\p{L})|[–—]|\band\b|\bwith\b)\s*/iu;

/* ---------------------------------------------------------------- regions */

/**
 * ONCALL_REGION_KEYWORDS as {"Region": ["keyword", ...]}, replacing the
 * defaults. Anything malformed (bad JSON, no usable entries) keeps the
 * defaults - a typo in Vercel must not blank the on-call pill.
 */
export function parseRegionKeywords(raw: string | undefined = process.env.ONCALL_REGION_KEYWORDS): RegionKeywords {
  const defaults = Object.fromEntries(Object.entries(DEFAULT_REGION_KEYWORDS).map(([region, words]) => [region, [...words]]));
  if (!raw?.trim()) {
    return defaults;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return defaults;
    }
    const out: RegionKeywords = {};
    for (const [region, words] of Object.entries(parsed as Record<string, unknown>)) {
      const name = region.trim();
      const list = Array.isArray(words)
        ? words.filter((word): word is string => typeof word === "string" && word.trim().length > 0).map((word) => word.trim().toLowerCase())
        : [];
      if (name && list.length > 0) {
        out[name] = list;
      }
    }
    return Object.keys(out).length > 0 ? out : defaults;
  } catch {
    return defaults;
  }
}

/** Display order of regions: as configured, then "On call". */
export function regionOrder(keywords: RegionKeywords): string[] {
  return [...Object.keys(keywords).filter((region) => region !== UNKNOWN_REGION), UNKNOWN_REGION];
}

interface RegionMatcher {
  region: string;
  regex: RegExp;
}

function compileRegions(keywords: RegionKeywords): RegionMatcher[] {
  const matchers: RegionMatcher[] = [];
  for (const [region, words] of Object.entries(keywords)) {
    for (const word of words) {
      const pattern = word
        .trim()
        .toLowerCase()
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        .replace(/\s+/g, "\\s+");
      if (pattern) {
        matchers.push({ region, regex: new RegExp(`(?<![\\p{L}\\p{N}])${pattern}(?![\\p{L}\\p{N}])`, "giu") });
      }
    }
  }
  return matchers;
}

export interface RegionMention {
  end: number;
  region: string;
  start: number;
}

/** Every region keyword in a title, in order; overlapping matches keep the longest. */
export function findRegionMentions(title: string, keywords: RegionKeywords): RegionMention[] {
  return mentionsWith(title, compileRegions(keywords));
}

function mentionsWith(title: string, matchers: RegionMatcher[]): RegionMention[] {
  const found: RegionMention[] = [];
  for (const { region, regex } of matchers) {
    regex.lastIndex = 0;
    for (const match of title.matchAll(regex)) {
      found.push({ end: match.index + match[0].length, region, start: match.index });
    }
  }
  found.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
  const out: RegionMention[] = [];
  let lastEnd = -1;
  for (const mention of found) {
    if (mention.start >= lastEnd) {
      out.push(mention);
      lastEnd = mention.end;
    }
  }
  return out;
}

/** The region a title names (the first one, when it names several), or "On call". */
export function detectRegion(title: string, keywords: RegionKeywords): string {
  return findRegionMentions(title, keywords)[0]?.region ?? UNKNOWN_REGION;
}

/* ----------------------------------------------------------------- people */

/** Lower-case, accents and punctuation gone, single spaces - for comparing names. */
export function normalizePersonName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** "tarang somani" / "TARANG SOMANI" -> "Tarang Somani"; mixed case is left as typed. */
export function prettifyName(raw: string): string {
  const name = raw.replace(/\s+/g, " ").trim();
  if (name !== name.toLowerCase() && name !== name.toUpperCase()) {
    return name;
  }
  return name.toLowerCase().replace(/(^|[\s'’-])(\p{L})/gu, (_match, lead: string, letter: string) => `${lead}${letter.toUpperCase()}`);
}

/** "tarang.somani+ff@certifyos.com" -> "Tarang Somani". */
export function nameFromEmail(email: string): string {
  const local = (email.split("@")[0] ?? "").replace(/\+.*$/, "");
  const words = local
    .split(/[._-]+/)
    .map((word) => word.replace(/\d+/g, ""))
    .filter(Boolean);
  return prettifyName(words.join(" "));
}

function cleanName(piece: string): string | null {
  const name = piece
    .replace(/^[\s.'’@*_~#!?=]+|[\s.'’*_~#!?=]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!/\p{L}/u.test(name) || name.length < 2 || name.length > 60 || name.split(" ").length > 4) {
    return null;
  }
  return prettifyName(name);
}

/**
 * The people a piece of title text names, once region words, rota words,
 * dates and times are gone. "FF Asia/Europe - Tarang Somani" -> ["Tarang
 * Somani"]; "US: Martin & priya nair" -> ["Martin", "Priya Nair"].
 */
export function peopleFromTitle(text: string, keywords: RegionKeywords): string[] {
  return peopleFromText(text, compileRegions(keywords));
}

function peopleFromText(text: string, matchers: RegionMatcher[]): string[] {
  let stripped = text;
  /* Regions first: "Asia/Europe" must not split into two "names". */
  for (const mention of [...mentionsWith(text, matchers)].reverse()) {
    stripped = `${stripped.slice(0, mention.start)} / ${stripped.slice(mention.end)}`;
  }
  stripped = stripped.replace(DAY_RANGE, " ").replace(DATE_PHRASE, " ").replace(HAS_DIGIT, " ").replace(NOISE, " ");

  const seen = new Set<string>();
  const people: string[] = [];
  for (const piece of stripped.split(PEOPLE_SEPARATORS)) {
    const name = cleanName(piece);
    const key = name ? normalizePersonName(name) : "";
    if (name && key && !seen.has(key)) {
      seen.add(key);
      people.push(name);
    }
  }
  return people;
}

function isCalendarAddress(email: string | undefined): boolean {
  /* Google's group/resource calendars: ...@group.calendar.google.com, ...@resource.calendar.google.com. */
  return Boolean(email && /@(?:[a-z0-9-]+\.)*calendar\.google\.com$/i.test(email));
}

export interface AttendeePeople {
  /* Accepted/tentative/invited people other than the organizer. */
  guests: OnCallPerson[];
  /* The organizer, when they are also on the guest list - used only if nothing else names anyone. */
  organizer: OnCallPerson[];
}

/** The people an event's guest list names: no declined guests, rooms, resources, groups or calendar addresses. */
export function attendeePeople(attendees: readonly IcsPerson[], organizer?: IcsPerson): AttendeePeople {
  const organizerEmail = organizer?.email?.toLowerCase();
  const guests: OnCallPerson[] = [];
  const organizerOut: OnCallPerson[] = [];
  const seen = new Set<string>();

  for (const attendee of attendees) {
    if (attendee.partstat === "DECLINED" || (attendee.cutype && attendee.cutype !== "INDIVIDUAL" && attendee.cutype !== "UNKNOWN")) {
      continue;
    }
    if (isCalendarAddress(attendee.email)) {
      continue;
    }
    const cn = attendee.name && !attendee.name.includes("@") ? prettifyName(attendee.name) : "";
    const name = cn || (attendee.email ? nameFromEmail(attendee.email) : "");
    if (!name) {
      continue;
    }
    const key = attendee.email ?? normalizePersonName(name);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const person: OnCallPerson = { ...(attendee.email ? { email: attendee.email } : {}), name };
    (organizerEmail && attendee.email === organizerEmail ? organizerOut : guests).push(person);
  }
  return { guests, organizer: organizerOut };
}

/* ----------------------------------------------------------------- titles */

export interface TitlePart {
  people: string[];
  region: string;
}

export interface TitleAnalysis {
  /* One part per region when the title names people for each of several regions; otherwise exactly one. */
  parts: TitlePart[];
  split: boolean;
}

interface RegionRun {
  end: number;
  region: string;
  start: number;
}

/* Consecutive mentions of one region ("Asia/Europe ... IST") are one run. */
function regionRuns(mentions: RegionMention[]): RegionRun[] {
  const runs: RegionRun[] = [];
  for (const mention of mentions) {
    const last = runs[runs.length - 1];
    if (last && last.region === mention.region) {
      last.end = mention.end;
    } else {
      runs.push({ ...mention });
    }
  }
  return runs;
}

/**
 * Which regions a title is about and who it names for each. A title naming
 * several regions is split when every region gets a name - either written
 * after it ("Asia/Europe - Tarang / US - Martin") or before it ("Tarang
 * (Asia/Europe), Martin (US)").
 */
export function analyzeTitle(title: string, keywords: RegionKeywords): TitleAnalysis {
  return analyzeWith(title, compileRegions(keywords));
}

function analyzeWith(title: string, matchers: RegionMatcher[]): TitleAnalysis {
  const runs = regionRuns(mentionsWith(title, matchers));
  const whole = peopleFromText(title, matchers);

  if (runs.length <= 1) {
    return { parts: [{ people: whole, region: runs[0]?.region ?? UNKNOWN_REGION }], split: false };
  }

  const after = runs.map((run, index) => peopleFromText(title.slice(run.start, runs[index + 1]?.start ?? title.length), matchers));
  const before = runs.map((run, index) => peopleFromText(title.slice(runs[index - 1]?.end ?? 0, run.end), matchers));
  for (const segmentation of [after, before]) {
    if (segmentation.every((people) => people.length > 0)) {
      return { parts: runs.map((run, index) => ({ people: segmentation[index] ?? [], region: run.region })), split: true };
    }
  }

  /* Several regions but no clean split: the one a name sits next to, else the first named. */
  const named = runs.findIndex((_run, index) => (after[index]?.length ?? 0) > 0);
  const namedBefore = runs.findIndex((_run, index) => (before[index]?.length ?? 0) > 0);
  const chosen = runs[named >= 0 ? named : namedBefore >= 0 ? namedBefore : 0];
  return { parts: [{ people: whole, region: chosen?.region ?? UNKNOWN_REGION }], split: false };
}

/* ----------------------------------------------------------------- shifts */

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function withGuestEmail(name: string, guests: OnCallPerson[]): OnCallPerson {
  const key = normalizePersonName(name);
  const guest = guests.find((candidate) => normalizePersonName(candidate.name) === key);
  return guest?.email ? { email: guest.email, name } : { name };
}

/**
 * One occurrence -> its shift(s). Usually one; a title that names people for
 * two regions becomes two, with ids `${uid}:${startIso}:${region}`.
 */
export function occurrenceToShifts(occurrence: EventOccurrence, keywords: RegionKeywords): OnCallShift[] {
  return occurrenceShiftsWith(occurrence, compileRegions(keywords));
}

function occurrenceShiftsWith(occurrence: EventOccurrence, matchers: RegionMatcher[]): OnCallShift[] {
  const startIso = new Date(occurrence.start).toISOString();
  const base = {
    allDay: occurrence.allDay,
    end: new Date(occurrence.end).toISOString(),
    start: startIso,
    title: clip(occurrence.summary.trim() || "(untitled)", TITLE_MAX_CHARS),
  };
  const analysis = analyzeWith(occurrence.summary, matchers);
  const guests = attendeePeople(occurrence.attendees, occurrence.organizer);
  const everyone = [...guests.guests, ...guests.organizer];

  if (analysis.split) {
    return analysis.parts.map((part) => ({
      ...base,
      id: `${occurrence.uid}:${startIso}:${part.region}`,
      people: part.people.map((name) => withGuestEmail(name, everyone)),
      region: part.region,
    }));
  }

  const part = analysis.parts[0] ?? { people: [], region: UNKNOWN_REGION };
  const people =
    guests.guests.length > 0 ? guests.guests : part.people.length > 0 ? part.people.map((name) => withGuestEmail(name, everyone)) : guests.organizer;
  return [{ ...base, id: `${occurrence.uid}:${startIso}`, people, region: part.region }];
}

function peopleSignature(shift: OnCallShift): string {
  const names = shift.people.map((person) => normalizePersonName(person.name)).sort();
  return names.length > 0 ? names.join("|") : `title:${shift.title}`;
}

/**
 * Back-to-back (or duplicate) shifts for the same region and people become
 * one, so seven daily all-day entries read "until Sunday" rather than "until
 * midnight". Keeps the first one's id and title.
 */
export function mergeContiguousShifts(shifts: readonly OnCallShift[]): OnCallShift[] {
  const sorted = [...shifts].sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || a.region.localeCompare(b.region));
  const out: OnCallShift[] = [];
  const latest = new Map<string, OnCallShift>();
  for (const shift of sorted) {
    const key = `${shift.region}\n${peopleSignature(shift)}`;
    const previous = latest.get(key);
    if (previous && Date.parse(shift.start) <= Date.parse(previous.end) + MERGE_GAP_MS) {
      if (Date.parse(shift.end) > Date.parse(previous.end)) {
        previous.end = shift.end;
      }
      previous.allDay = previous.allDay && shift.allDay;
      continue;
    }
    const copy: OnCallShift = { ...shift, people: [...shift.people] };
    out.push(copy);
    latest.set(key, copy);
  }
  return out;
}

/** Every occurrence's shifts, merged where they hand over to themselves. */
export function buildShifts(occurrences: readonly EventOccurrence[], keywords: RegionKeywords): OnCallShift[] {
  const matchers = compileRegions(keywords);
  return mergeContiguousShifts(occurrences.flatMap((occurrence) => occurrenceShiftsWith(occurrence, matchers)));
}

export interface SelectOptions {
  /* How far ahead `upcoming` reaches (default 14 days). */
  aheadMs?: number;
  /* How far back `upcoming` reaches (default 1 day). */
  backMs?: number;
  /* Region display order (regionOrder()). */
  regions: string[];
}

/**
 * Who is on call at `at`, who is next per region, and everything in the
 * window. `now` may hold two shifts of one region (co-on-call); `next` holds
 * every shift of a region that shares its earliest upcoming start.
 */
export function selectOnCall(shifts: readonly OnCallShift[], at: Date, options: SelectOptions): Pick<OnCallResponse, "next" | "now" | "upcoming"> {
  const atMs = at.getTime();
  const rank = (region: string): number => {
    const index = options.regions.indexOf(region);
    return index >= 0 ? index : options.regions.length;
  };
  const byRegionThenStart = (a: OnCallShift, b: OnCallShift): number =>
    rank(a.region) - rank(b.region) || a.region.localeCompare(b.region) || Date.parse(a.start) - Date.parse(b.start);
  const byStart = (a: OnCallShift, b: OnCallShift): number => Date.parse(a.start) - Date.parse(b.start) || rank(a.region) - rank(b.region);

  const now = shifts.filter((shift) => Date.parse(shift.start) <= atMs && atMs < Date.parse(shift.end)).sort(byRegionThenStart);

  const firstStart = new Map<string, number>();
  for (const shift of shifts) {
    const start = Date.parse(shift.start);
    if (start > atMs && start < (firstStart.get(shift.region) ?? Infinity)) {
      firstStart.set(shift.region, start);
    }
  }
  const next = shifts.filter((shift) => firstStart.get(shift.region) === Date.parse(shift.start)).sort(byRegionThenStart);

  const from = atMs - (options.backMs ?? DAY_MS);
  const to = atMs + (options.aheadMs ?? 14 * DAY_MS);
  const upcoming = shifts.filter((shift) => Date.parse(shift.end) > from && Date.parse(shift.start) < to).sort(byStart);

  return { next, now, upcoming };
}
