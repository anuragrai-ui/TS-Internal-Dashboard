import { useCallback, useRef } from "react";

import type { ApiResult } from "@/components/tracker/trackerApi";
import type {
  ActionProposal,
  ApproveProposalRequest,
  ExecuteActionRequest,
  ExecuteActionResponse,
  JiraOptionsResponse,
  ProposalDecisionResponse,
  TicketActionsResponse,
} from "@/lib/workspace/types";

/**
 * Browser-side calls to the action routes. Like trackerApi.ts, every helper
 * resolves to a result object instead of throwing.
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

export function fetchTicketActions(ticketKey: string): Promise<ApiResult<TicketActionsResponse>> {
  return call<TicketActionsResponse>(`/api/actions?ticket=${encodeURIComponent(ticketKey)}`);
}

export function postAction(request: ExecuteActionRequest): Promise<ApiResult<ExecuteActionResponse>> {
  return postJson<ExecuteActionResponse>("/api/actions", request);
}

export function fetchJiraOptions(ticketKey: string, query = ""): Promise<ApiResult<JiraOptionsResponse>> {
  const suffix = query.trim() ? `?q=${encodeURIComponent(query.trim())}` : "";
  return call<JiraOptionsResponse>(`/api/tracker/${encodeURIComponent(ticketKey)}/jira-options${suffix}`);
}

export function postApproveProposal(id: string, request: ApproveProposalRequest): Promise<ApiResult<ProposalDecisionResponse>> {
  return postJson<ProposalDecisionResponse>(`/api/actions/proposals/${encodeURIComponent(id)}/approve`, request);
}

export function postRejectProposal(id: string): Promise<ApiResult<{ proposal: ActionProposal }>> {
  return postJson<{ proposal: ActionProposal }>(`/api/actions/proposals/${encodeURIComponent(id)}/reject`, {});
}

/* ----------------------------------------------------- idempotency keys */

export function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  /* An insecure context (plain http on a LAN address) has no randomUUID, but does have getRandomValues. */
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Whether a failed call might still have reached the server - then the same key must be reused for a resend. */
export function mightHaveArrived(result: { ok: false; status: number }): boolean {
  return result.status === 0 || result.status >= 500 || result.status === 409;
}

/**
 * One idempotency key per intended write. Asking again for the SAME write
 * (same fingerprint) before it settled - after a dropped connection, say -
 * reuses the key, so the server de-duplicates instead of writing twice. A
 * different write, or `settle()` after a definite answer, starts a new key.
 */
export function useAttemptKey(): { keyFor: (fingerprint: string) => string; settle: () => void } {
  const current = useRef<{ fingerprint: string; key: string } | null>(null);
  const keyFor = useCallback((fingerprint: string): string => {
    if (current.current?.fingerprint === fingerprint) {
      return current.current.key;
    }
    const key = newIdempotencyKey();
    current.current = { fingerprint, key };
    return key;
  }, []);
  const settle = useCallback(() => {
    current.current = null;
  }, []);
  return { keyFor, settle };
}
