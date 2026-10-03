import { formatEtIst, pillSummary, regionRows, slackDmUrl, ticketHref } from "@/components/oncall/format";
import { firefighterChannelId, getFirefighterFeedWith, toFirefighterMessages } from "@/lib/firefighters/feed";
import {
  decodeIcsBytes,
  expandCalendar,
  parseIcs,
  parseIcsDateTime,
  parseIcsDuration,
  parseProperty,
  parseRecurrenceRule,
  pruneCalendar,
  resolveTimeZone,
  unescapeText,
  unfoldLines,
  zonedToUtc,
} from "@/lib/oncall/ical";
import { fetchIcs, getOnCallWith, MAX_ICS_BYTES } from "@/lib/oncall/schedule";
import {
  analyzeTitle,
  attendeePeople,
  buildShifts,
  DEFAULT_REGION_KEYWORDS,
  detectRegion,
  mergeContiguousShifts,
  occurrenceToShifts,
  parseRegionKeywords,
  peopleFromTitle,
  regionOrder,
  selectOnCall,
  UNKNOWN_REGION,
} from "@/lib/oncall/shifts";
import { loadSlackDirectoryWith, matchSlackUserId, resolveSlackUserIdsIn, toDirectoryUsers } from "@/lib/oncall/slackDirectory";
import { DEFAULT_FIREFIGHTER_CHANNEL } from "@/lib/workspace/types";

import type { FeedStore, FirefighterFeedDeps, HistoryPage } from "@/lib/firefighters/feed";
import type { EventOccurrence, IcsCalendar } from "@/lib/oncall/ical";
import type { OnCallDeps, OnCallStore } from "@/lib/oncall/schedule";
import type { RegionKeywords } from "@/lib/oncall/shifts";
import type { CachedDirectory, SlackDirectoryUser, UsersListPage } from "@/lib/oncall/slackDirectory";
import type { SlackReadResult } from "@/lib/slackApi";
import type { SlackHistoryMessage } from "@/lib/tracker/slackParse";
import type { OnCallShift } from "@/lib/workspace/types";

/**
 * Tests for on-call (the firefighter rotation read from Google Calendar's
 * iCal export) and the #firefighters feed: the ICS parser, recurrence and
 * time zones (including the US DST change on 1 Nov 2026), region and people
 * heuristics, now/next selection, the Slack directory match, caching with a
 * stale fallback, and the feed. Pure fakes only - no Google, Slack or Redis.
 *
 *   npx tsx scripts/test-oncall.ts
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

const iso = (ms: number): string => new Date(ms).toISOString();
const KEYWORDS: RegionKeywords = parseRegionKeywords("");
const DAY = 86_400_000;

/* ------------------------------------------------------------- fixtures */

/* What Google's "Secret address in iCal format" returns, trimmed to the parts that matter. CRLF line endings, 75-octet folds. */
const GOOGLE_ICS = [
  "BEGIN:VCALENDAR",
  "PRODID:-//Google Inc//Google Calendar 70.9054//EN",
  "VERSION:2.0",
  "CALSCALE:GREGORIAN",
  "METHOD:PUBLISH",
  "X-WR-CALNAME:TS Firefighters",
  "X-WR-TIMEZONE:America/New_York",
  "BEGIN:VTIMEZONE",
  "TZID:America/New_York",
  "X-LIC-LOCATION:America/New_York",
  "BEGIN:DAYLIGHT",
  "TZOFFSETFROM:-0500",
  "TZOFFSETTO:-0400",
  "TZNAME:EDT",
  "DTSTART:19700308T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU",
  "END:DAYLIGHT",
  "BEGIN:STANDARD",
  "TZOFFSETFROM:-0400",
  "TZOFFSETTO:-0500",
  "TZNAME:EST",
  "DTSTART:19701101T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU",
  "END:STANDARD",
  "END:VTIMEZONE",
  /* Asia/Europe: Tarang every other week, all day, one week skipped. */
  "BEGIN:VEVENT",
  "DTSTART;VALUE=DATE:20260928",
  "DTEND;VALUE=DATE:20261005",
  "RRULE:FREQ=WEEKLY;INTERVAL=2;WKST=MO",
  "EXDATE;VALUE=DATE:20261026",
  "DTSTAMP:20260901T120000Z",
  "UID:ff-ae-tarang@google.com",
  "CREATED:20260901T120000Z",
  "DESCRIPTION:Swap rules\\, see #firefighters\\; ask the TS lead.\\nSecond line",
  "LAST-MODIFIED:20260901T120000Z",
  "SEQUENCE:0",
  "STATUS:CONFIRMED",
  "SUMMARY:FF Asia/Europe - Tarang Somani",
  "TRANSP:TRANSPARENT",
  "END:VEVENT",
  /* Asia/Europe: Priya on the other weeks, three times only (COUNT). */
  "BEGIN:VEVENT",
  "DTSTART;VALUE=DATE:20261005",
  "DTEND;VALUE=DATE:20261012",
  "RRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=3",
  "UID:ff-ae-priya@google.com",
  "SUMMARY:FF Asia/Europe - priya nair",
  "END:VEVENT",
  /* US: Martin, Monday 09:00 New York to the next Monday 09:00, until mid-November, two weeks excluded (comma list + a second line). */
  "BEGIN:VEVENT",
  "DTSTART;TZID=America/New_York:20260921T090000",
  "DTEND;TZID=America/New_York:20260928T090000",
  "RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20261117T045959Z",
  "EXDATE;TZID=America/New_York:20261019T090000,20261109T090000",
  "EXDATE;TZID=America/New_York:20261116T090000",
  "UID:ff-us-rotation@google.com",
  "SUMMARY:Firefighter (FF) US: Martin Lee",
  "BEGIN:VALARM",
  "ACTION:EMAIL",
  "DESCRIPTION:This is an event reminder",
  "SUMMARY:Alarm notification",
  "TRIGGER:-P0DT0H30M0S",
  "END:VALARM",
  "END:VEVENT",
  /* US: the 12 October week swapped to Alex (RECURRENCE-ID override). */
  "BEGIN:VEVENT",
  "DTSTART;TZID=America/New_York:20261012T090000",
  "DTEND;TZID=America/New_York:20261019T090000",
  "RECURRENCE-ID;TZID=America/New_York:20261012T090000",
  "UID:ff-us-rotation@google.com",
  "SEQUENCE:1",
  "SUMMARY:Firefighter (FF) US: Alex Kim",
  "END:VEVENT",
  /* Cancelled - never shown. */
  "BEGIN:VEVENT",
  "DTSTART;VALUE=DATE:20261008",
  "DTEND;VALUE=DATE:20261009",
  "UID:cancelled-1@google.com",
  "SUMMARY:FF US - Ghost Person",
  "STATUS:CANCELLED",
  "END:VEVENT",
  /* No region in the title; people come from the guest list. The CN is folded mid-word. */
  "BEGIN:VEVENT",
  "DTSTART:20261010T000000Z",
  "DTEND:20261011T000000Z",
  "UID:attendee-1@google.com",
  "SUMMARY:Firefighter backup",
  "ORGANIZER;CN=TS Firefighters:mailto:c_abc123@group.calendar.google.com",
  "ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;CN=Kiran R",
  " ao;X-NUM-GUESTS=0:mailto:kiran.rao@certifyos.com",
  "ATTENDEE;CUTYPE=INDIVIDUAL;PARTSTAT=DECLINED;CN=Declined Dan:mailto:dan@certifyos.com",
  "ATTENDEE;CUTYPE=RESOURCE;PARTSTAT=ACCEPTED;CN=Room 4:mailto:c_room4@resource.calendar.google.com",
  'ATTENDEE;CUTYPE=INDIVIDUAL;PARTSTAT=ACCEPTED;CN="TS Firefighters":mailto:c_abc123@group.calendar.google.com',
  "ATTENDEE;CUTYPE=INDIVIDUAL;PARTSTAT=NEEDS-ACTION:mailto:sam.o-neil@certifyos.com",
  "END:VEVENT",
  /* Both regions in one weekend event. */
  "BEGIN:VEVENT",
  "DTSTART;VALUE=DATE:20261017",
  "DTEND;VALUE=DATE:20261019",
  "UID:weekend-both@google.com",
  "SUMMARY:Weekend FF: Asia/Europe - Ravi Kumar / US - Dana White",
  "END:VEVENT",
  "END:VCALENDAR",
  "",
].join("\r\n");

/* Wed 7 Oct 2026, 11:00 New York / 20:30 India. */
const AT = new Date("2026-10-07T15:00:00.000Z");

const DIRECTORY: SlackDirectoryUser[] = [
  { displayName: "martin", id: "U01MARTIN", realName: "Martin Lee" },
  { displayName: "tarang", id: "U01TARANG", realName: "Tarang Kumar Somani" },
  { displayName: "priya", email: "priya.nair@certifyos.com", id: "U01PRIYA", realName: "Priya N" },
  { displayName: "", id: "U01ALEX1", realName: "Alex Kim" },
  { displayName: "", id: "U01ALEX2", realName: "Alex Kim" },
  { displayName: "jose", id: "U01JOSE", realName: "José Ramírez" },
];

function calendar(): IcsCalendar {
  return parseIcs(GOOGLE_ICS);
}

function expandAround(at: Date, backDays = 1, aheadDays = 14): EventOccurrence[] {
  return expandCalendar(calendar(), { from: at.getTime() - backDays * DAY, to: at.getTime() + aheadDays * DAY }).occurrences;
}

/* ----------------------------------------------------------- ICS basics */

function testParsingBasics(): void {
  console.log("\n--- Test: ICS lines, properties, text and dates ---");
  assertEqual(unfoldLines("SUMMARY:Hello\r\n  World\r\nUID:1\n\tX\r\n\r\n"), ["SUMMARY:Hello World", "UID:1X"], "folds undone, blanks dropped");

  const attendee = parseProperty('ATTENDEE;CN="Lee, Martin: FF";PARTSTAT=ACCEPTED:mailto:martin@x.com');
  assertEqual(attendee, { name: "ATTENDEE", params: { CN: "Lee, Martin: FF", PARTSTAT: "ACCEPTED" }, value: "mailto:martin@x.com" }, "quoted param with : and ,");
  assertEqual(parseProperty("no colon here"), null, "a line with no value is skipped");
  assertEqual(parseProperty("ATTENDEE;CN=Rob ^'Bobby^' Lee:mailto:r@x.com")?.params.CN, 'Rob "Bobby" Lee', "RFC 6868 caret escapes");

  assertEqual(unescapeText("a\\, b\\; c\\nd\\Ne\\\\f"), "a, b; c\nd\ne\\f", "text escapes");
  assertEqual(parseIcsDateTime("20261005", { VALUE: "DATE" }), { dateOnly: true, naive: Date.UTC(2026, 9, 5), utc: false }, "date");
  assertEqual(parseIcsDateTime("20261005T090000Z"), { dateOnly: false, naive: Date.UTC(2026, 9, 5, 9), utc: true }, "UTC date-time");
  assertEqual(parseIcsDateTime("20261005T090000", { TZID: "America/New_York" })?.tzid, "America/New_York", "TZID kept");
  assertEqual(parseIcsDateTime("20260230"), null, "30 February rejected");
  assertEqual(parseIcsDateTime("tomorrow"), null, "garbage rejected");
  assertEqual(parseIcsDuration("P1W"), { days: 7, ms: 0 }, "weeks");
  assertEqual(parseIcsDuration("P1DT2H30M"), { days: 1, ms: 9_000_000 }, "days + time");
  assertEqual(parseIcsDuration("PT"), null, "empty duration rejected");

  const parsed = calendar();
  assertEqual(parsed.name, "TS Firefighters", "X-WR-CALNAME");
  assertEqual(parsed.timeZone, "America/New_York", "X-WR-TIMEZONE");
  assertEqual(parsed.events.length, 7, "seven VEVENTs (VTIMEZONE and VALARM are not events)");
  const us = parsed.events.find((event) => event.uid === "ff-us-rotation@google.com" && !event.recurrenceId);
  assertEqual(us?.summary, "Firefighter (FF) US: Martin Lee", "a VALARM's SUMMARY doesn't overwrite the event's");
  assertEqual(us?.exdates.length, 3, "EXDATE comma list plus a second EXDATE line");
  const tarang = parsed.events.find((event) => event.uid === "ff-ae-tarang@google.com");
  assertEqual(tarang?.description, "Swap rules, see #firefighters; ask the TS lead.\nSecond line", "DESCRIPTION unescaped");
  const guests = parsed.events.find((event) => event.uid === "attendee-1@google.com")?.attendees ?? [];
  assertEqual(guests[0], { cutype: "INDIVIDUAL", email: "kiran.rao@certifyos.com", name: "Kiran Rao", partstat: "ACCEPTED" }, "folded attendee CN rejoined");
  assertEqual(guests[3]?.name, "TS Firefighters", "quoted CN unquoted");

  /* A fold that splits "é" (C3 A9) must be undone before decoding. */
  const encoder = new TextEncoder();
  const bytes = new Uint8Array([...encoder.encode("SUMMARY:FF EMEA - Jos"), 0xc3, 0x0d, 0x0a, 0x20, 0xa9, 0x0d, 0x0a]);
  assertEqual(unfoldLines(decodeIcsBytes(bytes)), ["SUMMARY:FF EMEA - José"], "multi-byte character split by a fold survives");

  const broken = parseIcs("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x\r\nSUMMARY:no start\r\nEND:VEVENT\r\nEND:VCALENDAR");
  assertEqual(broken.events.length, 0, "an event without DTSTART is dropped");
  assert(broken.warnings.length === 1, "...with a warning");
  console.log("PASS");
}

function testTimeZones(): void {
  console.log("\n--- Test: wall clock to UTC with Intl (DST gap and overlap) ---");
  const ny = "America/New_York";
  assertEqual(iso(zonedToUtc(Date.UTC(2026, 9, 7, 9), ny)), "2026-10-07T13:00:00.000Z", "EDT is UTC-4");
  assertEqual(iso(zonedToUtc(Date.UTC(2026, 10, 2, 9), ny)), "2026-11-02T14:00:00.000Z", "EST is UTC-5 after 1 Nov 2026");
  assertEqual(iso(zonedToUtc(Date.UTC(2026, 10, 1, 1, 30), ny)), "2026-11-01T05:30:00.000Z", "ambiguous 01:30 is its first (EDT) occurrence");
  assertEqual(iso(zonedToUtc(Date.UTC(2026, 2, 8, 2, 30), ny)), "2026-03-08T07:30:00.000Z", "skipped 02:30 reads with the pre-jump offset (03:30 EDT)");
  assertEqual(iso(zonedToUtc(Date.UTC(2026, 9, 25, 1, 30), "Europe/London")), "2026-10-25T00:30:00.000Z", "London overlap: first (BST) occurrence");
  assertEqual(iso(zonedToUtc(Date.UTC(2026, 9, 7, 9), "Asia/Kolkata")), "2026-10-07T03:30:00.000Z", "IST is UTC+5:30");
  assertEqual(resolveTimeZone("/mozilla.org/20050126_1/America/New_York"), ny, "vendor-prefixed TZID");
  assertEqual(resolveTimeZone("Eastern Standard Time"), ny, "Windows zone name");
  assertEqual(resolveTimeZone("Etc/UTC"), "UTC", "UTC spellings");
  assertEqual(resolveTimeZone("Mars/Olympus_Mons"), null, "unknown zone");

  const floating = parseIcs(
    [
      "BEGIN:VCALENDAR",
      "X-WR-TIMEZONE:America/New_York",
      "BEGIN:VEVENT",
      "UID:floating",
      "DTSTART:20261007T090000",
      "DURATION:PT8H",
      "SUMMARY:US FF - Martin Lee",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:mars",
      "DTSTART;TZID=Mars/Olympus_Mons:20261008T090000",
      "DTEND;TZID=Mars/Olympus_Mons:20261008T170000",
      "SUMMARY:US FF - Martin Lee",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n"),
  );
  const result = expandCalendar(floating, { from: Date.UTC(2026, 9, 1), to: Date.UTC(2026, 9, 31) });
  assertEqual(
    result.occurrences.map((occurrence) => [occurrence.uid, iso(occurrence.start), iso(occurrence.end)]),
    [
      ["floating", "2026-10-07T13:00:00.000Z", "2026-10-07T21:00:00.000Z"],
      ["mars", "2026-10-08T13:00:00.000Z", "2026-10-08T21:00:00.000Z"],
    ],
    "floating time and an unknown TZID read in the calendar's zone; DURATION applied",
  );
  assert(result.warnings.some((warning) => warning.includes("Mars/Olympus_Mons")), "unknown zone reported");
  console.log("PASS");
}

/* ----------------------------------------------------------- recurrence */

function testGoogleCalendarExpansion(): void {
  console.log("\n--- Test: weekly series, EXDATE, COUNT, UNTIL, override, cancelled ---");
  const all = expandCalendar(calendar(), { from: Date.UTC(2026, 8, 1), to: Date.UTC(2026, 11, 31) });
  assertEqual(all.warnings, [], "no warnings for a well-formed Google export");
  const starts = (uid: string): string[] => all.occurrences.filter((occurrence) => occurrence.uid === uid).map((occurrence) => iso(occurrence.start));

  assertEqual(
    starts("ff-ae-tarang@google.com").slice(0, 5),
    ["2026-09-28T04:00:00.000Z", "2026-10-12T04:00:00.000Z", "2026-11-09T05:00:00.000Z", "2026-11-23T05:00:00.000Z", "2026-12-07T05:00:00.000Z"],
    "every other week, all-day midnight in New York (EDT then EST), 26 Oct excluded",
  );
  assertEqual(
    starts("ff-ae-priya@google.com"),
    ["2026-10-05T04:00:00.000Z", "2026-10-19T04:00:00.000Z", "2026-11-02T05:00:00.000Z"],
    "COUNT=3 stops after three",
  );
  const us = all.occurrences.filter((occurrence) => occurrence.uid === "ff-us-rotation@google.com");
  assertEqual(
    us.map((occurrence) => [iso(occurrence.start), occurrence.summary]),
    [
      ["2026-09-21T13:00:00.000Z", "Firefighter (FF) US: Martin Lee"],
      ["2026-09-28T13:00:00.000Z", "Firefighter (FF) US: Martin Lee"],
      ["2026-10-05T13:00:00.000Z", "Firefighter (FF) US: Martin Lee"],
      ["2026-10-12T13:00:00.000Z", "Firefighter (FF) US: Alex Kim"],
      ["2026-10-26T13:00:00.000Z", "Firefighter (FF) US: Martin Lee"],
      ["2026-11-02T14:00:00.000Z", "Firefighter (FF) US: Martin Lee"],
    ],
    "override swaps the person; EXDATEs (19 Oct, 9 and 16 Nov) removed; UNTIL stops before 23 Nov; 09:00 kept across DST",
  );
  const dstWeek = us.find((occurrence) => iso(occurrence.start) === "2026-10-26T13:00:00.000Z");
  assertEqual(dstWeek && iso(dstWeek.end), "2026-11-02T14:00:00.000Z", "the week spanning 1 Nov ends Monday 09:00 EST (a 7-day wall-clock length)");
  const priyaNov = all.occurrences.find((occurrence) => occurrence.uid === "ff-ae-priya@google.com" && iso(occurrence.start) === "2026-11-02T05:00:00.000Z");
  assertEqual(priyaNov && iso(priyaNov.end), "2026-11-09T05:00:00.000Z", "all-day week after DST: midnight EST to midnight EST");
  assert(!all.occurrences.some((occurrence) => occurrence.uid === "cancelled-1@google.com"), "STATUS:CANCELLED skipped");
  assertEqual(starts("weekend-both@google.com"), ["2026-10-17T04:00:00.000Z"], "single all-day event");

  const cancelledOverride = parseIcs(
    GOOGLE_ICS.replace(
      "SUMMARY:Firefighter (FF) US: Alex Kim",
      "SUMMARY:Firefighter (FF) US: Alex Kim\r\nSTATUS:CANCELLED",
    ),
  );
  const withoutWeek = expandCalendar(cancelledOverride, { from: Date.UTC(2026, 9, 10), to: Date.UTC(2026, 9, 20) }).occurrences;
  assertEqual(
    withoutWeek.filter((occurrence) => occurrence.uid === "ff-us-rotation@google.com").map((occurrence) => iso(occurrence.start)),
    ["2026-10-05T13:00:00.000Z"],
    "a cancelled override removes its occurrence (only the week before still overlaps)",
  );
  console.log("PASS");
}

function expandRule(rrule: string, dtstart: string, from: string, to: string, extra: string[] = [], maxSteps?: number): { starts: string[]; warnings: string[] } {
  const text = [
    "BEGIN:VCALENDAR",
    "X-WR-TIMEZONE:UTC",
    "BEGIN:VEVENT",
    "UID:rule",
    `DTSTART:${dtstart}`,
    `RRULE:${rrule}`,
    "SUMMARY:US FF - Martin Lee",
    ...extra,
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  const result = expandCalendar(parseIcs(text), { from: Date.parse(from), maxSteps, to: Date.parse(to) });
  return { starts: result.occurrences.map((occurrence) => iso(occurrence.start).slice(0, 10)), warnings: result.warnings };
}

function testRecurrenceRules(): void {
  console.log("\n--- Test: DAILY / MONTHLY / YEARLY rules, unsupported parts, the step cap ---");
  assertEqual(
    expandRule("FREQ=DAILY;INTERVAL=3;COUNT=4", "20261001T090000Z", "2026-09-01", "2026-12-01").starts,
    ["2026-10-01", "2026-10-04", "2026-10-07", "2026-10-10"],
    "daily, every third day, four times",
  );
  assertEqual(
    expandRule("FREQ=MONTHLY;BYDAY=1MO", "20260907T090000Z", "2026-09-01", "2027-01-01").starts,
    ["2026-09-07", "2026-10-05", "2026-11-02", "2026-12-07"],
    "monthly on the first Monday",
  );
  assertEqual(
    expandRule("FREQ=MONTHLY;BYDAY=-1FR", "20261030T090000Z", "2026-10-01", "2027-01-01").starts,
    ["2026-10-30", "2026-11-27", "2026-12-25"],
    "monthly on the last Friday",
  );
  assertEqual(
    expandRule("FREQ=MONTHLY", "20260131T090000Z", "2026-01-01", "2026-09-01").starts,
    ["2026-01-31", "2026-03-31", "2026-05-31", "2026-07-31", "2026-08-31"],
    "monthly on the 31st skips short months",
  );
  assertEqual(
    expandRule("FREQ=MONTHLY;BYMONTHDAY=1,-1", "20261001T090000Z", "2026-10-01", "2026-12-01").starts,
    ["2026-10-01", "2026-10-31", "2026-11-01", "2026-11-30"],
    "BYMONTHDAY with a negative day",
  );
  assertEqual(
    expandRule("FREQ=YEARLY", "20240101T090000Z", "2026-01-01", "2026-12-31").starts,
    ["2026-01-01"],
    "yearly",
  );
  assertEqual(
    expandRule("FREQ=WEEKLY;BYDAY=MO,TH;UNTIL=20261015", "20261005T090000Z", "2026-10-01", "2026-12-01").starts,
    ["2026-10-05", "2026-10-08", "2026-10-12", "2026-10-15"],
    "weekly on two days; a DATE UNTIL includes its day",
  );
  assertEqual(
    expandRule("FREQ=WEEKLY", "20200106T090000Z", "2026-10-01", "2026-10-20").starts,
    ["2026-10-05", "2026-10-12", "2026-10-19"],
    "a series from 2020 jumps straight to the window (no step cap hit)",
  );

  const hourly = expandRule("FREQ=HOURLY;COUNT=5", "20261005T090000Z", "2026-10-01", "2026-10-31");
  assertEqual(hourly.starts, ["2026-10-05"], "unsupported FREQ keeps only the first occurrence");
  assert(hourly.warnings.some((warning) => warning.includes("FREQ=HOURLY")), "...and says so");
  const setpos = expandRule("FREQ=MONTHLY;BYDAY=MO,TU;BYSETPOS=-1", "20261005T090000Z", "2026-10-01", "2026-12-31");
  assertEqual(setpos.starts, ["2026-10-05"], "BYSETPOS unsupported: first occurrence only");
  assertEqual(parseRecurrenceRule("FREQ=WEEKLY;BYDAY=2MO").rule, null, "an ordinal in a weekly BYDAY is rejected");

  const runaway = expandRule("FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30;COUNT=5", "20261005T090000Z", "2026-10-01", "2036-01-01", [], 200);
  assertEqual(runaway.starts, ["2026-10-05"], "a rule that never matches stops at the cap");
  assert(runaway.warnings.some((warning) => warning.includes("Stopped expanding")), "...with a warning");
  console.log("PASS");
}

/* ------------------------------------------------------------- people */

function testRegionsAndTitles(): void {
  console.log("\n--- Test: region detection and people from titles ---");
  const cases: Array<[string, string, string[]]> = [
    ["FF Asia/Europe - Tarang Somani", "Asia/Europe", ["Tarang Somani"]],
    ["Firefighter (FF) US: Martin Lee & Priya Nair", "US", ["Martin Lee", "Priya Nair"]],
    ["On-call EMEA — anna schmidt", "Asia/Europe", ["Anna Schmidt"]],
    ["APAC FF: Ravi + Kiran", "Asia/Europe", ["Ravi", "Kiran"]],
    ["US FF - Martin Lee (9am-5pm EST)", "US", ["Martin Lee"]],
    ["India on call: Kiran Rao, Sam Iyer and Dev Patel", "Asia/Europe", ["Kiran Rao", "Sam Iyer", "Dev Patel"]],
    ["AMER firefighting rotation - Dana White (Mon-Fri)", "US", ["Dana White"]],
    ["Bob and Alice on call", UNKNOWN_REGION, ["Bob", "Alice"]],
    ["Firefighting rotation", UNKNOWN_REGION, []],
    ["TARANG SOMANI - FF EU", "Asia/Europe", ["Tarang Somani"]],
    ["FF NA week of Oct 12 - @martin.lee", "US", ["Martin.lee"]],
    ["Jean-Luc Picard - FF Europe", "Asia/Europe", ["Jean-Luc Picard"]],
  ];
  for (const [title, region, people] of cases) {
    const analysis = analyzeTitle(title, KEYWORDS);
    assertEqual([analysis.parts[0]?.region, analysis.parts[0]?.people, analysis.split], [region, people, false], `"${title}"`);
  }

  assertEqual(
    analyzeTitle("FF Asia/Europe - Tarang / US - Martin", KEYWORDS),
    {
      parts: [
        { people: ["Tarang"], region: "Asia/Europe" },
        { people: ["Martin"], region: "US" },
      ],
      split: true,
    },
    "both regions, names after each",
  );
  assertEqual(
    analyzeTitle("Tarang Somani (Asia/Europe), Martin Lee (US)", KEYWORDS).parts,
    [
      { people: ["Tarang Somani"], region: "Asia/Europe" },
      { people: ["Martin Lee"], region: "US" },
    ],
    "both regions, names before each",
  );
  assertEqual(analyzeTitle("FF Asia/Europe & US", KEYWORDS), { parts: [{ people: [], region: "Asia/Europe" }], split: false }, "two regions, no names: the first");

  for (const word of ["Status sync", "Russia handover", "Eurasia", "bonus", "Thursday"]) {
    assertEqual(detectRegion(word, KEYWORDS), UNKNOWN_REGION, `"${word}" names no region (word boundaries)`);
  }
  assertEqual(detectRegion("ist shift", KEYWORDS), "Asia/Europe", "IST");
  assertEqual(detectRegion("PST coverage", KEYWORDS), "US", "PST");

  const custom = parseRegionKeywords('{"APAC":["apac","india"],"Americas":["us","amer"]}');
  assertEqual(detectRegion("India FF - Kiran", custom), "APAC", "ONCALL_REGION_KEYWORDS overrides the regions");
  assertEqual(regionOrder(custom), ["APAC", "Americas", UNKNOWN_REGION], "configured order, then On call");
  assertEqual(parseRegionKeywords("{not json"), KEYWORDS, "bad JSON keeps the defaults");
  assertEqual(parseRegionKeywords('{"X": []}'), KEYWORDS, "no usable entries keeps the defaults");
  assertEqual(Object.keys(DEFAULT_REGION_KEYWORDS), ["Asia/Europe", "US"], "default regions");
  assertEqual(peopleFromTitle("FF Asia/Europe 5 Oct - 12 Oct: Tarang", KEYWORDS), ["Tarang"], "dates and numbers are not people");
  console.log("PASS");
}

function testAttendees(): void {
  console.log("\n--- Test: people from the guest list ---");
  const event = calendar().events.find((candidate) => candidate.uid === "attendee-1@google.com");
  const people = attendeePeople(event?.attendees ?? [], event?.organizer);
  assertEqual(
    people.guests,
    [
      { email: "kiran.rao@certifyos.com", name: "Kiran Rao" },
      { email: "sam.o-neil@certifyos.com", name: "Sam O Neil" },
    ],
    "declined, resources and calendar addresses skipped; a guest without CN named from the email",
  );

  const occurrence = (summary: string, organizerEmail?: string): EventOccurrence => ({
    allDay: false,
    attendees: [{ email: "lead@certifyos.com", name: "Team Lead", partstat: "ACCEPTED" }],
    end: Date.UTC(2026, 9, 8),
    recurring: false,
    start: Date.UTC(2026, 9, 7),
    summary,
    uid: "u1",
    ...(organizerEmail ? { organizer: { email: organizerEmail } } : {}),
  });
  assertEqual(occurrenceToShifts(occurrence("FF US - Martin Lee", "lead@certifyos.com"), KEYWORDS)[0]?.people, [{ name: "Martin Lee" }], "the title beats a lone organizer-guest");
  assertEqual(
    occurrenceToShifts(occurrence("Firefighter", "lead@certifyos.com"), KEYWORDS)[0]?.people,
    [{ email: "lead@certifyos.com", name: "Team Lead" }],
    "...who is used when nothing else names anyone",
  );
  assertEqual(occurrenceToShifts(occurrence("FF US - Martin Lee"), KEYWORDS)[0]?.people, [{ email: "lead@certifyos.com", name: "Team Lead" }], "a real guest beats the title");
  console.log("PASS");
}

/* ------------------------------------------------------- shifts + select */

function shiftSummary(shift: OnCallShift): string {
  return `${shift.region}: ${shift.people.map((person) => person.name).join(" & ")} ${shift.start} -> ${shift.end}`;
}

function testShiftsAndSelection(): void {
  console.log("\n--- Test: shifts, merging, now / next / upcoming ---");
  const shifts = buildShifts(expandAround(AT), KEYWORDS);
  const selection = selectOnCall(shifts, AT, { regions: regionOrder(KEYWORDS) });

  assertEqual(
    selection.now.map(shiftSummary),
    [
      "Asia/Europe: Priya Nair 2026-10-05T04:00:00.000Z -> 2026-10-12T04:00:00.000Z",
      "US: Martin Lee 2026-10-05T13:00:00.000Z -> 2026-10-12T13:00:00.000Z",
    ],
    "now: one per region, in region order",
  );
  assertEqual(selection.now[0]?.id, "ff-ae-priya@google.com:2026-10-05T04:00:00.000Z", "id is uid:startIso");
  assertEqual(selection.now[0]?.allDay, true, "all-day flag");
  assertEqual(
    selection.next.map(shiftSummary),
    [
      "Asia/Europe: Tarang Somani 2026-10-12T04:00:00.000Z -> 2026-10-19T04:00:00.000Z",
      "US: Alex Kim 2026-10-12T13:00:00.000Z -> 2026-10-19T13:00:00.000Z",
      "On call: Kiran Rao & Sam O Neil 2026-10-10T00:00:00.000Z -> 2026-10-11T00:00:00.000Z",
    ],
    "next per region, the override's person included",
  );
  assertEqual(
    selection.upcoming.map(shiftSummary),
    [
      "Asia/Europe: Priya Nair 2026-10-05T04:00:00.000Z -> 2026-10-12T04:00:00.000Z",
      "US: Martin Lee 2026-10-05T13:00:00.000Z -> 2026-10-12T13:00:00.000Z",
      "On call: Kiran Rao & Sam O Neil 2026-10-10T00:00:00.000Z -> 2026-10-11T00:00:00.000Z",
      "Asia/Europe: Tarang Somani 2026-10-12T04:00:00.000Z -> 2026-10-19T04:00:00.000Z",
      "US: Alex Kim 2026-10-12T13:00:00.000Z -> 2026-10-19T13:00:00.000Z",
      "Asia/Europe: Ravi Kumar 2026-10-17T04:00:00.000Z -> 2026-10-19T04:00:00.000Z",
      "US: Dana White 2026-10-17T04:00:00.000Z -> 2026-10-19T04:00:00.000Z",
      "Asia/Europe: Priya Nair 2026-10-19T04:00:00.000Z -> 2026-10-26T04:00:00.000Z",
    ],
    "upcoming: 1 day back to 14 ahead, by start; the cancelled event and ended shifts left out; the two-region event split",
  );
  const split = selection.upcoming.filter((shift) => shift.title.startsWith("Weekend FF"));
  assertEqual(
    split.map((shift) => shift.id),
    ["weekend-both@google.com:2026-10-17T04:00:00.000Z:Asia/Europe", "weekend-both@google.com:2026-10-17T04:00:00.000Z:US"],
    "a split event's shifts get a region suffix",
  );

  /* 28 Oct: across the DST change; Asia/Europe has a gap (Tarang's 26 Oct week was excluded). */
  const dstAt = new Date("2026-10-28T12:00:00.000Z");
  const dst = selectOnCall(buildShifts(expandAround(dstAt), KEYWORDS), dstAt, { regions: regionOrder(KEYWORDS) });
  assertEqual(
    dst.now.map(shiftSummary),
    ["US: Martin Lee 2026-10-26T13:00:00.000Z -> 2026-11-09T14:00:00.000Z"],
    "Martin's two back-to-back weeks merge into one shift, ending Monday 9 Nov 09:00 EST",
  );
  assertEqual(dst.next.map(shiftSummary), ["Asia/Europe: Priya Nair 2026-11-02T05:00:00.000Z -> 2026-11-09T05:00:00.000Z"], "nobody now in Asia/Europe; Priya next");

  const day = (date: number, person: string): OnCallShift => ({
    allDay: true,
    end: iso(Date.UTC(2026, 9, date + 1, 4)),
    id: `d${date}`,
    people: [{ name: person }],
    region: "US",
    start: iso(Date.UTC(2026, 9, date, 4)),
    title: `FF US - ${person}`,
  });
  const merged = mergeContiguousShifts([day(5, "Martin"), day(6, "Martin"), day(7, "martin"), day(8, "Alex"), day(9, "Martin")]);
  assertEqual(
    merged.map((shift) => [shift.id, shift.end]),
    [
      ["d5", "2026-10-08T04:00:00.000Z"],
      ["d8", "2026-10-09T04:00:00.000Z"],
      ["d9", "2026-10-10T04:00:00.000Z"],
    ],
    "daily entries for one person merge (names compared case-insensitively); a handover breaks the run",
  );
  console.log("PASS");
}

/* --------------------------------------------------------- Slack users */

async function testSlackDirectory(): Promise<void> {
  console.log("\n--- Test: Slack directory match and users.list paging ---");
  assertEqual(
    toDirectoryUsers([
      { id: "U0ANN", profile: { display_name: "ann", email: "Ann@X.com", real_name: "Ann A" } },
      { deleted: true, id: "U0GONE", real_name: "Gone" },
      { id: "U0JIRA", is_bot: true, real_name: "Jira" },
      { id: "USLACKBOT", real_name: "Slackbot" },
      { id: "U0APP", is_app_user: true, real_name: "App" },
      { id: "bad-id", real_name: "Nope" },
    ]),
    [{ displayName: "ann", email: "ann@x.com", id: "U0ANN", realName: "Ann A" }],
    "people only; email lower-cased",
  );

  assertEqual(matchSlackUserId({ email: "priya.nair@certifyos.com", name: "Someone Else" }, DIRECTORY), "U01PRIYA", "exact email first");
  assertEqual(matchSlackUserId({ name: "martin lee" }, DIRECTORY), "U01MARTIN", "unique full name (case-insensitive)");
  assertEqual(matchSlackUserId({ name: "Tarang Somani" }, DIRECTORY), "U01TARANG", "unique first + last (middle name in Slack)");
  assertEqual(matchSlackUserId({ name: "Jose Ramirez" }, DIRECTORY), "U01JOSE", "accents ignored");
  assertEqual(matchSlackUserId({ name: "Alex Kim" }, DIRECTORY), undefined, "two Alex Kims: ambiguous, no link");
  assertEqual(matchSlackUserId({ name: "Martin" }, DIRECTORY), "U01MARTIN", "a lone first name matches when only one person could be meant");
  assertEqual(
    matchSlackUserId({ name: "Martin" }, [...DIRECTORY, { displayName: "mruiz", id: "U01RUIZ", realName: "Martin Ruiz" }]),
    undefined,
    "...and not when another Martin exists",
  );
  assertEqual(matchSlackUserId({ name: "Alex" }, DIRECTORY), undefined, "a first name with no exact display/real name match: none");
  assertEqual(matchSlackUserId({ name: "Priya Nair" }, DIRECTORY), undefined, "no email and no name match: none");
  assertEqual(
    resolveSlackUserIdsIn([{ name: "Martin Lee" }, { name: "Nobody" }, { name: "x", slackUserId: "U9" }], DIRECTORY),
    [{ name: "Martin Lee", slackUserId: "U01MARTIN" }, { name: "Nobody" }, { name: "x", slackUserId: "U9" }],
    "resolution keeps unmatched people and existing ids",
  );

  let cached: { ttl: number; value: CachedDirectory } | null = null;
  const reads: Array<Record<string, string>> = [];
  const pages: Array<SlackReadResult<UsersListPage>> = [
    { data: { members: [{ id: "U0ANN", real_name: "Ann A" }], ok: true, response_metadata: { next_cursor: "c2" } }, ok: true, rateLimited: false },
    { data: { members: [{ id: "U0BOB", real_name: "Bob B" }], ok: true, response_metadata: { next_cursor: "" } }, ok: true, rateLimited: false },
  ];
  const deps = {
    cacheGet: () => Promise.resolve(cached?.value ?? null),
    cacheSet: (value: CachedDirectory, ttl: number) => {
      cached = { ttl, value };
      return Promise.resolve();
    },
    read: (params: Record<string, string>) => {
      reads.push(params);
      return Promise.resolve(pages[reads.length - 1] ?? { data: null, error: "x", ok: false, rateLimited: false });
    },
  };
  const users = await loadSlackDirectoryWith(deps);
  assertEqual(users.map((user) => user.id), ["U0ANN", "U0BOB"], "two pages walked");
  assertEqual(reads.map((params) => ({ cursor: params.cursor, limit: params.limit })), [{ cursor: undefined, limit: "200" }, { cursor: "c2", limit: "200" }], "limit 200, cursor passed on");
  assertEqual([(cached as { ttl: number } | null)?.ttl, (cached as { value: CachedDirectory } | null)?.value.complete], [86_400, true], "complete walk cached a day");
  await loadSlackDirectoryWith(deps);
  assertEqual(reads.length, 2, "second load served from the cache");

  cached = null;
  const failing = { ...deps, read: () => Promise.resolve<SlackReadResult<UsersListPage>>({ data: null, error: "missing_scope", ok: false, rateLimited: false }) };
  assertEqual(await loadSlackDirectoryWith(failing), [], "a failed walk returns nothing");
  assertEqual((cached as { ttl: number } | null)?.ttl, 900, "...and is cached only briefly");
  console.log("PASS");
}

/* ------------------------------------------------------------- schedule */

const SECRET_URL = "https://calendar.google.com/calendar/ical/c_abc123%40group.calendar.google.com/private-s3cr3tt0ken/basic.ics";

function memoryStore(): OnCallStore & { raw: Map<string, unknown>; ttls: Map<string, number> } {
  const raw = new Map<string, unknown>();
  const ttls = new Map<string, number>();
  return {
    get: <T>(key: string) => Promise.resolve(raw.has(key) ? (structuredClone(raw.get(key)) as T) : null),
    raw,
    set: (key, value, ttlSeconds) => {
      raw.set(key, structuredClone(value));
      ttls.set(key, ttlSeconds);
      return Promise.resolve();
    },
    ttls,
  };
}

function scheduleDeps(store: OnCallStore, responses: Array<string | { error: string }>, calls: string[]): OnCallDeps {
  return {
    fetchIcs: (url) => {
      calls.push(url);
      const next = responses.shift() ?? { error: "no more responses" };
      return Promise.resolve(typeof next === "string" ? { bytes: new TextEncoder().encode(next), ok: true as const } : { error: next.error, ok: false as const });
    },
    regionKeywords: KEYWORDS,
    resolvePeople: (people) => Promise.resolve(resolveSlackUserIdsIn(people, DIRECTORY)),
    store,
    url: SECRET_URL,
  };
}

function keyEnding(store: { raw: Map<string, unknown> }, suffix: string): string {
  const key = [...store.raw.keys()].find((candidate) => candidate.endsWith(suffix));
  if (!key) {
    throw new Error(`no cache key ending in ${suffix}`);
  }
  return key;
}

async function testSchedule(): Promise<void> {
  console.log("\n--- Test: getOnCall - configured, cached, stale fallback, refresh ---");
  const unconfigured = await getOnCallWith({ ...scheduleDeps(memoryStore(), [], []), url: "  " }, AT);
  assertEqual(
    unconfigured,
    { at: AT.toISOString(), configured: false, fetchedAt: null, next: [], now: [], upcoming: [] },
    "no ONCALL_CALENDAR_ICAL_URL: configured=false, nothing fetched",
  );
  const insecureCalls: string[] = [];
  const insecure = await getOnCallWith({ ...scheduleDeps(memoryStore(), [GOOGLE_ICS], insecureCalls), url: "http://calendar.example.com/x.ics" }, AT);
  assert(insecure.configured && Boolean(insecure.error?.includes("https://")) && insecureCalls.length === 0, "an http:// address is refused without fetching");

  const store = memoryStore();
  const calls: string[] = [];
  const responses: Array<string | { error: string }> = [GOOGLE_ICS, { error: "The calendar answered HTTP 500." }, GOOGLE_ICS];
  const deps = scheduleDeps(store, responses, calls);

  const first = await getOnCallWith(deps, AT);
  assertEqual(calls.length, 1, "first read downloads");
  assertEqual(first.configured, true, "configured");
  assertEqual(first.fetchedAt, AT.toISOString(), "fetchedAt");
  assertEqual(first.calendarName, "TS Firefighters", "calendar name");
  assertEqual(first.timeZone, "America/New_York", "calendar zone");
  assertEqual(first.error, undefined, "no error");
  assertEqual(
    first.now.map((shift) => shift.people),
    [[{ name: "Priya Nair" }], [{ name: "Martin Lee", slackUserId: "U01MARTIN" }]],
    "now, with Slack ids where the directory matched",
  );
  assertEqual(first.next[0]?.people, [{ name: "Tarang Somani", slackUserId: "U01TARANG" }], "next resolved too");
  assertEqual(first.upcoming.length, 8, "upcoming");
  assertEqual(store.ttls.get(keyEnding(store, ":fresh")), 600, "fresh copy for 10 minutes");
  assertEqual(store.ttls.get(keyEnding(store, ":last_good")), 7 * 86_400, "last-good copy for 7 days");
  assert(![...store.raw.keys()].some((key) => key.includes("s3cr3t") || key.includes("calendar.google.com")), "cache keys never hold the address");
  const cachedCalendar = store.raw.get(keyEnding(store, ":fresh")) as { events: unknown[] };
  assert(cachedCalendar.events.length < 7, "the cached copy is trimmed to the weeks that matter");

  const later = new Date(AT.getTime() + 5 * 60_000);
  await getOnCallWith(deps, later);
  assertEqual(calls.length, 1, "within 10 minutes: served from the cache");

  store.raw.delete(keyEnding(store, ":fresh"));
  const stale = await getOnCallWith(deps, later);
  assertEqual(calls.length, 2, "fresh copy expired: downloads again");
  assertEqual(stale.error, "The calendar answered HTTP 500.", "the failure is reported");
  assertEqual(stale.fetchedAt, AT.toISOString(), "...while the last good copy is served");
  assertEqual(stale.now.length, 2, "...and still says who is on call");
  assertEqual(store.ttls.get(keyEnding(store, ":failure")), 120, "failure remembered for 2 minutes");

  const backedOff = await getOnCallWith(deps, later);
  assertEqual(calls.length, 2, "a recent failure isn't retried by every poll");
  assertEqual(backedOff.error, "The calendar answered HTTP 500.", "...but still reported");

  const refreshed = await getOnCallWith(deps, later, { refresh: true });
  assertEqual(calls.length, 3, "Refresh downloads now");
  assertEqual([refreshed.error, refreshed.fetchedAt], [undefined, later.toISOString()], "...and clears the error");
  await getOnCallWith(deps, later, { refresh: true });
  assertEqual(calls.length, 3, "a second Refresh within 30 seconds uses the copy");

  const htmlStore = memoryStore();
  const html = await getOnCallWith(scheduleDeps(htmlStore, ["<html>Sign in</html>"], []), AT);
  assert(Boolean(html.error?.includes("didn't return an iCal calendar")) && html.now.length === 0, "a non-calendar page is an error, not an empty rota");
  assert(!JSON.stringify([first, stale, html]).includes("s3cr3t"), "the secret address never appears in a response");

  const pruned = pruneCalendar(calendar(), AT.getTime() - 3 * DAY, AT.getTime() + 30 * DAY);
  assertEqual(
    pruned.events.map((event) => event.uid).sort(),
    ["attendee-1@google.com", "ff-ae-priya@google.com", "ff-ae-tarang@google.com", "ff-us-rotation@google.com", "ff-us-rotation@google.com", "weekend-both@google.com"],
    "pruning keeps whole series (master + override) and drops the cancelled event",
  );
  console.log("PASS");
}

async function testFetchIcs(): Promise<void> {
  console.log("\n--- Test: calendar download - https only, status, 2 MB cap, timeout ---");
  let called = 0;
  const fake = (response: Response | Error): typeof fetch =>
    (() => {
      called += 1;
      return response instanceof Error ? Promise.reject(response) : Promise.resolve(response);
    });

  const ok = await fetchIcs(SECRET_URL, fake(new Response("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n")));
  assert(ok.ok && new TextDecoder().decode(ok.bytes).startsWith("BEGIN:VCALENDAR"), "a calendar comes back as bytes");

  const missing = await fetchIcs(SECRET_URL, fake(new Response("nope", { status: 404 })));
  assert(!missing.ok && missing.error.includes("HTTP 404") && !missing.error.includes("s3cr3t"), "404 explained, address not echoed");

  const declaredHuge = await fetchIcs(SECRET_URL, fake(new Response("x", { headers: { "content-length": String(MAX_ICS_BYTES + 1) } })));
  assert(!declaredHuge.ok && declaredHuge.error.includes("2 MB"), "a declared size over 2 MB is refused");

  const big = new Uint8Array(MAX_ICS_BYTES + 10);
  const streamed = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(big.subarray(0, MAX_ICS_BYTES / 2));
      controller.enqueue(big.subarray(MAX_ICS_BYTES / 2));
      controller.close();
    },
  });
  const streamedHuge = await fetchIcs(SECRET_URL, fake(new Response(streamed)));
  assert(!streamedHuge.ok && streamedHuge.error.includes("2 MB"), "an undeclared stream over 2 MB is cut off");

  const timeout = new Error("The operation was aborted due to timeout");
  timeout.name = "TimeoutError";
  const timedOut = await fetchIcs(SECRET_URL, fake(timeout));
  assert(!timedOut.ok && timedOut.error.includes("10 seconds"), "timeout explained");

  const before = called;
  const plain = await fetchIcs("http://calendar.google.com/x.ics", fake(new Response("")));
  assert(!plain.ok && called === before, "http:// is refused before any request");
  console.log("PASS");
}

/* --------------------------------------------------------- #firefighters */

const CHANNEL = "C06LMNLJY82";

const HISTORY: SlackHistoryMessage[] = [
  {
    latest_reply: "1791380000.000100",
    reply_count: 3,
    text: "<@U01MARTIN> can you look at <https://certifyos.atlassian.net/browse/TS-116432|Provider stuck in review> - blocking CP-9876",
    ts: "1791370000.000100",
    type: "message",
    user: "U01ALICE",
  },
  {
    attachments: [{ fallback: "E2E failed", pretext: "E2E suite failed", text: "3 failures in credentialing" }],
    bot_id: "B01E2E",
    bot_profile: { name: "E2E Monitor" },
    subtype: "bot_message",
    text: "",
    ts: "1791380000.000200",
    type: "message",
  },
  { text: "a reply in a thread", thread_ts: "1791370000.000100", ts: "1791375000.000300", type: "message", user: "U01MARTIN" },
  { subtype: "channel_join", text: "<@U09> has joined the channel", ts: "1791360000.000400", type: "message", user: "U09" },
  { subtype: "thread_broadcast", text: "also sent to channel", thread_ts: "1791370000.000100", ts: "1791376000.000500", type: "message", user: "U01MARTIN" },
  { text: "x".repeat(900), ts: "1791350000.000600", type: "message", user: "U01UNKNOWN" },
];

function testFeedMessages(): void {
  console.log("\n--- Test: #firefighters messages - top level, names, keys, bots ---");
  const previous = process.env.FIREFIGHTER_SLACK_CHANNEL;
  delete process.env.FIREFIGHTER_SLACK_CHANNEL;
  assertEqual(firefighterChannelId(), DEFAULT_FIREFIGHTER_CHANNEL, "default channel");
  process.env.FIREFIGHTER_SLACK_CHANNEL = " C0123ABCDE ";
  assertEqual(firefighterChannelId(), "C0123ABCDE", "FIREFIGHTER_SLACK_CHANNEL override");
  process.env.FIREFIGHTER_SLACK_CHANNEL = "#firefighters";
  assertEqual(firefighterChannelId(), DEFAULT_FIREFIGHTER_CHANNEL, "a channel name (not an id) is ignored");
  if (previous === undefined) {
    delete process.env.FIREFIGHTER_SLACK_CHANNEL;
  } else {
    process.env.FIREFIGHTER_SLACK_CHANNEL = previous;
  }

  const names = new Map([
    ["U01ALICE", "Alice Adams"],
    ["U01MARTIN", "Martin Lee"],
  ]);
  const out = toFirefighterMessages(HISTORY, names, (ts) => `https://certifyos.slack.com/archives/${CHANNEL}/p${ts.replace(".", "")}`);
  assertEqual(out.map((message) => message.ts), ["1791380000.000200", "1791370000.000100", "1791350000.000600"], "top-level only (no replies, broadcasts or joins), newest first");
  assertEqual(
    out[1],
    {
      at: "2026-10-07T10:46:40.000Z",
      authorName: "Alice Adams",
      isBot: false,
      replyCount: 3,
      text: "@Martin Lee can you look at Provider stuck in review - blocking CP-9876",
      ticketKeys: ["TS-116432", "CP-9876"],
      ts: "1791370000.000100",
      lastReplyAt: "2026-10-07T13:33:20.000Z",
      permalink: `https://certifyos.slack.com/archives/${CHANNEL}/p1791370000000100`,
    },
    "a person's message: mention named, link label kept, keys from the URL, replies counted",
  );
  assertEqual([out[0]?.isBot, out[0]?.authorName, out[0]?.text], [true, "E2E Monitor", "E2E suite failed - 3 failures in credentialing"], "bot flagged, named, text from attachments");
  assertEqual([out[2]?.authorName, out[2]?.text.length], ["Someone", 600], "unknown author; text clipped to 600");
  console.log("PASS");
}

function memoryFeedStore(): FeedStore & { raw: Map<string, unknown>; ttls: Map<string, number> } {
  const raw = new Map<string, unknown>();
  const ttls = new Map<string, number>();
  return {
    get: <T>(key: string) => Promise.resolve(raw.has(key) ? (structuredClone(raw.get(key)) as T) : null),
    raw,
    set: (key, value, ttlSeconds) => {
      raw.set(key, structuredClone(value));
      ttls.set(key, ttlSeconds);
      return Promise.resolve();
    },
    ttls,
  };
}

async function testFeed(): Promise<void> {
  console.log("\n--- Test: getFirefighterFeed - cache, budget, errors, throttling ---");
  const store = memoryFeedStore();
  const log = { history: 0, marks: 0, permalinks: 0 };
  let next: SlackReadResult<HistoryPage> = { data: { messages: HISTORY, ok: true }, ok: true, rateLimited: false };
  const deps: FirefighterFeedDeps = {
    channel: CHANNEL,
    channelName: () => Promise.resolve("firefighters"),
    history: () => {
      log.history += 1;
      return Promise.resolve(next);
    },
    markHistoryRead: () => {
      log.marks += 1;
      return Promise.resolve();
    },
    now: () => new Date("2026-10-08T01:00:00.000Z"),
    permalink: (channel, ts) => {
      log.permalinks += 1;
      return Promise.resolve(`https://certifyos.slack.com/archives/${channel}/p${ts.replace(".", "")}`);
    },
    store,
    userName: (id) => Promise.resolve(id === "U01ALICE" ? "Alice Adams" : id === "U01MARTIN" ? "Martin Lee" : null),
  };

  const first = await getFirefighterFeedWith(deps);
  assertEqual([first.channel, first.channelName, first.messages.length, first.error], [CHANNEL, "firefighters", 3, undefined], "feed read");
  assertEqual([log.history, log.marks, log.permalinks], [1, 1, 1], "one history read, the drip told, one permalink call to learn the origin");
  assert(first.messages.every((message) => message.permalink?.startsWith("https://certifyos.slack.com/archives/")), "every message linked");
  assertEqual(store.ttls.get(`firefighters:feed:${CHANNEL}`), 60, "cached a minute");
  assertEqual(store.ttls.get(`firefighters:feed_last:${CHANNEL}`), 86_400, "last good copy kept a day");

  await getFirefighterFeedWith(deps);
  assertEqual(log.history, 1, "second read within a minute served from the cache");

  store.raw.delete(`firefighters:feed:${CHANNEL}`);
  next = { data: null, error: "ratelimited", ok: false, rateLimited: true, retryAfterSeconds: 45 };
  const throttled = await getFirefighterFeedWith(deps);
  assertEqual([throttled.rateLimited, throttled.messages.length, throttled.fetchedAt], [true, 3, "2026-10-08T01:00:00.000Z"], "throttled: the last good copy, flagged");
  assertEqual(store.ttls.get(`firefighters:feed:${CHANNEL}`), 45, "...until Slack's retry-after");

  store.raw.delete(`firefighters:feed:${CHANNEL}`);
  await getFirefighterFeedWith(deps);
  assertEqual(log.permalinks, 1, "the workspace origin is remembered");

  const bare = memoryFeedStore();
  const notIn = await getFirefighterFeedWith({
    ...deps,
    channelName: () => Promise.resolve(undefined),
    history: () => Promise.resolve({ data: { error: "not_in_channel", ok: false }, error: "not_in_channel", ok: false, rateLimited: false }),
    store: bare,
  });
  assertEqual([notIn.error, notIn.messages, notIn.channelName], ["not_in_channel", [], "firefighters"], "not_in_channel passed through; channel name falls back");

  const throttledCold = await getFirefighterFeedWith({
    ...deps,
    history: () => Promise.resolve({ data: null, error: "ratelimited", ok: false, rateLimited: true }),
    store: memoryFeedStore(),
  });
  assertEqual([throttledCold.error, throttledCold.rateLimited, throttledCold.messages.length], ["ratelimited", true, 0], "throttled with no copy yet");
  console.log("PASS");
}

/* ------------------------------------------------------------------- UI */

function testDisplayHelpers(): void {
  console.log("\n--- Test: pill summary, ET/IST times, links ---");
  const shifts = buildShifts(expandAround(AT), KEYWORDS);
  const selection = selectOnCall(shifts, AT, { regions: regionOrder(KEYWORDS) });
  assertEqual(pillSummary(selection.now), "Priya · Martin", "first names per region");
  assertEqual(regionRows(selection).map((row) => [row.region, row.now.length, row.next.length]), [["Asia/Europe", 1, 1], ["US", 1, 1], ["On call", 0, 1]], "rows per region");
  assertEqual(formatEtIst("2026-10-12T13:00:00.000Z"), "Mon, Oct 12, 9:00 AM ET · 6:30 PM IST", "same day in both zones");
  assertEqual(formatEtIst("2026-10-12T04:00:00.000Z"), "Mon, Oct 12, 12:00 AM ET · 9:30 AM IST", "midnight ET");
  assertEqual(formatEtIst("2026-10-12T02:00:00.000Z"), "Sun, Oct 11, 10:00 PM ET · Mon, Oct 12, 7:30 AM IST", "IST day shown when it differs");
  assertEqual(slackDmUrl("U01MARTIN"), "https://slack.com/app_redirect?channel=U01MARTIN&team=T022CKLG5M2", "DM link");
  assertEqual(slackDmUrl("javascript:alert(1)"), null, "only real user ids become links");
  assertEqual([ticketHref("TS-116432"), ticketHref("CP-9876"), ticketHref("XX-1")], ["/tracker?ticket=TS-116432", "/tracker?q=CP-9876", null], "ticket chips");
  console.log("PASS");
}

async function main(): Promise<void> {
  testParsingBasics();
  testTimeZones();
  testGoogleCalendarExpansion();
  testRecurrenceRules();
  testRegionsAndTitles();
  testAttendees();
  testShiftsAndSelection();
  await testSlackDirectory();
  await testSchedule();
  await testFetchIcs();
  testFeedMessages();
  await testFeed();
  testDisplayHelpers();
}

main()
  .then(() => {
    console.log("\nAll on-call tests passed.");
    process.exit(0);
  })
  .catch((error: unknown) => {
    console.error("\nOn-call test failed:", error);
    process.exit(1);
  });
