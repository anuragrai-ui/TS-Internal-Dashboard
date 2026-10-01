/**
 * The ONLY way escalation code may reach Jira - and it physically cannot write.
 *
 * The shared account the pilot runs as is a Jira project admin: it can delete
 * issues, transition tickets and edit SLA / working-hours config. "We only
 * call read endpoints" is therefore not a safety property - a typo'd path, a
 * copy-pasted helper or a future refactor must be UNABLE to issue a write.
 *
 * Every call funnels through request(), which checks the method and path
 * against a short allowlist BEFORE fetch is touched. Callers can't pass a full
 * URL, extra headers or a method override, and redirects are refused, so the
 * allowlist is the whole story.
 */

export class ReadOnlyViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReadOnlyViolation";
  }
}

export type ReadOnlyMethod = "GET" | "POST";

/** A Jira read failed (non-2xx, network error, timeout, refused redirect, unparseable body). */
export class ReadOnlyJiraError extends Error {
  readonly method: ReadOnlyMethod;
  readonly path: string;
  /* Status of a non-2xx response; null when there was no usable response at all (network error,
     timeout, refused redirect, malformed body). 403/404 on a CP is how callers spot cp_unreadable. */
  readonly status: number | null;

  constructor(method: ReadOnlyMethod, path: string, status: number | null, message: string) {
    super(message);
    this.name = "ReadOnlyJiraError";
    this.method = method;
    this.path = path;
    this.status = status;
  }
}

export interface ReadOnlyJiraConfig {
  apiToken: string;
  baseUrl: string;
  email: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export type QueryParams = Record<string, string | number | boolean | undefined>;

export interface RequestOptions {
  /* POST only - JSON-serialized. */
  body?: unknown;
  /* GET only - the ONLY way to send a query string; "?" inside a path is refused. */
  params?: QueryParams;
}

export interface RequestLogEntry {
  method: ReadOnlyMethod;
  path: string;
}

export interface SearchJqlOptions {
  expand?: string;
  /* Hard cap on issues returned across all pages (default 2000). */
  maxTotal?: number;
}

export interface ReadOnlyJiraClient {
  /** POST /rest/api/3/search/approximate-count - cheap sanity check against searchJql's cap. */
  approximateCount(jql: string): Promise<number>;
  get<T>(path: string, params?: QueryParams): Promise<T>;
  /**
   * The single choke point every helper goes through. Exposed so tests and the
   * dry run can prove the guard holds for any method/path - escalation code
   * should use get / searchJql / approximateCount.
   */
  request<T>(method: string, path: string, options?: RequestOptions): Promise<T>;
  /* Every request that passed the guard and was handed to fetch, in order. One client per run. */
  readonly requestLog: RequestLogEntry[];
  /** GET /rest/api/3/search/jql, following nextPageToken until exhausted or maxTotal is reached. */
  searchJql<T>(jql: string, fields: string[], opts?: SearchJqlOptions): Promise<T[]>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const SEARCH_PAGE_SIZE = 100;
const DEFAULT_SEARCH_MAX_TOTAL = 2_000;
/* Long JQL (e.g. `key in (...)` over every CP a pod touches) can exceed proxy
   URL limits as a GET; past this length the same search goes out as POST. */
const MAX_GET_URL_LENGTH = 6_000;
const ERROR_DETAIL_MAX_CHARS = 300;

const SEARCH_JQL_PATH = "/rest/api/3/search/jql";
const APPROXIMATE_COUNT_PATH = "/rest/api/3/search/approximate-count";

/* /rest/servicedesk/1/ (the internal SLA admin API) and every other
   /rest/workinghours path are deliberately absent: GET is not enough of a
   guarantee on internal APIs, and nothing in the pilot needs them. */
const GET_PATH_PREFIXES = ["/rest/api/3/", "/rest/servicedeskapi/"];
const WORKING_HOURS_CALENDAR_PATH = /^\/rest\/workinghours\/1\/api\/calendar(?:\/[0-9]+)?$/;
/* Both are read-only searches that happen to take a JSON body. */
const POST_PATHS = new Set([SEARCH_JQL_PATH, APPROXIMATE_COUNT_PATH]);

/* We don't canonicalize paths - we refuse anything that isn't already
   canonical. Any normalization we did could disagree with the one Jira or a
   proxy in front of it does (%2e%2e, "..;", backslashes, fullwidth dots), and
   that disagreement is exactly the hole. So: leading "/", no empty segments
   (kills "//host" and trailing "/"), and only RFC 3986 unreserved characters,
   which rules out "%", "?", "#", ";", ":", "\" and anything non-ASCII. */
const CANONICAL_PATH = /^(?:\/[A-Za-z0-9._~-]+)+$/;
const DOT_SEGMENT = /^\.+$/;

/* Some REST stacks honour a method override smuggled in the query string. */
const METHOD_OVERRIDE_PARAMS = new Set(["_method", "x-http-method", "x-http-method-override", "x-method-override"]);

export type Redactor = (text: string) => string;

const noRedaction: Redactor = (text) => text;

/* Refusals echo what was refused so the bad call site is easy to find, but a
   caller who got it wrong may have pasted a URL with userinfo or a ?token= in
   it. So: redact first (before any cut, so a cut can't strand half a token),
   then echo only the leading run of canonical-path characters - which stops
   at ":", "@", "?", "#", "%" - clipped, and say how much was withheld. */
const ECHO_SAFE_PREFIX = /^[A-Za-z0-9._~/-]*/;
const ECHO_MAX_CHARS = 120;

function describe(value: unknown, redact: Redactor): string {
  if (typeof value !== "string") {
    return `<${typeof value}>`;
  }

  const text = redact(value);
  const shown = (ECHO_SAFE_PREFIX.exec(text)?.[0] ?? "").slice(0, ECHO_MAX_CHARS);
  const withheld = text.length - shown.length;
  return withheld > 0 ? `${JSON.stringify(shown)} (+${withheld} chars not shown)` : JSON.stringify(shown);
}

/**
 * Throws ReadOnlyViolation unless (method, path) is on the allowlist. Pure, so
 * it can be asserted on directly; request() calls it before anything else,
 * passing its own redactor so the configured token never appears in a refusal.
 */
export function assertReadOnlyRequest(
  method: unknown,
  path: unknown,
  redact: Redactor = noRedaction,
): RequestLogEntry {
  /* Exact uppercase only: fetch uppercases "get"/"post" but not "patch", and
     we'd rather not reason about which spellings a server treats as what. */
  if (method !== "GET" && method !== "POST") {
    throw new ReadOnlyViolation(
      `Refused ${describe(method, redact)} ${describe(path, redact)}: only GET and two POST searches are allowed`,
    );
  }

  if (typeof path !== "string" || !CANONICAL_PATH.test(path)) {
    throw new ReadOnlyViolation(
      `Refused ${method} ${describe(path, redact)}: path must be a canonical /rest/... path (no host, query, encoding or traversal)`,
    );
  }

  if (path.split("/").some((segment) => DOT_SEGMENT.test(segment))) {
    throw new ReadOnlyViolation(`Refused ${method} ${describe(path, redact)}: dot segments are not allowed`);
  }

  const allowed =
    method === "GET"
      ? GET_PATH_PREFIXES.some((prefix) => path.startsWith(prefix)) || WORKING_HOURS_CALENDAR_PATH.test(path)
      : POST_PATHS.has(path);

  if (!allowed) {
    throw new ReadOnlyViolation(`Refused ${method} ${describe(path, redact)}: not on the read-only allowlist`);
  }

  return { method, path };
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Reads JIRA_BASE_URL / JIRA_EMAIL / JIRA_API_TOKEN at call time (not import
 * time), so a script can load its env file first. `env` is injectable for tests.
 */
export function readOnlyJiraConfigFromEnv(env: Record<string, string | undefined> = process.env): ReadOnlyJiraConfig {
  const baseUrl = nonEmpty(env.JIRA_BASE_URL);
  const email = nonEmpty(env.JIRA_EMAIL);
  const apiToken = nonEmpty(env.JIRA_API_TOKEN);

  const missing = [
    baseUrl ? null : "JIRA_BASE_URL",
    email ? null : "JIRA_EMAIL",
    apiToken ? null : "JIRA_API_TOKEN",
  ].filter((name): name is string => name !== null);

  if (!baseUrl || !email || !apiToken) {
    /* Names only - never echo a value, one of them is the token. */
    throw new Error(`Missing Jira configuration for the read-only escalation client. Set ${missing.join(", ")}.`);
  }

  return { apiToken, baseUrl, email };
}

/* The base URL must be a bare https origin: basic auth never goes over
   plaintext, and a path/query/userinfo on it would sit outside the guard. */
function parseOrigin(baseUrl: string): string {
  let url: URL;

  try {
    url = new URL(baseUrl.trim().replace(/\/+$/, ""));
  } catch {
    throw new Error("Read-only Jira client: baseUrl is not a valid URL.");
  }

  if (url.protocol !== "https:") {
    throw new Error("Read-only Jira client: baseUrl must use https.");
  }

  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("Read-only Jira client: baseUrl must be a bare origin like https://your-site.atlassian.net.");
  }

  return url.origin;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/* Jira's error bodies are {"errorMessages": [...], "errors": {field: msg}}. */
function summarizeErrorBody(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text);

    if (isRecord(parsed)) {
      const messages = Array.isArray(parsed.errorMessages)
        ? parsed.errorMessages.filter((message): message is string => typeof message === "string")
        : [];
      const fieldErrors = isRecord(parsed.errors)
        ? Object.entries(parsed.errors).map(([field, message]) => `${field}: ${String(message)}`)
        : [];
      const combined = [...messages, ...fieldErrors].join("; ");

      if (combined) {
        return combined;
      }
    }
  } catch {
    /* Not JSON - fall through to the raw text. */
  }

  return text;
}

export function createReadOnlyJiraClient(config: ReadOnlyJiraConfig): ReadOnlyJiraClient {
  const origin = parseOrigin(config.baseUrl);
  const email = config.email?.trim();
  const apiToken = config.apiToken?.trim();

  if (!email || !apiToken) {
    throw new Error("Read-only Jira client: email and apiToken are required.");
  }

  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Read-only Jira client: timeoutMs must be a positive number.");
  }

  /* Held as a local and called bare - calling a host fetch as a method of
     another object throws "Illegal invocation" in some runtimes. */
  const fetchImpl: typeof fetch = config.fetchImpl ?? fetch;
  const basicCredentials = Buffer.from(`${email}:${apiToken}`).toString("base64");
  const authorization = `Basic ${basicCredentials}`;
  const secrets = [...new Set([basicCredentials, apiToken, encodeURIComponent(apiToken)])].filter(
    (secret) => secret.length >= 4,
  );
  const requestLog: RequestLogEntry[] = [];

  /* Anything that ends up in an error message or the request log passes
     through here first: refused paths, sent paths, and text Jira or the
     network stack hands back to us. */
  function redact(text: string): string {
    return secrets.reduce((result, secret) => result.split(secret).join("[redacted]"), text);
  }

  function failure(entry: RequestLogEntry, status: number | null, reason: string): ReadOnlyJiraError {
    /* Redact before truncating so a cut can't leave half a token behind. The
       path is redacted too: it passed the guard, but a caller could still have
       put the token in it, and it lands in both the message and `.path`. */
    const path = redact(entry.path);
    const safe = collapse(redact(reason));
    const clipped = safe.length > ERROR_DETAIL_MAX_CHARS ? `${safe.slice(0, ERROR_DETAIL_MAX_CHARS)}...` : safe;
    return new ReadOnlyJiraError(entry.method, path, status, `Jira ${entry.method} ${path} ${clipped}`);
  }

  function buildUrl(entry: RequestLogEntry, params: QueryParams | undefined): URL {
    const url = new URL(`${origin}${entry.path}`);

    for (const [key, value] of Object.entries(params ?? {})) {
      if (!key || METHOD_OVERRIDE_PARAMS.has(key.toLowerCase())) {
        throw new ReadOnlyViolation(
          `Refused ${entry.method} ${describe(entry.path, redact)}: query parameter ${describe(key, redact)} is not allowed`,
        );
      }

      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }

    /* Belt and braces: the guard already proved this, but if URL parsing ever
       moved us somewhere else we refuse rather than send. */
    if (url.origin !== origin || url.pathname !== entry.path) {
      throw new ReadOnlyViolation(
        `Refused ${entry.method} ${describe(entry.path, redact)}: resolved outside the allowed path`,
      );
    }

    return url;
  }

  async function request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    /* Every refusal below goes through describe(..., redact), same as failure(). */
    const entry = assertReadOnlyRequest(method, path, redact);

    if (entry.method === "GET" && options.body !== undefined) {
      throw new ReadOnlyViolation(`Refused GET ${describe(entry.path, redact)}: GET requests carry no body`);
    }

    /* The two allowed POSTs take everything in the body; refusing a query
       string on them closes off any "?_method=" style override. */
    if (entry.method === "POST" && options.params && Object.keys(options.params).length > 0) {
      throw new ReadOnlyViolation(
        `Refused POST ${describe(entry.path, redact)}: POST searches take a body, not query parameters`,
      );
    }

    const url = buildUrl(entry, options.params);
    const headers: Record<string, string> = { Accept: "application/json", Authorization: authorization };
    let body: string | undefined;

    if (entry.method === "POST") {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.body ?? {});
    }

    /* Dry-run reporting prints this log, so it gets the same redaction as errors. */
    requestLog.push({ method: entry.method, path: redact(entry.path) });

    let response: Response;

    try {
      response = await fetchImpl(url.href, {
        body,
        headers,
        method: entry.method,
        /* A redirect could re-target the request (307 keeps POST) or carry the
           auth header to another host - fail instead of following. */
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      /* The original error is deliberately not attached as `cause`: network
         stack errors can carry request details we haven't redacted. */
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
        throw failure(entry, null, `timed out after ${timeoutMs}ms`);
      }

      const message = error instanceof Error ? error.message : String(error);
      const cause = error instanceof Error && error.cause instanceof Error ? ` (${error.cause.message})` : "";
      throw failure(entry, null, `request failed: ${message}${cause}`);
    }

    let text: string;

    try {
      text = await response.text();
    } catch {
      throw failure(entry, response.ok ? null : response.status, `failed reading the body (status ${response.status})`);
    }

    if (!response.ok) {
      const detail = summarizeErrorBody(text);
      const suffix = detail.trim() ? `: ${detail}` : "";
      throw failure(entry, response.status, `failed with status ${response.status}${suffix}`);
    }

    if (!text.trim()) {
      return undefined as T;
    }

    try {
      return JSON.parse(text) as T;
    } catch {
      throw failure(entry, null, `returned a non-JSON body (status ${response.status})`);
    }
  }

  function get<T>(path: string, params?: QueryParams): Promise<T> {
    return request<T>("GET", path, { params });
  }

  interface SearchPage {
    isLast?: unknown;
    issues: unknown[];
    /* Which way the page went out (long JQL switches to POST). */
    method: ReadOnlyMethod;
    nextPageToken?: unknown;
  }

  async function fetchSearchPage(
    jql: string,
    fields: string[],
    expand: string | undefined,
    maxResults: number,
    nextPageToken: string | undefined,
  ): Promise<SearchPage> {
    const params: Record<string, string> = { jql, maxResults: String(maxResults) };

    if (fields.length > 0) {
      params.fields = fields.join(",");
    }

    if (expand) {
      params.expand = expand;
    }

    if (nextPageToken) {
      params.nextPageToken = nextPageToken;
    }

    const getUrlLength = origin.length + SEARCH_JQL_PATH.length + 1 + new URLSearchParams(params).toString().length;
    const method: ReadOnlyMethod = getUrlLength <= MAX_GET_URL_LENGTH ? "GET" : "POST";
    const page =
      method === "GET"
        ? await request<unknown>("GET", SEARCH_JQL_PATH, { params })
        : await request<unknown>("POST", SEARCH_JQL_PATH, {
            body: { expand, fields: fields.length > 0 ? fields : undefined, jql, maxResults, nextPageToken },
          });

    /* A malformed page must fail loudly - silently returning [] would read as
       "nothing needs engineering". */
    if (!isRecord(page) || !Array.isArray(page.issues)) {
      const message = `Jira ${method} ${SEARCH_JQL_PATH} returned an unexpected response shape`;
      throw new ReadOnlyJiraError(method, SEARCH_JQL_PATH, null, message);
    }

    return { isLast: page.isLast, issues: page.issues, method, nextPageToken: page.nextPageToken };
  }

  async function searchJql<T>(jql: string, fields: string[], opts: SearchJqlOptions = {}): Promise<T[]> {
    if (typeof jql !== "string" || !jql.trim()) {
      throw new Error("searchJql: jql must be a non-empty string.");
    }

    const maxTotal = opts.maxTotal ?? DEFAULT_SEARCH_MAX_TOTAL;

    if (!Number.isInteger(maxTotal) || maxTotal < 1) {
      throw new Error("searchJql: maxTotal must be a positive integer.");
    }

    const results: T[] = [];
    const seenTokens = new Set<string>();
    let nextPageToken: string | undefined;

    while (results.length < maxTotal) {
      const remaining = maxTotal - results.length;
      const pageSize = Math.min(SEARCH_PAGE_SIZE, remaining);
      const page = await fetchSearchPage(jql, fields, opts.expand, pageSize, nextPageToken);

      /* Slice even though we asked for `remaining`: the cap must hold if Jira ignores maxResults. */
      results.push(...(page.issues.slice(0, remaining) as T[]));

      const token = typeof page.nextPageToken === "string" && page.nextPageToken ? page.nextPageToken : undefined;

      if (page.isLast === true || !token || page.issues.length === 0) {
        break;
      }

      /* A token we've already followed means pagination isn't advancing; looping
         would re-read the same issues until maxTotal and report duplicates. */
      if (seenTokens.has(token)) {
        throw new ReadOnlyJiraError(
          page.method,
          SEARCH_JQL_PATH,
          null,
          `Jira ${page.method} ${SEARCH_JQL_PATH} pagination repeated a nextPageToken`,
        );
      }

      seenTokens.add(token);
      nextPageToken = token;
    }

    return results;
  }

  async function approximateCount(jql: string): Promise<number> {
    if (typeof jql !== "string" || !jql.trim()) {
      throw new Error("approximateCount: jql must be a non-empty string.");
    }

    const response = await request<unknown>("POST", APPROXIMATE_COUNT_PATH, { body: { jql } });

    if (!isRecord(response) || typeof response.count !== "number") {
      const message = `Jira POST ${APPROXIMATE_COUNT_PATH} returned an unexpected response shape`;
      throw new ReadOnlyJiraError("POST", APPROXIMATE_COUNT_PATH, null, message);
    }

    return response.count;
  }

  /* Frozen so nothing can swap a helper for one that skips request(). */
  return Object.freeze({ approximateCount, get, request, requestLog, searchJql });
}
