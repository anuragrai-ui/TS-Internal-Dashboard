import { getCache, getCacheMeta, setCache } from "@/lib/cache";

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

interface JiraIssueFields {
  assignee?: JiraAccount | null;
  priority?: JiraNamedField | null;
  project?: JiraNamedField | null;
  reporter?: JiraAccount | null;
  status?: JiraNamedField | null;
  summary?: string;
  updated?: string;
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
  assignee: string;
  key: string;
  latest_comment_created: string;
  priority: string;
  priority_sort: number;
  project?: string;
  reporter: string;
  status?: string;
  summary?: string;
  updated?: string;
  url: string;
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

async function searchIssues(jql: string, maxResults = 100): Promise<JiraIssue[]> {
  const data = await jiraGet<{ issues?: JiraIssue[] }>("/search/jql", {
    fields: "summary,status,assignee,reporter,priority,updated,project",
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
    assignee: fields.assignee?.displayName ?? "Unassigned",
    key: issue.key,
    latest_comment_created: latestComment?.created ?? "",
    priority,
    priority_sort: priorityRank[priority] ?? 99,
    project: fields.project?.key,
    reporter: fields.reporter?.displayName ?? "",
    status: fields.status?.name,
    summary: fields.summary,
    updated: fields.updated,
    url: `${baseUrl}/browse/${issue.key}`,
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

  return [category, issues];
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
