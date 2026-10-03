import type { GmailMessage } from "@/lib/email/mime";
import type { AccessTokenResult } from "@/lib/google/oauth";

/**
 * The few Gmail API calls the support inbox makes, over fetch with a
 * timeout each (no googleapis dependency). Everything is "users/me": the
 * mailbox grant is the support account's own sign-in.
 *
 * Calls THROW GmailApiError (status = HTTP status, or null when there was
 * no answer: timeout / network). The sync and the reply path catch it -
 * the reply path must tell "Gmail said no" (nothing sent) apart from "no
 * answer" (it may have been sent). No error ever includes the token.
 */

const API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const DEFAULT_TIMEOUT_MS = 15_000;

export class GmailApiError extends Error {
  readonly reason: string | null;
  readonly status: number | null;

  constructor(message: string, status: number | null, reason: string | null = null) {
    super(message);
    this.name = "GmailApiError";
    this.status = status;
    this.reason = reason;
  }
}

export interface GmailListPage {
  messages?: Array<{ id: string; threadId: string }>;
  nextPageToken?: string;
}

export interface GmailHistoryPage {
  history?: Array<{ id?: string; messagesAdded?: Array<{ message?: { id?: string; labelIds?: string[]; threadId?: string } }> }>;
  historyId?: string;
  nextPageToken?: string;
}

export interface GmailClient {
  getMessage(id: string): Promise<GmailMessage>;
  getProfile(): Promise<{ emailAddress: string; historyId: string }>;
  listHistory(startHistoryId: string, pageToken?: string): Promise<GmailHistoryPage>;
  listMessages(query: string, pageToken?: string): Promise<GmailListPage>;
  /* `raw` is the RFC 2822 message, base64url. */
  send(raw: string, threadId: string | null): Promise<{ id: string; threadId: string }>;
}

export interface GmailClientOptions {
  accessToken: () => Promise<AccessTokenResult>;
  fetchImpl?: typeof fetch;
  /* Called on a 401 so the next call refreshes the token instead of reusing it. */
  onUnauthorized?: () => Promise<void>;
  timeoutMs?: number;
}

function reasonOf(body: unknown): string | null {
  const error = body && typeof body === "object" ? (body as { error?: { errors?: Array<{ reason?: unknown }>; status?: unknown } }).error : undefined;
  const reason = error?.errors?.[0]?.reason ?? error?.status;
  return typeof reason === "string" ? reason : null;
}

function describe(status: number, reason: string | null): string {
  if (status === 401) {
    return "Gmail rejected the mailbox sign-in. Connect the support mailbox on /inbox again.";
  }
  if (status === 403 && (reason === "accessNotConfigured" || reason === "SERVICE_DISABLED")) {
    return "The Gmail API isn't enabled in the dashboard's Google Cloud project - enable it there (see the README).";
  }
  if (status === 403) {
    return "Gmail refused the request (403) - the connected account may not be the support mailbox, or a permission was removed.";
  }
  if (status === 404) {
    return "Gmail says that doesn't exist (404).";
  }
  if (status === 429) {
    return "Gmail is rate-limiting the mailbox - it retries on its own.";
  }
  return `Gmail answered HTTP ${status}.`;
}

/** A Gmail client for the connected support mailbox. */
export function createGmailClient(options: GmailClientOptions): GmailClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function call<T>(method: "GET" | "POST", path: string, params?: Record<string, string | string[]>, body?: unknown): Promise<T> {
    const token = await options.accessToken();
    if (!token.ok) {
      throw new GmailApiError(token.error, 401, "not_connected");
    }
    const query = new URLSearchParams();
    for (const [name, value] of Object.entries(params ?? {})) {
      for (const item of Array.isArray(value) ? value : [value]) {
        query.append(name, item);
      }
    }
    const queryString = query.toString();
    const url = `${API_BASE}${path}${queryString ? `?${queryString}` : ""}`;
    let response: Response;
    try {
      response = await fetchImpl(url, {
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        cache: "no-store",
        headers: { Accept: "application/json", Authorization: `Bearer ${token.token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
        method,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : "unknown";
      throw new GmailApiError(name === "TimeoutError" || name === "AbortError" ? `Gmail didn't answer within ${Math.round(timeoutMs / 1000)} seconds.` : "Couldn't reach Gmail.", null);
    }
    const parsed: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const reason = reasonOf(parsed);
      if (response.status === 401) {
        await options.onUnauthorized?.();
      }
      throw new GmailApiError(describe(response.status, reason), response.status, reason);
    }
    return (parsed ?? {}) as T;
  }

  return {
    getMessage: (id) => call<GmailMessage>("GET", `/messages/${encodeURIComponent(id)}`, { format: "full" }),
    getProfile: () => call<{ emailAddress: string; historyId: string }>("GET", "/profile"),
    listHistory: (startHistoryId, pageToken) =>
      call<GmailHistoryPage>("GET", "/history", {
        historyTypes: "messageAdded",
        maxResults: "500",
        startHistoryId,
        ...(pageToken ? { pageToken } : {}),
      }),
    listMessages: (query, pageToken) => call<GmailListPage>("GET", "/messages", { maxResults: "100", q: query, ...(pageToken ? { pageToken } : {}) }),
    send: (raw, threadId) => call<{ id: string; threadId: string }>("POST", "/messages/send", undefined, { raw, ...(threadId ? { threadId } : {}) }),
  };
}
