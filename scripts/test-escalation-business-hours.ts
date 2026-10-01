import { businessHoursBetween, businessMsBetween, isWithinBusinessHours } from "@/lib/escalation/businessHours";
import { CERTIFY_SUPPORT_CALENDAR } from "@/lib/escalation/policy";
import type { BusinessCalendar } from "@/lib/escalation/types";

/* Every instant below is spelled out with its own offset (-04:00 EDT until
   2026-11-01, -05:00 EST until 2027-03-14) so nothing depends on the machine's
   zone or the real clock. */

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const CAL = CERTIFY_SUPPORT_CALENDAR;

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

function assertThrows(fn: () => unknown, label: string): void {
  try {
    fn();
  } catch (error) {
    assert(error instanceof RangeError, `${label} should throw a RangeError, got ${String(error)}`);
    return;
  }
  throw new Error(`Assertion failed: ${label} should have thrown`);
}

function at(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`bad fixture instant ${iso}`);
  return ms;
}

function bh(startIso: string, endIso: string, calendar: BusinessCalendar = CAL): number {
  return businessHoursBetween(at(startIso), at(endIso), calendar);
}

function within(iso: string, calendar: BusinessCalendar = CAL): boolean {
  return isWithinBusinessHours(at(iso), calendar);
}

/* Calendar 30's weekday hours, holiday-free, in another zone. */
function weekdayCalendarIn(timezone: string): BusinessCalendar {
  return { ...CAL, holidays: [], id: `test-${timezone}`, timezone };
}

/* One window every Sunday, for probing the 01:00-03:00 hours DST actually moves. */
function sundayWindowCalendar(startHour: number, endHour: number): BusinessCalendar {
  return {
    holidays: [],
    id: "test-sunday",
    name: "Sunday window",
    timezone: "America/New_York",
    workingTimes: [{ endMs: endHour * HOUR_MS, startMs: startHour * HOUR_MS, weekday: 0 }],
  };
}

const ALL_DAY_EVERY_DAY: BusinessCalendar = {
  holidays: [],
  id: "test-24x7",
  name: "24x7",
  timezone: "America/New_York",
  workingTimes: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ endMs: DAY_MS, startMs: 0, weekday })),
};

/* ---------------------------------------------------------------- reference */

/* Independent oracle for the randomized checks: no offset arithmetic at all,
   just Intl's own reading of each instant's local weekday/date/time. */
const referenceFormatters = new Map<string, Intl.DateTimeFormat>();
const WEEKDAY_INDEX: Record<string, number> = { Fri: 5, Mon: 1, Sat: 6, Sun: 0, Thu: 4, Tue: 2, Wed: 3 };

function referenceIsWorking(ms: number, calendar: BusinessCalendar): boolean {
  let formatter = referenceFormatters.get(calendar.timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
      minute: "2-digit",
      month: "2-digit",
      second: "2-digit",
      timeZone: calendar.timezone,
      weekday: "short",
      year: "numeric",
    });
    referenceFormatters.set(calendar.timezone, formatter);
  }
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    formatter.formatToParts(ms).find((p) => p.type === type)?.value ?? "";
  const isoDate = `${part("year")}-${part("month")}-${part("day")}`;
  const weekday = WEEKDAY_INDEX[part("weekday")];
  const msIntoDay = ((Number(part("hour")) * 60 + Number(part("minute"))) * 60 + Number(part("second"))) * 1000;

  const holiday = calendar.holidays.some((h) =>
    h.recurring ? h.isoDate.slice(5) === isoDate.slice(5) : h.isoDate === isoDate,
  );
  return (
    !holiday &&
    calendar.workingTimes.some((w) => w.weekday === weekday && w.startMs <= msIntoDay && msIntoDay < w.endMs)
  );
}

/* Exact whenever windows and span edges sit on 15-minute boundaries (true for calendar 30 and New York offsets). */
const REFERENCE_STEP_MS = 15 * 60_000;

function referenceBusinessMs(startMs: number, endMs: number, calendar: BusinessCalendar): number {
  let total = 0;
  for (let t = startMs; t < endMs; t += REFERENCE_STEP_MS) {
    if (referenceIsWorking(t, calendar)) total += REFERENCE_STEP_MS;
  }
  return total;
}

/* mulberry32 - a fixed seed keeps the "random" spans identical on every run. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/* ------------------------------------------------------------------- tests */

function testFullWeekdayIsNineHours(): void {
  console.log("\n--- Test: a full weekday on calendar 30 is 9 business hours ---");

  assertEqual(bh("2026-10-06T00:00:00-04:00", "2026-10-07T00:00:00-04:00"), 9, "Tue midnight to midnight");
  assertEqual(bh("2026-10-06T09:00:00-04:00", "2026-10-06T18:00:00-04:00"), 9, "Tue 09:00 to 18:00");
  assertEqual(bh("2026-10-05T00:00:00-04:00", "2026-10-10T00:00:00-04:00"), 45, "Mon-Fri is 5 x 9h");

  console.log("PASS: midnight-to-midnight and open-to-close both count exactly 9h; a clean week is 45h.");
}

function testFridayEveningToMondayMorning(): void {
  console.log("\n--- Test: Fri 17:00 ET -> Mon 10:00 ET skips the weekend ---");

  assertEqual(bh("2026-10-02T17:00:00-04:00", "2026-10-05T10:00:00-04:00"), 2, "Fri 17:00 -> Mon 10:00");

  console.log("PASS: last hour Friday + first hour Monday = 2h.");
}

function testWeekendOnlySpanIsZero(): void {
  console.log("\n--- Test: a span that only covers the weekend counts nothing ---");

  assertEqual(bh("2026-10-03T00:00:00-04:00", "2026-10-05T00:00:00-04:00"), 0, "Sat 00:00 -> Mon 00:00");
  assertEqual(bh("2026-10-02T18:00:00-04:00", "2026-10-05T09:00:00-04:00"), 0, "Fri close -> Mon open");

  console.log("PASS: Saturday and Sunday contribute 0h, including close-to-open.");
}

function testIndigenousPeoplesDayIsZero(): void {
  console.log("\n--- Test: 2026-10-12 (Indigenous Peoples Day, Monday) is a holiday ---");

  assertEqual(bh("2026-10-12T00:00:00-04:00", "2026-10-13T00:00:00-04:00"), 0, "holiday Monday");
  assertEqual(bh("2026-10-09T17:00:00-04:00", "2026-10-13T10:00:00-04:00"), 2, "Fri 17:00 -> Tue 10:00 over the long weekend");
  assertEqual(bh("2026-10-12T18:30:00-04:00", "2026-10-13T10:00:00-04:00"), 1, "holiday evening -> Tue 10:00");

  console.log("PASS: the holiday Monday counts 0h and the long weekend bridges Fri -> Tue.");
}

function testRecurringHolidayAppliesNextYear(): void {
  console.log("\n--- Test: recurring holidays repeat by month/day; one-off holidays don't ---");

  assertEqual(bh("2027-10-12T00:00:00-04:00", "2027-10-13T00:00:00-04:00"), 0, "2027-10-12 (Tue) is still a holiday");
  assertEqual(bh("2027-10-13T00:00:00-04:00", "2027-10-14T00:00:00-04:00"), 9, "2027-10-13 (Wed) is a normal day");

  const oneOff: BusinessCalendar = {
    ...CAL,
    holidays: [{ isoDate: "2026-10-14", name: "Office move", recurring: false }],
  };
  assertEqual(bh("2026-10-14T00:00:00-04:00", "2026-10-15T00:00:00-04:00", oneOff), 0, "one-off holiday in its year");
  assertEqual(bh("2027-10-14T00:00:00-04:00", "2027-10-15T00:00:00-04:00", oneOff), 9, "one-off holiday not in 2027");

  console.log("PASS: recurring=true repeats every year (Jira semantics); recurring=false is that date only.");
}

function testThanksgivingBothDaysAreZero(): void {
  console.log("\n--- Test: Thanksgiving (11-26) and the day after (11-27) both count 0 ---");

  assertEqual(bh("2026-11-26T00:00:00-05:00", "2026-11-27T00:00:00-05:00"), 0, "Thanksgiving Day");
  assertEqual(bh("2026-11-27T00:00:00-05:00", "2026-11-28T00:00:00-05:00"), 0, "Day After Thanksgiving");
  assertEqual(bh("2026-11-25T00:00:00-05:00", "2026-11-30T00:00:00-05:00"), 9, "Wed -> Mon only counts Wednesday");

  console.log("PASS: Thu + Fri of Thanksgiving week are both holidays; only Wednesday counts.");
}

function testSpanAcrossFallBackDst(): void {
  console.log("\n--- Test: a span across the 2026-11-01 DST end keeps 09:00-18:00 local ---");

  const start = "2026-10-30T12:00:00-04:00";
  const end = "2026-11-02T12:00:00-05:00";
  assertEqual(at(end) - at(start), 73 * HOUR_MS, "fixture sanity: the wall-clock span is 3 days + the extra hour");
  assertEqual(bh(start, end), 9, "Fri 12:00 EDT -> Mon 12:00 EST = 6h + 3h");

  /* Monday's window moved an hour later in UTC: 14:00Z-23:00Z instead of 13:00Z-22:00Z. */
  assertEqual(within("2026-10-30T13:30:00Z"), true, "Fri 09:30 EDT is open");
  assertEqual(within("2026-11-02T13:30:00Z"), false, "Mon 08:30 EST is not open yet");
  assertEqual(within("2026-11-02T22:30:00Z"), true, "Mon 17:30 EST is still open");
  assertEqual(bh("2026-11-02T13:00:00Z", "2026-11-02T23:00:00Z"), 9, "Mon EST window is 14:00Z-23:00Z");

  console.log("PASS: 6h Friday + 3h Monday = 9h, and the post-DST window is shifted in UTC, not in local time.");
}

function testSpanAcrossSpringForwardDst(): void {
  console.log("\n--- Test: a span across the 2027-03-14 DST start keeps 09:00-18:00 local ---");

  assertEqual(bh("2027-03-12T12:00:00-05:00", "2027-03-15T12:00:00-04:00"), 9, "Fri 12:00 EST -> Mon 12:00 EDT");
  assertEqual(within("2027-03-15T13:30:00Z"), true, "Mon 09:30 EDT is open");
  assertEqual(within("2027-03-12T13:30:00Z"), false, "Fri 08:30 EST is not open yet");

  console.log("PASS: 6h + 3h = 9h on the spring side too.");
}

function testDstDayLengthsAndAmbiguousWallTimes(): void {
  console.log("\n--- Test: DST days are 25h / 23h long, and moved wall times resolve predictably ---");

  assertEqual(bh("2026-11-01T00:00:00-04:00", "2026-11-02T00:00:00-05:00", ALL_DAY_EVERY_DAY), 25, "fall-back day is 25h");
  assertEqual(bh("2027-03-14T00:00:00-05:00", "2027-03-15T00:00:00-04:00", ALL_DAY_EVERY_DAY), 23, "spring-forward day is 23h");
  assertEqual(bh("2026-10-26T00:00:00-04:00", "2026-11-02T00:00:00-05:00", ALL_DAY_EVERY_DAY), 169, "week with fall-back is 169h");

  const oneToFour = sundayWindowCalendar(1, 4);
  assertEqual(bh("2026-10-25T00:00:00-04:00", "2026-10-26T00:00:00-04:00", oneToFour), 3, "ordinary Sunday 01-04 is 3h");
  assertEqual(bh("2026-11-01T00:00:00-04:00", "2026-11-02T00:00:00-05:00", oneToFour), 4, "01-04 with a repeated hour is 4h");
  assertEqual(bh("2027-03-14T00:00:00-05:00", "2027-03-15T00:00:00-04:00", oneToFour), 2, "01-04 with a skipped hour is 2h");

  /* A skipped start (02:30 does not exist) is pushed forward to 03:30 EDT. */
  const halfPastTwoToFour = sundayWindowCalendar(2.5, 4);
  assertEqual(bh("2027-03-14T00:00:00-05:00", "2027-03-15T00:00:00-04:00", halfPastTwoToFour), 0.5, "skipped start");
  assertEqual(bh("2026-11-01T00:00:00-04:00", "2026-11-02T00:00:00-05:00", halfPastTwoToFour), 1.5, "02:30 EST happens once");

  /* A repeated start (01:30 happens twice) opens at its first occurrence, and
     the window then stays open through the repeat. */
  const halfPastOneToThree = sundayWindowCalendar(1.5, 3);
  assertEqual(bh("2026-11-01T00:00:00-04:00", "2026-11-02T00:00:00-05:00", halfPastOneToThree), 2.5, "repeated start");
  assertEqual(within("2026-11-01T05:15:00Z", halfPastOneToThree), false, "01:15 EDT is before the window");
  assertEqual(within("2026-11-01T06:15:00Z", halfPastOneToThree), true, "01:15 EST is inside the window that opened at 01:30 EDT");

  console.log("PASS: day lengths follow DST; skipped wall times move forward, repeated ones use the first occurrence.");
}

function testStartBeforeOpeningCountsFromOpening(): void {
  console.log("\n--- Test: spans that start before 09:00 or end after 18:00 are clipped to the window ---");

  assertEqual(bh("2026-10-06T07:00:00-04:00", "2026-10-06T11:00:00-04:00"), 2, "07:00 -> 11:00");
  assertEqual(bh("2026-10-06T06:00:00-04:00", "2026-10-06T08:59:00-04:00"), 0, "entirely before opening");
  assertEqual(bh("2026-10-06T17:00:00-04:00", "2026-10-06T23:00:00-04:00"), 1, "17:00 -> 23:00");
  assertEqual(bh("2026-10-06T07:00:00-04:00", "2026-10-06T08:30:00-04:00"), 0, "07:00 -> 08:30");
  assertEqual(bh("2026-10-06T16:45:00-04:00", "2026-10-07T09:15:00-04:00"), 1.5, "fractional hours across close");

  console.log("PASS: time outside 09:00-18:00 never counts, and partial hours come back fractional.");
}

function testBoundariesAndEmptySpans(): void {
  console.log("\n--- Test: empty/reversed spans and spans that touch a boundary exactly ---");

  const nine = at("2026-10-06T09:00:00-04:00");
  const six = at("2026-10-06T18:00:00-04:00");
  assertEqual(businessMsBetween(nine, nine, CAL), 0, "end == start");
  assertEqual(businessMsBetween(six, nine, CAL), 0, "end < start");
  assertEqual(businessMsBetween(nine - HOUR_MS, nine, CAL), 0, "[08:00, 09:00) ends exactly at opening");
  assertEqual(businessMsBetween(six, six + HOUR_MS, CAL), 0, "[18:00, 19:00) starts exactly at close");
  assertEqual(businessMsBetween(six - HOUR_MS, six, CAL), HOUR_MS, "[17:00, 18:00) is a full hour");
  assertEqual(businessMsBetween(nine, nine + 1, CAL), 1, "first millisecond of the day counts");
  assertEqual(businessMsBetween(six - 1, six, CAL), 1, "last millisecond of the day counts");

  const closed: BusinessCalendar = { ...CAL, workingTimes: [] };
  assertEqual(businessMsBetween(nine, nine + 30 * DAY_MS, closed), 0, "a calendar with no working times");

  console.log("PASS: [start, end) is half-open at both window edges, and reversed spans are 0.");
}

function testIsWithinBusinessHours(): void {
  console.log("\n--- Test: isWithinBusinessHours at the edges, on a Saturday and on a holiday ---");

  assertEqual(within("2026-10-06T08:59:59-04:00"), false, "Tue 08:59:59");
  assertEqual(within("2026-10-06T09:00:00-04:00"), true, "Tue 09:00:00");
  assertEqual(within("2026-10-06T17:59:59-04:00"), true, "Tue 17:59:59");
  assertEqual(within("2026-10-06T17:59:59.999-04:00"), true, "Tue 17:59:59.999");
  assertEqual(within("2026-10-06T18:00:00-04:00"), false, "Tue 18:00:00");

  assertEqual(within("2026-10-03T12:00:00-04:00"), false, "Saturday noon");
  assertEqual(within("2026-10-04T12:00:00-04:00"), false, "Sunday noon");
  assertEqual(within("2026-10-12T12:00:00-04:00"), false, "Indigenous Peoples Day noon");
  assertEqual(within("2026-11-26T12:00:00-05:00"), false, "Thanksgiving noon");

  assertEqual(within("2026-11-03T08:59:59-05:00"), false, "Tue after DST 08:59:59 EST");
  assertEqual(within("2026-11-03T09:00:00-05:00"), true, "Tue after DST 09:00:00 EST");

  console.log("PASS: 09:00 is in, 18:00 is out; weekends and holidays are always out.");
}

function testThirtyBusinessDays(): void {
  console.log("\n--- Test: a 30-business-day span (Low L3) across a holiday, Veterans Day and DST ---");

  /* Oct 5 -> Nov 17 has 32 weekdays minus Oct 12 and Nov 11 = 30 business days. */
  assertEqual(bh("2026-10-05T09:00:00-04:00", "2026-11-17T18:00:00-05:00"), 270, "Mon Oct 5 open -> Tue Nov 17 close");
  assertEqual(bh("2026-10-05T09:00:00-04:00", "2026-11-18T09:00:00-05:00"), 270, "...same as -> Wed Nov 18 open");
  assertEqual(
    businessMsBetween(at("2026-10-05T09:00:00-04:00"), at("2026-11-18T09:00:01-05:00"), CAL),
    270 * HOUR_MS + 1000,
    "...one second past Wed open",
  );

  console.log("PASS: 30 business days = 270h, and close-to-next-open adds nothing.");
}

function testFullYear2027(): void {
  console.log("\n--- Test: all of 2027 = 261 weekdays minus 9 recurring holidays on weekdays ---");

  /* Jun 19, Jul 3, Nov 27 and Dec 25 fall on Saturdays in 2027 and are not shifted (Jira doesn't observe). */
  assertEqual(bh("2027-01-01T00:00:00-05:00", "2028-01-01T00:00:00-05:00"), 252 * 9, "2027 business hours");

  console.log("PASS: 252 business days x 9h = 2268h.");
}

function testUtcInstantsOnADifferentLocalDate(): void {
  console.log("\n--- Test: instants are bucketed by LOCAL date, not by their UTC date ---");

  /* 2026-10-14T02:00Z is Tue Oct 13 22:00 ET - after hours, not Wednesday. */
  assertEqual(within("2026-10-14T02:00:00Z"), false, "UTC Wed 02:00 is Tue 22:00 ET");
  assertEqual(bh("2026-10-14T02:00:00Z", "2026-10-14T15:00:00Z"), 2, "Tue 22:00 ET -> Wed 11:00 ET");
  assertEqual(bh("2026-10-10T00:00:00Z", "2026-10-11T00:00:00Z"), 0, "UTC Saturday = Fri 20:00 -> Sat 20:00 ET");
  assertEqual(bh("2026-10-05T00:00:00Z", "2026-10-06T00:00:00Z"), 9, "UTC Monday = Sun 20:00 -> Mon 20:00 ET");

  /* East of UTC the local business day starts on the previous UTC date. */
  const auckland = weekdayCalendarIn("Pacific/Auckland");
  assertEqual(within("2026-10-04T21:00:00Z", auckland), true, "UTC Sunday 21:00 is Mon 10:00 NZDT");
  assertEqual(within("2026-10-09T21:00:00Z", auckland), false, "UTC Friday 21:00 is Sat 10:00 NZDT");
  assertEqual(bh("2026-10-04T00:00:00Z", "2026-10-05T00:00:00Z", auckland), 4, "UTC Sunday holds Mon 09:00-13:00 NZDT");

  console.log("PASS: local dates decide weekday/holiday on both sides of UTC.");
}

function testMultipleWindowsPerDay(): void {
  console.log("\n--- Test: several windows per day (split shift), overlapping windows merge ---");

  const splitShift: BusinessCalendar = {
    ...CAL,
    workingTimes: [1, 2, 3, 4, 5].flatMap((weekday) => [
      { endMs: 12 * HOUR_MS, startMs: 9 * HOUR_MS, weekday },
      { endMs: 18 * HOUR_MS, startMs: 13 * HOUR_MS, weekday },
    ]),
  };
  assertEqual(bh("2026-10-06T00:00:00-04:00", "2026-10-07T00:00:00-04:00", splitShift), 8, "9-12 + 13-18");
  assertEqual(bh("2026-10-06T11:00:00-04:00", "2026-10-06T14:00:00-04:00", splitShift), 2, "11:00 -> 14:00 skips lunch");
  assertEqual(within("2026-10-06T12:30:00-04:00", splitShift), false, "lunch hour is closed");
  assertEqual(within("2026-10-06T13:00:00-04:00", splitShift), true, "13:00 reopens");

  const overlapping: BusinessCalendar = {
    ...CAL,
    workingTimes: [
      { endMs: 14 * HOUR_MS, startMs: 11 * HOUR_MS, weekday: 2 },
      { endMs: 12 * HOUR_MS, startMs: 9 * HOUR_MS, weekday: 2 },
    ],
  };
  assertEqual(bh("2026-10-06T00:00:00-04:00", "2026-10-07T00:00:00-04:00", overlapping), 5, "9-12 and 11-14 merge to 9-14");

  console.log("PASS: each window is intersected separately and overlaps are never double counted.");
}

/* Calendar 30 plus one extra working-time row, so a single bad row among good ones must still be caught. */
function withExtraWorkingTime(row: { endMs: number; startMs: number; weekday: number }): BusinessCalendar {
  return { ...CAL, workingTimes: [...CAL.workingTimes, row] };
}

function testRejectsBadInput(): void {
  console.log("\n--- Test: non-finite instants and malformed calendars fail loudly ---");

  const nine = at("2026-10-06T09:00:00-04:00");
  /* The reviewer's span: Sun 2026-10-04 -> Mon 2026-10-12 read 0h on a weekday-7 calendar. */
  const weekStart = at("2026-10-04T00:00:00-04:00");
  const weekEnd = at("2026-10-12T00:00:00-04:00");
  const rejects = (calendar: BusinessCalendar, label: string): void => {
    assertThrows(() => businessMsBetween(weekStart, weekEnd, calendar), `${label} (span)`);
    assertThrows(() => isWithinBusinessHours(nine, calendar), `${label} (isWithinBusinessHours)`);
    /* Validated before the end <= start shortcut, so even a zero-length first read fails. */
    assertThrows(() => businessMsBetween(nine, nine, calendar), `${label} (empty span)`);
  };

  assertThrows(() => businessMsBetween(Number.NaN, nine, CAL), "NaN start");
  assertThrows(() => businessMsBetween(nine, Number.POSITIVE_INFINITY, CAL), "infinite end");
  assertThrows(() => isWithinBusinessHours(Number.NaN, CAL), "NaN instant");

  /* Timezone: unknown, empty, or missing (Intl would silently use the machine's zone for undefined). */
  rejects({ ...CAL, timezone: "America/Nowhere" }, "unknown zone");
  rejects({ ...CAL, timezone: "" }, "empty zone");
  rejects({ ...CAL, timezone: undefined as unknown as string }, "missing zone");

  /* Weekday must be an integer 0 (Sunday) ... 6 (Saturday). */
  const nineToSix = { endMs: 18 * HOUR_MS, startMs: 9 * HOUR_MS };
  rejects(withExtraWorkingTime({ ...nineToSix, weekday: 7 }), "weekday 7 (1..7 numbering)");
  rejects(withExtraWorkingTime({ ...nineToSix, weekday: -1 }), "weekday -1");
  rejects(withExtraWorkingTime({ ...nineToSix, weekday: 1.5 }), "non-integer weekday");
  rejects(withExtraWorkingTime({ ...nineToSix, weekday: Number.NaN }), "NaN weekday");
  rejects({ ...CAL, workingTimes: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ ...nineToSix, weekday })) }, "whole week numbered 1..7");

  /* Window must be finite, inside one local day, and non-empty. */
  rejects(withExtraWorkingTime({ endMs: 18 * HOUR_MS, startMs: Number.NaN, weekday: 1 }), "NaN startMs");
  rejects(withExtraWorkingTime({ endMs: Number.POSITIVE_INFINITY, startMs: 9 * HOUR_MS, weekday: 1 }), "infinite endMs");
  rejects(withExtraWorkingTime({ endMs: 2 * HOUR_MS, startMs: -HOUR_MS, weekday: 1 }), "startMs before local midnight");
  rejects(withExtraWorkingTime({ endMs: 25 * HOUR_MS, startMs: 22 * HOUR_MS, weekday: 1 }), "endMs past local midnight");
  rejects(withExtraWorkingTime({ endMs: 2 * HOUR_MS, startMs: 22 * HOUR_MS, weekday: 1 }), "overnight window (start > end)");
  rejects(withExtraWorkingTime({ endMs: 9 * HOUR_MS, startMs: 9 * HOUR_MS, weekday: 1 }), "zero-length window");

  /* Wrong unit: 09:00-18:00 as seconds, as minutes, and as hours all fall off whole-minute ms. */
  const inUnit = (perHour: number): BusinessCalendar => ({
    ...CAL,
    workingTimes: [1, 2, 3, 4, 5].map((weekday) => ({ endMs: 18 * perHour, startMs: 9 * perHour, weekday })),
  });
  rejects(inUnit(3600), "times in seconds");
  rejects(inUnit(60), "times in minutes");
  rejects(inUnit(1), "times in hours");
  rejects(withExtraWorkingTime({ endMs: 18 * HOUR_MS, startMs: 9 * HOUR_MS + 30_000, weekday: 1 }), "sub-minute edge");

  /* Holiday dates: right shape is not enough, the date has to exist. */
  const withHoliday = (isoDate: string, recurring = true): BusinessCalendar => ({
    ...CAL,
    holidays: [...CAL.holidays, { isoDate, recurring }],
  });
  rejects(withHoliday("2026-1-1"), "holiday not zero-padded");
  rejects(withHoliday("2026-13-45"), "holiday month 13 day 45");
  rejects(withHoliday("2026-00-10"), "holiday month 00");
  rejects(withHoliday("2026-10-00"), "holiday day 00");
  rejects(withHoliday("2026-02-30", false), "holiday Feb 30");
  rejects(withHoliday("2027-02-29"), "holiday Feb 29 in a non-leap year");
  rejects(withHoliday("2026-10-12T00:00:00Z"), "holiday with a time part");
  rejects(withHoliday(undefined as unknown as string), "missing holiday date");

  console.log("PASS: a missing timestamp or any misread calendar field throws instead of reading as 0 (or shifted) hours.");
}

function testAcceptsEveryLegitimateCalendarEdge(): void {
  console.log("\n--- Test: validation still accepts real edge cases (00:00-24:00, leap-day holiday, no hours) ---");

  /* startMs 0 and endMs DAY_MS (local 24:00) are the inclusive limits of a window. */
  assertEqual(bh("2026-10-05T00:00:00-04:00", "2026-10-12T00:00:00-04:00", ALL_DAY_EVERY_DAY), 168, "24x7 week");

  /* A recurring Feb 29 read from a leap year is a real date; it just only matches in leap years. */
  const leapDay: BusinessCalendar = {
    ...CAL,
    holidays: [{ isoDate: "2028-02-29", name: "Leap day", recurring: true }],
  };
  assertEqual(bh("2028-02-29T00:00:00-05:00", "2028-03-01T00:00:00-05:00", leapDay), 0, "Tue 2028-02-29 is a holiday");
  assertEqual(bh("2027-02-26T00:00:00-05:00", "2027-03-02T00:00:00-05:00", leapDay), 18, "2027 has no Feb 29 to skip");

  /* Dec 31 / Jan 1 boundaries and a real minute-granular split shift both pass. */
  const edgy: BusinessCalendar = {
    ...CAL,
    holidays: [{ isoDate: "2026-12-31", recurring: false }],
    workingTimes: [{ endMs: 12 * HOUR_MS + 30 * 60_000, startMs: 8 * HOUR_MS + 45 * 60_000, weekday: 4 }],
  };
  assertEqual(bh("2026-12-31T00:00:00-05:00", "2027-01-01T00:00:00-05:00", edgy), 0, "Thu 2026-12-31 one-off holiday");
  assertEqual(bh("2027-01-07T00:00:00-05:00", "2027-01-08T00:00:00-05:00", edgy), 3.75, "Thu 08:45-12:30");

  /* A calendar with no working times is odd but well-formed: it counts 0, it does not throw. */
  assertEqual(bh("2026-10-05T00:00:00-04:00", "2026-10-12T00:00:00-04:00", { ...CAL, workingTimes: [] }), 0, "no hours");

  console.log("PASS: the full-day window, leap-day holidays, minute-granular windows and an empty calendar are all accepted.");
}

function testMatchesBruteForceReference(): void {
  console.log("\n--- Test: random spans match a 15-minute brute-force walk, and spans split additively ---");

  const random = seededRandom(20261002);
  const rangeStart = at("2026-10-01T00:00:00Z");
  const rangeEnd = at("2027-12-31T00:00:00Z");
  const align = (ms: number): number => Math.floor(ms / REFERENCE_STEP_MS) * REFERENCE_STEP_MS;

  /* Random spans anywhere in the range, plus spans pinned around both DST changes and Thanksgiving. */
  const anchors = [at("2026-10-29T00:00:00Z"), at("2027-03-11T00:00:00Z"), at("2026-11-24T00:00:00Z")];
  const spans: Array<[number, number]> = [];
  for (let i = 0; i < 60; i += 1) {
    const base = i < 45 ? rangeStart + random() * (rangeEnd - rangeStart) : (anchors[i % anchors.length] ?? rangeStart);
    const start = align(base + (i < 45 ? 0 : random() * 2 * DAY_MS));
    spans.push([start, align(start + random() * 8 * DAY_MS)]);
  }

  for (const [start, end] of spans) {
    const label = `${new Date(start).toISOString()} -> ${new Date(end).toISOString()}`;
    const actual = businessMsBetween(start, end, CAL);
    assertEqual(actual, referenceBusinessMs(start, end, CAL), `reference ${label}`);

    const split = start + Math.floor(random() * (end - start + 1));
    assertEqual(
      businessMsBetween(start, split, CAL) + businessMsBetween(split, end, CAL),
      actual,
      `additivity at ${new Date(split).toISOString()} for ${label}`,
    );
  }

  for (let i = 0; i < 400; i += 1) {
    const instant = Math.floor(rangeStart + random() * (rangeEnd - rangeStart));
    assertEqual(
      isWithinBusinessHours(instant, CAL),
      referenceIsWorking(instant, CAL),
      `isWithinBusinessHours at ${new Date(instant).toISOString()}`,
    );
  }

  console.log(`PASS: ${spans.length} spans and 400 instants agree with the brute-force reference.`);
}

function testLongSpanStaysCheap(): void {
  console.log("\n--- Test: a two-year span is computed per day, not per minute ---");

  const started = performance.now();
  const hours = bh("2026-10-01T00:00:00-04:00", "2028-10-01T00:00:00-04:00");
  const elapsedMs = performance.now() - started;
  assertEqual(
    hours,
    bh("2026-10-01T00:00:00-04:00", "2027-10-01T00:00:00-04:00") + bh("2027-10-01T00:00:00-04:00", "2028-10-01T00:00:00-04:00"),
    "two-year span equals the sum of its two years",
  );

  console.log(`PASS: two years = ${hours}h, computed in ${elapsedMs.toFixed(1)}ms.`);
}

function main(): void {
  try {
    testFullWeekdayIsNineHours();
    testFridayEveningToMondayMorning();
    testWeekendOnlySpanIsZero();
    testIndigenousPeoplesDayIsZero();
    testRecurringHolidayAppliesNextYear();
    testThanksgivingBothDaysAreZero();
    testSpanAcrossFallBackDst();
    testSpanAcrossSpringForwardDst();
    testDstDayLengthsAndAmbiguousWallTimes();
    testStartBeforeOpeningCountsFromOpening();
    testBoundariesAndEmptySpans();
    testIsWithinBusinessHours();
    testThirtyBusinessDays();
    testFullYear2027();
    testUtcInstantsOnADifferentLocalDate();
    testMultipleWindowsPerDay();
    testRejectsBadInput();
    testAcceptsEveryLegitimateCalendarEdge();
    testMatchesBruteForceReference();
    testLongSpanStaysCheap();
    console.log("\nAll escalation business-hours tests passed.");
    process.exit(0);
  } catch (error) {
    console.error("\nEscalation business-hours test failed:", error);
    process.exit(1);
  }
}

main();
