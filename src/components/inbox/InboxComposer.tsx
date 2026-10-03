"use client";

import { useId, useState } from "react";

import { mightHaveArrived, postAction, useAttemptKey } from "@/components/actions/actionsApi";
import { Icon } from "@/components/Icon";
import { BODY_MAX_CHARS } from "@/lib/actions/validate";

import type { ActionArgs, EmailCaseListItem } from "@/lib/workspace/types";

/**
 * The reply box under an email thread. A send is an "email_reply" action
 * through POST /api/actions - the same pipeline as a Jira reply: the
 * customer leak check, idempotency (a resend after a dropped connection
 * reuses the key, so it never goes twice), the rate limit and the audit
 * log. The server signs it with the sender's name and decides whether it
 * goes out at all (EMAIL_SEND_ENABLED) and to whom (EMAIL_TEST_RECIPIENT).
 */

interface Props {
  item: EmailCaseListItem;
  onSent: () => void;
  sendEnabled: boolean;
  testRecipient: string | null;
}

type Notice = { text: string; tone: "danger" | "success" | "warning" };

export function InboxComposer({ item, onSent, sendEnabled, testRecipient }: Props): React.ReactElement {
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const attempt = useAttemptKey();
  const fieldId = useId();
  const hintId = useId();
  const recipient = item.from?.email ?? "the customer";
  const tooLong = body.trim().length > BODY_MAX_CHARS;

  const send = async (): Promise<void> => {
    const text = body.trim();
    if (!text || tooLong) {
      return;
    }
    const args: ActionArgs = { body: text, caseId: item.caseId, operation: "email_reply" };
    const idempotencyKey = attempt.keyFor(JSON.stringify({ args, key: item.key }));
    setSending(true);
    setNotice(null);
    const result = await postAction({ args, idempotencyKey, ticketKey: item.key });
    setSending(false);
    if (!result.ok) {
      if (!mightHaveArrived(result)) {
        attempt.settle();
      }
      setNotice({ text: result.error, tone: "danger" });
      return;
    }
    attempt.settle();
    const execution = result.data.execution;
    if (execution.status === "succeeded" || execution.status === "duplicate") {
      setBody("");
      setNotice({
        text: execution.redirectedToTestChannel ? `Sent to the test recipient (${testRecipient ?? "EMAIL_TEST_RECIPIENT"}), not the customer.` : `Sent to ${recipient}.`,
        tone: "success",
      });
      onSent();
      return;
    }
    setNotice({ text: execution.error ?? "Not sent.", tone: execution.status === "uncertain" ? "warning" : "danger" });
  };

  return (
    <form
      aria-label="Reply to the customer"
      className="inb-composer"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <label className="inb-composer-label" htmlFor={fieldId}>
        Reply to {recipient}
      </label>
      <p className="inb-muted inb-composer-hint" id={hintId}>
        Plain text, from the support mailbox, signed with your name.
        {!sendEnabled ? " Sending is off (shadow mode) - set EMAIL_SEND_ENABLED=true in Vercel to go live." : ""}
        {sendEnabled && testRecipient ? ` Test mode: replies go to ${testRecipient} instead.` : ""}
      </p>
      <textarea
        aria-describedby={hintId}
        aria-invalid={tooLong}
        className="inb-composer-input"
        id={fieldId}
        onChange={(event) => setBody(event.target.value)}
        placeholder="Write a reply…"
        rows={5}
        value={body}
      />
      <div className="inb-composer-row">
        <span className="inb-muted inb-composer-count" data-over={tooLong}>
          {body.trim().length.toLocaleString("en-US")} / {BODY_MAX_CHARS.toLocaleString("en-US")}
        </span>
        <button aria-busy={sending} className="btn btn-sm btn-primary" disabled={sending || !body.trim() || tooLong || !sendEnabled} type="submit">
          <Icon name="message" size={13} /> {sending ? "Sending…" : "Send reply"}
        </button>
      </div>
      {notice ? (
        <p className="inb-notice" data-tone={notice.tone} role={notice.tone === "success" ? "status" : "alert"}>
          {notice.text}
        </p>
      ) : null}
    </form>
  );
}
