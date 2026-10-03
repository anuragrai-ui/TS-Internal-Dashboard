"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

import { Icon } from "@/components/Icon";
import {
  feedProblem,
  formatEtIst,
  groupByDay,
  isFirefighterFeedResponse,
  isOnCallResponse,
  isSlackPermalink,
  regionRows,
  relativeTime,
  shiftRange,
  slackChannelUrl,
  ticketHref,
  untilText,
} from "@/components/oncall/format";
import { OnCallPeople } from "@/components/oncall/OnCallPeople";

import type { FirefighterFeedResponse, FirefighterMessage, OnCallResponse, OnCallShift } from "@/lib/workspace/types";

const ONCALL_POLL_MS = 5 * 60_000;
/* The feed shares Slack's ~one-history-read-a-minute budget with the tracker; every few minutes is enough. */
const FEED_POLL_MS = 3 * 60_000;
const CLOCK_TICK_MS = 30_000;
const HIDE_BOTS_KEY = "ts-dashboard-firefighters-hide-bots";

type Fetched<T> = { data: T; ok: true } | { error: string; ok: false };

async function getJson<T>(url: string, valid: (value: unknown) => value is T): Promise<Fetched<T>> {
  try {
    const response = await fetch(url, { cache: "no-store" });
    const body: unknown = await response.json().catch(() => null);
    if (response.ok && valid(body)) {
      return { data: body, ok: true };
    }
    if (response.status === 401) {
      return { error: "Identify yourself on the Jira Tokens page first.", ok: false };
    }
    const message = body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string" ? (body as { error: string }).error : null;
    return { error: message ?? `Request failed (${response.status}).`, ok: false };
  } catch {
    return { error: "Couldn't reach the dashboard. Check your connection and try again.", ok: false };
  }
}

/* ------------------------------------------------------------- on-call */

function SetupCalendar(): React.ReactElement {
  return (
    <div className="oc-setup" role="note">
      <h3 className="oc-setup-title">
        <Icon name="gear" size={16} /> Connect the firefighter calendar
      </h3>
      <ol className="oc-setup-steps">
        <li>
          In Google Calendar, open <strong>Settings</strong> and choose the firefighter calendar under <em>Settings for my calendars</em>.
        </li>
        <li>
          Open <strong>Integrate calendar</strong> and copy the <strong>Secret address in iCal format</strong>.
        </li>
        <li>
          In Vercel, open this project&apos;s <strong>Settings → Environment Variables</strong> and add <code>ONCALL_CALENDAR_ICAL_URL</code> with that
          address, for <strong>Production</strong>, marked <strong>Sensitive</strong>.
        </li>
        <li>Redeploy. The header then shows who is on call, and this page shows the next two weeks.</li>
      </ol>
      <p className="oc-muted oc-setup-note">
        The secret address lets anyone who has it read the calendar - keep it out of Slack and Jira. Event titles like &quot;FF Asia/Europe -
        Tarang Somani&quot; or guests on the event both work; regions are read from words such as Asia, EMEA, India or US.
      </p>
    </div>
  );
}

function NowCards({ data, nowMs }: { data: OnCallResponse; nowMs: number }): React.ReactElement {
  const rows = regionRows(data);
  if (rows.length === 0) {
    return <div className="empty-state">Nothing on the calendar now or in the next 14 days.</div>;
  }
  return (
    <div className="oc-cards">
      {rows.map((row) => (
        <article aria-label={`${row.region} on call`} className="oc-card" data-active={row.now.length > 0} key={row.region}>
          <header className="oc-card-header">
            <h3 className="oc-card-region">{row.region}</h3>
            {row.now.length > 0 ? <span className="oc-tag oc-tag-now">On call now</span> : <span className="oc-tag">Nobody now</span>}
          </header>
          {row.now.map((shift) => (
            <div className="oc-card-shift" key={shift.id}>
              <OnCallPeople shift={shift} size="lg" />
              <p className="oc-card-time">
                Until {formatEtIst(shift.end)} <span className="oc-muted">({untilText(shift.end, nowMs)})</span>
              </p>
              <p className="oc-card-title">{shift.title}</p>
            </div>
          ))}
          {row.next.length > 0 ? (
            <div className="oc-card-next">
              <span className="oc-card-next-label">Next</span>
              {row.next.map((shift) => (
                <div className="oc-card-next-shift" key={shift.id}>
                  <OnCallPeople shift={shift} />
                  <span className="oc-card-time">from {formatEtIst(shift.start)}</span>
                </div>
              ))}
            </div>
          ) : null}
        </article>
      ))}
    </div>
  );
}

function shiftState(shift: OnCallShift, nowMs: number): "ended" | "future" | "now" {
  if (Date.parse(shift.end) <= nowMs) {
    return "ended";
  }
  return Date.parse(shift.start) <= nowMs ? "now" : "future";
}

function Agenda({ data, nowMs }: { data: OnCallResponse; nowMs: number }): React.ReactElement {
  const days = groupByDay(data.upcoming, data.timeZone);
  if (days.length === 0) {
    return <div className="empty-state">No shifts on the calendar for the next 14 days.</div>;
  }
  return (
    <ol className="oc-agenda">
      {days.map((day) => (
        <li className="oc-agenda-day" key={day.key}>
          <h3 className="oc-agenda-date">{day.label}</h3>
          <ul className="oc-agenda-list">
            {day.shifts.map((shift) => {
              const state = shiftState(shift, nowMs);
              const range = shiftRange(shift, data.timeZone);
              return (
                <li className="oc-agenda-item" data-state={state} key={shift.id}>
                  <span className="oc-region-chip">{shift.region}</span>
                  <div className="oc-agenda-body">
                    <OnCallPeople shift={shift} />
                    <span className="oc-agenda-time">
                      {range.from} → {range.until}
                    </span>
                  </div>
                  {state === "now" ? <span className="oc-tag oc-tag-now">Now</span> : state === "ended" ? <span className="oc-tag">Ended</span> : null}
                </li>
              );
            })}
          </ul>
        </li>
      ))}
    </ol>
  );
}

/* ---------------------------------------------------------- #firefighters */

function FeedMessage({ message, nowMs }: { message: FirefighterMessage; nowMs: number }): React.ReactElement {
  return (
    <li className="oc-msg" data-bot={message.isBot}>
      <div className="oc-msg-head">
        <span className="oc-msg-author">{message.authorName}</span>
        {message.isBot ? <span className="oc-badge">Bot</span> : null}
        <time className="oc-msg-time" dateTime={message.at} title={formatEtIst(message.at)}>
          {relativeTime(message.at, nowMs)}
        </time>
      </div>
      {message.text ? <p className="oc-msg-text">{message.text}</p> : <p className="oc-msg-text oc-muted">(no text)</p>}
      <div className="oc-msg-meta">
        {message.replyCount > 0 ? (
          <span className="oc-msg-replies">
            <Icon name="message" size={12} />
            {message.replyCount} {message.replyCount === 1 ? "reply" : "replies"}
            {message.lastReplyAt ? `, last ${relativeTime(message.lastReplyAt, nowMs)}` : ""}
          </span>
        ) : null}
        {message.ticketKeys.map((key) => {
          const href = ticketHref(key);
          return href ? (
            <Link aria-label={`Open ${key} in the escalation tracker`} className="oc-chip" href={href} key={key}>
              <Icon name="ticket" size={12} />
              {key}
            </Link>
          ) : null;
        })}
        {isSlackPermalink(message.permalink) ? (
          <a className="oc-text-btn oc-msg-open" href={message.permalink} rel="noreferrer" target="_blank">
            Open in Slack <Icon name="external-link" size={11} />
            <span className="visually-hidden"> (opens Slack)</span>
          </a>
        ) : null}
      </div>
    </li>
  );
}

/* ------------------------------------------------------------------ board */

/**
 * The on-call page: who is firefighter now (per region, handover in ET and
 * IST, Slack DM links), the next 14 days by day, and the live #firefighters
 * channel. Each half loads and fails on its own - a missing calendar must not
 * hide the channel, and the other way round.
 */
export function OnCallBoard(): React.ReactElement {
  const [oncall, setOncall] = useState<OnCallResponse | null>(null);
  const [oncallError, setOncallError] = useState<string | null>(null);
  const [oncallLoading, setOncallLoading] = useState(true);
  const [feed, setFeed] = useState<FirefighterFeedResponse | null>(null);
  const [feedError, setFeedError] = useState<string | null>(null);
  const [feedLoading, setFeedLoading] = useState(true);
  const [hideBots, setHideBots] = useState(true);
  const [nowMs, setNowMs] = useState<number | null>(null);
  const lastOncallRef = useRef(0);
  const lastFeedRef = useRef(0);
  const hideBotsId = useId();

  const loadOncall = useCallback(async (refresh: boolean) => {
    setOncallLoading(true);
    lastOncallRef.current = Date.now();
    const result = await getJson(`/api/oncall${refresh ? "?refresh=1" : ""}`, isOnCallResponse);
    if (result.ok) {
      setOncall(result.data);
      setOncallError(null);
    } else {
      setOncallError(result.error);
    }
    setOncallLoading(false);
    setNowMs(Date.now());
  }, []);

  const loadFeed = useCallback(async () => {
    setFeedLoading(true);
    lastFeedRef.current = Date.now();
    const result = await getJson("/api/firefighters", isFirefighterFeedResponse);
    if (result.ok) {
      setFeed(result.data);
      setFeedError(null);
    } else {
      setFeedError(result.error);
    }
    setFeedLoading(false);
    setNowMs(Date.now());
  }, []);

  useEffect(() => {
    void loadOncall(false);
    void loadFeed();
    try {
      if (window.localStorage.getItem(HIDE_BOTS_KEY) === "off") {
        setHideBots(false);
      }
    } catch {
      /* Storage blocked - bot posts just start hidden. */
    }

    const catchUp = (): void => {
      if (document.hidden) {
        return;
      }
      const now = Date.now();
      setNowMs(now);
      if (now - lastOncallRef.current >= ONCALL_POLL_MS) {
        void loadOncall(false);
      }
      if (now - lastFeedRef.current >= FEED_POLL_MS) {
        void loadFeed();
      }
    };
    const timer = setInterval(catchUp, CLOCK_TICK_MS);
    document.addEventListener("visibilitychange", catchUp);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", catchUp);
    };
  }, [loadFeed, loadOncall]);

  const toggleHideBots = (value: boolean): void => {
    setHideBots(value);
    try {
      window.localStorage.setItem(HIDE_BOTS_KEY, value ? "on" : "off");
    } catch {
      /* Still applies to this tab. */
    }
  };

  const messages = useMemo(() => feed?.messages ?? [], [feed]);
  const visibleMessages = useMemo(() => (hideBots ? messages.filter((message) => !message.isBot) : messages), [hideBots, messages]);
  const hiddenBots = messages.length - visibleMessages.length;
  const clock = nowMs ?? (oncall ? Date.parse(oncall.at) : 0);
  const channelName = feed?.channelName ?? "firefighters";
  const channelUrl = feed ? slackChannelUrl(feed.channel) : null;
  const problem = feed ? feedProblem(feed.rateLimited && feed.messages.length > 0 ? undefined : feed.error, channelName) : null;

  return (
    <div className="oc-board">
      <section aria-labelledby="oc-now-heading" className="oc-section oc-section-schedule">
        <div className="oc-section-header">
          <div className="oc-section-titles">
            <h2 className="oc-section-title" id="oc-now-heading">
              Now on call
            </h2>
            {oncall?.configured ? (
              <p className="oc-muted oc-section-meta">
                {oncall.calendarName ? `${oncall.calendarName} · ` : ""}
                {oncall.fetchedAt ? `calendar read ${relativeTime(oncall.fetchedAt, clock)}` : "calendar not read yet"}
                {oncall.timeZone ? ` · days in ${oncall.timeZone}` : ""}
              </p>
            ) : null}
          </div>
          <button aria-busy={oncallLoading} className="btn btn-sm" disabled={oncallLoading} onClick={() => void loadOncall(true)} type="button">
            <Icon name="refresh" size={13} /> {oncallLoading ? "Refreshing…" : "Refresh calendar"}
          </button>
        </div>

        {oncallError ? (
          <div className="oc-banner" data-tone="danger" role="alert">
            <Icon name="alert" size={15} /> <span>{oncallError}</span>
          </div>
        ) : null}

        {!oncall ? (
          oncallLoading ? (
            <div aria-live="polite" className="oc-loading">
              Loading the on-call calendar…
            </div>
          ) : null
        ) : !oncall.configured ? (
          <SetupCalendar />
        ) : (
          <>
            {oncall.error ? (
              <div className="oc-banner" data-tone="warning" role="status">
                <Icon name="alert" size={15} />
                <span>
                  <strong>Couldn&apos;t read the calendar.</strong> {oncall.error}
                  {oncall.fetchedAt ? ` Showing the copy from ${relativeTime(oncall.fetchedAt, clock)}.` : ""}
                </span>
              </div>
            ) : null}
            <NowCards data={oncall} nowMs={clock} />
            <h2 className="oc-section-title oc-agenda-heading">Next 14 days</h2>
            <Agenda data={oncall} nowMs={clock} />
          </>
        )}
      </section>

      <section aria-labelledby="oc-feed-heading" className="oc-section oc-section-feed">
        <div className="oc-section-header">
          <div className="oc-section-titles">
            <h2 className="oc-section-title" id="oc-feed-heading">
              #{channelName}
            </h2>
            {feed ? (
              <p className="oc-muted oc-section-meta">
                Latest top-level messages · read {relativeTime(feed.fetchedAt, clock)}
                {channelUrl ? (
                  <>
                    {" · "}
                    <a className="oc-inline-link" href={channelUrl} rel="noreferrer" target="_blank">
                      Open channel in Slack
                    </a>
                  </>
                ) : null}
              </p>
            ) : null}
          </div>
          <div className="oc-feed-controls">
            <label className="oc-toggle" htmlFor={hideBotsId}>
              <input checked={hideBots} id={hideBotsId} onChange={(event) => toggleHideBots(event.target.checked)} type="checkbox" />
              Hide bot posts
            </label>
            <button aria-busy={feedLoading} className="btn btn-sm" disabled={feedLoading} onClick={() => void loadFeed()} type="button">
              <Icon name="refresh" size={13} /> {feedLoading ? "Refreshing…" : "Refresh"}
            </button>
          </div>
        </div>

        {feedError ? (
          <div className="oc-banner" data-tone="danger" role="alert">
            <Icon name="alert" size={15} /> <span>{feedError}</span>
          </div>
        ) : null}

        {problem ? (
          <div className="oc-banner" data-tone="warning" role="status">
            <Icon name="alert" size={15} />
            <span>
              <strong>{problem.title}.</strong> {problem.body}
            </span>
          </div>
        ) : null}

        {feed?.rateLimited && feed.messages.length > 0 ? (
          <p className="oc-muted oc-feed-note" role="status">
            Slack is throttling reads - showing the copy from {relativeTime(feed.fetchedAt, clock)}.
          </p>
        ) : null}

        {!feed ? (
          feedLoading ? (
            <div aria-live="polite" className="oc-loading">
              Loading #firefighters…
            </div>
          ) : null
        ) : visibleMessages.length === 0 && !problem ? (
          <div className="empty-state">{messages.length > 0 ? "Only bot posts lately." : "No recent messages."}</div>
        ) : (
          <ul aria-label={`Latest messages in #${channelName}`} className="oc-feed">
            {visibleMessages.map((message) => (
              <FeedMessage key={message.ts} message={message} nowMs={clock} />
            ))}
          </ul>
        )}

        {hiddenBots > 0 ? (
          <p className="oc-muted oc-feed-note">
            {hiddenBots} bot {hiddenBots === 1 ? "post" : "posts"} hidden.{" "}
            <button className="oc-text-btn" onClick={() => toggleHideBots(false)} type="button">
              Show them
            </button>
          </p>
        ) : null}
      </section>
    </div>
  );
}
