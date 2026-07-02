import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Category, FormattedIssue } from "@/lib/jiraClient";

const SNAPSHOT_DIR = path.join(process.cwd(), "data");
const SNAPSHOT_FILE = path.join(SNAPSHOT_DIR, "jira-refresh-history.json");
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

async function readSnapshotFile(): Promise<JiraSnapshotFile> {
  try {
    const raw = await readFile(SNAPSHOT_FILE, "utf8");
    const parsed: unknown = JSON.parse(raw);

    if (isSnapshotFile(parsed)) {
      return parsed;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error("Unable to read Jira snapshot file:", error);
    }
  }

  return createEmptySnapshotFile();
}

async function writeSnapshotFile(snapshot: JiraSnapshotFile): Promise<void> {
  await mkdir(SNAPSHOT_DIR, { recursive: true });
  await writeFile(SNAPSHOT_FILE, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
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
}

export async function clearJiraSnapshots(now = new Date()): Promise<void> {
  await writeSnapshotFile(createEmptySnapshotFile(now));
}

export async function pruneJiraSnapshots(now = new Date()): Promise<void> {
  const snapshot = await readSnapshotFile();
  const rows = removeExpiredRows(snapshot.rows, now);

  if (rows.length !== snapshot.rows.length) {
    await writeSnapshotFile({
      ...snapshot,
      rows,
    });
  }
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
  const snapshot = await readSnapshotFile();
  const parsed = new Date(snapshot.last_cleared_at);

  if (Number.isNaN(parsed.getTime())) {
    return new Date(0);
  }

  return parsed;
}
