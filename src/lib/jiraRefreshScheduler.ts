import { clearCache } from "@/lib/cache";
import { refreshAllCategories } from "@/lib/jiraClient";
import {
  clearJiraSnapshots,
  getLastSnapshotClearTime,
  pruneJiraSnapshots,
} from "@/lib/jiraSnapshotStore";

const DAY_MS = 24 * 60 * 60 * 1000;
const CHECK_INTERVAL_MS = 60 * 60 * 1000;

let schedulerStarted = false;
let schedulerRunning = false;

function isSunday(date: Date): boolean {
  return date.getDay() === 0;
}

async function runScheduledJiraRefresh(now = new Date()): Promise<void> {
  if (schedulerRunning) {
    return;
  }

  schedulerRunning = true;

  try {
    await pruneJiraSnapshots(now);

    const lastClearedAt = await getLastSnapshotClearTime();
    const clearDue = now.getTime() - lastClearedAt.getTime() >= DAY_MS;

    if (!clearDue || isSunday(now)) {
      return;
    }

    await clearJiraSnapshots(now);
    clearCache();
    await refreshAllCategories();
  } catch (error) {
    console.error("Scheduled Jira refresh failed:", error);
  } finally {
    schedulerRunning = false;
  }
}

export function startJiraRefreshScheduler(): void {
  if (schedulerStarted || typeof window !== "undefined") {
    return;
  }

  schedulerStarted = true;
  void runScheduledJiraRefresh();
  setInterval(() => {
    void runScheduledJiraRefresh();
  }, CHECK_INTERVAL_MS);
}
