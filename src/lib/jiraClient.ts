import { after } from "next/server";

import { getCache, getCacheMeta, setCache } from "@/lib/cache";
import { saveCategorySnapshot } from "@/lib/jiraSnapshotStore";

const JIRA_BASE_URL = process.env.JIRA_BASE_URL;
const JIRA_EMAIL = process.env.JIRA_EMAIL;
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN;

interface JiraAccount {
  accountId?: string;
  accountType?: string;
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

interface JiraAttachment {
  content?: string;
  filename?: string;
  id?: string;
  mimeType?: string;
  size?: number;
}

interface JiraLinkedIssue {
  fields?: {
    /* Jira Cloud always embeds issuetype on a linked issue's fields
       regardless of what was requested for the primary issue (confirmed
       live) - no extra per-CP fetch needed to check a linked CP's type. */
    issuetype?: JiraNamedField | null;
    status?: JiraStatus | null;
  };
  key?: string;
}

interface JiraIssueLink {
  inwardIssue?: JiraLinkedIssue;
  outwardIssue?: JiraLinkedIssue;
}

interface JiraIssueFields {
  assignee?: JiraAccount | null;
  attachment?: JiraAttachment[];
  comment?: { comments?: unknown[] };
  components?: Array<{ name?: string }>;
  created?: string;
  description?: string;
  duedate?: string;
  issuelinks?: JiraIssueLink[];
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

export interface OcrEligibleAttachment {
  contentUrl: string;
  filename: string;
  id: string;
  mimeType: string;
  size: number;
}

export interface LinkedCpIssue {
  isDone: boolean;
  issueType?: string;
  key: string;
  status: string;
}

export interface FormattedIssue {
  action_date?: string;
  affected_services?: string;
  assignee: string;
  assignee_account_id?: string;
  attachment_count: number;
  attachments: OcrEligibleAttachment[];
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
  linked_cp_issue?: LinkedCpIssue;
  /* Every CP-project ticket linked on either side of any link type, not just
     the first one linked_cp_issue collapses down to - closureCandidates.ts
     needs the full set to require ALL (non-Story) linked CPs resolved before
     treating a TS ticket as closable, not just one of several. */
  linked_cp_issues?: LinkedCpIssue[];
  major_incident?: string;
  pending_reason?: string;
  priority: string;
  priority_sort: number;
  progress?: string;
  project?: string;
  reporter: string;
  reporter_account_id?: string;
  reporter_is_external: boolean;
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

/** A per-team-member Jira Basic-auth pair (see src/lib/userJiraTokens.ts) - lets a write be posted under an individual's own Jira identity instead of the shared service account. */
export interface JiraCredentials {
  apiToken: string;
  email: string;
}

function requireJiraConfig(credentials?: JiraCredentials): {
  apiToken: string;
  baseUrl: string;
  email: string;
} {
  if (!JIRA_BASE_URL) {
    throw new Error("Missing Jira configuration. Set JIRA_BASE_URL.");
  }

  const email = credentials?.email ?? JIRA_EMAIL;
  const apiToken = credentials?.apiToken ?? JIRA_API_TOKEN;

  if (!email || !apiToken) {
    throw new Error(
      "Missing Jira configuration. Set JIRA_EMAIL and JIRA_API_TOKEN, or pass explicit credentials.",
    );
  }

  return {
    apiToken,
    baseUrl: JIRA_BASE_URL.replace(/\/+$/, ""),
    email,
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
  credentials?: JiraCredentials,
): Promise<T> {
  const { apiToken, baseUrl, email } = requireJiraConfig(credentials);
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
    throw new JiraRequestError(response.status, `Jira request failed with status ${response.status}`);
  }

  return (await response.json()) as T;
}

async function jiraPost<T>(path: string, body: unknown, credentials?: JiraCredentials): Promise<T> {
  const { apiToken, baseUrl, email } = requireJiraConfig(credentials);
  const normalizedPath = path.replace(/^\/+/, "");
  const url = new URL(`${baseUrl}/rest/api/3/${normalizedPath}`);

  const response = await fetch(url, {
    body: JSON.stringify(body),
    headers: {
      Accept: "application/json",
      Authorization: `Basic ${Buffer.from(`${email}:${apiToken}`).toString("base64")}`,
      "Content-Type": "application/json",
    },
    method: "POST",
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const responseBody = await response.text();
    console.error("Jira error:", response.status);
    console.error(responseBody);
    throw new JiraRequestError(response.status, `Jira request failed with status ${response.status}`);
  }

  return (await response.json()) as T;
}

export async function downloadAttachment(contentUrl: string): Promise<Buffer> {
  const { apiToken, email } = requireJiraConfig();

  const response = await fetch(contentUrl, {
    headers: {
      Authorization: `Basic ${Buffer.from(`${email}:${apiToken}`).toString("base64")}`,
    },
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new Error(`Jira attachment download failed with status ${response.status}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

/** Thrown by jiraGet/jiraPost so callers (e.g. the per-user-token fallback in the follow-up send route) can distinguish an expired/revoked personal token (401/403) from any other Jira failure. */
export class JiraRequestError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "JiraRequestError";
    this.status = status;
  }
}

/** Passing `credentials` validates a specific team member's own email+token pair against Jira's own `/myself` (used when they register a personal token in Settings) instead of the shared service account. */
export async function getCurrentUser(credentials?: JiraCredentials): Promise<CurrentUser> {
  const data = await jiraGet<JiraAccount>("/myself", undefined, credentials);

  return {
    account_id: data.accountId,
    display_name: data.displayName,
    email: data.emailAddress,
  };
}

/* Long TTL (7 days): resolving a POD's EM/PM/PM-Manager by name (see
   src/lib/podRouting.ts) is a org-chart lookup that changes rarely, not
   per-ticket data - re-searching Jira on every CP escalation draft would be
   wasteful and slow. Keyed by the exact name string passed in, so a typo'd
   or since-renamed name just misses the cache rather than serving stale data
   for the wrong query. */
const JIRA_USER_SEARCH_TTL_SECONDS = 7 * 86_400;

/**
 * Resolves a Jira display name (e.g. "Saro Deravanesian", from the POD
 * org-chart mapping) to that account's real Jira accountId, via Jira's own
 * user-search endpoint - never guessed or hardcoded, since accountIds are
 * opaque per-workspace identifiers with no derivable pattern. Returns null
 * (not a throw) for no match or more than one match, since either case means
 * this specific name can't be trusted to identify exactly one person -
 * callers should treat that the same as "nobody to tag" rather than guessing
 * which of several same-named accounts was meant.
 */
export async function findJiraUserByName(
  name: string,
): Promise<{ account_id: string; display_name: string } | null> {
  const cacheKey = `jira_user_search:${name.trim().toLowerCase()}`;
  const cached = await getCache<{ account_id: string; display_name: string } | null>(cacheKey);

  if (cached) {
    return cached.value;
  }

  let matches: JiraAccount[];

  try {
    matches = await jiraGet<JiraAccount[]>("/user/search", { query: name });
  } catch (error) {
    console.warn(`Jira user search failed for "${name}".`, error);
    return null;
  }

  const realAccounts = matches.filter((account) => account.accountType === "atlassian");

  if (realAccounts.length !== 1 || !realAccounts[0]?.accountId) {
    if (realAccounts.length > 1) {
      console.warn(`Jira user search for "${name}" matched ${realAccounts.length} accounts - ambiguous, treating as unresolved.`);
    }
    await setCache(cacheKey, null, JIRA_USER_SEARCH_TTL_SECONDS);
    return null;
  }

  const result = { account_id: realAccounts[0].accountId, display_name: realAccounts[0].displayName ?? name };
  await setCache(cacheKey, result, JIRA_USER_SEARCH_TTL_SECONDS);
  return result;
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
  "issuelinks",
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

/** Just who posted each comment and when - enough for src/lib/replyTracking.ts to work out who's waiting on whom, without carrying comment bodies around. */
export interface CommentAuthorship {
  authorAccountId?: string;
  authorAccountType?: string;
  created: string;
}

export async function getIssueCommentAuthorship(issueKey: string): Promise<CommentAuthorship[]> {
  const comments = await getIssueComments(issueKey);

  return comments.map((comment) => ({
    authorAccountId: comment.author?.accountId,
    authorAccountType: comment.author?.accountType,
    created: comment.created ?? "",
  }));
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

interface AdfMentionNode {
  attrs?: {
    id?: string;
    text?: string;
  };
  content?: AdfMentionNode[];
  type?: string;
}

export interface CommentMention {
  accountId: string;
  displayName: string;
}

function collectMentions(node: AdfMentionNode, out: CommentMention[]): void {
  if (node.type === "mention" && node.attrs?.id) {
    out.push({
      accountId: node.attrs.id,
      displayName: node.attrs.text?.replace(/^@/, "") ?? node.attrs.id,
    });
  }

  for (const child of node.content ?? []) {
    collectMentions(child, out);
  }
}

/**
 * Finds the most recent comment (any author) that @-mentions at least one
 * person, and returns everyone mentioned there - used to find who to
 * re-escalate to on an unassigned CP ticket ("someone already tagged a
 * person informally, keep pinging that same person"). Different question
 * from latestCommentMentionsReporter() above (which only checks whether the
 * ticket's own reporter specifically was mentioned, for TS/CP actionability)
 * - kept separate rather than merged, since actionability and "who to
 * escalate to" are genuinely different questions with different answers.
 */
/**
 * Pure ADF-walking half of getLatestCommentMentions() below, separated out
 * so the mention-extraction logic (the part actually worth testing
 * carefully) can be unit-tested with constructed comment fixtures instead
 * of needing a live Jira call - jiraGet()'s config check happens against
 * module-level constants captured at import time, so mocking JIRA_BASE_URL
 * etc. via process.env after the fact has no effect on it.
 */
export function extractLatestMentionFromComments(
  comments: Array<{ body?: unknown }>,
): CommentMention[] {
  for (let i = comments.length - 1; i >= 0; i -= 1) {
    const body = comments[i]?.body;

    if (!body || typeof body !== "object") {
      continue;
    }

    const mentions: CommentMention[] = [];
    collectMentions(body, mentions);

    if (mentions.length > 0) {
      return mentions;
    }
  }

  return [];
}

export async function getLatestCommentMentions(issueKey: string): Promise<CommentMention[]> {
  const comments = await getIssueComments(issueKey);
  return extractLatestMentionFromComments(comments);
}

export async function getIssueByKey(issueKey: string): Promise<FormattedIssue | null> {
  const escapedKey = issueKey.replace(/"/g, '\\"');
  const issues = await searchIssues(`key = "${escapedKey}"`, 1);
  const issue = issues[0];

  return issue ? formatIssue(issue) : null;
}

export interface IssueSummary {
  key: string;
  priority: string;
  status?: string;
  summary?: string;
  updated?: string;
}

/**
 * Lightweight JQL search for AI tool-calling use (see src/lib/agentTools.ts)
 * - trimmed fields only, so a tool result stays small in the model's
 * context. Use getIssueByKey() when full detail on one specific ticket is
 * actually needed.
 */
export async function searchIssuesSummary(jql: string, maxResults = 5): Promise<IssueSummary[]> {
  const issues = await searchIssues(jql, maxResults);

  return issues.map((issue) => {
    const formatted = formatIssue(issue);
    return {
      key: formatted.key,
      priority: formatted.priority,
      status: formatted.status,
      summary: formatted.summary,
      updated: formatted.updated,
    };
  });
}

export interface ClosedIssueSummary {
  closedAt: string;
  key: string;
  reporter: string;
  status?: string;
  summary?: string;
  url: string;
}

/**
 * Paginated (nextPageToken) search returning just enough to list a closed
 * ticket - searchIssues() above stops at one page, which is fine for open
 * queues but not for "everything closed in the last six weeks". Capped at
 * maxTotal so a runaway JQL can't page forever.
 */
export async function searchClosedIssues(jql: string, maxTotal = 1000): Promise<ClosedIssueSummary[]> {
  const baseUrl = JIRA_BASE_URL?.replace(/\/+$/, "") ?? "";
  const results: ClosedIssueSummary[] = [];
  let nextPageToken: string | undefined;

  do {
    const data = await jiraGet<{
      issues?: Array<{
        fields: {
          reporter?: JiraAccount | null;
          resolutiondate?: string | null;
          status?: JiraStatus | null;
          statuscategorychangedate?: string | null;
          summary?: string;
        };
        key: string;
      }>;
      nextPageToken?: string;
    }>("/search/jql", {
      fields: "summary,status,reporter,statuscategorychangedate,resolutiondate",
      jql,
      maxResults: 100,
      ...(nextPageToken ? { nextPageToken } : {}),
    });

    for (const issue of data.issues ?? []) {
      results.push({
        closedAt: issue.fields.statuscategorychangedate ?? issue.fields.resolutiondate ?? "",
        key: issue.key,
        reporter: issue.fields.reporter?.displayName ?? "",
        status: issue.fields.status?.name,
        summary: issue.fields.summary,
        url: `${baseUrl}/browse/${issue.key}`,
      });
    }

    nextPageToken = data.nextPageToken;
  } while (nextPageToken && results.length < maxTotal);

  return results;
}

/** Jira's own approximate count for a JQL - one call regardless of how many issues match, for totals too large to page through. */
export async function countIssues(jql: string): Promise<number> {
  const data = await jiraPost<{ count?: number }>("/search/approximate-count", { jql });
  return data.count ?? 0;
}

interface JiraCommentResponse {
  id: string;
}

export const MENTION_PLACEHOLDER = "{{MENTION}}";

/**
 * Splits `text` on every occurrence of MENTION_PLACEHOLDER and builds an ADF
 * paragraph with a real `mention` node in each spot, consuming
 * `mentionAccountId` in order (a single string is one mention, same as
 * before; an array lets a CP escalation tag several people - e.g. a POD's
 * Engineering Manager and Product Manager together - by repeating the
 * placeholder in the drafted text once per person). A literal "@name" or
 * "[~accountid:...]" in plain text does NOT create a working Jira mention
 * (no notification, no link) - it has to be this node type. Falls back to a
 * single plain-text node if there's no placeholder or no accountId(s). If
 * the text has more placeholder occurrences than accountIds were given (should
 * only happen if a draft's wording drifted from what was resolved), the last
 * accountId repeats rather than leaving a placeholder as broken literal text.
 */
export function buildCommentAdfContent(
  text: string,
  mentionAccountId?: string | string[],
): Array<Record<string, unknown>> {
  const ids = (Array.isArray(mentionAccountId) ? mentionAccountId : [mentionAccountId]).filter(
    (id): id is string => Boolean(id),
  );

  if (ids.length === 0 || !text.includes(MENTION_PLACEHOLDER)) {
    return [{ text, type: "text" }];
  }

  const segments = text.split(MENTION_PLACEHOLDER);
  const content: Array<Record<string, unknown>> = [];

  segments.forEach((segment, index) => {
    if (segment) {
      content.push({ text: segment, type: "text" });
    }
    if (index < segments.length - 1) {
      content.push({ attrs: { id: ids[index] ?? ids[ids.length - 1] }, type: "mention" });
    }
  });

  return content;
}

export async function addFollowUpComment(
  issueKey: string,
  text: string,
  mentionAccountId?: string | string[],
  credentials?: JiraCredentials,
): Promise<{ id: string }> {
  const response = await jiraPost<JiraCommentResponse>(
    `/issue/${issueKey}/comment`,
    {
      body: {
        content: [
          {
            content: buildCommentAdfContent(text, mentionAccountId),
            type: "paragraph",
          },
        ],
        type: "doc",
        version: 1,
      },
    },
    credentials,
  );

  return { id: response.id };
}

interface JiraTransition {
  id: string;
  name: string;
  to?: {
    name?: string;
    statusCategory?: { key?: string };
  };
}

async function getAvailableTransitions(
  issueKey: string,
  credentials?: JiraCredentials,
): Promise<JiraTransition[]> {
  const data = await jiraGet<{ transitions?: JiraTransition[] }>(
    `/issue/${issueKey}/transitions`,
    undefined,
    credentials,
  );
  return data.transitions ?? [];
}

export type TransitionToDoneResult =
  | { transitioned: true }
  | { reason: string; transitioned: false };

/**
 * Transitions are workflow-specific (the id that reaches "Done" for one issue
 * type/project is not guaranteed to be the same for another), so this always
 * looks up the issue's own available transitions rather than assuming a
 * fixed id, and only acts on an exact "Done" status name match - it will not
 * guess at a same-category status like "Closed"/"Released" instead.
 */
export async function transitionIssueToDone(
  issueKey: string,
  credentials?: JiraCredentials,
): Promise<TransitionToDoneResult> {
  const transitions = await getAvailableTransitions(issueKey, credentials);
  const doneTransition = transitions.find((transition) => transition.to?.name?.toLowerCase() === "done");

  if (!doneTransition) {
    return { reason: `No transition to a "Done" status is available for ${issueKey}.`, transitioned: false };
  }

  try {
    await jiraPost(
      `/issue/${issueKey}/transitions`,
      {
        transition: { id: doneTransition.id },
      },
      credentials,
    );
    return { transitioned: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { reason: `Failed to transition ${issueKey} to Done: ${message}`, transitioned: false };
  }
}

export interface LinkedCpDetail {
  assigneeEmpty: boolean;
  isStale: boolean;
  key: string;
  status: string;
}

/** Extra per-CP-issue fetch for the "not assigned or worked on" check - the
 * embedded issuelinks data (see getLinkedCpIssue) only carries status, not
 * assignee/updated. Only called for the small subset of tickets that already
 * have a linked CP issue, never in bulk. */
export async function getLinkedCpDetail(cpKey: string): Promise<LinkedCpDetail | null> {
  try {
    const issue = await jiraGet<JiraIssue>(`/issue/${cpKey}`, {
      fields: "assignee,status,updated",
    });
    const updated = issue.fields.updated;
    const daysSinceUpdate = updated ? (Date.now() - Date.parse(updated)) / 86_400_000 : Infinity;

    return {
      assigneeEmpty: !issue.fields.assignee,
      isStale: daysSinceUpdate >= 3,
      key: cpKey,
      status: issue.fields.status?.name ?? "Unknown",
    };
  } catch (error) {
    console.warn(`Failed to fetch linked CP detail for ${cpKey}:`, error);
    return null;
  }
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

const MAX_OCR_ATTACHMENT_BYTES = 15 * 1024 * 1024;

function isOcrEligibleMimeType(mimeType: string): boolean {
  return mimeType.startsWith("image/") || mimeType === "application/pdf";
}

function getOcrEligibleAttachments(
  attachments: JiraAttachment[] | undefined,
): OcrEligibleAttachment[] {
  if (!Array.isArray(attachments)) {
    return [];
  }

  return attachments
    .filter(
      (attachment): attachment is Required<Pick<JiraAttachment, "content" | "filename" | "id" | "mimeType">> & JiraAttachment =>
        Boolean(attachment.id && attachment.content && attachment.filename && attachment.mimeType),
    )
    .filter((attachment) => isOcrEligibleMimeType(attachment.mimeType))
    .filter((attachment) => (attachment.size ?? 0) <= MAX_OCR_ATTACHMENT_BYTES)
    .map((attachment) => ({
      contentUrl: attachment.content,
      filename: attachment.filename,
      id: attachment.id,
      mimeType: attachment.mimeType,
      size: attachment.size ?? 0,
    }));
}

export function truncateText(text: unknown, maxLength = 240): string | undefined {
  if (typeof text !== "string" || text.length === 0) {
    return undefined;
  }
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength).trim()}…`;
}

function toLinkedCpIssue(linked: JiraLinkedIssue): LinkedCpIssue | undefined {
  if (!linked.key?.startsWith("CP-")) {
    return undefined;
  }

  const status = linked.fields?.status;

  return {
    isDone: status?.statusCategory?.key === "done",
    issueType: linked.fields?.issuetype?.name,
    key: linked.key,
    status: status?.name ?? "Unknown",
  };
}

/** Every CP-project issue linked on either side of any link type (Action item, Problem/Incident, etc. all observed in practice). */
function getAllLinkedCpIssues(links: JiraIssueLink[] | undefined): LinkedCpIssue[] {
  if (!Array.isArray(links)) {
    return [];
  }

  const results: LinkedCpIssue[] = [];

  for (const link of links) {
    const linked = link.inwardIssue ?? link.outwardIssue;
    const cpIssue = linked ? toLinkedCpIssue(linked) : undefined;

    if (cpIssue) {
      results.push(cpIssue);
    }
  }

  return results;
}

/** First linked CP-project issue found on either side of any link type (Action item, Problem/Incident, etc. all observed in practice - the SLA follow-up feature only cares that a CP ticket is linked, not which link type). Most callers want this single-result convenience; closureCandidates.ts uses getAllLinkedCpIssues instead since it must not silently drop additional linked CPs. */
function getLinkedCpIssue(links: JiraIssueLink[] | undefined): LinkedCpIssue | undefined {
  return getAllLinkedCpIssues(links)[0];
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
    assignee_account_id: fields.assignee?.accountId,
    attachment_count: fields.attachment?.length ?? 0,
    attachments: getOcrEligibleAttachments(fields.attachment),
    linked_cp_issue: getLinkedCpIssue(fields.issuelinks),
    linked_cp_issues: getAllLinkedCpIssues(fields.issuelinks),
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
    reporter_account_id: fields.reporter?.accountId,
    /* Jira's own distinction: "customer" = Jira Service Management portal/customer account, anything else (e.g. "atlassian") = a licensed internal user. */
    reporter_is_external: fields.reporter?.accountType === "customer",
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

function parseIntEnv(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Runs fn over items with at most `limit` in flight at once. getActionableItems
 * needs one Jira comment-fetch per candidate ticket to decide if it's actionable
 * - awaiting those one at a time (as this used to) turns a page load into
 * hundreds of sequential round-trips to Jira. Unbounded Promise.all instead
 * risks tripping Jira's rate limits, so this caps concurrency instead.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const currentIndex = nextIndex;
      nextIndex += 1;

      if (currentIndex >= items.length) {
        return;
      }

      const item = items[currentIndex];

      if (item !== undefined) {
        results[currentIndex] = await fn(item);
      }
    }
  }

  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return results;
}

async function getActionableItems(): Promise<FormattedIssue[]> {
  const concurrency = parseIntEnv(process.env.JIRA_FETCH_CONCURRENCY, 8);
  const results: FormattedIssue[] = [];

  const tsJql = `
        project = TS
        AND assignee = currentUser()
        AND statusCategory != Done
        ORDER BY updated DESC
    `;
  const tsIssues = await searchIssues(tsJql);

  const tsResults = await mapWithConcurrency<JiraIssue, FormattedIssue | null>(
    tsIssues,
    concurrency,
    async (issue) => {
      const [actionable, latestComment] = await latestCommentIsFromReporter(issue);
      return actionable ? { ...formatIssue(issue, latestComment), project: "TS" } : null;
    },
  );

  results.push(
    ...tsResults.filter((issue): issue is FormattedIssue => issue !== null),
  );

  const cpJql = `
        project = CP
        AND assignee = currentUser()
        AND statusCategory != Done
        ORDER BY updated DESC
    `;
  const cpIssues = await searchIssues(cpJql);

  const cpResults = await mapWithConcurrency<JiraIssue, FormattedIssue | null>(
    cpIssues,
    concurrency,
    async (issue) => {
      const [actionable, latestComment] = await latestCommentMentionsReporter(issue);
      return actionable ? { ...formatIssue(issue, latestComment), project: "CP" } : null;
    },
  );

  results.push(
    ...cpResults.filter((issue): issue is FormattedIssue => issue !== null),
  );

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
  const tsJql = `
        project = TS
        AND assignee = currentUser()
        AND statusCategory != Done
        AND status = "Waiting for Product"
        ORDER BY updated DESC
    `;
  const tsIssues = await searchIssues(tsJql);

  const cpJql = `
        project = CP
        AND status in ("Backlog", "Selected For Sprint")
        AND assignee = currentUser()
        ORDER BY updated DESC
    `;
  const cpIssues = await searchIssues(cpJql);

  const results = [...tsIssues, ...cpIssues].map((issue) => formatIssue(issue));

  results.sort((a, b) => (b.updated ?? "").localeCompare(a.updated ?? ""));

  return results;
}

/**
 * TS-only "Waiting for Product" tickets, unlike getWaitingForProductTickets()
 * above which unions in CP Backlog/Selected-for-Sprint tickets for the
 * dashboard category view. src/lib/productWaitFollowup.ts needs the TS-only
 * set - a CP ticket has no "reporter_is_external" concept, so mixing them in
 * here would be meaningless for that feature.
 */
export async function getWaitingForProductTsOnly(): Promise<FormattedIssue[]> {
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
  return Promise.all(
    Object.entries(CATEGORIES).map(async ([key, category]) => {
      const [, issues] = await getCategoryIssues(key);

      return {
        count: issues.length,
        description: category.description,
        key,
        title: category.title,
      };
    }),
  );
}

export async function getCategoryIssues(
  categoryKey: string,
): Promise<[Category | null, FormattedIssue[]]> {
  const category = CATEGORIES[categoryKey];

  if (!category) {
    return [null, []];
  }

  const cacheKey = `category:${categoryKey}`;
  const cached = await getCache<FormattedIssue[]>(cacheKey);

  if (cached) {
    return [category, cached.value];
  }

  const issues = await category.loader();
  await setCache(cacheKey, issues);

  after(() =>
    saveCategorySnapshot(categoryKey, category, issues).catch((error) => {
      console.error(`Failed to persist Jira snapshot for ${categoryKey}:`, error);
    }),
  );

  return [category, issues];
}

export async function refreshAllCategories(): Promise<void> {
  await Promise.all(
    Object.entries(CATEGORIES).map(async ([categoryKey, category]) => {
      const issues = await category.loader();
      await setCache(`category:${categoryKey}`, issues);

      try {
        await saveCategorySnapshot(categoryKey, category, issues);
      } catch (error) {
        console.error(`Failed to persist Jira snapshot for ${categoryKey}:`, error);
      }
    }),
  );
}

export async function getCategoryCacheMeta(
  categoryKey: string,
): Promise<CategoryCacheMeta> {
  const meta = await getCacheMeta(`category:${categoryKey}`);

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
