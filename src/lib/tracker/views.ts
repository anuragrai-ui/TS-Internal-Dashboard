import { ATTENTION_KIND_LABEL, attentionRank, attentionReasons } from "@/lib/tracker/attention";

import type { SignalKind, SignalTier, TrackerPriority, TrackerSla, TrackerTicket, WhoseMove } from "@/lib/tracker/types";

/**
 * Pure, client-safe logic behind the /tracker workspace: which tickets each
 * saved view shows, the filter chips, text search, grouping by whose move,
 * the sort orders, and how SLA/time values read on screen. No I/O and no
 * React here, so every rule the UI depends on is unit tested with fixtures
 * (scripts/test-tracker-views.ts) and the components stay presentational.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/* Jira's "Waiting for product" status id - the one manual escalation every TS engineer makes by hand. */
export const WAITING_FOR_PRODUCT_STATUS_ID = "10633";

/* "Due in 3h" turns amber below this - one working day's worth of warning. */
export const SLA_WARNING_MS = 8 * HOUR_MS;

/* How far back the "Closed" view looks. */
export const CLOSED_LOOKBACK_MS = 7 * DAY_MS;

/* Signals that only exist because a person escalated by hand (tier 2). */
export const MANUAL_SIGNAL_KINDS: ReadonlySet<SignalKind> = new Set<SignalKind>([
  "escalation_comment",
  "priority_raised",
  "slack_conversation",
  "slack_permalink",
]);

/* Filter value standing in for "no pod / no account / unassigned". */
export const NONE_VALUE = "__none__";

const PRIORITY_RANK: Record<TrackerPriority, number> = { Critical: 0, High: 1, Low: 3, Medium: 2 };

export const PRIORITY_ORDER: TrackerPriority[] = ["Critical", "High", "Medium", "Low"];

/* Pylon's band order: what needs picking up first, then what is waiting on someone else, then done. */
export const WHOSE_MOVE_ORDER: WhoseMove[] = ["new", "on_ts", "on_engineering", "on_operations", "on_customer", "closed"];

export const WHOSE_MOVE_LABEL: Record<WhoseMove, string> = {
  closed: "Closed",
  new: "New",
  on_customer: "On customer",
  on_engineering: "Waiting on engineering",
  on_operations: "On operations",
  on_ts: "On TS",
};

export const SIGNAL_TIER_LABEL: Record<SignalTier, string> = {
  1: "Escalated to engineering",
  2: "Escalated by a person",
  3: "Context",
};

/* ------------------------------------------------------------------ views */

export type TrackerViewId =
  | "all_open"
  | "breaching"
  | "closed_recent"
  | "critical"
  | "engineering"
  | "following"
  | "high"
  | "manual"
  | "medium_wfp"
  | "mine"
  | "needs_attention"
  | "slack_active"
  | "unassigned";

export interface ViewContext {
  following: ReadonlySet<string>;
  /* Jira accountId of whoever is browsing. */
  me: string;
  now: number;
}

export interface TrackerViewDef {
  /* Shown when the view is empty with no search or filters applied. */
  emptyText: string;
  id: TrackerViewId;
  label: string;
  matches: (ticket: TrackerTicket, context: ViewContext) => boolean;
  section: string;
}

export function isOpen(ticket: TrackerTicket): boolean {
  return ticket.statusCategory !== "done";
}

function hasSignal(ticket: TrackerTicket, kinds: ReadonlySet<SignalKind> | SignalKind): boolean {
  return ticket.signals.some((signal) => (typeof kinds === "string" ? signal.kind === kinds : kinds.has(signal.kind)));
}

/* TTR already breached, or the snapshot flagged it as about to be. */
export function isBreachingSla(ticket: TrackerTicket): boolean {
  return ticket.ttr.breached || hasSignal(ticket, "ttr_breached") || hasSignal(ticket, "ttr_at_risk");
}

export function isManuallyEscalated(ticket: TrackerTicket): boolean {
  return hasSignal(ticket, MANUAL_SIGNAL_KINDS);
}

function closedWithin(ticket: TrackerTicket, now: number, windowMs: number): boolean {
  if (isOpen(ticket)) {
    return false;
  }
  /* resolvedAt is the real close time; `updated` is the best stand-in when Jira has no resolution date. */
  const closedAt = Date.parse(ticket.resolvedAt ?? ticket.updated);
  return !Number.isNaN(closedAt) && now - closedAt <= windowMs;
}

export const TRACKER_VIEWS: TrackerViewDef[] = [
  {
    emptyText: "Nothing needs attention right now: no breaching clocks, unowned or idle High/Critical tickets, or hand-backs from engineering.",
    id: "needs_attention",
    label: "Needs attention",
    matches: (ticket, context) => attentionReasons(ticket, context.now).length > 0,
    section: "Inbox",
  },
  {
    emptyText: "Nothing assigned to you or followed by you is open. Follow a ticket from its detail panel to keep it here.",
    id: "mine",
    label: "My escalations",
    matches: (ticket, context) => isOpen(ticket) && (ticket.assignee?.accountId === context.me || context.following.has(ticket.key)),
    section: "Inbox",
  },
  {
    emptyText: "No open High/Critical tickets and nothing waiting on engineering.",
    id: "all_open",
    label: "All open",
    matches: (ticket) => isOpen(ticket),
    section: "Escalations",
  },
  {
    emptyText: "No open Critical tickets.",
    id: "critical",
    label: "Critical",
    matches: (ticket) => isOpen(ticket) && ticket.priority === "Critical",
    section: "Escalations",
  },
  {
    emptyText: "No open High tickets.",
    id: "high",
    label: "High",
    matches: (ticket) => isOpen(ticket) && ticket.priority === "High",
    section: "Escalations",
  },
  {
    emptyText: "No open ticket has breached or is about to breach its Time to resolution.",
    id: "breaching",
    label: "Breaching SLA",
    matches: (ticket) => isOpen(ticket) && isBreachingSla(ticket),
    section: "Escalations",
  },
  {
    emptyText: "Nothing is waiting on engineering right now.",
    id: "engineering",
    label: "Waiting on engineering",
    matches: (ticket) => isOpen(ticket) && ticket.whoseMove === "on_engineering",
    section: "Escalations",
  },
  {
    emptyText: "No open ticket has an active Slack conversation.",
    id: "slack_active",
    label: "Active in Slack",
    matches: (ticket) => isOpen(ticket) && ticket.slack.activeConversations > 0,
    section: "Escalations",
  },
  {
    emptyText: "No open ticket shows a manual escalation (priority raised, an \"escalate\" comment, or a Slack discussion).",
    id: "manual",
    label: "Manually escalated",
    matches: (ticket) => isOpen(ticket) && isManuallyEscalated(ticket),
    section: "Escalations",
  },
  {
    emptyText: "Every open ticket has an assignee.",
    id: "unassigned",
    label: "Unassigned",
    matches: (ticket) => isOpen(ticket) && ticket.assignee === null,
    section: "Escalations",
  },
  {
    emptyText: "You aren't following any tickets yet. Open one and press Follow.",
    id: "following",
    label: "Following",
    matches: (ticket, context) => context.following.has(ticket.key),
    section: "More",
  },
  {
    emptyText: "No Medium ticket is waiting for product.",
    id: "medium_wfp",
    label: "Medium in WfP",
    matches: (ticket) => isOpen(ticket) && ticket.priority === "Medium" && ticket.statusId === WAITING_FOR_PRODUCT_STATUS_ID,
    section: "More",
  },
  {
    emptyText: "Nothing tracked here was closed in the last 7 days.",
    id: "closed_recent",
    label: "Closed (7 days)",
    matches: (ticket, context) => closedWithin(ticket, context.now, CLOSED_LOOKBACK_MS),
    section: "More",
  },
];

export const DEFAULT_VIEW_ID: TrackerViewId = "all_open";

const VIEW_BY_ID = new Map(TRACKER_VIEWS.map((view) => [view.id, view]));

export function isTrackerViewId(value: string | null | undefined): value is TrackerViewId {
  return typeof value === "string" && VIEW_BY_ID.has(value as TrackerViewId);
}

export function getView(id: string | null | undefined): TrackerViewDef {
  return (isTrackerViewId(id) ? VIEW_BY_ID.get(id) : undefined) ?? (VIEW_BY_ID.get(DEFAULT_VIEW_ID) as TrackerViewDef);
}

export function viewCounts(tickets: TrackerTicket[], context: ViewContext): Record<TrackerViewId, number> {
  const counts = Object.fromEntries(TRACKER_VIEWS.map((view) => [view.id, 0])) as Record<TrackerViewId, number>;
  for (const ticket of tickets) {
    for (const view of TRACKER_VIEWS) {
      if (view.matches(ticket, context)) {
        counts[view.id] += 1;
      }
    }
  }
  return counts;
}

/* ---------------------------------------------------------------- filters */

export interface TrackerFilters {
  account: string[];
  assignee: string[];
  pod: string[];
  priority: string[];
  /* Why it needs attention (src/lib/tracker/attention.ts). */
  reason: string[];
  signal: string[];
}

export type FilterFacet = keyof TrackerFilters;

export const FILTER_FACETS: Array<{ facet: FilterFacet; label: string }> = [
  { facet: "priority", label: "Priority" },
  { facet: "pod", label: "Pod" },
  { facet: "assignee", label: "Assignee" },
  { facet: "account", label: "Account" },
  { facet: "reason", label: "Attention" },
  { facet: "signal", label: "Signals" },
];

export const EMPTY_FILTERS: TrackerFilters = { account: [], assignee: [], pod: [], priority: [], reason: [], signal: [] };

export interface FacetOption {
  count: number;
  label: string;
  value: string;
}

/* Every value a ticket has for one facet, paired with its display label. */
function facetEntries(ticket: TrackerTicket, facet: FilterFacet, now: number): Array<{ label: string; value: string }> {
  switch (facet) {
    case "account":
      return [ticket.account ? { label: ticket.account, value: ticket.account } : { label: "No account", value: NONE_VALUE }];
    case "assignee":
      return [ticket.assignee ? { label: ticket.assignee.name, value: ticket.assignee.accountId } : { label: "Unassigned", value: NONE_VALUE }];
    case "pod":
      return [ticket.pod ? { label: ticket.pod, value: ticket.pod } : { label: "No pod", value: NONE_VALUE }];
    case "priority":
      return [{ label: ticket.priority, value: ticket.priority }];
    case "reason":
      return attentionReasons(ticket, now).map((reason) => ({ label: ATTENTION_KIND_LABEL[reason.kind], value: reason.kind }));
    case "signal":
      return ticket.signals.map((signal) => ({ label: signal.label, value: signal.kind }));
  }
}

/* OR within one facet ("Critical or High"), AND across facets ("... and pod Alpha"). */
export function applyFilters(tickets: TrackerTicket[], filters: TrackerFilters, now: number = Date.now()): TrackerTicket[] {
  const active = FILTER_FACETS.filter(({ facet }) => filters[facet].length > 0);
  if (active.length === 0) {
    return tickets;
  }
  return tickets.filter((ticket) =>
    active.every(({ facet }) => facetEntries(ticket, facet, now).some((entry) => filters[facet].includes(entry.value))),
  );
}

/* The options a facet menu offers, with how many tickets have each. Priorities keep their natural order; the rest go by count. */
export function facetOptions(tickets: TrackerTicket[], facet: FilterFacet, now: number = Date.now()): FacetOption[] {
  const byValue = new Map<string, FacetOption>();
  for (const ticket of tickets) {
    /* A ticket can carry the same signal kind twice (two Slack threads); count it once. */
    const seen = new Set<string>();
    for (const entry of facetEntries(ticket, facet, now)) {
      if (seen.has(entry.value)) {
        continue;
      }
      seen.add(entry.value);
      const existing = byValue.get(entry.value);
      byValue.set(entry.value, { count: (existing?.count ?? 0) + 1, label: existing?.label ?? entry.label, value: entry.value });
    }
  }
  const options = [...byValue.values()];
  if (facet === "priority") {
    return options.sort((a, b) => PRIORITY_RANK[a.value as TrackerPriority] - PRIORITY_RANK[b.value as TrackerPriority]);
  }
  return options.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

export function toggleFilterValue(filters: TrackerFilters, facet: FilterFacet, value: string): TrackerFilters {
  const current = filters[facet];
  return { ...filters, [facet]: current.includes(value) ? current.filter((item) => item !== value) : [...current, value] };
}

export function hasActiveFilters(filters: TrackerFilters): boolean {
  return FILTER_FACETS.some(({ facet }) => filters[facet].length > 0);
}

/* ----------------------------------------------------------------- search */

function searchHaystack(ticket: TrackerTicket): string {
  return [ticket.key, ticket.summary, ticket.account ?? "", ticket.assignee?.name ?? "", ...ticket.cps.map((cp) => cp.key)].join("\n").toLowerCase();
}

/* Every whitespace-separated word must appear somewhere in key, summary, account, assignee or a linked CP key. */
export function matchesSearch(ticket: TrackerTicket, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return true;
  }
  const haystack = searchHaystack(ticket);
  return words.every((word) => haystack.includes(word));
}

/* ------------------------------------------------------------------- sort */

export type TrackerSortId = "activity" | "attention" | "created" | "priority" | "sla";

export const SORT_OPTIONS: Array<{ id: TrackerSortId; label: string }> = [
  { id: "attention", label: "Needs attention first" },
  { id: "sla", label: "SLA urgency" },
  { id: "priority", label: "Priority" },
  { id: "activity", label: "Last activity" },
  { id: "created", label: "Created" },
];

export const DEFAULT_SORT_ID: TrackerSortId = "sla";

/* The Needs attention view reads top-down by urgency; every other view keeps the SLA order unless the URL says otherwise. */
export function defaultSortFor(view: TrackerViewId): TrackerSortId {
  return view === "needs_attention" ? "attention" : DEFAULT_SORT_ID;
}

export function isTrackerSortId(value: string | null | undefined): value is TrackerSortId {
  return SORT_OPTIONS.some((option) => option.id === value);
}

function timeOf(iso: string | null | undefined): number {
  const parsed = iso ? Date.parse(iso) : Number.NaN;
  return Number.isNaN(parsed) ? 0 : parsed;
}

/* 0 breached, 1 running, 2 paused, 3 no live clock. Breached wins even when paused - the overrun already happened. */
function slaBucket(sla: TrackerSla): number {
  if (sla.breached) {
    return 0;
  }
  if (sla.state === "running" && sla.remainingMs !== null) {
    return 1;
  }
  if (sla.state === "paused") {
    return 2;
  }
  return 3;
}

/* Within the breached bucket the most overdue (most negative remaining) comes first; within running, the least time left. */
function compareSla(a: TrackerSla, b: TrackerSla): number {
  const bucket = slaBucket(a) - slaBucket(b);
  if (bucket !== 0) {
    return bucket;
  }
  if (slaBucket(a) <= 1) {
    return (a.remainingMs ?? 0) - (b.remainingMs ?? 0);
  }
  return 0;
}

function comparePriority(a: TrackerTicket, b: TrackerTicket): number {
  return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
}

function compareActivity(a: TrackerTicket, b: TrackerTicket): number {
  return timeOf(b.lastActivityAt) - timeOf(a.lastActivityAt);
}

/* Last resort so equal tickets never shuffle between polls. */
function compareKey(a: TrackerTicket, b: TrackerTicket): number {
  return a.key.localeCompare(b.key, "en", { numeric: true });
}

export const SORT_COMPARATORS: Record<Exclude<TrackerSortId, "attention">, (a: TrackerTicket, b: TrackerTicket) => number> = {
  activity: (a, b) => compareActivity(a, b) || comparePriority(a, b) || compareKey(a, b),
  created: (a, b) => timeOf(b.created) - timeOf(a.created) || compareKey(a, b),
  priority: (a, b) => comparePriority(a, b) || compareSla(a.ttr, b.ttr) || compareActivity(a, b) || compareKey(a, b),
  sla: (a, b) => compareSla(a.ttr, b.ttr) || comparePriority(a, b) || compareActivity(a, b) || compareKey(a, b),
};

/* Most urgent reason first, then the same tie-breaks as the SLA order. Each ticket's reasons are worked out once, not per comparison. */
function sortByAttention(tickets: TrackerTicket[], now: number): TrackerTicket[] {
  const rank = new Map(tickets.map((ticket) => [ticket.key, attentionRank(ticket, now)] as const));
  const rankOf = (ticket: TrackerTicket): number => rank.get(ticket.key) ?? Number.POSITIVE_INFINITY;
  return [...tickets].sort((a, b) => rankOf(a) - rankOf(b) || comparePriority(a, b) || SORT_COMPARATORS.sla(a, b));
}

export function sortTickets(tickets: TrackerTicket[], sort: TrackerSortId, now: number = Date.now()): TrackerTicket[] {
  return sort === "attention" ? sortByAttention(tickets, now) : [...tickets].sort(SORT_COMPARATORS[sort]);
}

/* ------------------------------------------------------------ pipeline */

export interface TrackerQuery {
  filters: TrackerFilters;
  search: string;
  sort: TrackerSortId;
  view: TrackerViewId;
}

/* View -> filters -> search -> sort: exactly what the list or board shows. */
export function selectTickets(tickets: TrackerTicket[], query: TrackerQuery, context: ViewContext): TrackerTicket[] {
  const view = getView(query.view);
  const inView = tickets.filter((ticket) => view.matches(ticket, context));
  const searched = applyFilters(inView, query.filters, context.now).filter((ticket) => matchesSearch(ticket, query.search));
  return sortTickets(searched, query.sort, context.now);
}

export interface TicketGroup {
  label: string;
  tickets: TrackerTicket[];
  whoseMove: WhoseMove;
}

/* Bands in Pylon order; empty bands are left out. Keeps the incoming (already sorted) order inside each band. */
export function groupByWhoseMove(tickets: TrackerTicket[]): TicketGroup[] {
  return WHOSE_MOVE_ORDER.map((whoseMove) => ({
    label: WHOSE_MOVE_LABEL[whoseMove],
    tickets: tickets.filter((ticket) => ticket.whoseMove === whoseMove),
    whoseMove,
  })).filter((group) => group.tickets.length > 0);
}

/* The keys j/k walk through: every visible row, skipping collapsed bands. */
export function navigableKeys(groups: TicketGroup[], collapsed: ReadonlySet<WhoseMove>): string[] {
  return groups.filter((group) => !collapsed.has(group.whoseMove)).flatMap((group) => group.tickets.map((ticket) => ticket.key));
}

/* The key `delta` rows away, clamped to the ends; the first row when nothing is selected yet. */
export function adjacentKey(keys: string[], current: string | null, delta: number): string | null {
  if (keys.length === 0) {
    return null;
  }
  const index = current ? keys.indexOf(current) : -1;
  if (index === -1) {
    return delta >= 0 ? (keys[0] ?? null) : (keys.at(-1) ?? null);
  }
  return keys[Math.min(keys.length - 1, Math.max(0, index + delta))] ?? null;
}

/* ----------------------------------------------------------- formatting */

/* "45m", "3h", "2d" - floored, never "0m". */
export function formatDurationShort(ms: number): string {
  const abs = Math.abs(ms);
  if (abs < HOUR_MS) {
    return `${Math.max(1, Math.floor(abs / MINUTE_MS))}m`;
  }
  if (abs < DAY_MS) {
    return `${Math.floor(abs / HOUR_MS)}h`;
  }
  return `${Math.floor(abs / DAY_MS)}d`;
}

export type SlaTone = "danger" | "muted" | "success" | "warning";

export interface SlaChip {
  paused: boolean;
  text: string;
  tone: SlaTone;
}

/**
 * How an SLA reads in a list row. remainingMs is as of the snapshot build:
 * JSM counts Time to resolution in business hours only, so subtracting wall
 * clock time since the build would be wrong overnight - the next rebuild
 * (every few minutes) moves it instead.
 */
export function slaChip(sla: TrackerSla): SlaChip {
  if (sla.breached) {
    return {
      paused: sla.state === "paused",
      text: sla.remainingMs !== null && sla.remainingMs < 0 ? `Breached ${formatDurationShort(sla.remainingMs)}` : "Breached",
      tone: "danger",
    };
  }
  if (sla.state === "paused") {
    return { paused: true, text: "Paused", tone: "muted" };
  }
  if (sla.state === "running" && sla.remainingMs !== null) {
    if (sla.remainingMs <= 0) {
      return { paused: false, text: "Breached", tone: "danger" };
    }
    return { paused: false, text: `Due in ${formatDurationShort(sla.remainingMs)}`, tone: sla.remainingMs < SLA_WARNING_MS ? "warning" : "muted" };
  }
  if (sla.state === "completed_only") {
    return { paused: false, text: "Met", tone: "success" };
  }
  return { paused: false, text: "—", tone: "muted" };
}

/* Share of the goal already used, 0..1, or null when there is no goal to measure against. */
export function slaProgress(sla: TrackerSla): number | null {
  if (sla.goalMs === null || sla.goalMs <= 0 || sla.remainingMs === null) {
    return null;
  }
  return Math.min(1, Math.max(0, (sla.goalMs - sla.remainingMs) / sla.goalMs));
}

/* "just now", "5m ago", "3h ago", "2d ago", "3mo ago", "1y ago"; compact drops the " ago" for dense rows. */
export function relativeTime(iso: string | null | undefined, now: number, compact = false): string {
  const at = iso ? Date.parse(iso) : Number.NaN;
  if (Number.isNaN(at)) {
    return "—";
  }
  const diff = now - at;
  /* A few seconds of clock skew between Jira, Slack and this browser should not read as "in the future". */
  if (diff < MINUTE_MS) {
    return compact ? "now" : "just now";
  }
  const suffix = compact ? "" : " ago";
  if (diff < HOUR_MS) {
    return `${Math.floor(diff / MINUTE_MS)}m${suffix}`;
  }
  if (diff < DAY_MS) {
    return `${Math.floor(diff / HOUR_MS)}h${suffix}`;
  }
  if (diff < 30 * DAY_MS) {
    return `${Math.floor(diff / DAY_MS)}d${suffix}`;
  }
  if (diff < 365 * DAY_MS) {
    return `${Math.floor(diff / (30 * DAY_MS))}mo${suffix}`;
  }
  return `${Math.floor(diff / (365 * DAY_MS))}y${suffix}`;
}

/* "Anurag Rai" -> "AR", "Anurag Kumar Rai" -> "AR", "Anurag" -> "A", nothing -> "". */
export function initials(name: string | null | undefined): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return "";
  }
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts.at(-1)?.[0] ?? "") : "";
  return `${first}${last}`.toUpperCase();
}

/* ------------------------------------------------------- read / unread */

export type ReadState = "read" | "unknown" | "unread";

/**
 * Pylon greys out rows you have already seen. We only know what this browser
 * opened (a per-viewer map of key -> the lastActivityAt seen then), so a
 * ticket never opened here is "unknown" and stays a normal row.
 */
export function readState(ticket: TrackerTicket, seen: Readonly<Record<string, string>>): ReadState {
  const seenAt = seen[ticket.key];
  if (seenAt === undefined) {
    return "unknown";
  }
  return timeOf(ticket.lastActivityAt) > timeOf(seenAt) ? "unread" : "read";
}
