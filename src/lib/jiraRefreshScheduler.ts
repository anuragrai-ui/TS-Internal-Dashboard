import { clearCache } from "@/lib/cache";
import { refreshAllCategories } from "@/lib/jiraClient";
import {
  clearJiraSnapshots,
  getLastSnapshotClearTime,
  pruneJiraSnapshots,
} from "@/lib/jiraSnapshotStore";

const DAY_MS = 24 * 60 * 60 * 1000;

function isSunday(date: Date): boolean {
  return date.getDay() === 0;
}

export async function runScheduledJiraRefresh(now = new Date()): Promise<boolean> {
  try {
    await pruneJiraSnapshots(now);

    const lastClearedAt = await getLastSnapshotClearTime();
    const clearDue = now.getTime() - lastClearedAt.getTime() >= DAY_MS;

    if (!clearDue || isSunday(now)) {
      return false;
    }

    await clearJiraSnapshots(now);
    await clearCache();
    await refreshAllCategories();
    return true;
  } catch (error) {
    console.error("Scheduled Jira refresh failed:", error);
    return false;
  }
}
