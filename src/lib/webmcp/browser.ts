import type { CasePanelState, FetchJsonInit, FetchJsonResult, PageToolDeps, UiEventDetailMap, UiEventName } from "@/lib/webmcp/tools";

/**
 * The real browser implementations of the page tools' deps: same-origin
 * fetch with the person's cookies, window CustomEvents into the React UI,
 * and a wait for the tracker's detail panel. Kept apart from tools.ts so the
 * tools stay pure and testable; only WebMcpProvider (a client component)
 * calls this, so `window` and `document` are always there.
 */

/* Matches the slowest route a tool calls (a cold ticket detail is several Jira reads). */
const FETCH_TIMEOUT_MS = 30_000;
/* How long prepare_reply waits for the panel (and its composer) to finish loading before dispatching anyway. */
const CASE_READY_TIMEOUT_MS = 8_000;
const CASE_POLL_MS = 100;

/*
 * The tracker's own markup (TrackerDetailPanel.tsx / TrackerWorkspace.tsx):
 * the panel is an aside labelled "<KEY> details"; the real one has a scroll
 * body and shows a timeline skeleton until its detail loads, while a ticket
 * that isn't in the tracker gets a bare aside with only a .trk-state message.
 */
const PANEL_SELECTOR = "aside.trk-panel";
const PANEL_BODY_SELECTOR = ".trk-panel-scroll";
const PANEL_LOADING_SELECTOR = ".trk-timeline-skeleton";
const PANEL_MESSAGE_SELECTOR = ".trk-state";

export interface BrowserDepsOptions {
  announce: (message: string) => void;
  navigate: (url: string) => void;
  /* A route answered 401: this browser is no longer identified. */
  onUnauthorized: () => void;
}

function combinedSignal(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  if (!signal) {
    return timeout;
  }
  /* AbortSignal.any is recent; without it the agent's cancel still wins over the timeout, which is the one that matters. */
  return typeof AbortSignal.any === "function" ? AbortSignal.any([timeout, signal]) : signal;
}

/**
 * GET/POST one of the dashboard's own /api routes as the person browsing.
 * Never throws; refuses anything that isn't a same-origin /api path, so no
 * tool argument can point the session's cookies somewhere else.
 */
export async function browserFetchJson<T>(path: string, init: FetchJsonInit = {}, onUnauthorized?: () => void): Promise<FetchJsonResult<T>> {
  if (!path.startsWith("/api/") || path.includes("//")) {
    return { error: "only the dashboard's own /api routes can be called", ok: false, status: 0 };
  }
  try {
    const response = await fetch(path, {
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      cache: "no-store",
      credentials: "same-origin",
      headers: init.body === undefined ? { Accept: "application/json" } : { Accept: "application/json", "Content-Type": "application/json" },
      method: init.method ?? "GET",
      signal: combinedSignal(init.signal),
    });
    const body = (await response.json().catch(() => null)) as (T & { error?: unknown }) | null;
    if (response.status === 401) {
      onUnauthorized?.();
    }
    if (!response.ok || body === null) {
      const error = typeof body?.error === "string" && body.error ? body.error : `the request failed (${response.status})`;
      return { error, ok: false, status: response.status };
    }
    return { data: body, ok: true, status: response.status };
  } catch (error) {
    const name = error instanceof DOMException ? error.name : "";
    return {
      error: name === "TimeoutError" ? "the dashboard took too long to answer" : name === "AbortError" ? "the request was cancelled" : "couldn't reach the dashboard",
      ok: false,
      status: 0,
    };
  }
}

function dispatchUiEvent<E extends UiEventName>(type: E, detail: UiEventDetailMap[E]): void {
  window.dispatchEvent(new CustomEvent(type, { detail }));
}

function findPanel(key: string): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>(PANEL_SELECTOR)].find((panel) => panel.getAttribute("aria-label") === `${key} details`);
}

/**
 * Resolves "ready" once KEY's detail panel is on screen with its detail
 * loaded - one frame later, so the components inside have attached their
 * listeners (the composer only hears prepareReply while mounted);
 * "not_tracked" when the panel says the ticket isn't in the tracker;
 * "timeout" on timeout or abort.
 */
export function waitForCasePanel(key: string, signal?: AbortSignal): Promise<CasePanelState> {
  return new Promise((resolve) => {
    const deadline = Date.now() + CASE_READY_TIMEOUT_MS;
    const check = (): void => {
      if (signal?.aborted) {
        resolve("timeout");
        return;
      }
      const panel = findPanel(key);
      if (panel?.querySelector(PANEL_BODY_SELECTOR) && !panel.querySelector(PANEL_LOADING_SELECTOR)) {
        requestAnimationFrame(() => setTimeout(() => resolve("ready"), 0));
        return;
      }
      if (panel && !panel.querySelector(PANEL_BODY_SELECTOR) && panel.querySelector(PANEL_MESSAGE_SELECTOR)) {
        resolve("not_tracked");
        return;
      }
      if (Date.now() >= deadline) {
        resolve("timeout");
        return;
      }
      setTimeout(check, CASE_POLL_MS);
    };
    check();
  });
}

/** PageToolDeps backed by this window. */
export function createBrowserDeps(options: BrowserDepsOptions): PageToolDeps {
  return {
    announce: options.announce,
    dispatch: dispatchUiEvent,
    fetchJson: <T>(path: string, init?: FetchJsonInit) => browserFetchJson<T>(path, init, options.onUnauthorized),
    location: () => ({ openTicket: new URLSearchParams(window.location.search).get("ticket"), pathname: window.location.pathname }),
    navigate: options.navigate,
    now: () => Date.now(),
    waitForCase: waitForCasePanel,
  };
}
