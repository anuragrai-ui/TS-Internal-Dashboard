import type { JiraCredentials } from "@/lib/jiraClient";
import type { ActionArgs } from "@/lib/workspace/types";

/**
 * Jira writes from the tracker: comment / internal note, status transition,
 * assignee, priority and "link a CP". Every call goes out with the ACTING
 * PERSON's own registered token (src/lib/userJiraTokens.ts), never the shared
 * service account, so Jira's own permissions decide what they may do and the
 * change is attributed to them in Jira's history.
 *
 * Outcomes are classified for the action pipeline (src/lib/actions/service.ts):
 * - Jira answered 4xx (or refused a pre-check)  -> failed, with Jira's own message
 *   (a required resolution, a missing permission...). Nothing changed.
 * - Timeout, dropped connection or 5xx on the WRITE itself -> uncertain: the
 *   request was sent and may have been applied. Never retried automatically.
 * A failed READ before the write (the transition list, the CP lookup) is
 * always "failed": nothing was sent that could have changed anything.
 *
 * Never throws. Error text never includes the token or the Authorization header.
 */

export const MISSING_TOKEN_MESSAGE = "Your Jira token isn't available - re-register it on Jira Tokens";

/* At most three calls per action (version, lookup, write): 3 x 15s stays well inside the routes' maxDuration (120s). */
const DEFAULT_TIMEOUT_MS = 15_000;
const ERROR_MAX_CHARS = 400;

export interface JiraWriteConfig {
  /* A bare https origin, no trailing slash. */
  baseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export type JiraWriteResult =
  | { error: string; status: "failed" | "uncertain" }
  | { externalId?: string; externalUrl?: string; status: "succeeded" };

/** JIRA_BASE_URL as a write config, or null when it's missing or isn't an https origin. */
export function jiraWriteConfigFromEnv(env: Record<string, string | undefined> = process.env): JiraWriteConfig | null {
  const raw = env.JIRA_BASE_URL?.trim();
  if (!raw) {
    return null;
  }
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
      return null;
    }
    return { baseUrl: `${url.origin}${url.pathname.replace(/\/+$/, "")}` };
  } catch {
    return null;
  }
}

/* ----------------------------------------------------------------- ADF */

type AdfNode = Record<string, unknown>;

/**
 * Plain text -> an Atlassian Document: a blank line starts a new paragraph,
 * a single newline is a hard break inside one. ADF refuses empty text nodes,
 * so blank and whitespace-only lines never become one. Pure.
 */
export function plainTextToAdf(text: string): { content: AdfNode[]; type: "doc"; version: 1 } {
  const paragraphs = text
    .replace(/\r\n?/g, "\n")
    .split(/\n[ \t]*\n/)
    .map((block) => block.split("\n").map((line) => line.replace(/\s+$/, "")))
    .map((lines) => {
      while (lines.length > 0 && lines[0] === "") {
        lines.shift();
      }
      while (lines.length > 0 && lines[lines.length - 1] === "") {
        lines.pop();
      }
      return lines;
    })
    .filter((lines) => lines.length > 0);

  const content = paragraphs.map((lines): AdfNode => {
    const inline: AdfNode[] = [];
    lines.forEach((line, index) => {
      if (index > 0) {
        inline.push({ type: "hardBreak" });
      }
      if (line) {
        inline.push({ text: line, type: "text" });
      }
    });
    return { content: inline, type: "paragraph" };
  });

  return { content, type: "doc", version: 1 };
}

/* --------------------------------------------------------------- calls */

type JiraCallResult<T> =
  | { data: T | null; ok: true }
  | { kind: "http"; message: string; ok: false; status: number }
  | { kind: "network"; message: string; ok: false; timedOut: boolean };

/** Jira's own words from an error body ({errorMessages, errors}), clipped. Pure. */
export function jiraErrorMessage(status: number, bodyText: string): string {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    /* An HTML error page from a proxy - fall through to the status line. */
  }
  const record = parsed && typeof parsed === "object" ? (parsed as { errorMessages?: unknown; errors?: unknown }) : {};
  const messages = Array.isArray(record.errorMessages) ? record.errorMessages.filter((message): message is string => typeof message === "string") : [];
  const fieldErrors =
    record.errors && typeof record.errors === "object"
      ? Object.entries(record.errors as Record<string, unknown>)
          .filter((entry): entry is [string, string] => typeof entry[1] === "string")
          .map(([field, message]) => `${field}: ${message}`)
      : [];
  const detail = [...messages, ...fieldErrors].join("; ");
  const text = detail || `Jira answered ${status}.`;
  const clipped = text.length > ERROR_MAX_CHARS ? `${text.slice(0, ERROR_MAX_CHARS - 1)}…` : text;

  if (status === 401) {
    return "Jira rejected your token (401) - re-register it on Jira Tokens.";
  }
  if (status === 403) {
    return `Jira says you don't have permission for this (403). ${detail ? clipped : ""}`.trim();
  }
  return clipped;
}

function authorization(creds: JiraCredentials): string {
  return `Basic ${Buffer.from(`${creds.email}:${creds.apiToken}`).toString("base64")}`;
}

async function jiraCall<T>(
  config: JiraWriteConfig,
  creds: JiraCredentials,
  method: "GET" | "POST" | "PUT",
  path: string,
  options: { body?: unknown; params?: Record<string, string> } = {},
): Promise<JiraCallResult<T>> {
  const url = new URL(`${config.baseUrl}/rest/api/3${path}`);
  for (const [name, value] of Object.entries(options.params ?? {})) {
    url.searchParams.set(name, value);
  }

  let response: Response;
  try {
    response = await (config.fetchImpl ?? fetch)(url, {
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      headers: {
        Accept: "application/json",
        Authorization: authorization(creds),
        ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      method,
      /* A redirect would carry Basic auth somewhere we didn't choose; a 3xx is reported as a failure instead. */
      redirect: "manual",
      signal: AbortSignal.timeout(config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return { kind: "network", message: timedOut ? "timed out" : "connection failed", ok: false, timedOut };
  }

  if (response.status >= 300 && response.status < 400) {
    return { kind: "http", message: `Jira redirected the request (${response.status}).`, ok: false, status: response.status };
  }
  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    return { kind: "http", message: jiraErrorMessage(response.status, bodyText), ok: false, status: response.status };
  }

  /* 204 (assignee, priority, transition) and 201 (issueLink) come back without a body. */
  const bodyText = await response.text().catch(() => "");
  if (!bodyText) {
    return { data: null, ok: true };
  }
  try {
    return { data: JSON.parse(bodyText) as T, ok: true };
  } catch {
    return { data: null, ok: true };
  }
}

function readFailure(what: string, result: Exclude<JiraCallResult<unknown>, { ok: true }>): JiraWriteResult {
  return {
    error: result.kind === "network" ? `Couldn't reach Jira to ${what} (${result.message}). Nothing was changed.` : result.message,
    status: "failed",
  };
}

function writeOutcome<T>(result: JiraCallResult<T>, onSuccess: (data: T | null) => JiraWriteResult): JiraWriteResult {
  if (result.ok) {
    return onSuccess(result.data);
  }
  if (result.kind === "network") {
    return {
      error: result.timedOut
        ? "Jira didn't answer in time - the change may have happened. Check Jira before retrying."
        : "The connection to Jira dropped - the change may have happened. Check Jira before retrying.",
      status: "uncertain",
    };
  }
  if (result.status >= 500) {
    return { error: `Jira answered ${result.status} - the change may have happened. Check Jira before retrying.`, status: "uncertain" };
  }
  return { error: result.message, status: "failed" };
}

function issuePath(key: string): string {
  return `/issue/${encodeURIComponent(key)}`;
}

function browseUrl(config: JiraWriteConfig, key: string): string {
  return `${config.baseUrl}/browse/${encodeURIComponent(key)}`;
}

/** The ticket's Jira `updated` as the person sees it - what expectedVersion is compared with. Never throws. */
export async function getTicketVersion(
  key: string,
  creds: JiraCredentials,
  config: JiraWriteConfig,
): Promise<{ ok: true; version: string | null } | { error: string; ok: false }> {
  const result = await jiraCall<{ fields?: { updated?: unknown } }>(config, creds, "GET", issuePath(key), { params: { fields: "updated" } });
  if (!result.ok) {
    return { error: result.kind === "network" ? `Jira ${result.message}` : result.message, ok: false };
  }
  const updated = result.data?.fields?.updated;
  return { ok: true, version: typeof updated === "string" && updated ? updated : null };
}

export interface JiraTransitionOption {
  id: string;
  name: string;
  toStatus: string;
}

/** The transitions this person may make on the ticket right now. Never throws. */
export async function getTransitions(
  key: string,
  creds: JiraCredentials,
  config: JiraWriteConfig,
): Promise<{ ok: true; transitions: JiraTransitionOption[] } | { error: string; ok: false }> {
  const result = await jiraCall<{ transitions?: Array<{ id?: unknown; name?: unknown; to?: { name?: unknown } }> }>(
    config,
    creds,
    "GET",
    `${issuePath(key)}/transitions`,
  );
  if (!result.ok) {
    return { error: result.kind === "network" ? `Jira ${result.message}` : result.message, ok: false };
  }
  const transitions = (result.data?.transitions ?? []).flatMap((transition): JiraTransitionOption[] =>
    typeof transition.id === "string" && typeof transition.name === "string"
      ? [{ id: transition.id, name: transition.name, toStatus: typeof transition.to?.name === "string" ? transition.to.name : transition.name }]
      : [],
  );
  return { ok: true, transitions };
}

/** A Jira account's display name; `name: null` when Jira has no such account. Never throws. */
export async function getJiraUserName(
  accountId: string,
  creds: JiraCredentials,
  config: JiraWriteConfig,
): Promise<{ name: string | null; ok: true } | { error: string; ok: false }> {
  const result = await jiraCall<{ displayName?: unknown }>(config, creds, "GET", "/user", { params: { accountId } });
  if (!result.ok) {
    return result.kind === "http" && result.status === 404 ? { name: null, ok: true } : { error: result.kind === "network" ? `Jira ${result.message}` : result.message, ok: false };
  }
  return { name: typeof result.data?.displayName === "string" && result.data.displayName ? result.data.displayName : null, ok: true };
}

/* A proposal's transitionName is only a label: it must name the id it travels with (the transition or its target status). */
function sameLabel(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** People Jira lets this person assign the ticket to, matching `query` (Jira's own search). Never throws. */
export async function searchAssignableUsers(
  key: string,
  query: string,
  creds: JiraCredentials,
  config: JiraWriteConfig,
): Promise<{ ok: true; users: Array<{ accountId: string; displayName: string }> } | { error: string; ok: false }> {
  const result = await jiraCall<Array<{ accountId?: unknown; accountType?: unknown; active?: unknown; displayName?: unknown }>>(
    config,
    creds,
    "GET",
    "/user/assignable/search",
    { params: { issueKey: key, maxResults: "50", query } },
  );
  if (!result.ok) {
    return { error: result.kind === "network" ? `Jira ${result.message}` : result.message, ok: false };
  }
  const users = (Array.isArray(result.data) ? result.data : []).flatMap((user) =>
    typeof user.accountId === "string" && typeof user.displayName === "string" && user.active !== false && user.accountType !== "app" && user.accountType !== "customer"
      ? [{ accountId: user.accountId, displayName: user.displayName }]
      : [],
  );
  return { ok: true, users };
}

/** Performs one Jira operation on `ticketKey` with the person's credentials and classifies the outcome. Never throws. */
export async function executeJiraWrite(ticketKey: string, args: ActionArgs, creds: JiraCredentials, config: JiraWriteConfig): Promise<JiraWriteResult> {
  try {
    switch (args.operation) {
      case "jira_comment": {
        const body = {
          body: plainTextToAdf(args.body),
          ...(args.visibility === "internal" ? { properties: [{ key: "sd.public.comment", value: { internal: true } }] } : {}),
        };
        const result = await jiraCall<{ id?: unknown }>(config, creds, "POST", `${issuePath(ticketKey)}/comment`, { body });
        return writeOutcome(result, (data) => {
          const id = typeof data?.id === "string" ? data.id : undefined;
          return {
            ...(id ? { externalId: id } : {}),
            externalUrl: id ? `${browseUrl(config, ticketKey)}?focusedCommentId=${encodeURIComponent(id)}` : browseUrl(config, ticketKey),
            status: "succeeded",
          };
        });
      }

      case "jira_transition": {
        /* The person's own list, re-read now: the ticket may have moved since the menu was drawn, and Jira's
           answer to an unavailable id is an unhelpful 400. */
        const available = await getTransitions(ticketKey, creds, config);
        if (!available.ok) {
          return { error: `Couldn't read ${ticketKey}'s available transitions: ${available.error}. Nothing was changed.`, status: "failed" };
        }
        const transition = available.transitions.find((candidate) => candidate.id === args.transitionId);
        if (!transition) {
          return {
            error: `"${args.transitionName}" isn't available on ${ticketKey} for you right now (its status may have changed) - reload and pick again.`,
            status: "failed",
          };
        }
        /* The reviewer approved the label; never let it stand for a different transition than the id performs. */
        if (!sameLabel(transition.name, args.transitionName) && !sameLabel(transition.toStatus, args.transitionName)) {
          return {
            error: `Transition ${args.transitionId} is "${transition.name}" (to ${transition.toStatus}), not "${args.transitionName}" - nothing was changed. Pick the status again.`,
            status: "failed",
          };
        }
        const result = await jiraCall(config, creds, "POST", `${issuePath(ticketKey)}/transitions`, { body: { transition: { id: args.transitionId } } });
        return writeOutcome(result, () => ({ externalUrl: browseUrl(config, ticketKey), status: "succeeded" }));
      }

      case "jira_assign": {
        const result = await jiraCall(config, creds, "PUT", `${issuePath(ticketKey)}/assignee`, { body: { accountId: args.accountId } });
        return writeOutcome(result, () => ({ externalUrl: browseUrl(config, ticketKey), status: "succeeded" }));
      }

      case "jira_priority": {
        const result = await jiraCall(config, creds, "PUT", issuePath(ticketKey), { body: { fields: { priority: { name: args.priority } } } });
        return writeOutcome(result, () => ({ externalUrl: browseUrl(config, ticketKey), status: "succeeded" }));
      }

      case "jira_link_cp": {
        const cp = await jiraCall(config, creds, "GET", issuePath(args.cpKey), { params: { fields: "summary" } });
        if (!cp.ok) {
          return cp.kind === "http" && cp.status === 404
            ? { error: `${args.cpKey} doesn't exist, or your Jira account can't see it.`, status: "failed" }
            : readFailure(`look up ${args.cpKey}`, cp);
        }
        const result = await jiraCall(config, creds, "POST", "/issueLink", {
          body: { inwardIssue: { key: ticketKey }, outwardIssue: { key: args.cpKey }, type: { name: "Relates" } },
        });
        return writeOutcome(result, () => ({ externalId: args.cpKey, externalUrl: browseUrl(config, ticketKey), status: "succeeded" }));
      }

      case "firefighter_escalation":
      case "slack_thread_reply":
        return { error: `${args.operation} is a Slack action, not a Jira one.`, status: "failed" };
    }
  } catch (error) {
    /* Only reachable through a bug above (every call path already returns a result) - and it may have been mid-write. */
    console.warn(`Actions: Jira ${args.operation} on ${ticketKey} threw.`, error instanceof Error ? error.message : String(error));
    return { error: "Something went wrong while talking to Jira - the change may have happened. Check Jira before retrying.", status: "uncertain" };
  }
}
