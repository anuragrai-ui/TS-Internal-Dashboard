import { getTicketVersion, getTransitions, MISSING_TOKEN_MESSAGE, searchAssignableUsers } from "@/lib/actions/jiraWrites";
import { ACTION_PRIORITIES } from "@/lib/actions/validate";

import type { JiraWriteConfig } from "@/lib/actions/jiraWrites";
import type { JiraCredentials } from "@/lib/jiraClient";
import type { JiraOptionsResponse } from "@/lib/workspace/types";

/**
 * What the action bar may offer for one ticket, read with the person's own
 * token so the lists match what Jira will actually let them do: the
 * transitions their workflow permits from the current status, the people
 * they may assign it to (Jira's own search), the four priorities, and the
 * ticket's `updated` to send back as expectedVersion.
 *
 * The version read decides success: without it nothing can be written
 * safely. A failed transition or assignee read just leaves that list empty.
 */

const QUERY_MAX_CHARS = 100;

export type JiraOptionsResult = { ok: true; options: JiraOptionsResponse } | { error: string; ok: false; status: number };

export async function getJiraOptions(
  ticketKey: string,
  query: string,
  creds: JiraCredentials | null,
  config: JiraWriteConfig | null,
): Promise<JiraOptionsResult> {
  if (!config) {
    return { error: "Jira isn't configured on the server (JIRA_BASE_URL).", ok: false, status: 503 };
  }
  if (!creds) {
    return { error: MISSING_TOKEN_MESSAGE, ok: false, status: 403 };
  }

  const [version, transitions, assignees] = await Promise.all([
    getTicketVersion(ticketKey, creds, config),
    getTransitions(ticketKey, creds, config),
    searchAssignableUsers(ticketKey, query.trim().slice(0, QUERY_MAX_CHARS), creds, config),
  ]);

  if (!version.ok) {
    return { error: `Couldn't read ${ticketKey} from Jira: ${version.error}`, ok: false, status: 502 };
  }
  if (!transitions.ok) {
    console.warn(`Actions: transitions for ${ticketKey} unavailable.`, transitions.error);
  }
  if (!assignees.ok) {
    console.warn(`Actions: assignable users for ${ticketKey} unavailable.`, assignees.error);
  }

  return {
    ok: true,
    options: {
      assignees: assignees.ok ? assignees.users : [],
      priorities: [...ACTION_PRIORITIES],
      transitions: transitions.ok ? transitions.transitions : [],
      version: version.version,
    },
  };
}
