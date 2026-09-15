/**
 * One-time migration: backs up the current `followup:log:*` audit history
 * to the "Follow-Up Log" Google Sheet tab (via appendFollowUpLogRows), then
 * clears the listed cache/history key prefixes from Redis - explicitly
 * SKIPPING `jira_user_tokens:*` so nobody has to re-register their personal
 * Jira token. Safe to re-run: the backup step is additive (append-only) and
 * the clear step only removes keys that already regenerate on demand
 * (caches) or age out anyway (cooldowns, audit history).
 *
 * Usage: npm run redis:backup-and-clean
 * Requires UPSTASH_REDIS_REST_URL/TOKEN and, for the backup step to
 * actually write anywhere, GOOGLE_SERVICE_ACCOUNT_EMAIL/PRIVATE_KEY - see
 * the "Follow-Up Log (Google Sheet)" README section. Without the Google
 * credentials this still clears Redis, but WARNS loudly and asks for
 * confirmation first, since that would otherwise discard history with no
 * backup.
 */
import { createInterface } from "node:readline/promises";

import type { FollowUpAuditEntry } from "@/lib/followupAudit";
import { appendFollowUpLogRows } from "@/lib/googleSheetsWriter";
import { isGoogleSheetsWriteConfigured } from "@/lib/googleSheetsWriter";
import { getRedis, isRedisConfigured } from "@/lib/redis";

const CLEAR_PREFIXES = [
  "followup:log:",
  "followup:last_sent:",
  "cache:",
  "agentfollowup:",
  "slack:mentions:",
];
const CLEAR_EXACT_KEYS = ["closure:candidates"];
const NEVER_TOUCH_PREFIX = "jira_user_tokens:";

async function scanAllKeys(matchPattern: string): Promise<string[]> {
  const redis = getRedis();
  const keys: string[] = [];
  let cursor = 0;

  do {
    const [nextCursor, batch] = await redis.scan(cursor, { match: matchPattern, count: 200 });
    keys.push(...batch);
    cursor = Number(nextCursor);
  } while (cursor !== 0);

  return keys;
}

async function backupAuditLogs(): Promise<number> {
  console.log("\n=== Step 1: backing up followup:log:* to the Follow-Up Log sheet ===");

  const keys = await scanAllKeys("followup:log:*");
  console.log(`Found ${keys.length} ticket(s) with audit history.`);

  if (keys.length === 0) {
    return 0;
  }

  const redis = getRedis();
  const rows: Parameters<typeof appendFollowUpLogRows>[0] = [];

  for (const key of keys) {
    const issueKey = key.replace(/^followup:log:/, "");
    const raw = await redis.zrange<string[]>(key, 0, -1);

    for (const member of raw) {
      try {
        const entry = JSON.parse(member) as FollowUpAuditEntry;
        rows.push({
          issueKey,
          jiraCommentId: entry.jira_comment_id,
          kind: entry.kind,
          postedAt: entry.posted_at,
          postedText: entry.posted_text,
          status: entry.status,
        });
      } catch (error) {
        console.warn(`Skipping unparseable entry in ${key}:`, error);
      }
    }
  }

  console.log(`Parsed ${rows.length} total follow-up entries across ${keys.length} ticket(s).`);

  if (rows.length === 0) {
    return 0;
  }

  // The Sheets API append endpoint has its own request-size limits - batch
  // in chunks rather than sending potentially thousands of rows in one call.
  const CHUNK_SIZE = 200;
  let written = 0;

  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const chunk = rows.slice(i, i + CHUNK_SIZE);
    const ok = await appendFollowUpLogRows(chunk);

    if (!ok) {
      throw new Error(
        `Failed to append rows ${i}-${i + chunk.length} to the sheet - aborting before any Redis keys are cleared.`,
      );
    }

    written += chunk.length;
    console.log(`  Backed up ${written}/${rows.length} rows...`);
  }

  return written;
}

async function clearCaches(): Promise<void> {
  console.log("\n=== Step 2: clearing cache/history keys (skipping jira_user_tokens:*) ===");

  const redis = getRedis();
  let totalDeleted = 0;

  for (const prefix of CLEAR_PREFIXES) {
    const keys = await scanAllKeys(`${prefix}*`);
    const safeKeys = keys.filter((key) => !key.startsWith(NEVER_TOUCH_PREFIX));

    if (safeKeys.length === 0) {
      console.log(`  ${prefix}* - nothing to clear.`);
      continue;
    }

    await Promise.all(safeKeys.map((key) => redis.del(key)));
    totalDeleted += safeKeys.length;
    console.log(`  ${prefix}* - cleared ${safeKeys.length} key(s).`);
  }

  for (const key of CLEAR_EXACT_KEYS) {
    const existed = await redis.del(key);
    if (existed) {
      totalDeleted += 1;
      console.log(`  ${key} - cleared.`);
    } else {
      console.log(`  ${key} - nothing to clear.`);
    }
  }

  console.log(`\nTotal keys cleared: ${totalDeleted}. jira_user_tokens:* was never touched.`);
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${question} (type "yes" to proceed): `);
  rl.close();
  return answer.trim().toLowerCase() === "yes";
}

async function main(): Promise<void> {
  if (!isRedisConfigured()) {
    console.error("UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN are not set - nothing to do.");
    process.exit(1);
  }

  if (!isGoogleSheetsWriteConfigured()) {
    console.warn(
      "\nWARNING: GOOGLE_SERVICE_ACCOUNT_EMAIL/GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY are not set.\n" +
        "The backup step cannot write anywhere - proceeding would clear followup:log:* history with NO backup.",
    );
    const proceedAnyway = await confirm(
      "Proceed with clearing Redis WITHOUT backing up the audit history to the sheet first?",
    );
    if (!proceedAnyway) {
      console.log("Aborted - no changes made. Add the Google service account credentials and re-run.");
      process.exit(0);
    }
  } else {
    const backedUp = await backupAuditLogs();
    console.log(`\nBacked up ${backedUp} row(s) to the Follow-Up Log sheet.`);
  }

  const proceed = await confirm("\nBackup step done (or skipped). Proceed with clearing the listed Redis prefixes?");
  if (!proceed) {
    console.log("Aborted before clearing anything.");
    process.exit(0);
  }

  await clearCaches();
  console.log("\nDone.");
}

main().catch((error) => {
  console.error("\nMigration failed:", error);
  process.exit(1);
});
