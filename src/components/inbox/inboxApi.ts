import type { ApiResult } from "@/components/tracker/trackerApi";
import type { EmailCaseDetail, EmailInboxFilter, EmailInboxResponse } from "@/lib/workspace/types";

/**
 * Browser-side calls to /api/email/*. Like trackerApi.ts, every helper
 * resolves to a result object instead of throwing. Replies go through the
 * shared actions route (src/components/actions/actionsApi.ts postAction).
 */

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

export function fetchInbox(filter: EmailInboxFilter): Promise<ApiResult<EmailInboxResponse>> {
  return call<EmailInboxResponse>(`/api/email/list?filter=${filter}`);
}

export function fetchEmailCase(caseId: string): Promise<ApiResult<EmailCaseDetail>> {
  return call<EmailCaseDetail>(`/api/email/case?id=${encodeURIComponent(caseId)}`);
}

export function postLink(caseId: string, jiraKey: string): Promise<ApiResult<{ caseId: string; key: string; merged: boolean }>> {
  return postJson("/api/email/link", { caseId, jiraKey });
}

export interface SyncNowResult {
  error?: string;
  ok: boolean;
  skipped?: string;
  summary?: { errors: string[]; processed: number; skipped: number };
}

export function postSyncNow(): Promise<ApiResult<SyncNowResult>> {
  return postJson<SyncNowResult>("/api/email/sync-now", {});
}

/** A sender as one short label. Pure. */
export function senderLabel(from: { email: string; name: string | null } | null): string {
  if (!from) {
    return "Support mailbox";
  }
  return from.name ? `${from.name} <${from.email}>` : from.email;
}

/** "1.2 MB", "340 KB". Pure. */
export function formatBytes(size: number): string {
  if (size >= 1_048_576) {
    return `${(size / 1_048_576).toFixed(1)} MB`;
  }
  return `${Math.max(1, Math.round(size / 1024))} KB`;
}
