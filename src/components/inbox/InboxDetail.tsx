"use client";

import Link from "next/link";
import { useId, useState } from "react";

import { Icon } from "@/components/Icon";
import { InboxComposer } from "@/components/inbox/InboxComposer";
import { formatBytes, postLink, senderLabel } from "@/components/inbox/inboxApi";
import { relativeTime } from "@/components/oncall/format";

import type { EmailCaseDetail, EmailCaseMessage } from "@/lib/workspace/types";

/**
 * One email case: the thread (plain text only - an email's HTML is
 * converted on the way in and never rendered), linking it to a TS ticket,
 * and the reply box.
 */

interface Props {
  detail: EmailCaseDetail;
  nowMs: number;
  onBack: () => void;
  /* After a link or a reply: reload the list and this case (a merge may move it to another id). */
  onChanged: (caseId: string) => void;
  sendEnabled: boolean;
  testRecipient: string | null;
}

function MessageItem({ message, nowMs }: { message: EmailCaseMessage; nowMs: number }): React.ReactElement {
  const outbound = message.direction === "outbound";
  return (
    <li className="inb-msg" data-direction={message.direction}>
      <header className="inb-msg-head">
        <span className="inb-msg-from">{outbound ? (message.sentBy ? `${message.sentBy} (support mailbox)` : "Support mailbox") : senderLabel(message.from)}</span>
        <time className="inb-msg-time" dateTime={message.createdAt} title={new Date(message.createdAt).toLocaleString("en-US")}>
          {relativeTime(message.createdAt, nowMs)}
        </time>
      </header>
      {message.to.length > 0 ? (
        <p className="inb-muted inb-msg-to">
          to {message.to.map((to) => to.email).join(", ")}
          {message.cc.length > 0 ? ` · cc ${message.cc.map((cc) => cc.email).join(", ")}` : ""}
        </p>
      ) : null}
      {/* Text, never markup: React escapes it, and the body was converted to plain text on the way in. */}
      <p className="inb-msg-body">{message.bodyText || "(no text)"}</p>
      {message.attachments.length > 0 ? (
        <ul aria-label="Attachments" className="inb-attachments">
          {message.attachments.map((attachment, index) => (
            <li className="inb-attachment" key={`${attachment.name}-${index}`}>
              <Icon name="note" size={12} /> {attachment.name} <span className="inb-muted">({formatBytes(attachment.size)})</span>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function LinkForm({ caseId, onLinked }: { caseId: string; onLinked: (caseId: string) => void }): React.ReactElement {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();

  return (
    <form
      className="inb-link-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!key.trim()) {
          return;
        }
        setBusy(true);
        setError(null);
        void postLink(caseId, key.trim()).then((result) => {
          setBusy(false);
          if (result.ok) {
            setKey("");
            onLinked(result.data.caseId);
          } else {
            setError(result.error);
          }
        });
      }}
    >
      <label className="inb-link-label" htmlFor={inputId}>
        Link to Jira ticket
      </label>
      <div className="inb-link-row">
        <input
          aria-describedby={error ? `${inputId}-error` : undefined}
          aria-invalid={Boolean(error)}
          autoComplete="off"
          className="inb-input"
          id={inputId}
          inputMode="text"
          onChange={(event) => setKey(event.target.value)}
          placeholder="TS-123"
          spellCheck={false}
          value={key}
        />
        <button aria-busy={busy} className="btn btn-sm" disabled={busy || !key.trim()} type="submit">
          <Icon name="link" size={13} /> {busy ? "Linking…" : "Link"}
        </button>
      </div>
      {error ? (
        <p className="inb-notice" data-tone="danger" id={`${inputId}-error`} role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}

export function InboxDetail({ detail, nowMs, onBack, onChanged, sendEnabled, testRecipient }: Props): React.ReactElement {
  const { item, messages } = detail;
  return (
    <article aria-labelledby="inb-detail-title" className="inb-detail">
      <button className="btn btn-sm btn-ghost inb-back" onClick={onBack} type="button">
        <Icon name="chevron-left" size={13} /> All email
      </button>
      <header className="inb-detail-head">
        <h2 className="inb-detail-title" id="inb-detail-title">
          {item.subject}
        </h2>
        <div className="inb-detail-meta">
          {item.jiraKey ? (
            <Link aria-label={`Open ${item.jiraKey} in the escalation tracker`} className="inb-chip" href={`/tracker?ticket=${encodeURIComponent(item.jiraKey)}`}>
              <Icon name="ticket" size={12} /> {item.jiraKey}
            </Link>
          ) : (
            <span className="inb-chip" data-tone="muted" title="Not linked to a Jira ticket yet">
              {item.key}
            </span>
          )}
          <span className="inb-muted">{item.statusName || "New"}</span>
          {item.from ? <span className="inb-muted">from {senderLabel(item.from)}</span> : null}
          {item.accountSuggestion ? (
            <span className="inb-muted" title="From the sender's email domain - not confirmed">
              Account suggestion: <strong>{item.accountSuggestion}</strong>
            </span>
          ) : null}
        </div>
      </header>

      {!item.jiraKey ? <LinkForm caseId={item.caseId} onLinked={onChanged} /> : null}

      <ol aria-label="Email thread" className="inb-thread">
        {messages.map((message) => (
          <MessageItem key={message.id} message={message} nowMs={nowMs} />
        ))}
      </ol>

      <InboxComposer item={item} onSent={() => onChanged(item.caseId)} sendEnabled={sendEnabled} testRecipient={testRecipient} />
    </article>
  );
}
