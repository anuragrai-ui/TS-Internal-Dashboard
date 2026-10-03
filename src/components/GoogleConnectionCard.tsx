"use client";

import { useCallback, useEffect, useState } from "react";

import { Icon } from "@/components/Icon";
import { googleConnectErrorMessage } from "@/lib/google/messages";

import type { GoogleConnectionStatus, GooglePurpose } from "@/lib/workspace/types";

/**
 * One Google sign-in's state with its Connect / Disconnect controls - used
 * by the on-call page (calendar) and the inbox (support mailbox). Connect is
 * a plain link to /api/google/connect, which redirects to Google; the
 * result comes back as ?google=connected or ?google_error=<code> on this
 * page and is shown here once. Disconnect asks once before revoking.
 */

interface Props {
  /* Shown instead of the default heading. */
  title?: string;
  /* One line under the heading - what the connection is for. */
  description: string;
  /* The account to sign in as, when it has to be a particular one (the support mailbox). */
  signInAs?: string | null;
  connectLabel: string;
  /* Called after a disconnect, or when the page loads fresh from a successful connect. */
  onChange?: () => void;
  purpose: GooglePurpose;
}

function isStatus(value: unknown): value is GoogleConnectionStatus {
  return Boolean(value) && typeof value === "object" && typeof (value as { state?: unknown }).state === "string" && Array.isArray((value as { missingEnv?: unknown }).missingEnv);
}

function formatDate(iso: string | undefined): string {
  const ms = iso ? Date.parse(iso) : Number.NaN;
  return Number.isNaN(ms) ? "an unknown date" : new Date(ms).toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" });
}

export function GoogleConnectionCard({ connectLabel, description, onChange, purpose, signInAs, title }: Props): React.ReactElement {
  const [status, setStatus] = useState<GoogleConnectionStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; tone: "danger" | "success" } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/google/status?purpose=${purpose}`, { cache: "no-store" });
      const body: unknown = await response.json().catch(() => null);
      if (response.ok && isStatus(body)) {
        setStatus(body);
        setLoadError(null);
      } else {
        setLoadError(response.status === 401 ? "Identify yourself on the Jira Tokens page first." : "Couldn't read the Google connection.");
      }
    } catch {
      setLoadError("Couldn't reach the dashboard.");
    }
  }, [purpose]);

  useEffect(() => {
    void load();
    /* The callback's outcome rides on the URL once; show it, then drop it so a reload doesn't repeat it. */
    try {
      const url = new URL(window.location.href);
      const error = googleConnectErrorMessage(url.searchParams.get("google_error"));
      const connected = url.searchParams.get("google") === "connected";
      if (error || connected) {
        setNotice(error ? { text: error, tone: "danger" } : { text: "Connected to Google.", tone: "success" });
        url.searchParams.delete("google_error");
        url.searchParams.delete("google");
        window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
        if (connected) {
          onChange?.();
        }
      }
    } catch {
      /* No URL access - nothing to show. */
    }
    /* Once per mount: a new onChange identity must not replay the URL notice. */
  }, [load]); // onChange deliberately omitted

  const disconnect = async (): Promise<void> => {
    setBusy(true);
    try {
      const response = await fetch("/api/google/disconnect", {
        body: JSON.stringify({ purpose }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const body = (await response.json().catch(() => null)) as { error?: string; revoked?: boolean; status?: unknown } | null;
      if (!response.ok) {
        setNotice({ text: body?.error ?? `Disconnect failed (${response.status}).`, tone: "danger" });
      } else {
        if (isStatus(body?.status)) {
          setStatus(body.status);
        }
        setNotice({ text: body?.revoked ? "Disconnected and revoked at Google." : "Disconnected here; Google didn't confirm the revoke - remove the app under the account's Google security settings if needed.", tone: "success" });
        onChange?.();
      }
    } catch {
      setNotice({ text: "Couldn't reach the dashboard - nothing changed.", tone: "danger" });
    }
    setBusy(false);
    setConfirming(false);
  };

  const state = status?.state;
  const connectHref = `/api/google/connect?purpose=${purpose}`;
  const tone = state === "connected" ? "success" : state === "broken" ? "danger" : "warning";
  const stateLabel = state === "connected" ? "Connected" : state === "broken" ? "Needs reconnecting" : state === "unconfigured" ? "Not set up" : state === "not_connected" ? "Not connected" : "Checking…";

  return (
    <section aria-label={title ?? "Google connection"} className="inb-gconn" data-state={state ?? "loading"}>
      <div className="inb-gconn-head">
        <span className="inb-gconn-title">
          <Icon name="link" size={14} /> {title ?? "Google connection"}
        </span>
        <span className={`status-badge tone-${tone}`}>{stateLabel}</span>
      </div>
      <p className="inb-muted inb-gconn-desc">{description}</p>

      {loadError ? (
        <p className="inb-gconn-line" role="alert">
          {loadError}
        </p>
      ) : null}

      {state === "connected" ? (
        <p className="inb-gconn-line">
          Connected as <strong>{status?.connectedEmail}</strong> by {status?.connectedBy ?? "someone"} on {formatDate(status?.connectedAt)}.
        </p>
      ) : null}
      {state === "broken" ? (
        <p className="inb-gconn-line" role="status">
          Google stopped accepting the sign-in of <strong>{status?.connectedEmail}</strong>
          {status?.brokenAt ? ` on ${formatDate(status.brokenAt)}` : ""} - it was revoked or expired. Connect again to resume.
        </p>
      ) : null}
      {state === "not_connected" ? (
        <p className="inb-gconn-line">
          Nobody has signed in yet.{signInAs ? (
            <>
              {" "}
              Sign in as <strong>{signInAs}</strong>.
            </>
          ) : null}
        </p>
      ) : null}
      {status && status.missingEnv.length > 0 ? (
        <p className="inb-gconn-line">
          Missing on the server: {status.missingEnv.map((name, index) => (
            <span key={name}>
              {index > 0 ? ", " : ""}
              <code>{name}</code>
            </span>
          ))}
          .
        </p>
      ) : null}

      {notice ? (
        <p className="inb-gconn-notice" data-tone={notice.tone} role={notice.tone === "danger" ? "alert" : "status"}>
          {notice.text}
        </p>
      ) : null}

      <div className="inb-gconn-actions">
        {state && state !== "unconfigured" ? (
          <a className={state === "connected" ? "btn btn-sm" : "btn btn-sm btn-primary"} href={connectHref}>
            {state === "connected" ? "Reconnect" : connectLabel}
          </a>
        ) : null}
        {state === "connected" || state === "broken" ? (
          confirming ? (
            <>
              <button aria-busy={busy} className="btn btn-sm inb-btn-danger" disabled={busy} onClick={() => void disconnect()} type="button">
                {busy ? "Disconnecting…" : "Yes, disconnect"}
              </button>
              <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => setConfirming(false)} type="button">
                Cancel
              </button>
            </>
          ) : (
            <button className="btn btn-sm btn-ghost" onClick={() => setConfirming(true)} type="button">
              Disconnect
            </button>
          )
        ) : null}
      </div>
    </section>
  );
}
