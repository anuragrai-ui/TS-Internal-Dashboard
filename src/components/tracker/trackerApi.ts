import type { SlackConversationRef, SlackThreadResponse, TrackerDetail, TrackerListResponse } from "@/lib/tracker/types";

/**
 * Browser-side calls to the /api/tracker routes. Every helper resolves to a
 * result object instead of throwing, so a flaky network or a route that is
 * still deploying shows up as a polite banner rather than a crashed page.
 */

export type ApiResult<T> = { data: T; ok: true } | { error: string; ok: false; status: number };

async function call<T>(url: string, init?: RequestInit): Promise<ApiResult<T>> {
  try {
    const response = await fetch(url, { cache: "no-store", ...init });
    const body = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
    if (!response.ok || body === null) {
      return {
        error: body?.error ?? (response.status === 401 ? "Identify yourself on the Jira Tokens page first." : `Request failed (${response.status}).`),
        ok: false,
        status: response.status,
      };
    }
    return { data: body, ok: true };
  } catch {
    return { error: "Couldn't reach the dashboard. Check your connection and try again.", ok: false, status: 0 };
  }
}

function postJson<T>(url: string, body: unknown): Promise<ApiResult<T>> {
  return call<T>(url, { body: JSON.stringify(body), headers: { "Content-Type": "application/json" }, method: "POST" });
}

export function fetchTrackerList(): Promise<ApiResult<TrackerListResponse>> {
  return call<TrackerListResponse>("/api/tracker");
}

export function fetchTrackerDetail(key: string): Promise<ApiResult<TrackerDetail>> {
  return call<TrackerDetail>(`/api/tracker/${encodeURIComponent(key)}`);
}

export function postFollow(key: string, follow: boolean): Promise<ApiResult<{ following: boolean }>> {
  return postJson<{ following: boolean }>(`/api/tracker/${encodeURIComponent(key)}/follow`, { follow });
}

export function postRefresh(): Promise<ApiResult<{ builtAt: string | null; errors: string[] }>> {
  return postJson<{ builtAt: string | null; errors: string[] }>("/api/tracker/refresh", {});
}

export function postSlackLink(key: string, permalink: string): Promise<ApiResult<{ conversation: SlackConversationRef }>> {
  return postJson<{ conversation: SlackConversationRef }>(`/api/tracker/${encodeURIComponent(key)}/slack`, { permalink });
}

/* A throttled read may arrive as a 429 or as a 200 with rateLimited - both are "try again in a minute", not a failure. */
export async function fetchSlackThread(channel: string, rootTs: string): Promise<ApiResult<SlackThreadResponse>> {
  const params = new URLSearchParams({ channel, ts: rootTs });
  const result = await call<SlackThreadResponse>(`/api/tracker/slack-thread?${params.toString()}`);
  if (!result.ok && result.status === 429) {
    return { data: { messages: [], rateLimited: true }, ok: true };
  }
  return result;
}
