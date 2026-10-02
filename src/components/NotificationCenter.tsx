"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { Icon } from "@/components/Icon";
import { NOTIFICATIONS_CHANGED_EVENT } from "@/components/NotificationBell";
import { NotificationItem } from "@/components/NotificationItem";

import type { NotificationPage, NotificationSource, NotificationView } from "@/lib/notifications/types";

type Scope = "mine" | "team";
type SourceFilter = NotificationSource | "all";

const PAGE_SIZE = 40;
const SOURCE_FILTERS: Array<{ label: string; value: SourceFilter }> = [
  { label: "All", value: "all" },
  { label: "Jira", value: "jira" },
  { label: "Slack", value: "slack" },
  { label: "Escalations", value: "escalation" },
];

async function fetchPage(scope: Scope, before?: number): Promise<NotificationPage | null> {
  const params = new URLSearchParams({ limit: String(PAGE_SIZE), scope });
  if (before !== undefined) {
    params.set("before", String(before));
  }
  try {
    const response = await fetch(`/api/notifications?${params.toString()}`, { cache: "no-store" });
    const body = (await response.json()) as Partial<NotificationPage>;
    return response.ok && Array.isArray(body.items) ? (body as NotificationPage) : null;
  } catch {
    return null;
  }
}

/** The full feed behind the bell: both tabs, filters, paging back through the last two weeks. */
export function NotificationCenter(): React.ReactElement {
  const [scope, setScope] = useState<Scope>("mine");
  const [source, setSource] = useState<SourceFilter>("all");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [items, setItems] = useState<NotificationView[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [status, setStatus] = useState<"error" | "idle" | "loading">("loading");

  const load = useCallback(async (nextScope: Scope) => {
    setStatus("loading");
    const page = await fetchPage(nextScope);
    if (!page) {
      setStatus("error");
      return;
    }
    setItems(page.items);
    setHasMore(page.hasMore);
    setUnreadCount(page.unreadCount);
    setStatus("idle");
  }, []);

  useEffect(() => {
    void load(scope);
  }, [load, scope]);

  /* The bell found something new, or read state changed in another place - refresh the first page. */
  useEffect(() => {
    const onChanged = (event: Event): void => {
      if ((event as CustomEvent<{ from?: string }>).detail?.from !== "center") {
        void load(scope);
      }
    };
    window.addEventListener(NOTIFICATIONS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(NOTIFICATIONS_CHANGED_EVENT, onChanged);
  }, [load, scope]);

  const loadMore = async (): Promise<void> => {
    const last = items.at(-1);
    if (!last) {
      return;
    }
    setStatus("loading");
    const page = await fetchPage(scope, last.score);
    if (!page) {
      setStatus("error");
      return;
    }
    setItems((current) => [...current, ...page.items.filter((item) => !current.some((existing) => existing.id === item.id))]);
    setHasMore(page.hasMore);
    setStatus("idle");
  };

  const markRead = async (target: { all: true } | { ids: string[] }): Promise<void> => {
    setItems((current) => current.map((item) => ("all" in target || target.ids.includes(item.id) ? { ...item, read: true } : item)));
    try {
      const response = await fetch("/api/notifications/read", {
        body: JSON.stringify(target),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const body = (await response.json()) as { unreadCount?: number };
      if (response.ok && typeof body.unreadCount === "number") {
        setUnreadCount(body.unreadCount);
      }
    } catch {
      /* The optimistic state stays; the next load corrects it. */
    }
    window.dispatchEvent(new CustomEvent(NOTIFICATIONS_CHANGED_EVENT, { detail: { from: "center" } }));
  };

  const visible = useMemo(
    () => items.filter((item) => (source === "all" || item.source === source) && (!unreadOnly || !item.read)),
    [items, source, unreadOnly],
  );

  return (
    <div className="notif-center">
      <div className="notif-center-toolbar">
        <div className="notif-tabs" role="tablist">
          <button aria-selected={scope === "mine"} className="notif-tab" onClick={() => setScope("mine")} role="tab" type="button">
            For you
            {unreadCount > 0 ? <span className="notif-tab-count">{unreadCount >= 100 ? "99+" : unreadCount}</span> : null}
          </button>
          <button aria-selected={scope === "team"} className="notif-tab" onClick={() => setScope("team")} role="tab" type="button">
            Team
          </button>
        </div>

        <div className="notif-filter-group" role="group" aria-label="Filter by source">
          {SOURCE_FILTERS.map((filter) => (
            <button
              aria-pressed={source === filter.value}
              className="notif-filter-chip"
              key={filter.value}
              onClick={() => setSource(filter.value)}
              type="button"
            >
              {filter.label}
            </button>
          ))}
        </div>

        <label className="notif-unread-toggle">
          <input checked={unreadOnly} onChange={(event) => setUnreadOnly(event.target.checked)} type="checkbox" />
          Unread only
        </label>

        <div className="notif-center-actions">
          <button className="followup-button" onClick={() => void load(scope)} type="button">
            <Icon name="refresh" size={13} /> Refresh
          </button>
          <button className="followup-button" disabled={unreadCount === 0} onClick={() => void markRead({ all: true })} type="button">
            <Icon name="check" size={13} /> Mark all read
          </button>
        </div>
      </div>

      {status === "error" ? <div className="notif-error">Couldn&apos;t load notifications. Try Refresh in a moment.</div> : null}

      <div className="notif-center-list" role="list">
        {visible.length === 0 && status !== "loading" ? (
          <div className="empty-state">
            {items.length === 0
              ? scope === "mine"
                ? "Nothing yet. Customer replies, comments and status changes on your TS tickets, engineering updates on their CPs, and replies to the dashboard's Slack threads will show up here."
                : "No team activity in the last two weeks."
              : "Nothing matches these filters."}
          </div>
        ) : (
          visible.map((item) => (
            <div key={item.id} role="listitem">
              <NotificationItem
                item={item}
                onOpen={(opened) => {
                  if (!opened.read) {
                    void markRead({ ids: [opened.id] });
                  }
                }}
              />
            </div>
          ))
        )}
      </div>

      <div className="notif-center-footer">
        {status === "loading" ? <span className="page-subtitle">Loading…</span> : null}
        {hasMore && status !== "loading" ? (
          <button className="followup-button" onClick={() => void loadMore()} type="button">
            Load older
          </button>
        ) : null}
      </div>
    </div>
  );
}
