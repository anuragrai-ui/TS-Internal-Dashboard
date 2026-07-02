export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startJiraRefreshScheduler } = await import("@/lib/jiraRefreshScheduler");
    startJiraRefreshScheduler();
  }
}
