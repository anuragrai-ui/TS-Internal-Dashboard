import { isWithinBusinessHours } from "@/lib/escalation/businessHours";
import { planEscalations } from "@/lib/escalation/plan";
import {
  DEFAULT_ESCALATION_POLICY,
  isEscalationKilled,
  PILOT_POD_OPTION_ID,
  seedRoutingRows,
  WAITING_FOR_PRODUCT_STATUS_ID,
} from "@/lib/escalation/policy";
import { createReadOnlyJiraClient, readOnlyJiraConfigFromEnv } from "@/lib/escalation/readOnlyJira";
import {
  acquireRunLock,
  acquireRunThrottle,
  countParentOpened,
  forgetRecord,
  getAck,
  getRunnerConfig,
  getSent,
  getShadowChannel,
  loadEpisodeFloors,
  loadRecords,
  markSent,
  parentsOpenedOn,
  releaseRunLock,
  saveLastRun,
  saveRecord,
} from "@/lib/escalation/runnerStore";
import { isLiveState } from "@/lib/escalation/stateMachine";
import { CP_FIELDS, searchByKeys, statusCategory, sweepWaitingForProduct, toCpSnapshot } from "@/lib/escalation/sweep";
import { applyEffect, stepEscalation } from "@/lib/escalation/threadUpdates";
import { rememberPostedSlackMessage } from "@/lib/notifications/slackThreads";
import { addNotifications } from "@/lib/notifications/store";
import { isRedisConfigured } from "@/lib/redis";
import { getSlackPermalink, postSlackMessageDetailed } from "@/lib/slackApi";
import { neutralizeMentions } from "@/lib/slackTestMode";
import { listRegisteredJiraUsers } from "@/lib/userJiraTokens";

import type { EscalationRecord, RunnerConfig, RunSummary } from "@/lib/escalation/runnerStore";
import type { CurrentObservation } from "@/lib/escalation/stateMachine";
import type { Outbound } from "@/lib/escalation/threadUpdates";
import type { EscalationGroup, PlannedEscalation, RoutingRow } from "@/lib/escalation/types";
import type { AppNotification } from "@/lib/notifications/types";

/**
 * The escalation pilot's SHADOW runner: the same Jira sweep, classification,
 * ladder and state machine as the dry run, but stateful, and it really posts
 * - only ever to the shadow channel (the Slack test channel), with nobody
 * @-mentioned. One thread per CP: a parent message when the CP first
 * qualifies, then every ladder level and state change as a reply in it.
 *
 * Nothing here can write to Jira (read-only client). There is no live mode
 * yet: posting to a pod channel needs the go-live checklist in the README.
 *
 * Scheduling: Vercel Hobby cron is daily, so a run is kicked off by the
 * dashboard's own notification polls, at most once every 10 minutes across
 * all browsers (plus "Run now" on the Escalations page). With nobody on the
 * dashboard, nothing runs; the next run catches up, because each run
 * recomputes everything from Jira.
 */

const LABEL_FOR_LEVEL: Record<1 | 2 | 3, string> = { 1: "wait warning", 2: "wait breach", 3: "top-owner escalation" };
const RECORD_RETENTION_MS = 30 * 86_400_000;

function etDay(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { day: "2-digit", month: "2-digit", timeZone: "America/New_York", year: "numeric" }).format(now);
}

/* Shadow posts never ping anyone, and the parent says where it would go once live. */
function shadowText(placement: Outbound["placement"], text: string, podChannelId: string | undefined, quiet: boolean): string {
  const safe = neutralizeMentions(text);
  if (placement === "thread") {
    return safe;
  }
  const where = podChannelId ? `<#${podChannelId}>` : "the pod's channel";
  const hold = quiet ? " Live mode would hold it for business hours (Mon-Fri 9:00-18:00 ET)." : "";
  return `:ghost: *Shadow run* - not live yet. Once live, this posts to ${where}. Nobody is @-mentioned.${hold}\n\n${safe}`;
}

function notificationFor(
  message: Outbound,
  record: EscalationRecord,
  planned: PlannedEscalation | null,
  audience: string[],
  url: string | undefined,
): AppNotification | null {
  const base = {
    at: new Date().toISOString(),
    audience,
    cpKey: record.cpKey,
    id: `esc:${message.dedupeKey}`,
    source: "escalation" as const,
    ticketKey: record.qualifyingTsKeys?.[0] ?? record.tsKeys[0],
    url,
  };
  const waiting = (record.qualifyingTsKeys ?? []).length;

  if (message.kind === "parent") {
    return {
      ...base,
      detail: [`${waiting} TS ticket${waiting === 1 ? "" : "s"} waiting`, planned?.effectivePriority, record.podName ? `${record.podName} pod` : null]
        .filter(Boolean)
        .join(" · "),
      important: true,
      kind: "escalation_opened",
      title: `Escalation thread opened for ${record.cpKey}`,
    };
  }
  if (message.effect.type === "level") {
    const level = message.effect.level;
    return {
      ...base,
      detail: planned ? `${Math.floor(planned.engineeringWaitBh)} business hours waiting on engineering · ${planned.effectivePriority}` : undefined,
      important: level >= 2,
      kind: "escalation_update",
      title: `${record.cpKey} escalation reached L${level} (${LABEL_FOR_LEVEL[level]})`,
    };
  }
  if (message.effect.type === "state") {
    const titles: Partial<Record<string, string>> = {
      acked: `${record.cpKey} escalation resumed`,
      fix_ready: `${record.cpKey} fix is ready - escalation paused`,
      frozen_pod_changed: `${record.cpKey} moved pods - escalation stopped`,
      handed_back: `${record.cpKey} escalation stopped: no tickets waiting`,
      open: `${record.cpKey} escalation resumed`,
      resolved: `${record.cpKey} escalation resolved${record.resolutionReason ? ` (${record.resolutionReason.replace("_", " ")})` : ""}`,
    };
    const title = titles[message.effect.state];
    return title
      ? { ...base, important: message.effect.state === "fix_ready" || message.effect.state === "resolved", kind: "escalation_update", title }
      : null;
  }
  if (message.effect.type === "tickets") {
    return { ...base, important: false, kind: "escalation_update", title: `${record.cpKey}: waiting tickets changed (${waiting} now)` };
  }
  return null;
}

/** Throttled entry point for the notification poll: one run per 10 minutes across every open dashboard, only while shadow mode is on. */
export async function maybeRunEscalations(): Promise<RunSummary | null> {
  if (!isRedisConfigured() || !(await acquireRunThrottle())) {
    return null;
  }
  const config = await getRunnerConfig();
  return config.mode === "shadow" ? runEscalationsOnce("poll") : null;
}

export async function runEscalationsOnce(trigger: RunSummary["trigger"], now: Date = new Date()): Promise<RunSummary> {
  const started = Date.now();
  const base: RunSummary = { at: now.toISOString(), durationMs: 0, heldBackByCaps: [], posted: [], trackedLive: 0, trigger };

  if (!isRedisConfigured()) {
    return { ...base, skipped: "unconfigured" };
  }
  const config = await getRunnerConfig();
  if (config.mode !== "shadow") {
    return { ...base, skipped: "off" };
  }
  if (isEscalationKilled()) {
    return { ...base, skipped: "killed" };
  }
  const shadowChannel = getShadowChannel();
  if (!shadowChannel) {
    return { ...base, skipped: "no_shadow_channel" };
  }
  if (!(await acquireRunLock())) {
    return { ...base, skipped: "already_running" };
  }

  let summary: RunSummary;
  try {
    summary = await runLocked(base, config, shadowChannel, now);
  } catch (error) {
    summary = { ...base, error: error instanceof Error ? error.message : String(error) };
    console.warn("Escalation shadow run failed.", summary.error);
  } finally {
    await releaseRunLock();
  }

  summary.durationMs = Date.now() - started;
  await saveLastRun(summary);
  return summary;
}

async function runLocked(base: RunSummary, config: RunnerConfig, shadowChannel: string, now: Date): Promise<RunSummary> {
  const policy = DEFAULT_ESCALATION_POLICY;
  const nowIso = now.toISOString();
  const jira = readOnlyJiraConfigFromEnv();
  const client = createReadOnlyJiraClient(jira);
  const baseUrl = jira.baseUrl.replace(/\/+$/, "");

  const routing: RoutingRow[] = seedRoutingRows("shadow").map((row) =>
    row.podOptionId === PILOT_POD_OPTION_ID ? { ...row, shadowChannelId: shadowChannel } : row,
  );
  const pilotRow = routing.find((row) => row.podOptionId === PILOT_POD_OPTION_ID);
  const sweep = await sweepWaitingForProduct(client, baseUrl, routing);
  const groups = new Map<string, EscalationGroup>(
    sweep.classification.escalations.filter((group) => group.routing.podOptionId === PILOT_POD_OPTION_ID).map((group) => [group.cp.key, group]),
  );
  const [records, episodeFloors] = await Promise.all([loadRecords(), loadEpisodeFloors()]);

  /* Which TS tickets are in Waiting for product on each CP, whatever the CP's outcome - the state
     machine's WfP membership. A shipped CP drops out of the groups, but its tickets haven't left. */
  const waitingByCp = new Map<string, string[]>();
  for (const ticket of sweep.tickets) {
    for (const cpKey of new Set(ticket.links.map((link) => link.cpKey))) {
      waitingByCp.set(cpKey, [...(waitingByCp.get(cpKey) ?? []), ticket.key]);
    }
  }

  /* Every pilot group, plus every escalation whose episode is still running. A finished one only
     matters again if its CP is back in a group (a reopen), which the first set already covers. */
  const liveKeys = [...records.values()].filter((record) => isLiveState(record.state)).map((record) => record.cpKey);
  const cpKeys = [...new Set([...groups.keys(), ...liveKeys])];

  const cps = new Map(sweep.cps);
  const missingCps = cpKeys.filter((key) => !cps.has(key));
  for (const issue of missingCps.length > 0 ? await searchByKeys(client, missingCps, CP_FIELDS) : []) {
    cps.set(issue.key, toCpSnapshot(issue, baseUrl));
  }

  const ticketsByKey = new Map(sweep.tickets.map((ticket) => [ticket.key, ticket]));
  const attachedKeys = new Set(cpKeys.flatMap((key) => [...(records.get(key)?.tsKeys ?? []), ...(waitingByCp.get(key) ?? [])]));
  const attachedTsStates: CurrentObservation["attachedTsStates"] = {};
  for (const key of attachedKeys) {
    const ticket = ticketsByKey.get(key);
    if (ticket) {
      attachedTsStates[key] = { inWfp: true, statusCategory: ticket.statusCategory };
    }
  }
  const unseen = [...attachedKeys].filter((key) => !ticketsByKey.has(key));
  for (const issue of unseen.length > 0 ? await searchByKeys(client, unseen, ["status"]) : []) {
    attachedTsStates[issue.key] = { inWfp: issue.fields.status?.id === WAITING_FOR_PRODUCT_STATUS_ID, statusCategory: statusCategory(issue.fields.status) };
  }

  /* Planned uncapped: the caps are applied below, in the planner's order (most urgent first). */
  const plan = planEscalations([...groups.values()], {
    goLiveAt: config.goLiveAt,
    now: nowIso,
    policy: { ...policy, maxNewParentsPerDay: Number.MAX_SAFE_INTEGER, maxNewParentsPerRun: Number.MAX_SAFE_INTEGER },
  });
  const plannedByCp = new Map(plan.planned.map((planned) => [planned.cpKey, planned]));
  const digest = plan.planned.flatMap((planned) => planned.messages).find((message) => message.kind === "backlog_digest") ?? null;
  const ordered = [...plan.planned.map((planned) => planned.cpKey), ...cpKeys.filter((key) => !plannedByCp.has(key)).sort()];

  const users = await listRegisteredJiraUsers();
  const registered = new Set(users.map((user) => user.accountId));
  const quiet = !isWithinBusinessHours(now.getTime(), policy.calendar);
  const day = etDay(now);
  let openedToday = await parentsOpenedOn(day);
  let openedThisRun = 0;
  const posted: RunSummary["posted"] = [];
  const heldBackByCaps: string[] = [];

  for (const cpKey of ordered) {
    let previous = records.get(cpKey) ?? null;
    const group = groups.get(cpKey) ?? null;
    if (previous === null && group === null) {
      continue;
    }

    /* A ✅ from Slack is stored on its own key by the event handler; fold it in before reconciling. */
    if (previous && previous.state === "open") {
      const ack = await getAck(cpKey, previous.episode);
      if (ack) {
        previous = { ...previous, ackedAt: ack.ackedAt, ackedBySlackId: ack.slackUserId, announcedState: "acked", state: "acked" };
      }
    }

    const planned = plannedByCp.get(cpKey) ?? null;
    const step = stepEscalation({
      attachedTsStates,
      cp: cps.get(cpKey) ?? null,
      cpKey,
      episodeFloor: episodeFloors.get(cpKey),
      group,
      now: nowIso,
      planned,
      policy,
      previous,
      ticketUrl: (key) => `${baseUrl}/browse/${key}`,
      waitingTsKeys: waitingByCp.get(cpKey) ?? [],
    });
    if (!step) {
      continue;
    }

    let record = step.record;
    const outbound = step.outbound;
    const opensThread = outbound.some((message) => message.kind === "parent");

    if (opensThread && (openedThisRun >= policy.maxNewParentsPerRun || openedToday >= policy.maxNewParentsPerDay)) {
      /* The state still advances; the thread opens on a later run, most urgent first. */
      heldBackByCaps.push(cpKey);
      await saveRecord(record);
      continue;
    }

    /* Everyone who owns a waiting ticket and uses the dashboard, plus whoever switched the shadow run on. */
    const audience = [
      ...new Set([
        ...(record.qualifyingTsKeys ?? [])
          .map((key) => ticketsByKey.get(key)?.assigneeAccountId)
          .filter((id): id is string => Boolean(id && registered.has(id))),
        ...(config.enabledByAccountId && registered.has(config.enabledByAccountId) ? [config.enabledByAccountId] : []),
      ]),
    ];

    if (opensThread && digest && planned && config.goLiveAt && Date.parse(planned.waitT0) === Date.parse(config.goLiveAt) && !(await getSent(digest.dedupeKey))) {
      const digestPost = await postSlackMessageDetailed(shadowChannel, shadowText("channel", digest.text, pilotRow?.channelId, quiet));
      if (digestPost) {
        await markSent(digest.dedupeKey, { channel: digestPost.channel, ts: digestPost.ts });
        posted.push({ cpKey, kind: "backlog_digest" });
      }
    }

    const notifications: AppNotification[] = [];
    for (const message of outbound) {
      if (message.text === null) {
        record = applyEffect(record, message, null, nowIso);
        continue;
      }
      if (message.placement === "thread" && !record.threadTs) {
        break;
      }

      let ref = await getSent(message.dedupeKey);
      if (!ref) {
        const sent = await postSlackMessageDetailed(
          shadowChannel,
          shadowText(message.placement, message.text, pilotRow?.channelId, quiet),
          message.placement === "thread" ? { threadTs: record.threadTs } : {},
        );
        if (!sent) {
          /* Slack refused or is down: stop here for this CP and decide it all again next run. */
          break;
        }
        ref = { channel: sent.channel, ts: sent.ts };
        await markSent(message.dedupeKey, ref);
        posted.push({ cpKey, kind: message.kind });

        await rememberPostedSlackMessage(ref.channel, ref.ts, {
          audience,
          cpKey,
          kind: "escalation",
          label: `the escalation thread for ${cpKey}`,
          ticketKeys: record.qualifyingTsKeys ?? [],
          threadTs: message.placement === "thread" ? (record.threadTs ?? ref.ts) : ref.ts,
        });
        const permalink = (await getSlackPermalink(ref.channel, ref.ts)) ?? undefined;
        const notification = notificationFor(message, record, planned, audience, permalink);
        if (notification) {
          notifications.push(notification);
        }
        if (message.kind === "parent") {
          record.permalink = permalink;
          /* Only a parent actually posted now counts toward the caps - one recovered from the ledger already did. */
          openedThisRun += 1;
          openedToday += 1;
          await countParentOpened(day);
        }
      }

      record = applyEffect(record, message, ref, nowIso);
    }

    await saveRecord(record);
    if (notifications.length > 0) {
      await addNotifications(notifications, new Date());
    }
  }

  /* Finished episodes are kept a month (a reopen inside that window is still recognised as one), then dropped. */
  for (const record of records.values()) {
    if (!isLiveState(record.state) && !groups.has(record.cpKey) && Date.parse(record.updatedAt ?? "") < now.getTime() - RECORD_RETENTION_MS) {
      await forgetRecord(record.cpKey);
    }
  }

  const exceptions = sweep.classification.exceptions;
  const liveAfter = [...(await loadRecords()).values()].filter((record) => isLiveState(record.state)).length;

  return {
    ...base,
    exceptions: {
      actionable: exceptions.filter((exception) => exception.tier === "actionable").length,
      info: exceptions.filter((exception) => exception.tier === "info").length,
    },
    heldBackByCaps,
    posted,
    trackedLive: liveAfter,
  };
}
