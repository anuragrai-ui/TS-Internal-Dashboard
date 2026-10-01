/**
 * Read-only dry run of the engineering-escalation pilot against LIVE Jira.
 *
 *   npm run escalation:dry-run
 *   npm run escalation:dry-run -- --json                       # full machine-readable output
 *   npm run escalation:dry-run -- --readings-file=tmp/sla.jsonl # append SLA readings; compare with earlier runs
 *
 * Sweeps every Support Ticket in "Waiting for product", classifies it against
 * the pilot routing (Credentialing), and prints exactly which escalations
 * would open, what the Slack messages would say, which exceptions would be
 * raised, and the measurements the plan still assumes (Released -> Blocked
 * flapping lag, SLA clock drift outside business hours).
 *
 * Every Jira call goes through src/lib/escalation/readOnlyJira.ts, which
 * refuses anything but GETs and the two read-only search POSTs - this script
 * cannot create, edit, comment on, link, or transition anything, and it never
 * talks to Slack. Ticket summaries, descriptions and reporter/customer names
 * are never requested.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import { businessMsBetween } from "@/lib/escalation/businessHours";
import { classify, cpOutcome } from "@/lib/escalation/classify";
import {
  CERTIFY_SUPPORT_CALENDAR,
  DEFAULT_ESCALATION_POLICY,
  ESCALATION_CP_ISSUE_TYPES,
  EPIC_ISSUE_TYPE,
  MAJOR_INCIDENT_FIELD,
  PILOT_POD_OPTION_ID,
  POD_FIELD,
  seedRoutingRows,
  SUPPORT_TICKET_ISSUE_TYPE_ID,
  TIME_TO_RESOLUTION_FIELD,
  WAITING_FOR_PRODUCT_STATUS_ID,
} from "@/lib/escalation/policy";
import { planEscalations } from "@/lib/escalation/plan";
import { createReadOnlyJiraClient, readOnlyJiraConfigFromEnv } from "@/lib/escalation/readOnlyJira";
import { parseJsmSla } from "@/lib/escalation/slaParser";

import type { ReadOnlyJiraClient } from "@/lib/escalation/readOnlyJira";
import type { CpSnapshot, Priority, StatusCategory, TsLink, TsSnapshot } from "@/lib/escalation/types";

/* ------------------------------------------------------------------ jira shapes */

interface JiraNamed {
  id?: string;
  key?: string;
  name?: string;
  value?: string;
}

interface JiraStatus extends JiraNamed {
  statusCategory?: { key?: string };
}

interface JiraLinkedIssue {
  key?: string;
}

interface JiraIssue {
  fields: Record<string, unknown> & {
    assignee?: { accountId?: string; displayName?: string } | null;
    issuelinks?: Array<{
      inwardIssue?: JiraLinkedIssue;
      outwardIssue?: JiraLinkedIssue;
      type?: JiraNamed;
    }>;
    issuetype?: JiraNamed | null;
    priority?: JiraNamed | null;
    resolution?: JiraNamed | null;
    status?: JiraStatus | null;
  };
  key: string;
}

interface ChangelogPage {
  isLast?: boolean;
  maxResults?: number;
  startAt?: number;
  total?: number;
  values?: Array<{ created?: string; items?: Array<{ fieldId?: string; field?: string; from?: string; to?: string }> }>;
}

/* ---------------------------------------------------------------------- helpers */

const args = new Set(process.argv.slice(2).filter((arg) => !arg.includes("=")));
const kv = new Map(
  process.argv
    .slice(2)
    .filter((arg) => arg.includes("="))
    .map((arg) => {
      const [k, ...rest] = arg.replace(/^--/, "").split("=");
      return [k!, rest.join("=")] as const;
    }),
);
const asJson = args.has("--json");

function log(line = ""): void {
  if (!asJson) {
    console.log(line);
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        out[index] = await fn(items[index]!);
      }
    }),
  );
  return out;
}

function statusCategory(status: JiraStatus | null | undefined): StatusCategory {
  const key = status?.statusCategory?.key;
  return key === "done" ? "done" : key === "indeterminate" ? "indeterminate" : "new";
}

const PRIORITIES = new Set<Priority>(["Critical", "High", "Medium", "Low"]);
function toPriority(name: string | undefined): Priority | null {
  return name && PRIORITIES.has(name as Priority) ? (name as Priority) : null;
}

function optionId(raw: unknown): string | null {
  return raw && typeof raw === "object" && typeof (raw as JiraNamed).id === "string" ? (raw as JiraNamed).id! : null;
}

function optionName(raw: unknown): string | null {
  return raw && typeof raw === "object" && typeof (raw as JiraNamed).value === "string" ? (raw as JiraNamed).value! : null;
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) {
    return null;
  }
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

function bh(ms: number): string {
  return `${(ms / 3_600_000).toFixed(1)} bh`;
}

/* ------------------------------------------------------------------- data load */

const TS_FIELDS = ["status", "issuetype", "priority", "assignee", "issuelinks", POD_FIELD, TIME_TO_RESOLUTION_FIELD, MAJOR_INCIDENT_FIELD];
const CP_FIELDS = ["status", "issuetype", "resolution", "assignee", "priority", POD_FIELD];

function toTsSnapshot(issue: JiraIssue, baseUrl: string, enteredWfpAt: string | null): TsSnapshot {
  const links: TsLink[] = [];
  for (const link of issue.fields.issuelinks ?? []) {
    const other = link.inwardIssue ?? link.outwardIssue;
    if (other?.key?.startsWith("CP-")) {
      links.push({
        cpKey: other.key,
        direction: link.inwardIssue ? "inward" : "outward",
        linkTypeId: link.type?.id ?? "",
        linkTypeName: link.type?.name ?? "",
      });
    }
  }

  return {
    assigneeAccountId: issue.fields.assignee?.accountId ?? null,
    assigneeName: issue.fields.assignee?.displayName ?? null,
    enteredWfpAt,
    issueTypeId: issue.fields.issuetype?.id ?? "",
    key: issue.key,
    links,
    majorIncident: Boolean(issue.fields[MAJOR_INCIDENT_FIELD]),
    podOptionId: optionId(issue.fields[POD_FIELD]),
    priority: toPriority(issue.fields.priority?.name),
    statusCategory: statusCategory(issue.fields.status),
    statusId: issue.fields.status?.id ?? "",
    statusName: issue.fields.status?.name ?? "",
    ttr: parseJsmSla(issue.fields[TIME_TO_RESOLUTION_FIELD]),
    url: `${baseUrl}/browse/${issue.key}`,
  };
}

function toCpSnapshot(issue: JiraIssue, baseUrl: string): CpSnapshot {
  return {
    assigneeAccountId: issue.fields.assignee?.accountId ?? null,
    assigneeName: issue.fields.assignee?.displayName ?? null,
    issueTypeId: issue.fields.issuetype?.id ?? "",
    issueTypeName: issue.fields.issuetype?.name ?? "",
    key: issue.key,
    podName: optionName(issue.fields[POD_FIELD]),
    podOptionId: optionId(issue.fields[POD_FIELD]),
    priorityName: issue.fields.priority?.name ?? null,
    resolutionId: issue.fields.resolution?.id ?? null,
    resolutionName: issue.fields.resolution?.name ?? null,
    statusCategory: statusCategory(issue.fields.status),
    statusId: issue.fields.status?.id ?? "",
    statusName: issue.fields.status?.name ?? "",
    url: `${baseUrl}/browse/${issue.key}`,
  };
}

async function fullChangelog(client: ReadOnlyJiraClient, key: string): Promise<NonNullable<ChangelogPage["values"]>> {
  const all: NonNullable<ChangelogPage["values"]> = [];
  for (let startAt = 0; startAt < 5_000; ) {
    const page = await client.get<ChangelogPage>(`/rest/api/3/issue/${key}/changelog`, { maxResults: 100, startAt });
    const values = page.values ?? [];
    all.push(...values);
    if (page.isLast !== false || values.length === 0) {
      break;
    }
    startAt += values.length;
  }
  return all;
}

function statusTransitions(changelog: NonNullable<ChangelogPage["values"]>): Array<{ at: string; from: string; to: string }> {
  const out: Array<{ at: string; from: string; to: string }> = [];
  for (const history of changelog) {
    for (const item of history.items ?? []) {
      if ((item.fieldId === "status" || item.field === "status") && history.created) {
        out.push({ at: history.created, from: item.from ?? "", to: item.to ?? "" });
      }
    }
  }
  return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/* ------------------------------------------------------------------ measurements */

async function measureReleaseFlapLag(client: ReadOnlyJiraClient): Promise<{
  lagsMinutes: number[];
  sampled: number;
}> {
  /* The CP open-PR guard moves Released/Closed back to Blocked. How long after
     release it fires decides the resolve grace period (currently a provisional 30 min). */
  const flapped = await client.searchJql<JiraIssue>(
    "project = CP AND (status CHANGED FROM 10571 TO 10007 AFTER -60d OR status CHANGED FROM 6 TO 10007 AFTER -60d)",
    ["status"],
    { maxTotal: 80 },
  );
  const lags: number[] = [];
  await mapLimit(flapped, 5, async (issue) => {
    const transitions = statusTransitions(await fullChangelog(client, issue.key));
    for (let i = 0; i < transitions.length; i += 1) {
      const into = transitions[i]!;
      if (into.to !== "10571" && into.to !== "6") {
        continue;
      }
      const next = transitions[i + 1];
      if (next && next.from === into.to && next.to === "10007") {
        lags.push((Date.parse(next.at) - Date.parse(into.at)) / 60_000);
      }
    }
  });
  return { lagsMinutes: lags.sort((a, b) => a - b), sampled: flapped.length };
}

interface SlaReading {
  at: string;
  key: string;
  remainingMs: number;
  withinCalendarHours: boolean | null;
}

async function readRunningTtr(client: ReadOnlyJiraClient): Promise<SlaReading[]> {
  const running = await client.searchJql<JiraIssue>(
    `issuetype = ${SUPPORT_TICKET_ISSUE_TYPE_ID} AND cf[10650] = running() ORDER BY key`,
    [TIME_TO_RESOLUTION_FIELD],
    { maxTotal: 25 },
  );
  const at = new Date().toISOString();
  return running.flatMap((issue) => {
    const sla = parseJsmSla(issue.fields[TIME_TO_RESOLUTION_FIELD]);
    return sla.state === "running" && sla.remainingMs !== null
      ? [{ at, key: issue.key, remainingMs: sla.remainingMs, withinCalendarHours: sla.withinCalendarHours }]
      : [];
  });
}

/* Compares JSM's own clock movement with ours between two readings of the same
   running ticket: if they disagree, the internal business-hours clock (used for
   the engineering ladder) doesn't match calendar 30. */
function compareReadings(previous: SlaReading[], current: SlaReading[]): Array<{ driftMinutes: number; key: string; jiraMovedMinutes: number; oursMinutes: number }> {
  const byKey = new Map(previous.map((reading) => [reading.key, reading]));
  const out: Array<{ driftMinutes: number; key: string; jiraMovedMinutes: number; oursMinutes: number }> = [];
  for (const reading of current) {
    const before = byKey.get(reading.key);
    if (!before) {
      continue;
    }
    const jiraMoved = (before.remainingMs - reading.remainingMs) / 60_000;
    const ours = businessMsBetween(Date.parse(before.at), Date.parse(reading.at), CERTIFY_SUPPORT_CALENDAR) / 60_000;
    out.push({ driftMinutes: Math.round(jiraMoved - ours), jiraMovedMinutes: Math.round(jiraMoved), key: reading.key, oursMinutes: Math.round(ours) });
  }
  return out;
}

/* --------------------------------------------------------------------------- main */

async function main(): Promise<void> {
  const config = readOnlyJiraConfigFromEnv();
  const client = createReadOnlyJiraClient(config);
  const baseUrl = config.baseUrl.replace(/\/+$/, "");
  const now = new Date().toISOString();

  log(`Escalation pilot dry run - ${now} (read-only, nothing is posted anywhere)`);
  log("");

  /* 1. Calendar drift: the hardcoded copy of calendar 30 vs Jira's live one. */
  const liveCalendar = await client.get<{
    holidays?: Array<{ iso8601Date?: string; recurring?: boolean }>;
    timezoneId?: string;
    workingTimes?: Array<{ end?: number; start?: number; weekday?: string }>;
  }>("/rest/workinghours/1/api/calendar/30");
  const liveHolidays = new Set((liveCalendar.holidays ?? []).map((h) => `${h.iso8601Date}:${h.recurring}`));
  const ourHolidays = new Set(CERTIFY_SUPPORT_CALENDAR.holidays.map((h) => `${h.isoDate}:${h.recurring}`));
  const calendarDrift = [
    ...[...liveHolidays].filter((h) => !ourHolidays.has(h)).map((h) => `Jira has holiday ${h} that the pilot copy lacks`),
    ...[...ourHolidays].filter((h) => !liveHolidays.has(h)).map((h) => `pilot copy has holiday ${h} that Jira no longer has`),
    ...(liveCalendar.timezoneId !== CERTIFY_SUPPORT_CALENDAR.timezone ? [`timezone is ${liveCalendar.timezoneId}`] : []),
    ...((liveCalendar.workingTimes ?? []).some((w) => w.start !== 9 * 3_600_000 || w.end !== 18 * 3_600_000) ||
    (liveCalendar.workingTimes ?? []).length !== 5
      ? ["working hours are no longer Mon-Fri 09:00-18:00"]
      : []),
  ];

  /* 2. Every Support Ticket in Waiting for product. */
  const tsJql = `issuetype = ${SUPPORT_TICKET_ISSUE_TYPE_ID} AND status = ${WAITING_FOR_PRODUCT_STATUS_ID} ORDER BY key`;
  const [tsIssues, tsApprox] = await Promise.all([
    client.searchJql<JiraIssue>(tsJql, TS_FIELDS, { maxTotal: 1_000 }),
    client.approximateCount(tsJql),
  ]);

  /* 3. Every CP they link to, fetched with its OWN Pod (the routing key). */
  const cpKeys = [...new Set(tsIssues.flatMap((issue) => toTsSnapshot(issue, baseUrl, null).links.map((link) => link.cpKey)))].sort();
  const cpIssues: JiraIssue[] = [];
  for (let i = 0; i < cpKeys.length; i += 50) {
    const chunk = cpKeys.slice(i, i + 50);
    cpIssues.push(...(await client.searchJql<JiraIssue>(`key in (${chunk.join(",")})`, CP_FIELDS, { maxTotal: 100 })));
  }
  const cps = new Map(cpIssues.map((issue) => [issue.key, toCpSnapshot(issue, baseUrl)]));

  /* Simulating go-live: owners have no verified Slack ids yet, so "live" mode
     surfaces exactly what would block going live (person_unmapped, L3...). */
  const routing = seedRoutingRows("live");

  /* 4. WfP entry time from the changelog - only for tickets that actually join a pilot escalation. */
  const firstPass = classify(tsIssues.map((issue) => toTsSnapshot(issue, baseUrl, null)), cps, routing);
  const pilotTsKeys = new Set(firstPass.escalations.flatMap((group) => group.tickets.map((ticket) => ticket.key)));
  const wfpEntry = new Map<string, string | null>();
  await mapLimit([...pilotTsKeys], 5, async (key) => {
    const transitions = statusTransitions(await fullChangelog(client, key));
    const lastInto = [...transitions].reverse().find((t) => t.to === WAITING_FOR_PRODUCT_STATUS_ID);
    wfpEntry.set(key, lastInto?.at ?? null);
  });
  const tickets = tsIssues.map((issue) => toTsSnapshot(issue, baseUrl, wfpEntry.get(issue.key) ?? null));
  const result = classify(tickets, cps, routing);

  /* 5. Two plans: what day one of go-live would post (backlog timers start at
     go-live, one digest), and what the timers would say if counted from each
     ticket's real WfP entry (calibration only - never posted). */
  const goLive = planEscalations(result.escalations, { goLiveAt: now, now, policy: DEFAULT_ESCALATION_POLICY });
  const fromEntry = planEscalations(result.escalations, { now, policy: DEFAULT_ESCALATION_POLICY });

  /* 6. Measurements. */
  const [flap, readings] = await Promise.all([measureReleaseFlapLag(client), readRunningTtr(client)]);
  const readingsFile = kv.get("readings-file");
  let drift: ReturnType<typeof compareReadings> = [];
  if (readingsFile) {
    const previous = existsSync(readingsFile)
      ? readFileSync(readingsFile, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as SlaReading)
      : [];
    const latestPrevious = new Map<string, SlaReading>();
    for (const reading of previous) {
      latestPrevious.set(reading.key, reading);
    }
    drift = compareReadings([...latestPrevious.values()], readings);
    mkdirSync(dirname(readingsFile), { recursive: true });
    appendFileSync(readingsFile, readings.map((reading) => JSON.stringify(reading)).join("\n") + (readings.length ? "\n" : ""));
  }

  const unusualTypes = new Map<string, number>();
  for (const cp of cps.values()) {
    const outcome = cpOutcome(cp);
    if ((outcome === "open" || outcome === "fix_ready") && cp.issueTypeName !== EPIC_ISSUE_TYPE && !ESCALATION_CP_ISSUE_TYPES.has(cp.issueTypeName)) {
      unusualTypes.set(cp.issueTypeName, (unusualTypes.get(cp.issueTypeName) ?? 0) + 1);
    }
  }

  const methods = client.requestLog.reduce<Record<string, number>>((acc, entry) => {
    const label = entry.method === "POST" ? `POST ${entry.path}` : "GET";
    acc[label] = (acc[label] ?? 0) + 1;
    return acc;
  }, {});

  const report = {
    calendarDrift,
    cpTypesNotEscalated: Object.fromEntries(unusualTypes),
    epicOnlyTsKeys: result.epicOnlyTsKeys,
    escalations: fromEntry.planned.map((planned) => ({
      cpKey: planned.cpKey,
      effectivePriority: planned.effectivePriority,
      engineeringWaitBh: Math.round(planned.engineeringWaitBh * 10) / 10,
      levelDueIfTimedFromWfpEntry: planned.levelDue,
      nextLevel: planned.nextLevel,
      priorityBumpReasons: planned.priorityBumpReasons,
      state: planned.state,
      tsKeys: planned.tsKeys,
      waitT0: planned.waitT0,
    })),
    exceptions: result.exceptions,
    goLiveDayMessages: goLive.planned.flatMap((planned) => planned.messages.map((message) => ({ cpKey: planned.cpKey, ...message }))),
    goLiveRateLimited: goLive.rateLimited,
    heldForQuietHours: goLive.heldForQuietHours,
    jiraRequests: methods,
    measurements: {
      releaseToBlockedLagMinutes: {
        max: flap.lagsMinutes.at(-1) ?? null,
        p50: percentile(flap.lagsMinutes, 50),
        p95: percentile(flap.lagsMinutes, 95),
        pairs: flap.lagsMinutes.length,
        sampledCps: flap.sampled,
      },
      runningTtrReadings: readings.length,
      slaClockDrift: drift,
    },
    outOfScopeByPod: result.outOfScopeByPod,
    sweep: { cpsFetched: cps.size, cpsLinked: cpKeys.length, tsApproximateCount: tsApprox, tsInWaitingForProduct: tsIssues.length },
  };

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  /* --------------------------------------------------------------- text report */
  log(`Swept ${tsIssues.length} Support Tickets in Waiting for product (Jira count ~${tsApprox}), linked to ${cpKeys.length} CPs (${cps.size} readable).`);
  log(`Calendar 30 drift: ${calendarDrift.length === 0 ? "none" : calendarDrift.join("; ")}`);
  log("");

  log(`PILOT (Credentialing, CP Pod ${PILOT_POD_OPTION_ID}) - ${result.escalations.length} escalations would open`);
  for (const planned of fromEntry.planned) {
    log(
      `  ${planned.cpKey.padEnd(9)} ${planned.state.padEnd(9)} ${planned.effectivePriority.padEnd(8)} ` +
        `${String(planned.tsKeys.length).padStart(2)} TS  waited ${bh(planned.engineeringWaitBh * 3_600_000).padStart(9)}  ` +
        `level if timed from WfP entry: L${planned.levelDue}` +
        (planned.nextLevel ? ` (L${planned.nextLevel.level} in ${planned.nextLevel.dueInBh.toFixed(1)} bh)` : "") +
        (planned.priorityBumpReasons.length ? `  bump: ${planned.priorityBumpReasons.join("; ")}` : ""),
    );
  }
  log("");

  const levelCounts = [0, 1, 2, 3].map((level) => fromEntry.planned.filter((planned) => planned.levelDue === level).length);
  log(`If timers counted from real WfP entry (calibration only): L0 ${levelCounts[0]}, L1 ${levelCounts[1]}, L2 ${levelCounts[2]}, L3 ${levelCounts[3]}`);
  log(
    `Go-live day instead: backlog timers start now, ${goLive.planned.filter((planned) => planned.messages.length > 0).length} parents post ` +
      `(caps: ${DEFAULT_ESCALATION_POLICY.maxNewParentsPerRun}/run, ${DEFAULT_ESCALATION_POLICY.maxNewParentsPerDay}/day), ` +
      `${goLive.rateLimited.length} wait for later runs, ${goLive.heldForQuietHours.length} held for business hours.`,
  );
  log("");

  const sample = goLive.planned.find((planned) => planned.messages.some((message) => message.kind === "parent"));
  const sampleParent = sample?.messages.find((message) => message.kind === "parent");
  if (sample && sampleParent) {
    log(`Sample parent message (${sample.cpKey}) - would post to the Credentialing channel once live:`);
    log(sampleParent.text.split("\n").map((line) => `  | ${line}`).join("\n"));
    log("");
  }
  const digest = goLive.planned.flatMap((planned) => planned.messages).find((message) => message.kind === "backlog_digest");
  if (digest) {
    log("Backlog digest (one message at go-live):");
    log(digest.text.split("\n").map((line) => `  | ${line}`).join("\n"));
    log("");
  }

  const byKind = new Map<string, { actionable: number; info: number }>();
  for (const exception of result.exceptions) {
    const counts = byKind.get(exception.kind) ?? { actionable: 0, info: 0 };
    counts[exception.tier] += 1;
    byKind.set(exception.kind, counts);
  }
  log(`Exceptions: ${result.exceptions.filter((e) => e.tier === "actionable").length} actionable, ${result.exceptions.filter((e) => e.tier === "info").length} info`);
  for (const [kind, counts] of [...byKind.entries()].sort()) {
    log(`  ${kind.padEnd(28)} actionable ${String(counts.actionable).padStart(3)}   info ${String(counts.info).padStart(3)}`);
  }
  for (const exception of result.exceptions.filter((e) => e.tier === "actionable").slice(0, 15)) {
    log(`    - ${exception.kind}: ${[exception.podName, exception.tsKey, exception.cpKey].filter(Boolean).join(" / ")} - ${exception.detail}`);
  }
  log("");

  log(`Out of scope (other pods, counted only): ${Object.entries(result.outOfScopeByPod).map(([pod, n]) => `${pod} ${n}`).join(", ") || "none"}`);
  log(`Epic-only tickets (block closure, never escalate): ${result.epicOnlyTsKeys.length}`);
  log(`Pending CPs of a type that never escalates: ${unusualTypes.size === 0 ? "none" : [...unusualTypes].map(([t, n]) => `${t} ${n}`).join(", ")}`);
  log("");

  const lag = report.measurements.releaseToBlockedLagMinutes;
  log("Measurements:");
  log(
    `  Released/Closed -> Blocked flapping (last 60 days): ${lag.pairs} flips across ${lag.sampledCps} CPs; ` +
      (lag.pairs ? `p50 ${lag.p50?.toFixed(1)} min, p95 ${lag.p95?.toFixed(1)} min, max ${lag.max?.toFixed(1)} min` : "no flips") +
      ` (resolve grace is currently ${DEFAULT_ESCALATION_POLICY.resolveGraceMinutes} min)`,
  );
  log(`  Running Time to Resolution readings taken: ${readings.length}` + (readingsFile ? ` (appended to ${readingsFile})` : " (pass --readings-file=... to compare across runs)"));
  for (const d of drift) {
    log(`    ${d.key}: Jira clock moved ${d.jiraMovedMinutes} min, ours ${d.oursMinutes} min, drift ${d.driftMinutes} min`);
  }
  log("");
  log(`Jira requests made: ${Object.entries(methods).map(([label, n]) => `${label} x${n}`).join(", ")} - no writes are possible.`);
}

main().catch((error: unknown) => {
  console.error("Dry run failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
