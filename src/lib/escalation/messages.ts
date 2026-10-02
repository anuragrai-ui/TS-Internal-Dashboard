import type { EscalationGroup, EscalationLevel, ParsedSla, PersonRef, Priority, TsSnapshot } from "@/lib/escalation/types";

/**
 * Slack mrkdwn for the engineering-escalation pilot. Pure string building
 * over values the planner already computed (business-hour waits, levels,
 * mentions), so the text can never disagree with the plan it belongs to.
 *
 * Privacy: only keys, links, statuses, timings and owner names are ever
 * rendered. The snapshots deliberately carry no summaries, descriptions,
 * reporters or customer names, and nothing here reaches for extra fields
 * on them - keep it that way, these messages land in engineering channels.
 */

export const MAX_TS_KEYS_IN_PARENT = 10;

export interface NextLevel {
  dueInBh: number;
  level: EscalationLevel;
}

export interface ParentView {
  /* Business hours engineering has to acknowledge; null when nothing is asked of them (fix ready). */
  ackDueBh: number | null;
  /* The CP assignee as a real mention - only when routing data holds a verified Slack id for them. */
  assigneeMention: PersonRef | null;
  /* Set for backlog escalations: their ladder timer starts at go-live, not at WfP entry. */
  backlogGoLiveAt: string | null;
  basePriority: Priority;
  /* Real bump reasons only (notes such as "no WfP entry time" go in `notes`). */
  bumpReasons: string[];
  /* Owners tagged on the parent (EM, PM). */
  ccMentions: PersonRef[];
  effectivePriority: Priority;
  engineeringWaitBh: number;
  levelDue: EscalationLevel;
  nextLevel: NextLevel | null;
  notes: string[];
  state: "open" | "fix_ready";
  /* Business hours each TS ticket has waited since its OWN WfP entry (null = entry unknown). */
  ticketWaitBh: ReadonlyMap<string, number | null>;
  waitT0: string;
}

export interface LevelView {
  effectivePriority: Priority;
  engineeringWaitBh: number;
  /* False when owners.l3 is unset: L3 then tags nobody extra (the classifier raised l3_unconfigured). */
  l3Configured: boolean;
  mentions: PersonRef[];
  nextLevel: NextLevel | null;
  thresholdBh: number;
}

const LEVEL_LABEL: Record<1 | 2 | 3, string> = {
  1: "wait warning",
  2: "wait breach",
  3: "top-owner escalation",
};

/* Slack ids are U/W + uppercase alphanumerics. Anything else is rendered as
   plain text rather than trusted inside <@...>, so a bad routing row can't
   smuggle a special token (e.g. "!channel") into a mention. */
const SLACK_USER_ID_PATTERN = /^[UW][A-Z0-9]{2,}$/;
const SAFE_URL_PATTERN = /^https:\/\/[^\s<>|]+$/;
const ISSUE_KEY_PATTERN = /^([A-Z][A-Z0-9_]*)-(\d+)$/;

export function isVerifiedSlackUserId(id: string | undefined): id is string {
  return id !== undefined && SLACK_USER_ID_PATTERN.test(id);
}

/** Natural order for Jira keys (CP-9 before CP-10), so plans and messages are stable. */
export function compareIssueKeys(a: string, b: string): number {
  const matchA = ISSUE_KEY_PATTERN.exec(a);
  const matchB = ISSUE_KEY_PATTERN.exec(b);

  if (matchA && matchB) {
    const [, projectA = "", numberA = "0"] = matchA;
    const [, projectB = "", numberB = "0"] = matchB;

    if (projectA !== projectB) {
      return projectA < projectB ? -1 : 1;
    }

    return Number(numberA) - Number(numberB);
  }

  return a < b ? -1 : a > b ? 1 : 0;
}

/* --------------------------------------------------------------- renderers */

export function renderParent(group: EscalationGroup, view: ParentView): string {
  const { cp } = group;
  const headline =
    view.state === "fix_ready" ? ":white_check_mark: *Engineering escalation - fix ready*" : ":rotating_light: *Engineering escalation*";
  const assignee = view.assigneeMention ? renderMention(view.assigneeMention) : escapeText(cp.assigneeName ?? "Unassigned");

  const lines = [
    `${headline} ${link(cp.url, cp.key)} - ${escapeText(group.routing.podName)} pod`,
    `*CP status:* ${escapeText(cp.statusName)}  |  *Priority:* ${renderPriority(view)}`,
    `*CP assignee:* ${assignee}`,
    renderWaitLine(view),
    ...view.notes.map((note) => `_Note: ${escapeText(note)}_`),
    `*Waiting TS tickets (${group.tickets.length}), business hours since each entered Waiting for product:*`,
    ...renderTicketLines(group.tickets, view.ticketWaitBh),
    ...renderNextAction(group, view),
  ];

  const cc = renderMentions(view.ccMentions);

  if (cc) {
    lines.push(`cc ${cc}`);
  }

  return finalizeText(lines.join("\n"));
}

export function renderLevel(level: 1 | 2 | 3, group: EscalationGroup, view: LevelView): string {
  const { cp } = group;
  const tagged = renderMentions(view.mentions);
  const ticketCount = pluralize(group.tickets.length, "TS ticket");
  const wait = floorHours(view.engineeringWaitBh);
  const threshold = floorHours(view.thresholdBh);
  const lines: string[] = [];

  if (level === 1) {
    lines.push(
      `:hourglass_flowing_sand: *L1 - engineering ${LEVEL_LABEL[1]}* on ${link(cp.url, cp.key)}: ${wait} business hours waiting on engineering (${view.effectivePriority} L1 at ${threshold}h), ${ticketCount} attached.`,
      `${askPrefix(tagged)} take a look and share an ETA when you get a chance? Thank you!`,
    );
  } else if (level === 2) {
    lines.push(
      `:warning: *L2 - engineering ${LEVEL_LABEL[2]}* on ${link(cp.url, cp.key)}: ${wait} business hours waiting, past the ${view.effectivePriority} target of ${threshold}h, ${ticketCount} attached.`,
      `${askPrefix(tagged)} help get this prioritized and share an ETA? Really appreciate it.`,
    );
  } else {
    lines.push(
      `:rotating_light: *L3 - ${LEVEL_LABEL[3]}* on ${link(cp.url, cp.key)}: ${wait} business hours waiting (${view.effectivePriority} L3 at ${threshold}h), ${ticketCount} attached.`,
      `${askPrefix(tagged)} help unblock this or let us know what it needs? Thank you.`,
    );

    if (!view.l3Configured) {
      lines.push(`_No L3 owner is configured for the ${escapeText(group.routing.podName)} pod yet, so nobody extra is tagged._`);
    }
  }

  if (view.nextLevel && view.nextLevel.level !== 0) {
    lines.push(`Next: ${renderLevelName(view.nextLevel.level)} in ${ceilHours(view.nextLevel.dueInBh)} business hours.`);
  }

  return finalizeText(lines.join("\n"));
}

export function renderFixReady(group: EscalationGroup): string {
  return renderFixReadyFor(group.cp, group.tickets.length);
}

export function renderFixReadyFor(cp: { key: string; statusName: string; url: string }, waitingTickets: number): string {
  return finalizeText(
    [
      `:white_check_mark: ${link(cp.url, cp.key)} is *${escapeText(cp.statusName)}* - the fix is built and waiting to ship, so the escalation ladder is paused.`,
      `This thread stays open until it's released; support will update the ${pluralize(waitingTickets, "waiting TS ticket")} then.`,
    ].join("\n"),
  );
}

export function renderBacklogDigest(cpKeys: string[], goLiveAt: string): string {
  const keys = cpKeys.map(escapeText).join(", ");

  return finalizeText(
    [
      `:inbox_tray: *Engineering escalation go-live* (${formatInstant(goLiveAt)}): ${pluralize(cpKeys.length, "CP")} already waiting on engineering before go-live.`,
      "Their escalation timers start at go-live rather than at their original Waiting for product entry, so nothing escalates on past wait. Each gets its own thread as it posts:",
      keys,
    ].join("\n"),
  );
}

/* ------------------------------------------------- thread updates (runner) */

/* The slice of a CP the thread updates mention - keys, links and statuses only, like every other message here. */
export interface CpRef {
  key: string;
  statusName: string;
  url: string;
}

export type ResolvedReason = "rejected" | "shipped" | "ts_done" | "wrong_pod";

export function renderResolved(cp: CpRef, reason: ResolvedReason, waitingTickets: number): string {
  const cpLink = link(cp.url, cp.key);
  const status = escapeText(cp.statusName);

  if (reason === "shipped") {
    return finalizeText(
      `:white_check_mark: ${cpLink} is *${status}* - resolving this escalation. Support will update the ${pluralize(waitingTickets, "waiting TS ticket")}.`,
    );
  }
  if (reason === "rejected") {
    return finalizeText(
      `:no_entry_sign: ${cpLink} was closed without a fix (*${status}*) - resolving this escalation. Support will decide the next step with the customer.`,
    );
  }
  if (reason === "ts_done") {
    return finalizeText(`:white_check_mark: Every TS ticket waiting on ${cpLink} is resolved - closing this escalation.`);
  }
  return finalizeText(`:mute: Marked as the wrong pod - this thread stops here.`);
}

export function renderHandedBack(cp: CpRef): string {
  return finalizeText(
    `:leftwards_arrow_with_hook: No TS tickets are waiting on ${link(cp.url, cp.key)} any more (they left Waiting for product), so this escalation stops here. If one comes back, it opens a new thread.`,
  );
}

export function renderPodChanged(cp: CpRef, podName: string | null): string {
  return finalizeText(
    `:twisted_rightwards_arrows: ${link(cp.url, cp.key)} moved to ${podName ? `the ${escapeText(podName)} pod` : "another pod"} - this thread stops here.`,
  );
}

export function renderLadderResumed(cp: CpRef): string {
  return finalizeText(`:arrows_counterclockwise: ${link(cp.url, cp.key)} moved back to *${escapeText(cp.statusName)}* - the escalation ladder resumes.`);
}

export function renderTicketsChanged(cp: CpRef, joined: Array<{ key: string; url: string }>, left: string[], waitingNow: number): string {
  const lines: string[] = [];
  if (joined.length > 0) {
    lines.push(`:heavy_plus_sign: Now also waiting on ${link(cp.url, cp.key)}: ${joined.map((ticket) => link(ticket.url, ticket.key)).join(", ")}.`);
  }
  if (left.length > 0) {
    lines.push(`:heavy_minus_sign: No longer waiting (left Waiting for product): ${left.map(escapeText).join(", ")}.`);
  }
  lines.push(`${pluralize(waitingNow, "TS ticket")} waiting in total.`);
  return finalizeText(lines.join("\n"));
}

export function renderAcknowledged(cp: CpRef, byName: string): string {
  return finalizeText(
    `:white_check_mark: Acknowledged by ${escapeText(byName)}. The ladder keeps counting engineering wait until ${escapeText(cp.key)} is ready for release - please share an ETA here when you have one.`,
  );
}

/* ----------------------------------------------------------------- pieces */

function renderPriority(view: ParentView): string {
  if (view.bumpReasons.length === 0) {
    return view.effectivePriority;
  }

  const reasons = view.bumpReasons.map(escapeText).join("; ");

  /* A Critical base can't go higher, but the reasons (a major incident, a
     breached TTR) still tell engineering why it is urgent - never drop them. */
  if (view.effectivePriority === view.basePriority) {
    return `${view.effectivePriority} (already the highest priority; also: ${reasons})`;
  }

  return `${view.effectivePriority} (bumped from ${view.basePriority}: ${reasons})`;
}

function renderWaitLine(view: ParentView): string {
  const wait = floorHours(view.engineeringWaitBh);

  if (view.backlogGoLiveAt) {
    return `*Engineering wait:* ${wait} business hours since go-live (${formatInstant(view.backlogGoLiveAt)}) - this CP was already waiting before go-live, so its timer starts there.`;
  }

  return `*Engineering wait:* ${wait} business hours since ${formatInstant(view.waitT0)} (earliest Waiting for product entry).`;
}

function renderTicketLines(tickets: TsSnapshot[], waits: ReadonlyMap<string, number | null>): string[] {
  /* Longest wait first so the oldest customer pain is what people see. */
  const ordered = [...tickets].sort((a, b) => {
    const waitA = waits.get(a.key) ?? null;
    const waitB = waits.get(b.key) ?? null;

    if (waitA !== waitB) {
      if (waitA === null) return 1;
      if (waitB === null) return -1;
      return waitB - waitA;
    }

    return compareIssueKeys(a.key, b.key);
  });

  const shown = ordered.slice(0, MAX_TS_KEYS_IN_PARENT).map((ticket) => {
    const waited = waits.get(ticket.key) ?? null;
    const waitText = waited === null ? "WfP entry unknown" : `${floorHours(waited)}h waited`;

    return `• ${link(ticket.url, ticket.key)} - ${waitText} - ${ttrChip(ticket.ttr)}`;
  });

  const hidden = ordered.length - shown.length;

  return hidden > 0 ? [...shown, `• +${hidden} more`] : shown;
}

function renderNextAction(group: EscalationGroup, view: ParentView): string[] {
  if (view.state === "fix_ready") {
    return [
      `*Next:* release the fix - the escalation ladder is paused while ${escapeText(group.cp.key)} is ${escapeText(group.cp.statusName)}; support updates the waiting tickets once it ships.`,
    ];
  }

  const lines: string[] = [];

  if (view.ackDueBh !== null) {
    lines.push(`*Next:* acknowledge and share an ETA within ${floorHours(view.ackDueBh)} business hours.`);
  }

  if (view.levelDue > 0) {
    const later = view.nextLevel
      ? `; ${renderLevelName(view.nextLevel.level)} in ${ceilHours(view.nextLevel.dueInBh)} business hours`
      : " - every level has been reached";
    lines.push(`*Escalation:* ${renderLevelName(view.levelDue)} is due now${later}.`);
  } else if (view.nextLevel) {
    lines.push(`*Escalation:* ${renderLevelName(view.nextLevel.level)} in ${ceilHours(view.nextLevel.dueInBh)} business hours.`);
  }

  return lines;
}

function renderLevelName(level: EscalationLevel): string {
  return level === 0 ? "L0" : `L${level} (${LEVEL_LABEL[level]})`;
}

function ttrChip(ttr: ParsedSla): string {
  const left = ttr.remainingMs === null ? null : `${floorHours(Math.max(0, ttr.remainingMs) / 3_600_000)}h left`;

  if (ttr.breached) return "TTR breached";

  switch (ttr.state) {
    case "paused":
      return left ? `TTR paused, ${left}` : "TTR paused";
    case "running":
      return left ? `TTR running, ${left}` : "TTR running";
    case "completed_only":
      return "TTR met";
    case "none":
      return "no SLA";
  }
}

function askPrefix(tagged: string): string {
  return tagged ? `${tagged} could you` : "Could someone on the pod";
}

function renderMentions(people: PersonRef[]): string {
  return people.map(renderMention).join(" ");
}

/* A verified Slack id becomes a real mention; anything else stays visibly
   unverified plain text, never a guessed mention. */
function renderMention(person: PersonRef): string {
  return isVerifiedSlackUserId(person.slackUserId)
    ? `<@${person.slackUserId}>`
    : `@${escapeText(person.displayName)} (unverified)`;
}

function link(url: string, label: string): string {
  return SAFE_URL_PATTERN.test(url) ? `<${url}|${escapeText(label)}>` : escapeText(label);
}

/* Slack's three control characters. Escaping them is what stops a Jira
   status or display name from turning into <!here>, <@U..> or a link. */
function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/* Belt and braces over the escaping above: nothing this module emits may
   page a whole channel, whatever a routing row or Jira field contains
   (e.g. a person whose display name is literally "here"). */
function finalizeText(text: string): string {
  return text.replace(/<!([^>]*)>/g, "").replace(/@(channel|here|everyone)\b/gi, "$1");
}

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/* Waits are floored and due-ins ceiled to 0.1h, so the text never claims a
   level is reached (or further away) than the plan's exact numbers say. */
function floorHours(hours: number): string {
  return trimTenths(Math.floor(hours * 10 + 1e-9) / 10);
}

function ceilHours(hours: number): string {
  return trimTenths(Math.ceil(hours * 10 - 1e-9) / 10);
}

function trimTenths(value: number): string {
  return value.toFixed(1).replace(/\.0$/, "");
}

function formatInstant(iso: string): string {
  const ms = Date.parse(iso);

  return Number.isNaN(ms) ? escapeText(iso) : `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}
