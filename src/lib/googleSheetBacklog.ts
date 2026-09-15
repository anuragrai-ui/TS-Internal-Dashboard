import type { FormattedIssue } from "@/lib/jiraClient";

const DEFAULT_SPREADSHEET_ID =
  "1EfCH8LOevjTBZsWzkiiD4RdyXwf82CypiAJEcpa7V-U";
const DEFAULT_BACKLOG_GID = "0";
const DEFAULT_FOLLOWUPS_GID = "957104001";
const FOUR_HOURS_SECONDS = 4 * 60 * 60;
const FOUR_HOURS_MS = FOUR_HOURS_SECONDS * 1000;
const SHEET_TIMEZONE_OFFSET = "+05:30";

interface SheetCsvCacheEntry {
  expiresAt: number;
  value: string;
}

const sheetCsvCache = new Map<string, SheetCsvCacheEntry>();
const sheetCsvRequests = new Map<string, Promise<string>>();

export const GOOGLE_SHEET_URL = `https://docs.google.com/spreadsheets/d/${DEFAULT_SPREADSHEET_ID}/edit`;

export interface SheetFollowup {
  aiInsight: string;
  assignee: string;
  followupDraft: string;
  followupState: string;
  generatedAt: string;
  key: string;
  lastActivity: string;
  linkedTicket: string;
  priority: string;
  recommendedAction: string;
  sourceLink: string;
  status: string;
  summary: string;
  ticketType: string;
}

export interface SheetBacklogTicket {
  comments: string;
  customers: string[];
  firstResponse?: string;
  issue: FormattedIssue;
  linkedIssues: string[];
  reopened?: string;
  resolved?: string;
}

export interface SheetBacklogData {
  assignees: Array<{ count: number; name: string }>;
  fetchedAt: string;
  followups: SheetFollowup[];
  linkedCpCount: number;
  sourceUrl: string;
  statusCounts: Array<{ count: number; status: string }>;
  tickets: SheetBacklogTicket[];
}

function spreadsheetId(): string {
  return process.env.GOOGLE_SHEET_ID?.trim() || DEFAULT_SPREADSHEET_ID;
}

function exportUrl(gid: string): string {
  return `https://docs.google.com/spreadsheets/d/${spreadsheetId()}/export?format=csv&gid=${gid}`;
}

export function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];

    if (quoted) {
      if (character === '"') {
        if (input[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
      continue;
    }

    if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (character !== "\r") {
      field += character;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

function recordsFromCsv(input: string): Array<Record<string, string>> {
  const [headers, ...rows] = parseCsv(input);

  if (!headers) {
    return [];
  }

  return rows
    .filter((row) => row.some((value) => value.trim().length > 0))
    .map((row) =>
      Object.fromEntries(
        headers.map((header, index) => [header.trim(), row[index]?.trim() ?? ""]),
      ),
    );
}

function normalizeSheetDate(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const match = value.match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})$/,
  );

  if (!match) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
  }

  const month = match[1] ?? "";
  const day = match[2] ?? "";
  const year = match[3] ?? "";
  const hour = match[4] ?? "";
  const minute = match[5] ?? "";
  const second = match[6] ?? "";
  const pad = (part: string): string => part.padStart(2, "0");
  const parsed = new Date(
    `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${minute}:${second}${SHEET_TIMEZONE_OFFSET}`,
  );

  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function latestDate(values: Array<string | undefined>): string {
  return (
    values
      .filter((value): value is string => Boolean(value))
      .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0] ?? ""
  );
}

function prioritySort(priority: string): number {
  const rank: Record<string, number> = {
    critical: 1,
    highest: 1,
    high: 2,
    medium: 3,
    low: 4,
    lowest: 5,
  };

  return rank[priority.toLowerCase()] ?? 99;
}

function isExternalReporter(reporter: string): boolean {
  return !reporter.toLowerCase().endsWith("@certifyos.com");
}

function compactComment(value: string): string {
  const maximumLength = 4_000;
  if (value.length <= maximumLength) {
    return value;
  }
  return `…${value.slice(-maximumLength)}`;
}

export function parseSheetBacklogCsv(input: string): SheetBacklogTicket[] {
  const records = recordsFromCsv(input);

  const firstRecord = records[0];
  if (firstRecord && !("Key" in firstRecord)) {
    throw new Error("Google Sheet export is missing the expected Key column.");
  }

  const byKey = new Map<string, SheetBacklogTicket>();
  const jiraBaseUrl = (process.env.JIRA_BASE_URL || "https://certifyos.atlassian.net").replace(
    /\/+$/,
    "",
  );

  for (const record of records) {
    const key = record.Key?.trim();
    if (!key) {
      continue;
    }

    const linkedIssues = record["Linked Issues"]
      ?.split(";")
      .map((value) => value.trim())
      .filter(Boolean) ?? [];
    const existing = byKey.get(key);

    if (existing) {
      existing.linkedIssues = [...new Set([...existing.linkedIssues, ...linkedIssues])];
      const linkedCpKey = existing.linkedIssues.find((linkedKey) => linkedKey.startsWith("CP-"));
      existing.issue.linked_cp_issue = linkedCpKey
        ? { isDone: false, key: linkedCpKey, status: "Linked from sheet" }
        : undefined;
      continue;
    }

    const created = normalizeSheetDate(record.Created);
    const resolved = normalizeSheetDate(record.Resolved);
    const firstResponse = normalizeSheetDate(record["[CHART] Date of First Response"]);
    const reopened = normalizeSheetDate(record["Reopen Date"]);
    const lastActivity = latestDate([created, firstResponse, reopened, resolved]);
    const linkedCpKey = linkedIssues.find((linkedKey) => linkedKey.startsWith("CP-"));
    const comments = record.Comment ?? "";
    const customers = (record["Customer(s)"] ?? "")
      .split(";")
      .map((value) => value.trim())
      .filter(Boolean);
    const priority = record.Priority || "Unknown";
    const resolution = record.Resolution?.trim();

    byKey.set(key, {
      comments,
      customers,
      firstResponse,
      issue: {
        action_date: lastActivity || created,
        assignee: record.Assignee || "Unassigned",
        attachment_count: (comments.match(/!.*?!|\[\^.*?\]/g) ?? []).length,
        attachments: [],
        comment_count: comments ? Math.max(1, comments.split(";").length) : 0,
        components: [],
        created,
        description: compactComment(comments),
        issue_type: record["Issue Type"] || "Support Ticket",
        key,
        labels: ["google-sheet"],
        latest_comment_created: lastActivity,
        linked_cp_issue: linkedCpKey
          ? { isDone: false, key: linkedCpKey, status: "Linked from sheet" }
          : undefined,
        priority,
        priority_sort: prioritySort(priority),
        project: "TS",
        reporter: record.Reporter || "Unknown",
        reporter_is_external: isExternalReporter(record.Reporter || ""),
        status: record.Status || "Unknown",
        status_category: resolution ? "Done" : "In Progress",
        subtask_count: 0,
        summary: record.Summary || "Untitled ticket",
        support_category: customers.join(", ") || undefined,
        source: "Google Sheets",
        updated: lastActivity,
        url: `${jiraBaseUrl}/browse/${key}`,
      },
      linkedIssues,
      reopened,
      resolved,
    });
  }

  return [...byKey.values()];
}

export function parseSheetFollowupsCsv(input: string): SheetFollowup[] {
  return recordsFromCsv(input)
    .map((record) => ({
      aiInsight: record["AI Insight"] ?? "",
      assignee: record.Assignee ?? "",
      followupDraft: record["Follow-up Draft"] ?? "",
      followupState: record["Follow-up State"] ?? "",
      generatedAt: normalizeSheetDate(record["Generated At"]) ?? record["Generated At"] ?? "",
      key: record["Ticket Key"] ?? "",
      lastActivity: normalizeSheetDate(record["Last Activity"]) ?? record["Last Activity"] ?? "",
      linkedTicket: record["Linked Ticket"] ?? "",
      priority: record.Priority ?? "",
      recommendedAction: record["Recommended Action"] ?? "",
      sourceLink: record["Source Link"] ?? "",
      status: record.Status ?? "",
      summary: record.Summary ?? "",
      ticketType: record["Ticket Type"] ?? "",
    }))
    .filter((followup) => Boolean(followup.key));
}

async function fetchSheetCsv(gid: string): Promise<string> {
  const url = exportUrl(gid);
  const cached = sheetCsvCache.get(url);

  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const pending = sheetCsvRequests.get(url);
  if (pending) {
    return pending;
  }

  const request = fetch(url, {
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  })
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(`Google Sheet export failed with status ${response.status}.`);
      }

      const value = await response.text();
      sheetCsvCache.set(url, {
        expiresAt: Date.now() + FOUR_HOURS_MS,
        value,
      });
      return value;
    })
    .finally(() => {
      sheetCsvRequests.delete(url);
    });

  sheetCsvRequests.set(url, request);
  return request;
}

function countBy(
  values: string[],
): Array<{ count: number; name: string }> {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ count, name }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export async function getSheetBacklog(): Promise<SheetBacklogData> {
  const backlogGid = process.env.GOOGLE_SHEET_BACKLOG_GID?.trim() || DEFAULT_BACKLOG_GID;
  const followupsGid =
    process.env.GOOGLE_SHEET_FOLLOWUPS_GID?.trim() || DEFAULT_FOLLOWUPS_GID;
  const [backlogCsv, followupsCsv] = await Promise.all([
    fetchSheetCsv(backlogGid),
    fetchSheetCsv(followupsGid).catch((error) => {
      console.warn("Unable to read AI Follow-ups sheet; continuing without generated drafts.", error);
      return "";
    }),
  ]);
  const tickets = parseSheetBacklogCsv(backlogCsv);
  const followups = parseSheetFollowupsCsv(followupsCsv);
  const assignees = countBy(tickets.map((ticket) => ticket.issue.assignee));
  const statusCounts = countBy(
    tickets.map((ticket) => ticket.issue.status || "Unknown"),
  ).map(({ count, name }) => ({ count, status: name }));
  const linkedCpKeys = new Set(
    tickets.flatMap((ticket) =>
      ticket.linkedIssues.filter((key) => key.startsWith("CP-")),
    ),
  );

  return {
    assignees,
    fetchedAt: new Date().toISOString(),
    followups,
    linkedCpCount: linkedCpKeys.size,
    sourceUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId()}/edit`,
    statusCounts,
    tickets,
  };
}

export function countTicketsNeedingFollowup(
  tickets: SheetBacklogTicket[],
  now = new Date(),
): number {
  const cutoff = now.getTime() - 3 * 24 * 60 * 60 * 1000;
  return tickets.filter((ticket) => {
    const lastActivity = new Date(
      ticket.issue.latest_comment_created || ticket.issue.updated || ticket.issue.created || 0,
    ).getTime();
    return !ticket.resolved && Number.isFinite(lastActivity) && lastActivity <= cutoff;
  }).length;
}
