"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { Icon } from "@/components/Icon";
import { NOTIFICATIONS_CHANGED_EVENT } from "@/components/NotificationBell";
import { fetchTrackerList, postFollow, postRefresh } from "@/components/tracker/trackerApi";
import { TrackerBoard } from "@/components/tracker/TrackerBoard";
import { TrackerDetailPanel } from "@/components/tracker/TrackerDetailPanel";
import { TrackerFilterBar } from "@/components/tracker/TrackerFilterBar";
import { TrackerHeader } from "@/components/tracker/TrackerHeader";
import { trackerRowId, TrackerList, TrackerListSkeleton } from "@/components/tracker/TrackerList";
import { TrackerViewsNav } from "@/components/tracker/TrackerViewsNav";
import { attentionReasons } from "@/lib/tracker/attention";
import {
  adjacentKey,
  defaultSortFor,
  DEFAULT_VIEW_ID,
  EMPTY_FILTERS,
  getView,
  groupByWhoseMove,
  hasActiveFilters,
  isTrackerSortId,
  navigableKeys,
  selectTickets,
  viewCounts,
} from "@/lib/tracker/views";
import { UI_EVENTS } from "@/lib/workspace/types";

import type { TrackerLayout } from "@/components/tracker/TrackerHeader";
import type { TrackerListResponse, WhoseMove } from "@/lib/tracker/types";
import type { TrackerFilters, TrackerSortId, TrackerViewId, ViewContext } from "@/lib/tracker/views";
import type { OpenCaseDetail } from "@/lib/workspace/types";

/* The snapshot itself rebuilds every few minutes server-side; a minute keeps the list fresh without hammering Redis. */
const VISIBLE_POLL_MS = 60_000;
/* Before the first build exists, check back soon, then ease off; once the tries run out only a focus or Retry starts it over. */
const BUILDING_BACKOFF_MS = [10_000, 20_000, 60_000, 60_000, 60_000, 60_000];
/* Below this width the detail panel slides over the list instead of sharing the row (same breakpoint as globals.css). */
const OVERLAY_QUERY = "(max-width: 1099px)";
const CLOCK_TICK_MS = 30_000;
const SEARCH_URL_DEBOUNCE_MS = 300;
const SEEN_STORAGE_KEY = "ts-tracker-seen";
const COLLAPSED_STORAGE_KEY = "ts-tracker-collapsed";
const MAX_SEEN_ENTRIES = 600;

/* Per-browser conveniences only - never needed for correctness, so every storage failure is swallowed. */
function readStorage<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeStorage(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Private window or storage full - the page works the same without it. */
  }
}

/* Next's useSearchParams follows history.pushState/replaceState, so URL state changes without a server round trip. */
function writeParams(updates: Record<string, string | null>, mode: "push" | "replace"): void {
  const params = new URLSearchParams(window.location.search);
  for (const [name, value] of Object.entries(updates)) {
    if (value === null || value === "") {
      params.delete(name);
    } else {
      params.set(name, value);
    }
  }
  const query = params.toString();
  const url = `${window.location.pathname}${query ? `?${query}` : ""}`;
  if (mode === "push") {
    window.history.pushState(null, "", url);
  } else {
    window.history.replaceState(null, "", url);
  }
}

function urlWithoutTicket(): string {
  const params = new URLSearchParams(window.location.search);
  params.delete("ticket");
  const query = params.toString();
  return `${window.location.pathname}${query ? `?${query}` : ""}`;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return target.isContentEditable || ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName);
}

function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (notify) => {
      const media = window.matchMedia(query);
      media.addEventListener("change", notify);
      return () => media.removeEventListener("change", notify);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

function focusRow(key: string): void {
  requestAnimationFrame(() => {
    const row = document.getElementById(trackerRowId(key));
    row?.focus({ preventScroll: true });
    row?.scrollIntoView({ block: "nearest" });
  });
}

/**
 * The /tracker workspace: views on the left, the list or board in the
 * middle, the detail panel on the right. View, open ticket, search, layout
 * and sort live in the URL so a link reopens exactly what you were looking
 * at; filters and collapsed bands are per-visit/per-browser.
 */
export function TrackerWorkspace(): React.ReactElement {
  const searchParams = useSearchParams();
  const viewDef = getView(searchParams.get("view"));
  const view = viewDef.id;
  const openKey = searchParams.get("ticket");
  const urlSearch = searchParams.get("q") ?? "";
  const layout: TrackerLayout = searchParams.get("layout") === "board" ? "board" : "list";
  const sortParam = searchParams.get("sort");
  const defaultSort = defaultSortFor(view);
  const sort: TrackerSortId = isTrackerSortId(sortParam) ? sortParam : defaultSort;

  const [list, setList] = useState<TrackerListResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState(urlSearch);
  const [filters, setFilters] = useState<TrackerFilters>(EMPTY_FILTERS);
  const [collapsed, setCollapsed] = useState<ReadonlySet<WhoseMove>>(new Set());
  const [cursorKey, setCursorKey] = useState<string | null>(openKey);
  const [followOverrides, setFollowOverrides] = useState<Record<string, boolean>>({});
  const [seen, setSeen] = useState<Record<string, string>>({});
  const [now, setNow] = useState(() => Date.now());
  const [buildTries, setBuildTries] = useState(0);
  const overlay = useMediaQuery(OVERLAY_QUERY);
  const searchRef = useRef<HTMLInputElement>(null);
  const writtenSearch = useRef(urlSearch);
  /* Set while the open ?ticket= entry is one we pushed: the URL it was pushed from, so closing can step back instead of leaving a dead entry. */
  const pushedFrom = useRef<string | null>(null);
  const focusAfterClose = useRef<string | null>(null);

  /* ------------------------------------------------------------ loading */

  const load = useCallback(async (): Promise<void> => {
    const result = await fetchTrackerList();
    if (!result.ok) {
      setLoadError(result.error);
      return;
    }
    setList(result.data);
    setLoadError(null);
    /* Drop optimistic follow flips the server now agrees with. */
    const serverFollowing = new Set(result.data.following);
    setFollowOverrides((current) => Object.fromEntries(Object.entries(current).filter(([key, value]) => serverFollowing.has(key) !== value)));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const building = list !== null && list.builtAt === null;

  useEffect(() => {
    const timer = building
      ? undefined
      : setInterval(() => {
          if (document.visibilityState === "visible") {
            void load();
          }
        }, VISIBLE_POLL_MS);
    /* Coming back to the page also restarts a first-build poll that already gave up. */
    const onFocus = (): void => {
      setBuildTries(0);
      void load();
    };
    const onVisible = (): void => {
      if (document.visibilityState === "visible") {
        onFocus();
      }
    };
    /* The bell saw something new on someone's tickets - the list likely moved too. */
    window.addEventListener(NOTIFICATIONS_CHANGED_EVENT, onFocus);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      window.removeEventListener(NOTIFICATIONS_CHANGED_EVENT, onFocus);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [building, load]);

  useEffect(() => {
    const delay = building ? BUILDING_BACKOFF_MS[buildTries] : undefined;
    if (delay === undefined) {
      return undefined;
    }
    const timer = setTimeout(() => {
      if (document.visibilityState === "visible") {
        void load();
      }
      setBuildTries((tries) => tries + 1);
    }, delay);
    return () => clearTimeout(timer);
  }, [building, buildTries, load]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    setSeen(readStorage<Record<string, string>>(SEEN_STORAGE_KEY, {}));
    setCollapsed(new Set(readStorage<WhoseMove[]>(COLLAPSED_STORAGE_KEY, [])));
  }, []);

  /* Back/forward changed ?q= under us: follow it, unless it is just our own debounced write landing. */
  useEffect(() => {
    if (urlSearch !== writtenSearch.current) {
      writtenSearch.current = urlSearch;
      setSearch(urlSearch);
    }
  }, [urlSearch]);

  useEffect(() => {
    if (search === writtenSearch.current) {
      return undefined;
    }
    const timer = setTimeout(() => {
      writtenSearch.current = search;
      writeParams({ q: search.trim() ? search : null }, "replace");
    }, SEARCH_URL_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search]);

  /* ------------------------------------------------------------ derived */

  const following = useMemo(() => {
    const set = new Set(list?.following ?? []);
    for (const [key, value] of Object.entries(followOverrides)) {
      if (value) {
        set.add(key);
      } else {
        set.delete(key);
      }
    }
    return set;
  }, [followOverrides, list?.following]);

  const tickets = useMemo(() => list?.tickets ?? [], [list?.tickets]);
  const context: ViewContext = useMemo(() => ({ following, me: list?.me ?? "", now }), [following, list?.me, now]);
  const counts = useMemo(() => (list && list.builtAt ? viewCounts(tickets, context) : null), [context, list, tickets]);
  const inView = useMemo(() => tickets.filter((ticket) => viewDef.matches(ticket, context)), [context, tickets, viewDef]);
  const visible = useMemo(() => selectTickets(tickets, { filters, search, sort, view }, context), [context, filters, search, sort, tickets, view]);
  const groups = useMemo(() => groupByWhoseMove(visible), [visible]);
  /* Only the Needs attention view spends the chips: why each row is there. */
  const reasons = useMemo(
    () => (view === "needs_attention" ? new Map(visible.map((ticket) => [ticket.key, attentionReasons(ticket, now)] as const)) : undefined),
    [now, view, visible],
  );
  const keys = useMemo(() => navigableKeys(groups, layout === "board" ? new Set() : collapsed), [collapsed, groups, layout]);
  const openTicket = openKey ? tickets.find((ticket) => ticket.key === openKey) : undefined;
  const openIndex = openKey ? keys.indexOf(openKey) : -1;

  /* Opening a ticket marks its current activity as seen in this browser (the read/unread greying). */
  useEffect(() => {
    if (!openTicket) {
      return;
    }
    setSeen((current) => {
      if (current[openTicket.key] === openTicket.lastActivityAt) {
        return current;
      }
      const entries = Object.entries({ ...current, [openTicket.key]: openTicket.lastActivityAt });
      const next = Object.fromEntries(entries.slice(-MAX_SEEN_ENTRIES));
      writeStorage(SEEN_STORAGE_KEY, next);
      return next;
    });
  }, [openTicket]);

  /* ------------------------------------------------------------ actions */

  /* The cursor follows the open ticket however it changed (row click, j/k, or back/forward), so j/k and Prev/Next step from it. */
  useEffect(() => {
    if (openKey) {
      setCursorKey(openKey);
    } else {
      pushedFrom.current = null;
    }
  }, [openKey]);

  /* Closing hands focus back to the row, once the list is interactive again (an overlay panel makes it inert while open). */
  useEffect(() => {
    if (!openKey && focusAfterClose.current) {
      focusRow(focusAfterClose.current);
      focusAfterClose.current = null;
    }
  }, [openKey]);

  const openTicketKey = useCallback(
    (key: string, mode: "push" | "replace" = "push") => {
      const effective = openKey ? "replace" : mode;
      if (effective === "push") {
        pushedFrom.current = urlWithoutTicket();
      }
      setCursorKey(key);
      writeParams({ ticket: key }, effective);
    },
    [openKey],
  );

  /* A page tool (WebMCP open_case, or one that drafts/proposes on a ticket) asks for a ticket: open it exactly as a row click does. */
  useEffect(() => {
    const onOpenCase = (event: Event): void => {
      const key = (event as CustomEvent<Partial<OpenCaseDetail> | null>).detail?.key;
      if (typeof key === "string" && /^TS-\d+$/.test(key)) {
        openTicketKey(key);
      }
    };
    window.addEventListener(UI_EVENTS.openCase, onOpenCase);
    return () => window.removeEventListener(UI_EVENTS.openCase, onOpenCase);
  }, [openTicketKey]);

  const closePanel = useCallback(() => {
    if (!openKey) {
      return;
    }
    focusAfterClose.current = openKey;
    if (pushedFrom.current !== null && pushedFrom.current === urlWithoutTicket()) {
      /* Our own pushState opened it and nothing else in the URL changed since, so Back is the matching close (no dead history entry). */
      pushedFrom.current = null;
      window.history.back();
    } else {
      writeParams({ ticket: null }, "replace");
    }
  }, [openKey]);

  const move = useCallback(
    (delta: number) => {
      const next = adjacentKey(keys, openKey ?? cursorKey, delta);
      if (!next) {
        return;
      }
      setCursorKey(next);
      focusRow(next);
      /* With the panel open, j/k walk the panel too - Linear-style triage. */
      if (openKey) {
        writeParams({ ticket: next }, "replace");
      }
    },
    [cursorKey, keys, openKey],
  );

  const selectView = (next: TrackerViewId): void => {
    setFilters(EMPTY_FILTERS);
    /* This push lands on top of the ticket entry, so Back no longer undoes the open. */
    pushedFrom.current = null;
    writeParams({ view: next === DEFAULT_VIEW_ID ? null : next }, "push");
  };

  const toggleGroup = (whoseMove: WhoseMove): void => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(whoseMove)) {
        next.delete(whoseMove);
      } else {
        next.add(whoseMove);
      }
      writeStorage(COLLAPSED_STORAGE_KEY, [...next]);
      return next;
    });
  };

  const toggleFollow = async (key: string): Promise<void> => {
    const next = !following.has(key);
    setFollowOverrides((current) => ({ ...current, [key]: next }));
    const result = await postFollow(key, next);
    if (result.ok) {
      setFollowOverrides((current) => ({ ...current, [key]: result.data.following }));
      setActionError(null);
    } else {
      setFollowOverrides((current) => ({ ...current, [key]: !next }));
      setActionError(`Couldn't ${next ? "follow" : "unfollow"} ${key}: ${result.error}`);
    }
  };

  const refresh = async (): Promise<void> => {
    setRefreshing(true);
    const result = await postRefresh();
    setActionError(result.ok ? null : `Refresh failed: ${result.error}`);
    await load();
    setRefreshing(false);
  };

  /* ----------------------------------------------------------- keyboard */

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      /* Escape closes the panel from anywhere; the search box swallows it first while it still has text to clear. */
      if (event.key === "Escape") {
        if (openKey) {
          event.preventDefault();
          const target = event.target;
          /* In a panel field (the Slack link input) it only leaves the field, so a pasted link survives; the next Escape closes. */
          if (target instanceof HTMLElement && ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName) && target.closest(".trk-panel")) {
            target.blur();
            return;
          }
          closePanel();
        }
        return;
      }
      if (isTypingTarget(event.target)) {
        return;
      }
      const onRow = event.target instanceof HTMLElement && event.target.closest('[role="option"]') !== null;
      if (event.key === "/") {
        event.preventDefault();
        searchRef.current?.focus();
      } else if (event.key === "j" || (event.key === "ArrowDown" && onRow)) {
        event.preventDefault();
        move(1);
      } else if (event.key === "k" || (event.key === "ArrowUp" && onRow)) {
        event.preventDefault();
        move(-1);
      } else if (event.key === "Enter" && event.target === document.body && cursorKey) {
        event.preventDefault();
        openTicketKey(cursorKey);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [closePanel, cursorKey, move, openKey, openTicketKey]);

  /* ------------------------------------------------------------- render */

  const filtered = hasActiveFilters(filters) || search.trim() !== "";
  /* A failed first build shows its errors in place of the list instead of in the banner. */
  const listErrors = building ? [] : (list?.errors ?? []);
  const errors = [...listErrors, ...(actionError ? [actionError] : [])];
  const buildFailed = building && (list?.errors.length ?? 0) > 0;
  /* Over the list, the covered list and views must not stay reachable by keyboard or screen reader. */
  const coverList = overlay && openKey !== null;

  let content: React.ReactNode;
  if (!list) {
    content = loadError ? (
      <div className="trk-state">
        <Icon name="alert" size={20} />
        <p>{loadError}</p>
        <button className="trk-btn" onClick={() => void load()} type="button">
          Try again
        </button>
      </div>
    ) : (
      <TrackerListSkeleton />
    );
  } else if (buildFailed) {
    content = (
      <div className="trk-state" role="alert">
        <Icon name="alert" size={20} />
        <p>The tracker couldn&apos;t be built: {list.errors.join(" · ")}</p>
        <button
          className="trk-btn"
          disabled={refreshing}
          onClick={() => {
            setBuildTries(0);
            void refresh();
          }}
          type="button"
        >
          {refreshing ? "Retrying…" : "Retry"}
        </button>
      </div>
    );
  } else if (building) {
    content = (
      <div className="trk-state" role="status">
        <span className="trk-spin">
          <Icon name="refresh" size={20} />
        </span>
        <p>Building the tracker for the first time… This reads every High/Critical ticket from Jira and takes a minute; the list appears on its own.</p>
      </div>
    );
  } else if (visible.length === 0) {
    content = (
      <div className="trk-state">
        <Icon name="inbox" size={20} />
        <p>{filtered ? "No tickets match this search and these filters." : viewDef.emptyText}</p>
        {filtered ? (
          <button
            className="trk-btn"
            onClick={() => {
              setFilters(EMPTY_FILTERS);
              setSearch("");
            }}
            type="button"
          >
            Clear search and filters
          </button>
        ) : null}
      </div>
    );
  } else if (layout === "board") {
    content = <TrackerBoard cursorKey={cursorKey} groups={groups} onOpen={openTicketKey} openKey={openKey} reasons={reasons} renderedKeys={keys} seen={seen} />;
  } else {
    content = (
      <TrackerList
        collapsed={collapsed}
        cursorKey={cursorKey}
        groups={groups}
        now={now}
        onOpen={openTicketKey}
        onToggleGroup={toggleGroup}
        openKey={openKey}
        reasons={reasons}
        renderedKeys={keys}
        seen={seen}
      />
    );
  }

  return (
    <div className="trk-workspace" data-panel={openKey ? "open" : "closed"}>
      <div className="trk-views-host" inert={coverList}>
        <TrackerViewsNav counts={counts} onSelect={selectView} selected={view} />
      </div>

      <div className="trk-center" inert={coverList}>
        <TrackerHeader
          builtAt={list?.builtAt ?? null}
          count={list?.builtAt ? visible.length : null}
          layout={layout}
          now={now}
          onLayoutChange={(next) => writeParams({ layout: next === "list" ? null : next }, "replace")}
          onRefresh={() => void refresh()}
          onSearchChange={setSearch}
          onSortChange={(next) => writeParams({ sort: next === defaultSort ? null : next }, "replace")}
          refreshing={refreshing}
          search={search}
          searchRef={searchRef}
          sort={sort}
          title={viewDef.label}
        />
        <TrackerFilterBar filters={filters} now={now} onChange={setFilters} tickets={inView} />
        {errors.length > 0 ? (
          <div className="trk-banner" role="status">
            <Icon name="alert" size={14} />
            <span>
              {listErrors.length > 0 ? "Some tracker data couldn't be loaded, so parts of this list may be stale: " : ""}
              {errors.join(" · ")}
            </span>
            {actionError ? (
              <button aria-label="Dismiss" className="trk-icon-btn" onClick={() => setActionError(null)} type="button">
                <Icon name="close" size={12} />
              </button>
            ) : null}
          </div>
        ) : null}
        {loadError && list ? (
          <div className="trk-banner" data-tone="danger" role="status">
            <Icon name="alert" size={14} />
            <span>Couldn&apos;t refresh the list ({loadError}). Showing what was loaded last.</span>
          </div>
        ) : null}
        <div className="trk-scroll">{content}</div>
      </div>

      {openKey ? (
        <>
          <div aria-hidden="true" className="trk-panel-backdrop" onClick={closePanel} />
          {openTicket ? (
            <TrackerDetailPanel
              focusOnOpen={overlay}
              following={following.has(openTicket.key)}
              hasNext={openIndex !== -1 && openIndex < keys.length - 1}
              hasPrevious={openIndex > 0}
              jiraBaseUrl={list?.jiraBaseUrl ?? ""}
              now={now}
              onClose={closePanel}
              onNext={() => move(1)}
              onPrevious={() => move(-1)}
              onToggleFollow={() => void toggleFollow(openTicket.key)}
              ticket={openTicket}
            />
          ) : list?.builtAt ? (
            <aside aria-label={`${openKey} details`} className="trk-panel">
              <div className="trk-panel-toolbar">
                <button aria-label="Close panel" autoFocus={overlay} className="trk-icon-btn" onClick={closePanel} type="button">
                  <Icon name="close" size={15} />
                </button>
              </div>
              <div className="trk-state">
                <p>{openKey} isn&apos;t in the tracker - it isn&apos;t a High/Critical Support Ticket or waiting on engineering, or it closed a while ago.</p>
                {list.jiraBaseUrl ? (
                  <a className="trk-btn" href={`${list.jiraBaseUrl}/browse/${encodeURIComponent(openKey)}`} rel="noreferrer" target="_blank">
                    <Icon name="external-link" size={13} />
                    Open in Jira
                  </a>
                ) : null}
              </div>
            </aside>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
