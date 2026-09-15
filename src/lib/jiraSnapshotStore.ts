import { randomUUID } from "node:crypto";

import { getRedis, isRedisConfigured } from "@/lib/redis";
import type { Category, FormattedIssue } from "@/lib/jiraClient";

const SNAPSHOT_KEY = "jira:snapshot";
const LOCK_KEY = "jira:snapshot:lock";
const LOCK_TTL_MS = 5000;
const LOCK_RETRY_DELAY_MS = 50;
const LOCK_MAX_WAIT_MS = 4000;
const RETENTION_MS = 24 * 60 * 60 * 1000;

export interface JiraSnapshotRow extends FormattedIssue {
  category_key: string;
  category_title: string;
  fetched_at: string;
}

interface JiraSnapshotFile {
  last_cleared_at: string;
  retention_hours: number;
  rows: JiraSnapshotRow[];
}

export interface JiraSnapshotSummary {
  categories: string[];
  last_cleared_at: string;
  latest_fetched_at: string;
  retention_hours: number;
  row_count: number;
}

function createEmptySnapshotFile(now = new Date()): JiraSnapshotFile {
  return {
    last_cleared_at: now.toISOString(),
    retention_hours: 24,
    rows: [],
  };
}

function isSnapshotFile(value: unknown): value is JiraSnapshotFile {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<JiraSnapshotFile>;
  return (
    typeof candidate.last_cleared_at === "string" &&
    candidate.retention_hours === 24 &&
    Array.isArray(candidate.rows)
  );
}

async function readSnapshotFileIfExists(): Promise<JiraSnapshotFile | null> {
  if (!isRedisConfigured()) {
    return null;
  }

  try {
    const stored = await getRedis().get<unknown>(SNAPSHOT_KEY);

    if (isSnapshotFile(stored)) {
      return stored;
    }
  } catch (error) {
    console.error("Unable to read Jira snapshot from Redis:", error);
  }

  return null;
}

async function readSnapshotFile(): Promise<JiraSnapshotFile> {
  return (await readSnapshotFileIfExists()) ?? createEmptySnapshotFile();
}

async function writeSnapshotFile(snapshot: JiraSnapshotFile): Promise<void> {
  if (!isRedisConfigured()) {
    return;
  }

  await getRedis().set(SNAPSHOT_KEY, snapshot);
}

async function acquireSnapshotLock(): Promise<string> {
  const token = randomUUID();

  if (!isRedisConfigured()) {
    return token;
  }

  const redis = getRedis();
  const deadline = Date.now() + LOCK_MAX_WAIT_MS;

  for (;;) {
    const acquired = await redis.set(LOCK_KEY, token, {
      nx: true,
      px: LOCK_TTL_MS,
    });

    if (acquired === "OK") {
      return token;
    }

    if (Date.now() >= deadline) {
      throw new Error("Timed out acquiring Jira snapshot lock");
    }

    await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_DELAY_MS));
  }
}

async function releaseSnapshotLock(token: string): Promise<void> {
  if (!isRedisConfigured()) {
    return;
  }

  const redis = getRedis();
  const current = await redis.get<string>(LOCK_KEY);

  if (current === token) {
    await redis.del(LOCK_KEY);
  }
}

async function withSnapshotLock<T>(mutation: () => Promise<T>): Promise<T> {
  const token = await acquireSnapshotLock();

  try {
    return await mutation();
  } finally {
    await releaseSnapshotLock(token);
  }
}

function removeExpiredRows(
  rows: JiraSnapshotRow[],
  now = new Date(),
): JiraSnapshotRow[] {
  const cutoff = now.getTime() - RETENTION_MS;

  return rows.filter((row) => {
    const fetchedAt = Date.parse(row.fetched_at);
    return Number.isFinite(fetchedAt) && fetchedAt >= cutoff;
  });
}

export async function saveCategorySnapshot(
  categoryKey: string,
  category: Category,
  issues: FormattedIssue[],
): Promise<void> {
  await withSnapshotLock(async () => {
    const now = new Date();
    const snapshot = await readSnapshotFile();
    const rows = removeExpiredRows(snapshot.rows, now);
    const fetchedAt = now.toISOString();

    rows.push(
      ...issues.map((issue) => ({
        ...issue,
        category_key: categoryKey,
        category_title: category.title,
        fetched_at: fetchedAt,
      })),
    );

    await writeSnapshotFile({
      ...snapshot,
      rows,
    });
  });
}

export async function clearJiraSnapshots(now = new Date()): Promise<void> {
  await withSnapshotLock(() => writeSnapshotFile(createEmptySnapshotFile(now)));
}

export async function pruneJiraSnapshots(now = new Date()): Promise<void> {
  await withSnapshotLock(async () => {
    const snapshot = await readSnapshotFile();
    const rows = removeExpiredRows(snapshot.rows, now);

    if (rows.length !== snapshot.rows.length) {
      await writeSnapshotFile({
        ...snapshot,
        rows,
      });
    }
  });
}

export async function getJiraSnapshotRows(): Promise<JiraSnapshotRow[]> {
  const snapshot = await readSnapshotFile();
  return removeExpiredRows(snapshot.rows);
}

export async function getJiraSnapshotSummary(): Promise<JiraSnapshotSummary> {
  const snapshot = await readSnapshotFile();
  const rows = removeExpiredRows(snapshot.rows);
  const latestFetchedAt = rows
    .map((row) => row.fetched_at)
    .sort((a, b) => b.localeCompare(a))
    .at(0);

  return {
    categories: [...new Set(rows.map((row) => row.category_key))],
    last_cleared_at: snapshot.last_cleared_at,
    latest_fetched_at: latestFetchedAt ?? "",
    retention_hours: snapshot.retention_hours,
    row_count: rows.length,
  };
}

export async function getLastSnapshotClearTime(): Promise<Date> {
  const snapshot = await readSnapshotFileIfExists();

  if (!snapshot) {
    return new Date(0);
  }

  const parsed = new Date(snapshot.last_cleared_at);

  if (Number.isNaN(parsed.getTime())) {
    return new Date(0);
  }

  return parsed;
}
