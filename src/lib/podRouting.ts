/**
 * Static POD -> org-chart mapping, sourced directly from the team's org
 * sheet (pasted by the user, cross-checked against real ticket data - e.g.
 * Scrapers' Tech Lead Abhiraj Singh Kular is the live assignee on CP-37735,
 * whose `pod` field is "Scrapers"). Every `FormattedIssue.pod` value
 * currently seen on real tickets is covered; a POD not in this map (or an
 * issue with no `pod` set at all) falls back to `FALLBACK_SLACK_CHANNEL`
 * with no EM/PM/PM Manager to tag - confirmed with the user rather than
 * guessed, since a wrong Slack channel/mention here pings a real person.
 *
 * Names, not accountIds/Slack IDs, are stored here - resolving a name to a
 * Jira accountId (findJiraUserByName in jiraClient.ts) or a Slack user ID
 * (via email lookup) happens lazily where needed, both cached, so this table
 * stays a plain, human-editable source of truth.
 */
export interface PodRoute {
  /** Engineering Manager - confirmed blank (no fallback) for Applied AI, Outreach, and unset entirely for Pipeline Pod. */
  em?: string;
  /** Product Manager - confirmed blank for Data Refresh. */
  pm?: string;
  /**
   * Second-tier escalation contact when a nudge gets no response within
   * cadence. Confirmed blank for Outreach, Data Integration, Scrapers, Data
   * Refresh, and unset for Pipeline Pod - per the user, a blank PM Manager
   * means skip the 2nd-tier tag entirely rather than guessing a substitute.
   */
  pmManager?: string;
  slackChannel: string;
}

/** Technical Support - the agreed fallback for any POD without its own channel below. */
export const FALLBACK_SLACK_CHANNEL = "C07U9C0EPEH";

export const POD_ROUTING: Record<string, PodRoute> = {
  Credentialing: {
    em: "Saro Deravanesian",
    pm: "Prashanth Venkataraman",
    pmManager: "Simon Hayhurst",
    slackChannel: "C08CUMU0F6G",
  },
  "Classic Sustenance": {
    em: "Saro Deravanesian",
    pm: "Daisy Xiao",
    pmManager: "Ammar Jagirdar",
    slackChannel: FALLBACK_SLACK_CHANNEL,
  },
  "Provider Portal": {
    em: "Ansar Memon",
    pm: "Ruchika Jain",
    pmManager: "Simon Hayhurst",
    slackChannel: "C096TU44HDH",
  },
  // Jira's Pod dropdown value is "PDM" - the org sheet's column is "Provider Data Management".
  PDM: {
    em: "Ansar Memon",
    pm: "Madhunika Sivasankar",
    pmManager: "Ammar Jagirdar",
    slackChannel: "C0939KN291V",
  },
  Roster: {
    em: "Ansar Memon",
    pm: "Anmol Wassan",
    pmManager: "Ammar Jagirdar",
    slackChannel: "C0939KN291V",
  },
  Outreach: {
    em: "Dinusha Rathnayaka",
    pm: "Conor Lang",
    slackChannel: FALLBACK_SLACK_CHANNEL,
  },
  "Data Integration": {
    em: "John Anderson",
    pm: "Prashanth Venkataraman",
    slackChannel: FALLBACK_SLACK_CHANNEL,
  },
  Scrapers: {
    em: "John Anderson",
    pm: "Prashanth Venkataraman",
    slackChannel: FALLBACK_SLACK_CHANNEL,
  },
  "Data Refresh": {
    em: "Akanksha Jain",
    slackChannel: FALLBACK_SLACK_CHANNEL,
  },
  // Not one of the org sheet's 20 PODs - the user confirmed its PM directly (no EM/PM Manager given).
  "Pipeline Pod": {
    pm: "Prashanth Venkataraman",
    slackChannel: "C0AM8EUGJBH",
  },
};

export function resolvePodRoute(pod: string | undefined): PodRoute {
  if (!pod) {
    return { slackChannel: FALLBACK_SLACK_CHANNEL };
  }
  return POD_ROUTING[pod] ?? { slackChannel: FALLBACK_SLACK_CHANNEL };
}
