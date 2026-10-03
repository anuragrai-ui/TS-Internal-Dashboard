"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { GoogleConnectionCard } from "@/components/GoogleConnectionCard";
import { Icon } from "@/components/Icon";
import { InboxDetail } from "@/components/inbox/InboxDetail";
import { fetchEmailCase, fetchInbox, postSyncNow, senderLabel } from "@/components/inbox/inboxApi";
import { relativeTime } from "@/components/oncall/format";

import type { EmailCaseDetail, EmailInboxFilter, EmailInboxResponse } from "@/lib/workspace/types";

/**
 * The support inbox: customer email read from the support Gmail mailbox
 * (src/lib/email/*), as cases. A list on the left (newest activity first,
 * filterable), the selected thread on the right; on a phone, one at a time.
 * The list refreshes every minute while the tab is visible; intake itself
 * runs in the background with the notification poll, or now via "Sync now".
 */

const POLL_MS = 60_000;
const FILTERS: Array<{ id: EmailInboxFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "unlinked", label: "Not linked" },
  { id: "linked", label: "Linked" },
  { id: "open", label: "Open" },
];

const SKIP_TEXT: Record<string, string> = {
  already_running: "A sync is already running - results show up in a moment.",
  db_unconfigured: "The case store database isn't configured (DATABASE_URL).",
  mailbox_not_connected: "Connect the support mailbox first.",
  mailbox_unconfigured: "The mailbox isn't set up on the server yet (see below).",
  redis_unconfigured: "Redis isn't configured.",
  throttled: "Synced moments ago - try again in half a minute.",
};

export function InboxWorkspace(): React.ReactElement {
  const [filter, setFilter] = useState<EmailInboxFilter>("all");
  const [overview, setOverview] = useState<EmailInboxResponse | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<EmailCaseDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncNote, setSyncNote] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(0);
  const lastLoadRef = useRef(0);
  const detailRef = useRef<HTMLDivElement>(null);

  const loadList = useCallback(async (which: EmailInboxFilter) => {
    setLoading(true);
    lastLoadRef.current = Date.now();
    const result = await fetchInbox(which);
    if (result.ok) {
      setOverview(result.data);
      setListError(result.data.error ?? null);
    } else {
      setListError(result.error);
    }
    setLoading(false);
    setNowMs(Date.now());
  }, []);

  const loadDetail = useCallback(async (caseId: string) => {
    setDetailError(null);
    const result = await fetchEmailCase(caseId);
    if (result.ok) {
      setDetail(result.data);
    } else {
      setDetail(null);
      setDetailError(result.error);
    }
  }, []);

  useEffect(() => {
    void loadList(filter);
  }, [filter, loadList]);

  useEffect(() => {
    const tick = (): void => {
      if (!document.hidden && Date.now() - lastLoadRef.current >= POLL_MS) {
        void loadList(filter);
      }
      setNowMs(Date.now());
    };
    const timer = setInterval(tick, 15_000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [filter, loadList]);

  const select = (caseId: string): void => {
    setSelectedId(caseId);
    setDetail(null);
    void loadDetail(caseId).then(() => detailRef.current?.focus());
  };

  const changed = (caseId: string): void => {
    /* A link may have merged this case into its Jira case - follow the id the server returned. */
    setSelectedId(caseId);
    void loadDetail(caseId);
    void loadList(filter);
  };

  const syncNow = async (): Promise<void> => {
    setSyncing(true);
    setSyncNote(null);
    const result = await postSyncNow();
    setSyncing(false);
    if (result.ok) {
      const summary = result.data.summary;
      setSyncNote(result.data.skipped ? (SKIP_TEXT[result.data.skipped] ?? result.data.skipped) : `Synced: ${summary?.processed ?? 0} new, ${summary?.skipped ?? 0} skipped.`);
    } else {
      setSyncNote(result.error);
    }
    void loadList(filter);
  };

  const mailbox = overview?.mailbox;
  const connected = mailbox?.state === "connected";
  const items = overview?.items ?? [];
  const sync = overview?.sync;

  return (
    <div className="inb-workspace" data-view={selectedId ? "detail" : "list"}>
      <div className="inb-toolbar">
        <div aria-label="Filter email" className="inb-filters" role="group">
          {FILTERS.map((option) => (
            <button aria-pressed={filter === option.id} className="inb-filter" key={option.id} onClick={() => setFilter(option.id)} type="button">
              {option.label}
            </button>
          ))}
        </div>
        <div className="inb-toolbar-end">
          {sync?.lastTick ? (
            <span className="inb-muted inb-sync-meta">
              Last sync {relativeTime(sync.lastTick.at, nowMs || Date.parse(sync.lastTick.at))}
              {sync.pending > 0 ? ` · ${sync.pending} queued` : ""}
            </span>
          ) : null}
          <button aria-busy={syncing} className="btn btn-sm" disabled={syncing || !connected} onClick={() => void syncNow()} type="button">
            <Icon name="refresh" size={13} /> {syncing ? "Syncing…" : "Sync now"}
          </button>
        </div>
      </div>

      {syncNote ? (
        <p className="inb-notice" data-tone="info" role="status">
          {syncNote}
        </p>
      ) : null}
      {listError ? (
        <p className="inb-notice" data-tone="danger" role="alert">
          {listError}
        </p>
      ) : null}
      {sync?.lastError && sync.lastTick?.errors.length ? (
        <p className="inb-notice" data-tone="warning" role="status">
          Last sync problem: {sync.lastError.message}
        </p>
      ) : null}

      {overview && overview.missingEnv.length > 0 ? (
        <div className="inb-setup" role="note">
          <h2 className="inb-setup-title">
            <Icon name="gear" size={15} /> Finish setting up email intake
          </h2>
          <p>
            Set these in Vercel (Settings → Environment Variables), then redeploy:{" "}
            {overview.missingEnv.map((name, index) => (
              <span key={name}>
                {index > 0 ? ", " : ""}
                <code>{name}</code>
              </span>
            ))}
            . The README section &quot;Google connection &amp; email intake&quot; has the Google Cloud steps.
          </p>
        </div>
      ) : null}

      {overview && !overview.sendEnabled ? (
        <p className="inb-notice" data-tone="warning" role="note">
          Shadow mode: email is read in, but replies are off until <code>EMAIL_SEND_ENABLED=true</code> is set in Vercel.
        </p>
      ) : null}
      {overview?.sendEnabled && overview.testRecipient ? (
        <p className="inb-notice" data-tone="warning" role="note">
          Test mode: every reply goes to {overview.testRecipient} instead of the customer.
        </p>
      ) : null}

      {overview && !connected ? (
        <GoogleConnectionCard
          connectLabel="Connect support mailbox"
          description="Reads new mail in the support inbox and sends replies from it (gmail.readonly + gmail.send). Sign in once as the support mailbox itself."
          onChange={() => void loadList(filter)}
          purpose="mailbox"
          signInAs={overview.supportAddress}
          title="Support mailbox"
        />
      ) : null}

      <div className="inb-panes">
        <section aria-label="Email cases" className="inb-list-pane">
          {loading && !overview ? (
            <p aria-live="polite" className="inb-muted inb-loading">
              Loading email…
            </p>
          ) : items.length === 0 ? (
            <div className="empty-state">{connected ? "No email here yet." : "Nothing yet - connect the support mailbox to start reading email."}</div>
          ) : (
            <ul className="inb-list">
              {items.map((item) => (
                <li className="inb-row" data-selected={item.caseId === selectedId} key={item.caseId}>
                  <button aria-current={item.caseId === selectedId ? "true" : undefined} className="inb-row-main" onClick={() => select(item.caseId)} type="button">
                    <span className="inb-row-top">
                      <span className="inb-row-from">{item.from ? (item.from.name ?? item.from.email) : senderLabel(null)}</span>
                      <time className="inb-row-time" dateTime={item.lastActivityAt}>
                        {relativeTime(item.lastActivityAt, nowMs || Date.parse(item.lastActivityAt))}
                      </time>
                    </span>
                    <span className="inb-row-subject">{item.subject}</span>
                    <span className="inb-row-snippet">{item.snippet}</span>
                  </button>
                  <span className="inb-row-chips">
                    {item.jiraKey ? (
                      <Link aria-label={`Open ${item.jiraKey} in the escalation tracker`} className="inb-chip" href={`/tracker?ticket=${encodeURIComponent(item.jiraKey)}`}>
                        <Icon name="ticket" size={11} /> {item.jiraKey}
                      </Link>
                    ) : (
                      <span className="inb-chip" data-tone="muted">
                        Not linked
                      </span>
                    )}
                    {item.messageCount > 1 ? <span className="inb-muted inb-row-count">{item.messageCount} messages</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <div aria-live="polite" className="inb-detail-pane" ref={detailRef} tabIndex={-1}>
          {detail ? (
            <InboxDetail
              detail={detail}
              key={detail.item.caseId}
              nowMs={nowMs || Date.now()}
              onBack={() => {
                setSelectedId(null);
                setDetail(null);
              }}
              onChanged={changed}
              sendEnabled={overview?.sendEnabled ?? false}
              testRecipient={overview?.testRecipient ?? null}
            />
          ) : detailError ? (
            <p className="inb-notice" data-tone="danger" role="alert">
              {detailError}
            </p>
          ) : selectedId ? (
            <p className="inb-muted inb-loading">Loading the thread…</p>
          ) : (
            <div className="empty-state inb-detail-empty">Pick an email to read the thread, link it to a Jira ticket or reply.</div>
          )}
        </div>
      </div>

      {overview && connected ? (
        <details className="inb-manage">
          <summary>Support mailbox connection</summary>
          <GoogleConnectionCard
            connectLabel="Connect support mailbox"
            description="Reads new mail in the support inbox and sends replies from it (gmail.readonly + gmail.send)."
            onChange={() => void loadList(filter)}
            purpose="mailbox"
            signInAs={overview.supportAddress}
            title="Support mailbox"
          />
        </details>
      ) : null}
    </div>
  );
}
