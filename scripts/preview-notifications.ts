/**
 * What the notification bell would have shown each registered dashboard user
 * over the last N hours, read from live Jira - nothing is stored, nothing is
 * marked, and Jira is only ever read (src/lib/escalation/readOnlyJira.ts).
 *
 *   npm run notifications:preview                # last 24 hours
 *   npm run notifications:preview -- --hours=4
 */
import { createReadOnlyJiraClient, readOnlyJiraConfigFromEnv } from "@/lib/escalation/readOnlyJira";
import { collectJiraNotifications } from "@/lib/notifications/jiraSync";
import { listRegisteredJiraUsers } from "@/lib/userJiraTokens";

const hoursArg = process.argv.find((arg) => arg.startsWith("--hours="));
const hours = Math.min(72, Math.max(1, Number(hoursArg?.split("=")[1] ?? 24) || 24));

async function main(): Promise<void> {
  const users = await listRegisteredJiraUsers();
  if (users.length === 0) {
    console.log("No registered dashboard users - nobody would get notifications.");
    return;
  }

  const config = readOnlyJiraConfigFromEnv();
  const client = createReadOnlyJiraClient(config);
  const nowMs = Date.now();
  const { cpsWatched, notifications, ticketsWatched } = await collectJiraNotifications({
    baseUrl: config.baseUrl,
    client,
    nowMs,
    sinceMs: nowMs - hours * 3_600_000,
    users,
  });

  console.log(`Last ${hours}h: ${ticketsWatched} TS tickets and ${cpsWatched} linked CPs changed -> ${notifications.length} notifications (${client.requestLog.length} Jira reads).`);
  for (const user of users) {
    const mine = notifications.filter((item) => item.audience.includes(user.accountId)).sort((a, b) => b.at.localeCompare(a.at));
    const byKind = mine.reduce<Record<string, number>>((acc, item) => ({ ...acc, [item.kind]: (acc[item.kind] ?? 0) + 1 }), {});
    console.log(`\n${user.displayName}: ${mine.length} (${mine.filter((item) => item.important).length} important) ${JSON.stringify(byKind)}`);
    for (const item of mine.slice(0, 12)) {
      console.log(`  ${item.important ? "!" : " "} ${item.at.slice(5, 16).replace("T", " ")}  ${item.title}${item.detail ? `  - ${item.detail.slice(0, 70)}` : ""}`);
    }
  }
}

main().catch((error: unknown) => {
  console.error("Preview failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
