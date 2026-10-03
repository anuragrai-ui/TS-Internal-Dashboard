"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import { Icon } from "@/components/Icon";
import { formatEtIst, isOnCallResponse, pillSummary, regionRows, relativeTime, spokenSummary } from "@/components/oncall/format";
import { OnCallPeople } from "@/components/oncall/OnCallPeople";

import type { OnCallResponse } from "@/lib/workspace/types";

/* The schedule changes weekly; five minutes is plenty, and nothing is polled while the tab is hidden. */
const POLL_MS = 5 * 60_000;

/**
 * Header pill: who is firefighter right now ("On call: Tarang · Martin"),
 * opening a small panel with now + next per region, handover times in ET and
 * IST, and Slack DM links. Rendered only for an identified browser (the API
 * refuses anyone else). Until the calendar is connected it is a quiet "Set
 * up on-call" link to the page that explains how.
 */
export function OnCallPill(): React.ReactElement | null {
  const [data, setData] = useState<OnCallResponse | null>(null);
  const [loadedAt, setLoadedAt] = useState(0);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const headingId = useId();

  useEffect(() => {
    let stopped = false;
    let inFlight = false;
    let lastLoaded = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const schedule = (delay: number): void => {
      clearTimeout(timer);
      if (!stopped && !document.hidden) {
        timer = setTimeout(() => void load(), Math.max(delay, 1_000));
      }
    };

    const load = async (): Promise<void> => {
      if (inFlight || stopped) {
        return;
      }
      inFlight = true;
      try {
        const response = await fetch("/api/oncall", { cache: "no-store" });
        if (response.status === 401) {
          /* Identity ended elsewhere - stop until the next page load. */
          stopped = true;
          return;
        }
        const body: unknown = await response.json();
        if (response.ok && isOnCallResponse(body)) {
          setData(body);
        }
      } catch {
        /* Offline or a deploy in progress - the next tick tries again. */
      } finally {
        inFlight = false;
        lastLoaded = Date.now();
        setLoadedAt(lastLoaded);
        schedule(POLL_MS);
      }
    };

    const onVisibility = (): void => {
      if (document.hidden) {
        clearTimeout(timer);
        return;
      }
      const age = Date.now() - lastLoaded;
      if (age >= POLL_MS) {
        void load();
      } else {
        schedule(POLL_MS - age);
      }
    };

    void load();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) {
      buttonRef.current?.focus();
    }
  }, []);

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    /* Focus moves into the panel so screen readers announce it; Escape brings it back to the pill. */
    panelRef.current?.focus();
    const onPointer = (event: MouseEvent): void => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        close(true);
      }
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [close, open]);

  /* Tabbing out of the panel closes it, like any disclosure popover. */
  const onBlur = (event: React.FocusEvent<HTMLDivElement>): void => {
    const next = event.relatedTarget as Node | null;
    if (open && next && !containerRef.current?.contains(next)) {
      setOpen(false);
    }
  };

  if (!data) {
    return null;
  }

  if (!data.configured) {
    return (
      <Link
        aria-label="Set up on-call: connect the firefighter calendar"
        className="oc-pill oc-pill-setup"
        href="/oncall"
        title="Connect the firefighter calendar to see who is on call"
      >
        <Icon name="zap" size={14} />
        <span className="oc-pill-label">Set up on-call</span>
      </Link>
    );
  }

  const summary = pillSummary(data.now);
  const rows = regionRows(data);
  const state = data.now.length > 0 ? "ok" : data.error ? "error" : "empty";
  const label =
    data.now.length > 0
      ? `On call now: ${spokenSummary(data.now)}. Show the on-call schedule`
      : data.error
        ? "On-call schedule unavailable. Show details"
        : "Nobody is on call right now according to the calendar. Show the on-call schedule";

  return (
    <div className="oc-pill-wrap" onBlur={onBlur} ref={containerRef}>
      <button
        aria-controls={open ? panelId : undefined}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={label}
        className="oc-pill"
        data-state={state}
        onClick={() => setOpen((value) => !value)}
        ref={buttonRef}
        title={summary ? `On call: ${summary}` : "On call"}
        type="button"
      >
        <Icon name="zap" size={14} />
        <span className="oc-pill-label">On call</span>
        <span className="oc-pill-names">{summary || (data.error ? "Unavailable" : "Nobody")}</span>
      </button>

      {open ? (
        <div aria-labelledby={headingId} className="oc-pop" id={panelId} ref={panelRef} role="dialog" tabIndex={-1}>
          <div className="oc-pop-header">
            <h2 className="oc-pop-title" id={headingId}>
              Who&apos;s on call
            </h2>
            {data.calendarName ? <span className="oc-muted oc-pop-calendar">{data.calendarName}</span> : null}
          </div>

          {data.error ? (
            <p className="oc-pop-error">
              <Icon name="alert" size={13} /> {data.error}
              {data.fetchedAt && loadedAt ? ` Showing the copy from ${relativeTime(data.fetchedAt, loadedAt)}.` : ""}
            </p>
          ) : null}

          {rows.length === 0 ? (
            <p className="oc-pop-empty">Nothing on the calendar now or in the next 14 days.</p>
          ) : (
            <div className="oc-pop-regions">
              {rows.map((row) => (
                <section aria-label={row.region} className="oc-pop-region" key={row.region}>
                  <h3 className="oc-pop-region-name">{row.region}</h3>
                  {row.now.length > 0 ? (
                    row.now.map((shift) => (
                      <div className="oc-pop-row" key={shift.id}>
                        <span className="oc-tag oc-tag-now">Now</span>
                        <div className="oc-pop-row-body">
                          <OnCallPeople shift={shift} />
                          <span className="oc-pop-time">until {formatEtIst(shift.end)}</span>
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="oc-pop-row">
                      <span className="oc-tag">Now</span>
                      <span className="oc-muted">Nobody on the calendar</span>
                    </div>
                  )}
                  {row.next.map((shift) => (
                    <div className="oc-pop-row" key={shift.id}>
                      <span className="oc-tag">Next</span>
                      <div className="oc-pop-row-body">
                        <OnCallPeople shift={shift} />
                        <span className="oc-pop-time">from {formatEtIst(shift.start)}</span>
                      </div>
                    </div>
                  ))}
                </section>
              ))}
            </div>
          )}

          <div className="oc-pop-footer">
            <Link className="oc-text-btn" href="/oncall" onClick={() => setOpen(false)}>
              On-call schedule &amp; #firefighters <Icon name="chevron-right" size={12} />
            </Link>
          </div>
        </div>
      ) : null}
    </div>
  );
}
