import type { FirefighterFeedResponse, OnCallPerson, OnCallResponse, OnCallShift } from "@/lib/workspace/types";

/**
 * Display helpers shared by the on-call pill and the on-call page. Pure and
 * client-safe. The team works across New York and India, so shift times are
 * always shown in both ET and IST rather than in the viewer's own zone.
 */

export const ET_ZONE = "America/New_York";
export const IST_ZONE = "Asia/Kolkata";
/* The CertifyOS Slack workspace - app_redirect opens the DM / channel in the Slack app or web. */
const SLACK_TEAM_ID = "T022CKLG5M2";
const SLACK_USER_ID = /^[UW][A-Z0-9]{2,}$/;
const SLACK_CHANNEL_ID = /^[CG][A-Z0-9]{6,}$/;
const TICKET_KEY = /^(?:TS|CP)-\d{1,7}$/;

/** Shape check for a /api/oncall body before it reaches the UI. */
export function isOnCallResponse(value: unknown): value is OnCallResponse {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<OnCallResponse>;
  return typeof candidate.configured === "boolean" && Array.isArray(candidate.now) && Array.isArray(candidate.next) && Array.isArray(candidate.upcoming);
}

/** Shape check for a /api/firefighters body. */
export function isFirefighterFeedResponse(value: unknown): value is FirefighterFeedResponse {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<FirefighterFeedResponse>;
  return typeof candidate.channel === "string" && Array.isArray(candidate.messages);
}

/** A Slack link that opens a direct message with the person; null for anything that isn't a user id. */
export function slackDmUrl(userId: string | undefined): string | null {
  return userId && SLACK_USER_ID.test(userId) ? `https://slack.com/app_redirect?channel=${userId}&team=${SLACK_TEAM_ID}` : null;
}

/** A Slack link that opens a channel; null for anything that isn't a channel id. */
export function slackChannelUrl(channelId: string): string | null {
  return SLACK_CHANNEL_ID.test(channelId) ? `https://slack.com/app_redirect?channel=${channelId}&team=${SLACK_TEAM_ID}` : null;
}

/** Only links that really go to Slack are rendered from feed data (it is untrusted). */
export function isSlackPermalink(url: string | undefined): url is string {
  return Boolean(url && /^https:\/\/[a-z0-9-]+(?:\.enterprise)?\.slack\.com\//.test(url));
}

/** Where a ticket chip goes: TS tickets open in the tracker; a CP key searches the tracker for the tickets linked to it. */
export function ticketHref(key: string): string | null {
  if (!TICKET_KEY.test(key)) {
    return null;
  }
  return key.startsWith("TS-") ? `/tracker?ticket=${encodeURIComponent(key)}` : `/tracker?q=${encodeURIComponent(key)}`;
}

export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

/** "Tarang & Priya" for one shift. */
export function shiftFirstNames(shift: OnCallShift): string {
  return [...new Set(shift.people.map((person) => firstName(person.name)))].join(" & ");
}

/** The pill's summary: first names per region now on call, "Tarang · Martin". Empty when nobody is listed. */
export function pillSummary(now: readonly OnCallShift[]): string {
  const parts: string[] = [];
  for (const shift of now) {
    const names = shiftFirstNames(shift);
    if (names && !parts.includes(names)) {
      parts.push(names);
    }
  }
  return parts.join(" · ");
}

/** "Tarang Somani (Asia/Europe), Martin Lee (US)" - for an accessible label. */
export function spokenSummary(now: readonly OnCallShift[]): string {
  return now
    .map((shift) => `${shift.people.map((person) => person.name).join(" and ") || "nobody listed"} (${shift.region})`)
    .join(", ");
}

export interface RegionRow {
  next: OnCallShift[];
  now: OnCallShift[];
  region: string;
}

/** Now + next grouped by region, in the order the server sent them (configured region order). */
export function regionRows(data: Pick<OnCallResponse, "next" | "now">): RegionRow[] {
  const rows: RegionRow[] = [];
  const rowFor = (region: string): RegionRow => {
    let row = rows.find((candidate) => candidate.region === region);
    if (!row) {
      row = { next: [], now: [], region };
      rows.push(row);
    }
    return row;
  };
  data.now.forEach((shift) => rowFor(shift.region).now.push(shift));
  data.next.forEach((shift) => rowFor(shift.region).next.push(shift));
  return rows;
}

function zonedParts(iso: string, timeZone: string): { day: string; time: string } | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  try {
    return {
      day: date.toLocaleDateString("en-US", { day: "numeric", month: "short", timeZone, weekday: "short" }),
      /* Newer ICU puts a narrow no-break space before AM/PM; a plain space renders the same everywhere. */
      time: date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone }).replace(/\u202f/g, " "),
    };
  } catch {
    return null;
  }
}

/** "Mon, Oct 5, 9:00 AM ET · 6:30 PM IST" - the IST day repeated only when it differs. */
export function formatEtIst(iso: string): string {
  const et = zonedParts(iso, ET_ZONE);
  const ist = zonedParts(iso, IST_ZONE);
  if (!et || !ist) {
    return iso;
  }
  const istText = ist.day === et.day ? `${ist.time} IST` : `${ist.day}, ${ist.time} IST`;
  return `${et.day}, ${et.time} ET · ${istText}`;
}

/** "Mon, Oct 5" in a zone (falls back to the viewer's zone). */
export function formatDay(iso: string, timeZone?: string): string {
  const date = new Date(iso);
  try {
    return date.toLocaleDateString("en-US", { day: "numeric", month: "short", timeZone, weekday: "short" });
  } catch {
    return date.toLocaleDateString("en-US", { day: "numeric", month: "short", weekday: "short" });
  }
}

/** A sortable calendar-day key ("2026-10-05") in a zone. */
export function dayKey(iso: string, timeZone?: string): string {
  const date = new Date(iso);
  try {
    return date.toLocaleDateString("en-CA", { day: "2-digit", month: "2-digit", timeZone, year: "numeric" });
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

/** Shifts grouped by the calendar day they start on, in the calendar's zone. */
export function groupByDay(shifts: readonly OnCallShift[], timeZone?: string): Array<{ key: string; label: string; shifts: OnCallShift[] }> {
  const groups: Array<{ key: string; label: string; shifts: OnCallShift[] }> = [];
  for (const shift of shifts) {
    const key = dayKey(shift.start, timeZone);
    const group = groups.find((candidate) => candidate.key === key);
    if (group) {
      group.shifts.push(shift);
    } else {
      groups.push({ key, label: formatDay(shift.start, timeZone), shifts: [shift] });
    }
  }
  return groups.sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * A shift's span for the agenda. All-day shifts read as calendar days in the
 * calendar's zone ("Mon, Oct 5 → Sun, Oct 11"); timed ones in ET and IST.
 */
export function shiftRange(shift: OnCallShift, timeZone?: string): { from: string; until: string } {
  if (shift.allDay) {
    /* The end is the midnight after the last day. */
    const lastDay = new Date(Date.parse(shift.end) - 1).toISOString();
    return { from: formatDay(shift.start, timeZone), until: `${formatDay(lastDay, timeZone)} (all day)` };
  }
  return { from: formatEtIst(shift.start), until: formatEtIst(shift.end) };
}

/** "5m ago", "3h ago", "2d ago" - or a date once it's over a week. */
export function relativeTime(iso: string, nowMs: number): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) {
    return "";
  }
  const seconds = Math.max(0, Math.round((nowMs - at) / 1000));
  if (seconds < 60) {
    return "just now";
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.round(hours / 24);
  return days < 7 ? `${days}d ago` : new Date(at).toLocaleDateString("en-US", { day: "numeric", month: "short" });
}

/** "in 3h", "in 2d" - how soon a shift starts or ends. */
export function untilText(iso: string, nowMs: number): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) {
    return "";
  }
  const minutes = Math.round((at - nowMs) / 60_000);
  if (minutes <= 0) {
    return "now";
  }
  if (minutes < 60) {
    return `in ${minutes}m`;
  }
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `in ${hours}h` : `in ${Math.round(hours / 24)}d`;
}

export function personKey(person: OnCallPerson, index: number): string {
  return `${person.slackUserId ?? person.email ?? person.name}:${index}`;
}

export interface FeedProblem {
  body: string;
  title: string;
}

/** What to tell people about a #firefighters read error, and what to do about it. */
export function feedProblem(error: string | undefined, channelName: string): FeedProblem | null {
  if (!error) {
    return null;
  }
  switch (error) {
    case "not_in_channel":
    case "channel_not_found":
      return {
        body: `The dashboard's Slack bot isn't a member of #${channelName}. In Slack, type /invite @ts-internal-dashboard in #${channelName}, then refresh.`,
        title: "Bot not in the channel",
      };
    case "missing_scope":
      return { body: "The Slack connection lacks permission to read channel history (channels:history). See Settings → Slack.", title: "Missing Slack permission" };
    case "no_token":
      return { body: "Slack isn't connected for this deployment. See Settings → Slack.", title: "Slack not connected" };
    case "ratelimited":
      return { body: "Slack is throttling history reads. Try again in a minute.", title: "Slack is busy" };
    default:
      return { body: `Slack said "${error}". Try again shortly, or open the channel in Slack.`, title: "Couldn't read the channel" };
  }
}
