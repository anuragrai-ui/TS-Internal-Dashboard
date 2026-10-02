"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { Icon } from "@/components/Icon";
import { NotificationItem } from "@/components/NotificationItem";
import { notificationIcon } from "@/lib/notifications/format";

import type { NotificationPage, NotificationView } from "@/lib/notifications/types";

/* Live enough to feel instant, cheap enough to leave open all day: an unchanged poll is one Redis read. */
const VISIBLE_POLL_MS = 30_000;
const HIDDEN_POLL_MS = 120_000;
const TOAST_MS = 9_000;
const MAX_TOASTS = 3;
const DESKTOP_ALERTS_KEY = "ts-dashboard-desktop-alerts";
/* The bell and the Notifications page tell each other when read state or the feed changed. */
export const NOTIFICATIONS_CHANGED_EVENT = "ts-notifications:changed";

type Scope = "mine" | "team";
type DesktopState = "blocked" | "off" | "on" | "unsupported";

interface PollBody extends Partial<NotificationPage> {
  error?: string;
  unchanged?: boolean;
}

function unreadLabel(count: number): string {
  return count >= 100 ? "99+" : String(count);
}

function showDesktopAlerts(items: NotificationView[]): void {
  for (const item of items.slice(0, MAX_TOASTS)) {
    try {
      const alert = new Notification(item.title, { body: item.detail ?? "", icon: "/icon.svg", tag: item.id });
      alert.onclick = () => {
        window.focus();
        if (item.url) {
          window.open(item.url, "_blank", "noopener,noreferrer");
        }
        alert.close();
      };
    } catch {
      /* Some browsers only allow notifications from a service worker; the in-page toast still shows. */
    }
  }
}

async function postMarkRead(target: { all: true } | { ids: string[] }): Promise<number | null> {
  try {
    const response = await fetch("/api/notifications/read", {
      body: JSON.stringify(target),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const body = (await response.json()) as { unreadCount?: number };
    return response.ok && typeof body.unreadCount === "number" ? body.unreadCount : null;
  } catch {
    return null;
  }
}

function markLocally(page: NotificationPage | null, ids: string[] | "all"): NotificationPage | null {
  return page && { ...page, items: page.items.map((item) => (ids === "all" || ids.includes(item.id) ? { ...item, read: true } : item)) };
}

interface ToastProps {
  item: NotificationView;
  onDismiss: (id: string) => void;
  onOpen: (item: NotificationView) => void;
}

function Toast({ item, onDismiss, onOpen }: ToastProps): React.ReactElement {
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (paused) {
      return undefined;
    }
    const timer = setTimeout(() => onDismiss(item.id), TOAST_MS);
    return () => clearTimeout(timer);
  }, [item.id, onDismiss, paused]);

  return (
    <div
      className="notif-toast"
      data-important={item.important}
      onBlur={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <span className="notif-item-icon" data-source={item.source}>
        <Icon name={notificationIcon(item)} size={14} />
      </span>
      <div className="notif-toast-body">
        <div className="notif-toast-title">{item.title}</div>
        {item.detail ? <div className="notif-toast-detail">{item.detail}</div> : null}
        {item.url ? (
          <a className="notif-toast-link" href={item.url} onClick={() => onOpen(item)} rel="noreferrer" target="_blank">
            Open <Icon name="external-link" size={11} />
          </a>
        ) : null}
      </div>
      <button aria-label="Dismiss notification" className="notif-toast-close" onClick={() => onDismiss(item.id)} type="button">
        <Icon name="close" size={12} />
      </button>
    </div>
  );
}

/**
 * Header bell: unread badge, a dropdown of the latest notifications ("For
 * you" and "Team"), live toasts for anything new, and opt-in desktop alerts
 * for when the tab is in the background. Only rendered for an identified
 * browser - notifications are per person.
 */
export function NotificationBell(): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<Scope>("mine");
  const [mine, setMine] = useState<NotificationPage | null>(null);
  const [team, setTeam] = useState<NotificationPage | null>(null);
  const [toasts, setToasts] = useState<NotificationView[]>([]);
  const [desktop, setDesktop] = useState<DesktopState>("off");
  const [error, setError] = useState<string | null>(null);
  /* Toasts render into <body>: inside the sticky header they'd sit under the issue drawer and the mobile sidebar. */
  const [portalReady, setPortalReady] = useState(false);
  const versionRef = useRef<string | null>(null);
  /* Highest feed score already shown - anything above it is new enough to toast. Null until the first load. */
  const newestScoreRef = useRef<number | null>(null);
  const desktopRef = useRef<DesktopState>("off");
  const pollRef = useRef<() => void>(() => undefined);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    desktopRef.current = desktop;
  }, [desktop]);

  useEffect(() => {
    setPortalReady(true);
  }, []);

  const applyMine = useCallback((page: NotificationPage) => {
    versionRef.current = page.version;
    setMine(page);

    const newest = page.items.reduce((max, item) => Math.max(max, item.score), 0);
    const seen = newestScoreRef.current;
    newestScoreRef.current = Math.max(seen ?? 0, newest);

    /* The first load only sets the baseline: what was already there isn't news. */
    if (seen === null) {
      return;
    }

    const fresh = page.items.filter((item) => item.score > seen && !item.read);
    if (fresh.length === 0) {
      return;
    }

    setToasts((current) => [...fresh.slice(0, MAX_TOASTS), ...current.filter((toast) => !fresh.some((item) => item.id === toast.id))].slice(0, MAX_TOASTS));
    if (document.hidden && desktopRef.current === "on") {
      showDesktopAlerts(fresh);
    }
    window.dispatchEvent(new CustomEvent(NOTIFICATIONS_CHANGED_EVENT, { detail: { from: "bell" } }));
  }, []);

  useEffect(() => {
    let stopped = false;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const schedule = (): void => {
      clearTimeout(timer);
      if (!stopped) {
        timer = setTimeout(() => void poll(), document.hidden ? HIDDEN_POLL_MS : VISIBLE_POLL_MS);
      }
    };

    const poll = async (): Promise<void> => {
      if (inFlight || stopped) {
        return;
      }
      inFlight = true;
      try {
        const params = new URLSearchParams({ limit: "20", scope: "mine" });
        if (versionRef.current) {
          params.set("v", versionRef.current);
        }
        const response = await fetch(`/api/notifications?${params.toString()}`, { cache: "no-store" });
        if (response.status === 401) {
          /* Identity ended (token removed or rotated elsewhere) - stop polling until the next page load. */
          stopped = true;
          return;
        }
        const body = (await response.json()) as PollBody;
        if (!response.ok) {
          setError(body.error ?? "Notifications are unavailable right now.");
        } else if (!body.unchanged && Array.isArray(body.items)) {
          setError(null);
          applyMine(body as NotificationPage);
        }
      } catch {
        /* Offline or a deploy in progress - the next tick tries again. */
      } finally {
        inFlight = false;
        schedule();
      }
    };

    const wake = (): void => {
      if (!document.hidden) {
        void poll();
      }
    };
    const onChanged = (event: Event): void => {
      if ((event as CustomEvent<{ from?: string }>).detail?.from !== "bell") {
        versionRef.current = null;
        void poll();
      }
    };

    pollRef.current = () => {
      versionRef.current = null;
      void poll();
    };
    void poll();
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("focus", wake);
    window.addEventListener(NOTIFICATIONS_CHANGED_EVENT, onChanged);

    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("focus", wake);
      window.removeEventListener(NOTIFICATIONS_CHANGED_EVENT, onChanged);
    };
  }, [applyMine]);

  useEffect(() => {
    if (typeof Notification === "undefined") {
      setDesktop("unsupported");
    } else if (Notification.permission === "denied") {
      setDesktop("blocked");
    } else {
      try {
        if (Notification.permission === "granted" && window.localStorage.getItem(DESKTOP_ALERTS_KEY) === "on") {
          setDesktop("on");
        }
      } catch {
        /* Storage blocked - desktop alerts just start off. */
      }
    }
  }, []);

  /* The Team tab is loaded when shown; only "For you" is polled. */
  useEffect(() => {
    if (!open || scope !== "team") {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/notifications?scope=team&limit=20", { cache: "no-store" });
        const body = (await response.json()) as PollBody;
        if (!cancelled && response.ok && Array.isArray(body.items)) {
          setTeam(body as NotificationPage);
        }
      } catch {
        /* Keep whatever was shown before. */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, scope]);

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const onPointer = (event: MouseEvent): void => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const markRead = useCallback(async (ids: string[] | "all") => {
    setMine((page) => markLocally(page, ids));
    setTeam((page) => markLocally(page, ids));
    setToasts((current) => (ids === "all" ? [] : current.filter((toast) => !ids.includes(toast.id))));
    const unreadCount = await postMarkRead(ids === "all" ? { all: true } : { ids });
    if (unreadCount !== null) {
      setMine((page) => page && { ...page, unreadCount });
    }
    window.dispatchEvent(new CustomEvent(NOTIFICATIONS_CHANGED_EVENT, { detail: { from: "bell" } }));
    /* Re-read rather than trusting the version from the write: something new may have landed in between. */
    pollRef.current();
  }, []);

  const openItem = useCallback(
    (item: NotificationView) => {
      if (!item.read) {
        void markRead([item.id]);
      }
    },
    [markRead],
  );

  const dismissToast = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const toggleDesktop = async (): Promise<void> => {
    if (desktop === "on") {
      setDesktop("off");
      try {
        window.localStorage.removeItem(DESKTOP_ALERTS_KEY);
      } catch {
        /* nothing to undo */
      }
      return;
    }
    if (typeof Notification === "undefined") {
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission === "granted") {
      setDesktop("on");
      try {
        window.localStorage.setItem(DESKTOP_ALERTS_KEY, "on");
      } catch {
        /* still on for this tab */
      }
    } else if (permission === "denied") {
      setDesktop("blocked");
    }
  };

  const unread = mine?.unreadCount ?? 0;
  const shown = scope === "mine" ? mine : team;
  const desktopLabel =
    desktop === "on" ? "Desktop alerts: on" : desktop === "blocked" ? "Desktop alerts blocked in browser" : desktop === "unsupported" ? "" : "Turn on desktop alerts";

  return (
    <div className="notif-bell" ref={containerRef}>
      <button
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={unread > 0 ? `Notifications, ${unreadLabel(unread)} unread` : "Notifications"}
        className="header-icon-btn notif-bell-btn"
        onClick={() => setOpen((value) => !value)}
        title="Notifications"
        type="button"
      >
        <Icon name="bell" />
        {unread > 0 ? <span className="notif-badge">{unreadLabel(unread)}</span> : null}
      </button>

      {open ? (
        <div aria-label="Notifications" className="notif-panel" role="dialog">
          <div className="notif-panel-header">
            <div className="notif-tabs" role="tablist">
              <button aria-selected={scope === "mine"} className="notif-tab" onClick={() => setScope("mine")} role="tab" type="button">
                For you
                {unread > 0 ? <span className="notif-tab-count">{unreadLabel(unread)}</span> : null}
              </button>
              <button aria-selected={scope === "team"} className="notif-tab" onClick={() => setScope("team")} role="tab" type="button">
                Team
              </button>
            </div>
            <button className="notif-text-btn" disabled={unread === 0} onClick={() => void markRead("all")} type="button">
              <Icon name="check" size={13} /> Mark all read
            </button>
          </div>

          {error ? <div className="notif-error">{error}</div> : null}

          <div className="notif-list" role="list">
            {!shown ? (
              <div className="notif-empty">Loading…</div>
            ) : shown.items.length === 0 ? (
              <div className="notif-empty">
                {scope === "mine"
                  ? "Nothing yet. Comments, status changes and Slack replies on your tickets will show up here."
                  : "No team activity yet."}
              </div>
            ) : (
              shown.items.map((item) => (
                <div key={item.id} role="listitem">
                  <NotificationItem item={item} onOpen={openItem} />
                </div>
              ))
            )}
          </div>

          <div className="notif-panel-footer">
            <Link className="notif-text-btn" href="/notifications" onClick={() => setOpen(false)}>
              View all
            </Link>
            {desktopLabel ? (
              <button className="notif-text-btn" disabled={desktop === "blocked"} onClick={() => void toggleDesktop()} type="button">
                <Icon name="bell" size={13} /> {desktopLabel}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {portalReady
        ? createPortal(
            <div aria-live="polite" className="notif-toast-stack">
              {toasts.map((item) => (
                <Toast item={item} key={item.id} onDismiss={dismissToast} onOpen={openItem} />
              ))}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
