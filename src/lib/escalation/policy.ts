import { FALLBACK_SLACK_CHANNEL, POD_ROUTING } from "@/lib/podRouting";

import type { BusinessCalendar, PersonRef, Priority, RoutingMode, RoutingRow } from "@/lib/escalation/types";

/**
 * Pilot policy for the engineering-escalation service. Every number here is
 * a PROPOSAL from the 2026-10-02 discovery (see README "Engineering
 * escalation pilot"), to be calibrated during the shadow week - not an
 * agreed SLA. Ids were read live from Jira on 2026-10-02.
 */

export const SUPPORT_TICKET_ISSUE_TYPE_ID = "10844";
export const WAITING_FOR_PRODUCT_STATUS_ID = "10633";
export const TIME_TO_RESOLUTION_FIELD = "customfield_10650";
export const POD_FIELD = "customfield_10165";
export const MAJOR_INCIDENT_FIELD = "customfield_10046";

/* JSM calendar 30 "Certify Support", read from /rest/workinghours/1/api/calendar/30
   on 2026-10-02. The dry run re-reads it and flags any drift (calendar_mismatch). */
const NINE_AM_MS = 9 * 3_600_000;
const SIX_PM_MS = 18 * 3_600_000;

export const CERTIFY_SUPPORT_CALENDAR: BusinessCalendar = {
  holidays: [
    { isoDate: "2026-01-01", name: "New Years Day", recurring: true },
    { isoDate: "2026-01-19", name: "Martin Luther King Jr Day", recurring: true },
    { isoDate: "2026-02-16", name: "Presidents Day", recurring: true },
    { isoDate: "2026-05-25", name: "Memorial Day", recurring: true },
    { isoDate: "2026-06-19", name: "Juneteenth", recurring: true },
    { isoDate: "2026-07-03", name: "Independence Day observed", recurring: true },
    { isoDate: "2026-09-07", name: "Labor Day", recurring: true },
    { isoDate: "2026-10-12", name: "Indigenous Peoples Day", recurring: true },
    { isoDate: "2026-11-11", name: "Veterans Day", recurring: true },
    { isoDate: "2026-11-26", name: "Thanksgiving Day", recurring: true },
    { isoDate: "2026-11-27", name: "Day After Thanksgiving", recurring: true },
    { isoDate: "2026-12-24", name: "Christmas Eve", recurring: true },
    { isoDate: "2026-12-25", name: "Christmas Day", recurring: true },
  ],
  id: "30",
  name: "Certify Support",
  timezone: "America/New_York",
  workingTimes: [1, 2, 3, 4, 5].map((weekday) => ({ endMs: SIX_PM_MS, startMs: NINE_AM_MS, weekday })),
};

/* CP issue types an escalation may be keyed on. Epics are excluded (they
   still block closure - see src/lib/linkedCp.ts - but never escalate). */
export const ESCALATION_CP_ISSUE_TYPES = new Set(["Bug", "Task", "Story", "Sub-task", "Sub-Bug", "Hotfix Request"]);
export const EPIC_ISSUE_TYPE = "Epic";

/* CP statuses/resolutions -> CpOutcome (see types.ts). Done-category alone is
   not enough: Ready for Release (10131) is "done" in Jira but unshipped. */
export const FIX_READY_STATUS_IDS = new Set(["10131" /* Ready for Release */, "12665" /* HF-Ready for Release */]);
export const SHIPPED_STATUS_IDS = new Set(["10571" /* Released */, "12666" /* HF-Released */, "12912" /* HF-Closed */]);
export const REJECTED_STATUS_IDS = new Set(["12663" /* HF-Rejected */, "10132" /* Won't Do (Epic) */]);
export const CLOSED_STATUS_ID = "6";
/* A Closed CP with one of these resolutions closed WITHOUT a fix. */
export const REJECTED_RESOLUTION_IDS = new Set([
  "10002" /* Duplicate */,
  "10003" /* Cannot Reproduce */,
  "10004" /* Declined */,
  "10006" /* Known Issue */,
  "10009" /* Won't Do */,
  "10046" /* Working as Designed */,
]);

export interface LadderThresholds {
  /* Engineering-wait levels, in business hours since WfP entry: L1 warn, L2 breach, L3 top owner. */
  l1Bh: number;
  l2Bh: number;
  l3Bh: number;
}

export interface EscalationPolicy {
  /* Acknowledge due, in business hours after the parent posts; reminders at 1x, 2x (adds PM Manager), 3x (adds L3). */
  ackDueBh: Record<Priority, number>;
  calendar: BusinessCalendar;
  ladder: Record<Priority, LadderThresholds>;
  maxNewParentsPerDay: number;
  maxNewParentsPerRun: number;
  /* Priority goes up one step when 3+ TS tickets wait on the same CP. */
  priorityBumpAttachedTickets: number;
  /* ...or when the lowest frozen TTR remaining is at or below this fraction of its goal (or already breached). */
  priorityBumpTtrRemainingFraction: number;
  /* Minutes a CP must stay shipped/rejected before resolving (absorbs the open-PR guard flipping Released -> Blocked). Provisional until measured. */
  resolveGraceMinutes: number;
  version: string;
}

export const DEFAULT_ESCALATION_POLICY: EscalationPolicy = {
  ackDueBh: { Critical: 2, High: 4, Low: 18, Medium: 9 },
  calendar: CERTIFY_SUPPORT_CALENDAR,
  ladder: {
    Critical: { l1Bh: 4, l2Bh: 9, l3Bh: 18 },
    High: { l1Bh: 27, l2Bh: 45, l3Bh: 72 },
    Low: { l1Bh: 90, l2Bh: 180, l3Bh: 270 },
    Medium: { l1Bh: 45, l2Bh: 90, l3Bh: 135 },
  },
  maxNewParentsPerDay: 10,
  maxNewParentsPerRun: 3,
  priorityBumpAttachedTickets: 3,
  priorityBumpTtrRemainingFraction: 0.25,
  resolveGraceMinutes: 30,
  version: "2026-10-02-proposal",
};

/* All 22 Pod (customfield_10165) options, read 2026-10-02. Unknown option
   ids raise cp_pod_unmapped; known pods with mode "off" are only counted. */
export const POD_OPTIONS: Array<{ id: string; name: string }> = [
  { id: "12446", name: "AI/ML" },
  { id: "12448", name: "Credentialing" },
  { id: "10228", name: "Data Integration" },
  { id: "12440", name: "Data Refresh" },
  { id: "10324", name: "Developer Efficiency" },
  { id: "10325", name: "DevOps" },
  { id: "12444", name: "MDM" },
  { id: "12441", name: "Monitoring" },
  { id: "12442", name: "Payer Enrollment & Licensing" },
  { id: "10361", name: "Provider Portal" },
  { id: "12443", name: "Roster" },
  { id: "12445", name: "Scrapers" },
  { id: "12447", name: "Shared Services" },
  { id: "15555", name: "Outreach" },
  { id: "15588", name: "TS" },
  { id: "15621", name: "Data Analytics" },
  { id: "15906", name: "Rules Configuration" },
  { id: "16173", name: "Classic Sustenance" },
  { id: "16206", name: "Data Research" },
  { id: "16239", name: "Portal Rebuild" },
  { id: "16439", name: "Pipeline Pod" },
  { id: "16618", name: "PDM" },
];

export const PILOT_POD_OPTION_ID = "12448"; /* Credentialing */

function person(displayName: string | undefined): PersonRef | undefined {
  /* Names only - Slack/Jira ids get filled in (verified) on the routing page later. */
  return displayName ? { displayName } : undefined;
}

/**
 * Seeds one routing row per Pod option from the existing POD_ROUTING org
 * chart. Only the pilot pod gets a mode other than "off". The fallback
 * Technical Support channel is never used for escalations - a pod without
 * its own channel simply has none.
 */
export function seedRoutingRows(pilotMode: RoutingMode = "observe"): RoutingRow[] {
  return POD_OPTIONS.map(({ id, name }) => {
    const route = POD_ROUTING[name];
    const channelId = route && route.slackChannel !== FALLBACK_SLACK_CHANNEL ? route.slackChannel : undefined;

    return {
      channelId,
      extraAckers: [],
      mode: id === PILOT_POD_OPTION_ID ? pilotMode : "off",
      owners: {
        em: person(route?.em),
        pm: person(route?.pm),
        pmManager: person(route?.pmManager),
      },
      podName: name,
      podOptionId: id,
    };
  });
}

/** Redeploy-time backstop only; the instant pause switch lives in the state store once it exists. */
export function isEscalationKilled(): boolean {
  return process.env.ESCALATION_KILL === "1" || process.env.ESCALATION_KILL === "true";
}
