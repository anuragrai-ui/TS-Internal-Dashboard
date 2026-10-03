import { getFollowersByKey } from "@/lib/tracker/follow";
import { mergeAudience } from "@/lib/tracker/signals";
import { getTrackerOwners } from "@/lib/tracker/snapshot";
import { listRegisteredJiraUsers } from "@/lib/userJiraTokens";

/**
 * Who hears about a tracked ticket - used by the Slack index (mentions and
 * replies in linked conversations) and the tracker's SLA warnings. The
 * assignee comes from the cached snapshot's owner index, so this costs a few Redis reads
 * and never a Jira call; a key the snapshot doesn't hold (a CP, or a ticket
 * outside the scope) gets its followers only, and the caller adds whoever
 * owns it if it knows. Keys with nobody to tell are absent from the map.
 */

/** Registered dashboard users (Jira accountIds) to notify about each ticket: its assignee if registered, plus followers. */
export async function getTicketAudience(keys: string[]): Promise<Map<string, string[]>> {
  if (keys.length === 0) {
    return new Map();
  }
  try {
    const [owners, users, followersByKey] = await Promise.all([getTrackerOwners(), listRegisteredJiraUsers(), getFollowersByKey(keys)]);
    return mergeAudience({
      assigneeByKey: owners ?? new Map(),
      followersByKey,
      keys,
      registered: new Set(users.map((user) => user.accountId)),
    });
  } catch (error) {
    console.warn("Tracker: could not work out a ticket audience.", error instanceof Error ? error.message : error);
    return new Map();
  }
}
