import { getCache, getCacheMeta, setCache } from "@/lib/cache";
import { saveCategorySnapshot } from "@/lib/jiraSnapshotStore";

const JIRA_BASE_URL = process.env.JIRA_BASE_URL;
const JIRA_EMAIL = process.env.JIRA_EMAIL;
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN;

interface JiraAccount {
  accountId?: string;
  displayName?: string;
  emailAddress?: string;
}

interface JiraNamedField {
  key?: string;
  name?: string;
}

interface JiraStatus {
  name?: string;
  statusCategory?: { key?: string; name?: string } | null;
}

interface JiraOption {
  value?: string;
}

interface JiraServiceRef {
  name?: string;
}

interface JiraProgress {
  progress?: number;
  total?: number;
}

interface JiraIssueFields {
  assignee?: JiraAccount | null;
  attachment?: unknown[];
  comment?: { comments?: unknown[] };
  components?: Array<{ name?: string }>;
  created?: string;
  description?: string;
  duedate?: string;
  issuetype?: JiraNamedField | null;
  labels?: string[];
  priority?: JiraNamedField | null;
  progress?: JiraProgress | null;
  project?: JiraNamedField | null;
  reporter?: JiraAccount | null;
  status?: JiraStatus | null;
  subtasks?: unknown[];
  summary?: string;
  updated?: string;

  /* Custom fields - IDs verified against all_filed.json field metadata export */
  customfield_10039?: JiraServiceRef[] | null; /* Affected services */
  customfield_10042?: JiraOption | null; /* Urgency Levels */
  customfield_10043?: JiraOption | null; /* Pending reason */
  customfield_10046?: string | null; /* Major incident */
  customfield_10048?: JiraOption | null; /* Severity */
  customfield_10054?: JiraOption | null; /* Source */
  customfield_10162?: JiraOption[] | null; /* Team */
  customfield_10165?: JiraOption | null; /* Pod */
  customfield_10166?: JiraOption | null; /* Support Category */
  customfield_10287?: JiraOption | null; /* Client Support Task Type */
  customfield_10288?: JiraOption | null; /* Client Support Escalation Field */
}

interface JiraIssue {
  key: string;
  fields: JiraIssueFields;
}

interface JiraComment {
  author?: JiraAccount;
  body?: unknown;
  created?: string;
}

export interface TicketCommentContext {
  author: string;
  body: string;
  created: string;
}

export interface CurrentUser {
  account_id?: string;
  display_name?: string;
  email?: string;
}

export interface DashboardTile {
  count: number;
  description: string;
  key: string;
  title: string;
}

export interface FormattedIssue {
  action_date?: string;
  affected_services?: string;
  assignee: string;
  attachment_count: number;
  client_support_task_type?: string;
  comment_count: number;
  components: string[];
  created?: string;
  description?: string;
  duedate?: string;
  escalation_field?: string;
  issue_type?: string;
  key: string;
  labels: string[];
  latest_comment_created: string;
  major_incident?: string;
  pending_reason?: string;
  priority: string;
  priority_sort: number;
  progress?: string;
  project?: string;
  reporter: string;
  severity?: string;
  source?: string;
  status?: string;
  status_category?: string;
  subtask_count: number;
  summary?: string;
  support_category?: string;
  team?: string;
  updated?: string;
  urgency?: string;
  url: string;
  pod?: string;
}

export interface Category {
  description: string;
  loader: () => Promise<FormattedIssue[]>;
  title: string;
}

export interface CategoryCacheMeta {
  last_sync: string;
  next_sync: string;
  next_sync_iso: string;
}

function requireJiraConfig(): {
  apiToken: string;
  baseUrl: string;
  email: string;
} {
  if (!JIRA_BASE_URL || !JIRA_EMAIL || !JIRA_API_TOKEN) {
    throw new Error(
      "Missing Jira configuration. Set JIRA_BASE_URL, JIRA_EMAIL, and JIRA_API_TOKEN.",
    );
  }

  return {
    apiToken: JIRA_API_TOKEN,
    baseUrl: JIRA_BASE_URL.replace(/\/+$/, ""),
    email: JIRA_EMAIL,
  };
}

function formatDateTime(date: Date): string {
  const formatter = new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    hour: "2-digit",
    hour12: true,
    minute: "2-digit",
    month: "short",
    year: "numeric",
  });

  return formatter.format(date);
}

async function jiraGet<T>(
  path: string,
  params?: Record<string, string | number>,
): Promise<T> {
  const { apiToken, baseUrl, email } = requireJiraConfig();
  const normalizedPath = path.replace(/^\/+/, "");
  const url = new URL(`${baseUrl}/rest/api/3/${normalizedPath}`);

  for (const [key, value] of Object.entries(params ?? {})) {
    url.searchParams.set(key, String(value));
  }

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      Authorization: `Basic ${Buffer.from(`${email}:${apiToken}`).toString("base64")}`,
    },
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const body = await response.text();
    console.error("Jira error:", response.status);
    console.error(body);
    throw new Error(`Jira request failed with status ${response.status}`);
  }

  return (await response.json()) as T;
}

export async function getCurrentUser(): Promise<CurrentUser> {
  const data = await jiraGet<JiraAccount>("/myself");

  return {
    account_id: data.accountId,
    display_name: data.displayName,
    email: data.emailAddress,
  };
}

const JIRA_FIELDS = [
  "summary",
  "description",
  "status",
  "priority",
  "assignee",
  "reporter",
  "created",
  "updated",
  "duedate",
  "issuetype",
  "labels",
  "components",
  "comment",
  "attachment",
  "subtasks",
  "project",
  "progress",
  "customfield_10039",
  "customfield_10042",
  "customfield_10043",
  "customfield_10046",
  "customfield_10048",
  "customfield_10054",
  "customfield_10162",
  "customfield_10165",
  "customfield_10166",
  "customfield_10287",
  "customfield_10288",
].join(",");

async function searchIssues(jql: string, maxResults = 100): Promise<JiraIssue[]> {
  const data = await jiraGet<{ issues?: JiraIssue[] }>("/search/jql", {
    fields: JIRA_FIELDS,
    jql,
    maxResults,
  });

  return data.issues ?? [];
}

async function getIssueComments(issueKey: string): Promise<JiraComment[]> {
  const data = await jiraGet<{ comments?: JiraComment[] }>(
    `/issue/${issueKey}/comment`,
    { orderBy: "created" },
  );

  return data.comments ?? [];
}

export async function getTicketCommentContext(
  issueKey: string,
): Promise<TicketCommentContext[]> {
  const comments = await getIssueComments(issueKey);

  return comments.slice(-5).map((comment) => ({
    author: comment.author?.displayName ?? "Unknown",
    body:
      typeof comment.body === "string"
        ? comment.body
        : JSON.stringify(comment.body ?? ""),
    created: comment.created ?? "",
  }));
}

async function latestCommentIsFromReporter(
  issue: JiraIssue,
): Promise<[boolean, JiraComment | null]> {
  const reporter = issue.fields.reporter;

  if (!reporter) {
    return [false, null];
  }

  const comments = await getIssueComments(issue.key);

  if (comments.length === 0) {
    return [false, null];
  }

  const latestComment = comments.at(-1) ?? null;
  const latestAuthor = latestComment?.author;

  return [latestAuthor?.accountId === reporter.accountId, latestComment];
}

async function latestCommentMentionsReporter(
  issue: JiraIssue,
): Promise<[boolean, JiraComment | null]> {
  const reporter = issue.fields.reporter;

  if (!reporter) {
    return [false, null];
  }

  const comments = await getIssueComments(issue.key);

  if (comments.length === 0) {
    return [false, null];
  }

  const latestComment = comments.at(-1) ?? null;
  const body =
    typeof latestComment?.body === "string"
      ? latestComment.body
      : JSON.stringify(latestComment?.body ?? "");

  return [Boolean(reporter.accountId && body.includes(reporter.accountId)), latestComment];
}

function getOptionValue(option: JiraOption | null | undefined): string | undefined {
  return option?.value;
}

function getOptionArrayValue(items: JiraOption[] | null | undefined): string | undefined {
  if (!Array.isArray(items) || items.length === 0) {
    return undefined;
  }
  const values = items.map((item) => item.value).filter((value): value is string => Boolean(value));
  return values.length > 0 ? values.join(", ") : undefined;
}

function getServiceArrayValue(items: JiraServiceRef[] | null | undefined): string | undefined {
  if (!Array.isArray(items) || items.length === 0) {
    return undefined;
  }
  const names = items.map((item) => item.name).filter((name): name is string => Boolean(name));
  return names.length > 0 ? names.join(", ") : undefined;
}

function getProgressValue(progress: JiraProgress | null | undefined): string | undefined {
  if (!progress || typeof progress.total !== "number" || progress.total <= 0) {
    return undefined;
  }
  const percent = Math.round(((progress.progress ?? 0) / progress.total) * 100);
  return `${percent}%`;
}

function formatArrayField(items: Array<{ name?: string }> | undefined): string[] {
  if (!Array.isArray(items)) {
    return [];
  }
  return items.map((item) => item.name ?? "").filter(Boolean);
}

function truncateText(text: unknown, maxLength = 240): string | undefined {
  if (typeof text !== "string" || text.length === 0) {
    return undefined;
  }
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength).trim()}…`;
}

function formatIssue(
  issue: JiraIssue,
  latestComment: JiraComment | null = null,
): FormattedIssue {
  const fields = issue.fields;
  const priority = fields.priority?.name ?? "None";
  const priorityRank: Record<string, number> = {
    High: 2,
    Highest: 1,
    Low: 4,
    Lowest: 5,
    Medium: 3,
    None: 99,
  };
  const baseUrl = JIRA_BASE_URL?.replace(/\/+$/, "") ?? "";

  return {
    action_date: latestComment?.created ?? fields.updated,
    affected_services: getServiceArrayValue(fields.customfield_10039),
    assignee: fields.assignee?.displayName ?? "Unassigned",
    attachment_count: fields.attachment?.length ?? 0,
    client_support_task_type: getOptionValue(fields.customfield_10287),
    comment_count: fields.comment?.comments?.length ?? 0,
    components: formatArrayField(fields.components),
    created: fields.created,
    description: truncateText(fields.description),
    duedate: fields.duedate,
    escalation_field: getOptionValue(fields.customfield_10288),
    issue_type: fields.issuetype?.name,
    key: issue.key,
    labels: fields.labels ?? [],
    latest_comment_created: latestComment?.created ?? "",
    major_incident: fields.customfield_10046 ?? undefined,
    pending_reason: getOptionValue(fields.customfield_10043),
    priority,
    priority_sort: priorityRank[priority] ?? 99,
    progress: getProgressValue(fields.progress),
    project: fields.project?.key,
    reporter: fields.reporter?.displayName ?? "",
    severity: getOptionValue(fields.customfield_10048),
    source: getOptionValue(fields.customfield_10054),
    status: fields.status?.name,
    status_category: fields.status?.statusCategory?.key ?? undefined,
    subtask_count: fields.subtasks?.length ?? 0,
    summary: fields.summary,
    support_category: getOptionValue(fields.customfield_10166),
    team: getOptionArrayValue(fields.customfield_10162),
    updated: fields.updated,
    urgency: getOptionValue(fields.customfield_10042),
    url: `${baseUrl}/browse/${issue.key}`,
    pod: getOptionValue(fields.customfield_10165),
  };
}

async function getActionableItems(): Promise<FormattedIssue[]> {
  const results: FormattedIssue[] = [];

  const tsJql = `
        project = TS
        AND assignee = currentUser()
        AND statusCategory != Done
        ORDER BY updated DESC
    `;
  const tsIssues = await searchIssues(tsJql);

  for (const issue of tsIssues) {
    const [actionable, latestComment] = await latestCommentIsFromReporter(issue);

    if (actionable) {
      results.push({
        ...formatIssue(issue, latestComment),
        project: "TS",
      });
    }
  }

  const cpJql = `
        project = CP
        AND assignee = currentUser()
        AND statusCategory != Done
        ORDER BY updated DESC
    `;
  const cpIssues = await searchIssues(cpJql);

  for (const issue of cpIssues) {
    const [actionable, latestComment] = await latestCommentMentionsReporter(issue);

    if (actionable) {
      results.push({
        ...formatIssue(issue, latestComment),
        project: "CP",
      });
    }
  }

  results.sort((a, b) => {
    const priorityDiff = a.priority_sort - b.priority_sort;

    if (priorityDiff !== 0) {
      return priorityDiff;
    }

    return (a.action_date ?? a.updated ?? "").localeCompare(
      b.action_date ?? b.updated ?? "",
    );
  });

  return results;
}

async function getWaitingForProductTickets(): Promise<FormattedIssue[]> {
  const jql = `
        project = TS
        AND assignee = currentUser()
        AND statusCategory != Done
        AND status = "Waiting for Product"
        ORDER BY updated DESC
    `;

  return (await searchIssues(jql)).map((issue) => formatIssue(issue));
}

async function getWaitingForClientTickets(): Promise<FormattedIssue[]> {
  const jql = `
        project = TS
        AND assignee = currentUser()
        AND statusCategory != Done
        AND status = "Waiting for Client"
        ORDER BY updated DESC
    `;

  return (await searchIssues(jql)).map((issue) => formatIssue(issue));
}

async function getWaitingForOperationsTickets(): Promise<FormattedIssue[]> {
  const jql = `
        project = TS
        AND assignee = currentUser()
        AND statusCategory != Done
        AND status = "Waiting for Operations"
        ORDER BY updated DESC
    `;

  return (await searchIssues(jql)).map((issue) => formatIssue(issue));
}

export const CATEGORIES: Record<string, Category> = {
  actionable: {
    description: "Tickets requiring your attention.",
    loader: getActionableItems,
    title: "Actionable Items",
  },
  "waiting-product": {
    description: "TS tickets currently waiting for Product.",
    loader: getWaitingForProductTickets,
    title: "Waiting for Product",
  },
  "waiting-client": {
    description: "TS tickets currently waiting for Client.",
    loader: getWaitingForClientTickets,
    title: "Waiting for Client",
  },
  "waiting-operations": {
    description: "TS tickets currently waiting for Operations.",
    loader: getWaitingForOperationsTickets,
    title: "Waiting for Operations",
  },
};

export async function getDashboardTiles(): Promise<DashboardTile[]> {
  const tiles: DashboardTile[] = [];

  for (const [key, category] of Object.entries(CATEGORIES)) {
    const [, issues] = await getCategoryIssues(key);

    tiles.push({
      count: issues.length,
      description: category.description,
      key,
      title: category.title,
    });
  }

  return tiles;
}

export async function getCategoryIssues(
  categoryKey: string,
): Promise<[Category | null, FormattedIssue[]]> {
  const category = CATEGORIES[categoryKey];

  if (!category) {
    return [null, []];
  }

  const cacheKey = `category:${categoryKey}`;
  const cached = getCache<FormattedIssue[]>(cacheKey);

  if (cached) {
    return [category, cached.value];
  }

  const issues = await category.loader();
  setCache(cacheKey, issues);

  saveCategorySnapshot(categoryKey, category, issues).catch((error) => {
    console.error(`Failed to persist Jira snapshot for ${categoryKey}:`, error);
  });

  return [category, issues];
}

export async function refreshAllCategories(): Promise<void> {
  for (const categoryKey of Object.keys(CATEGORIES)) {
    const category = CATEGORIES[categoryKey];

    if (category) {
      const issues = await category.loader();
      setCache(`category:${categoryKey}`, issues);

      try {
        await saveCategorySnapshot(categoryKey, category, issues);
      } catch (error) {
        console.error(`Failed to persist Jira snapshot for ${categoryKey}:`, error);
      }
    }
  }
}

export function getCategoryCacheMeta(categoryKey: string): CategoryCacheMeta {
  const meta = getCacheMeta(`category:${categoryKey}`);

  if (!meta) {
    return {
      last_sync: "Not synced yet",
      next_sync: "",
      next_sync_iso: "",
    };
  }

  return {
    last_sync: formatDateTime(meta.createdAt),
    next_sync: formatDateTime(meta.expiresAt),
    next_sync_iso: meta.expiresAt.toISOString(),
  };
}
