import { getIssueByKey } from "@/lib/jiraClient";
import type { FormattedIssue } from "@/lib/jiraClient";
import { resolvePodRoute } from "@/lib/podRouting";
import { findSlackUserIdByName } from "@/lib/slackApi";

import type { SlaFollowUpCandidate } from "@/lib/slaFollowup";

export interface SlaBreachAlertDraft {
  channel: string;
  pmDisplayName?: string;
  podName?: string;
  text: string;
}

/**
 * Only meaningful when the underlying blocker is a Product-side CP ticket
 * that isn't being worked on ("cp_not_worked") and we're now late even by
 * our own SLA-breach buffer (missedSla) - tagging a POD's PM only makes
 * sense when Product is the party that can actually act. A client's own
 * silence ("no_reporter_response") has no Product-side fix, so this alert
 * doesn't apply there - and stage 3 candidates always have missedSla:false
 * (see slaFollowup.ts), so they're excluded automatically.
 */
export function isEligibleForSlaBreachAlert(candidate: SlaFollowUpCandidate): boolean {
  return candidate.missedSla && candidate.reason === "cp_not_worked" && Boolean(candidate.issue.linked_cp_issue);
}

/**
 * Builds the Slack alert for an SLA-breached, CP-blocked TS ticket -
 * routes to the POD that owns the blocking CP (not the TS ticket's own pod,
 * since the TS ticket belongs to support - the CP is what's actually stuck
 * on Product's side), tagging that POD's PM. Never throws: an unresolved
 * Slack user just becomes a plain-text @name in the message rather than a
 * real mention, and an unmapped POD falls back to the Technical Support
 * channel (see resolvePodRoute).
 */
export async function buildSlaBreachAlert(
  candidate: SlaFollowUpCandidate,
  getIssue: (key: string) => Promise<FormattedIssue | null> = getIssueByKey,
  findSlackUserId: (name: string) => Promise<string | null> = findSlackUserIdByName,
): Promise<SlaBreachAlertDraft | null> {
  if (!isEligibleForSlaBreachAlert(candidate)) {
    return null;
  }

  const { issue } = candidate;
  const linkedCpKey = issue.linked_cp_issue?.key;

  if (!linkedCpKey) {
    return null;
  }

  const linkedCp = await getIssue(linkedCpKey);
  const route = resolvePodRoute(linkedCp?.pod);
  const pmSlackId = route.pm ? await findSlackUserId(route.pm) : null;
  const pmMention = pmSlackId ? `<@${pmSlackId}>` : route.pm ? `@${route.pm}` : "team";
  const daysStuck = Math.round(candidate.daysSinceLastActivity * 10) / 10;

  const text = [
    `:rotating_light: *SLA breach* on <${issue.url}|${issue.key}> - ${issue.summary ?? "no summary"}.`,
    `It's blocked on <${linkedCp?.url ?? `https://certifyos.atlassian.net/browse/${linkedCpKey}`}|${linkedCpKey}>, which hasn't moved in ${daysStuck} days and we're now past our own SLA on this one.`,
    `${pmMention} could you help get this assigned and share an ETA / fix when you get a chance? Really appreciate the help - thank you!`,
  ].join("\n");

  return { channel: route.slackChannel, pmDisplayName: route.pm, podName: linkedCp?.pod, text };
}
