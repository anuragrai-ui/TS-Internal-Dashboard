import type { DroppedAction } from "@/lib/assist/result";
import type { AssistRun, AssistRunListResponse, AssistRunResponse, AssistSummary, InvestigationResult } from "@/lib/workspace/types";

/**
 * Browser-side calls to the /api/assist routes. Like trackerApi.ts, every
 * helper resolves to a result object instead of throwing; failures keep the
 * route's `code` ("ai_not_configured", "rate_limited") so the panel can say
 * the right thing.
 */

export type AssistApiResult<T> = { data: T; ok: true } | { code?: string; error: string; ok: false; status: number };

/** A run as the routes send it: the contract's AssistRun, whose result may also list the actions that weren't proposed. */
export type AssistRunView = AssistRun & { result?: InvestigationResult & { droppedActions?: DroppedAction[] } };

async function call<T>(url: string, init?: RequestInit): Promise<AssistApiResult<T>> {
  try {
    const response = await fetch(url, { cache: "no-store", ...init });
    const body = (await response.json().catch(() => null)) as (T & { code?: string; error?: string }) | null;
    if (!response.ok || body === null) {
      return {
        code: body?.code,
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

export function fetchAssistSummary(ticketKey: string, refresh: boolean): Promise<AssistApiResult<AssistSummary>> {
  return call<AssistSummary>(`/api/assist/${encodeURIComponent(ticketKey)}/summary${refresh ? "?refresh=1" : ""}`);
}

export function startAssistInvestigation(ticketKey: string): Promise<AssistApiResult<AssistRunResponse & { run: AssistRunView }>> {
  return call<AssistRunResponse & { run: AssistRunView }>(`/api/assist/${encodeURIComponent(ticketKey)}/investigations`, { method: "POST" });
}

export function fetchAssistRuns(ticketKey: string): Promise<AssistApiResult<AssistRunListResponse & { runs: AssistRunView[] }>> {
  return call<AssistRunListResponse & { runs: AssistRunView[] }>(`/api/assist/${encodeURIComponent(ticketKey)}/investigations`);
}

export function fetchAssistRun(id: string): Promise<AssistApiResult<AssistRunResponse & { run: AssistRunView }>> {
  return call<AssistRunResponse & { run: AssistRunView }>(`/api/assist/runs/${encodeURIComponent(id)}`);
}
