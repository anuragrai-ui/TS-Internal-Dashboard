"use client";

import { useEffect, useId, useRef, useState } from "react";

import { ErrorNotice, ExecutionNotice } from "@/components/actions/ExecutionNotice";
import { mightHaveArrived, postAction, useAttemptKey } from "@/components/actions/actionsApi";
import { Icon } from "@/components/Icon";
import { BODY_MAX_CHARS } from "@/lib/actions/validate";
import { UI_EVENTS } from "@/lib/workspace/types";

import type { IconName } from "@/components/Icon";
import type { SlackConversationRef } from "@/lib/tracker/types";
import type { ActionArgs, ActionExecution, PrepareReplyDetail } from "@/lib/workspace/types";

export type ComposerTab = "firefighters" | "internal" | "public" | "slack";

const TABS: Array<{ icon: IconName; id: ComposerTab; label: string }> = [
  { icon: "message", id: "public", label: "Reply to customer" },
  { icon: "note", id: "internal", label: "Internal note" },
  { icon: "hash", id: "slack", label: "Slack thread" },
  { icon: "zap", id: "firefighters", label: "#firefighters" },
];

const PLACEHOLDER: Record<ComposerTab, string> = {
  firefighters: "What's wrong, what you've tried, and what you need from engineering…",
  internal: "Add an internal note - only the team sees it…",
  public: "Write a reply to the customer…",
  slack: "Reply in the linked Slack thread…",
};

const SEND_LABEL: Record<ComposerTab, string> = {
  firefighters: "Post to #firefighters",
  internal: "Add note",
  public: "Send reply",
  slack: "Reply in thread",
};

type Outcome = { args: ActionArgs; execution: ActionExecution } | { error: string } | null;

interface TicketComposerProps {
  conversations: SlackConversationRef[];
  /* The conversation tab open in the panel, if any - preselected for "Slack thread". */
  defaultConversationId?: string;
  onSent: () => void;
  /* A request from elsewhere in the panel (the "Escalate" button) to switch tab and focus; `nonce` makes repeats count. */
  openRequest?: { nonce: number; tab: ComposerTab } | null;
  ticketKey: string;
}

/**
 * The composer at the bottom of the detail panel: a reply to the customer,
 * an internal note, a reply in a linked Slack thread, or an escalation in
 * #firefighters. Each tab keeps its own draft, so switching never carries
 * text meant for the team into a customer reply. Sending is always a
 * person's click (or Ctrl/Cmd+Enter); text prepared by AI Assist or a page
 * tool only ever fills the box.
 */
export function TicketComposer({ conversations, defaultConversationId, onSent, openRequest, ticketKey }: TicketComposerProps): React.ReactElement {
  const baseId = useId();
  const [tab, setTab] = useState<ComposerTab>("internal");
  const [drafts, setDrafts] = useState<Record<ComposerTab, string>>({ firefighters: "", internal: "", public: "", slack: "" });
  const [conversationId, setConversationId] = useState(defaultConversationId ?? conversations[0]?.id ?? "");
  const [mentionOnCall, setMentionOnCall] = useState(true);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const rootRef = useRef<HTMLElement>(null);
  const attempt = useAttemptKey();

  const body = drafts[tab];
  const trimmedLength = body.trim().length;
  const tooLong = trimmedLength > BODY_MAX_CHARS;
  const conversation = conversations.find((candidate) => candidate.id === conversationId) ?? null;
  const canSend = !busy && trimmedLength > 0 && !tooLong && (tab !== "slack" || conversation !== null);

  const focusBox = (): void => {
    /* After React has painted the tab switch. */
    requestAnimationFrame(() => {
      rootRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      textareaRef.current?.focus();
    });
  };

  /* The open conversation tab changed, or the list arrived: follow it unless a still-linked one is already picked. */
  useEffect(() => {
    setConversationId((current) =>
      defaultConversationId && conversations.some((candidate) => candidate.id === defaultConversationId)
        ? defaultConversationId
        : conversations.some((candidate) => candidate.id === current)
          ? current
          : (conversations[0]?.id ?? ""),
    );
  }, [conversations, defaultConversationId]);

  /* Only requests made while this composer is on screen count - not one left over from the previous ticket. */
  const handledNonce = useRef(openRequest?.nonce ?? 0);
  useEffect(() => {
    if (openRequest && openRequest.nonce !== handledNonce.current) {
      handledNonce.current = openRequest.nonce;
      setTab(openRequest.tab);
      setOutcome(null);
      focusBox();
    }
  }, [openRequest]);

  /* AI Assist's "use this draft" and the page tools: fill the box and focus it - never send. */
  useEffect(() => {
    const onPrepare = (event: Event): void => {
      const detail = (event as CustomEvent<PrepareReplyDetail>).detail;
      if (!detail || detail.ticketKey !== ticketKey || typeof detail.body !== "string") {
        return;
      }
      const target: ComposerTab = detail.target === "public" ? "public" : detail.target === "slack" ? "slack" : "internal";
      setTab(target);
      setDrafts((current) => ({ ...current, [target]: detail.body.slice(0, BODY_MAX_CHARS) }));
      if (target === "slack" && detail.channel && detail.threadTs) {
        const match = conversations.find((candidate) => candidate.channel === detail.channel && candidate.rootTs === detail.threadTs);
        if (match) {
          setConversationId(match.id);
        }
      }
      setOutcome(null);
      focusBox();
    };
    window.addEventListener(UI_EVENTS.prepareReply, onPrepare);
    return () => window.removeEventListener(UI_EVENTS.prepareReply, onPrepare);
  }, [conversations, ticketKey]);

  const argsFor = (current: ComposerTab, text: string): ActionArgs | null => {
    switch (current) {
      case "public":
        return { body: text, operation: "jira_comment", visibility: "public" };
      case "internal":
        return { body: text, operation: "jira_comment", visibility: "internal" };
      case "slack":
        return conversation ? { body: text, channel: conversation.channel, operation: "slack_thread_reply", threadTs: conversation.rootTs } : null;
      case "firefighters":
        return { body: text, mentionOnCall, operation: "firefighter_escalation" };
    }
  };

  const send = async (): Promise<void> => {
    if (!canSend) {
      return;
    }
    const sentTab = tab;
    const args = argsFor(sentTab, body.trim());
    if (!args) {
      return;
    }
    setBusy(true);
    setOutcome(null);
    const result = await postAction({ args, idempotencyKey: attempt.keyFor(JSON.stringify({ args, ticketKey })), ticketKey });
    setBusy(false);

    if (!result.ok) {
      /* A dropped connection may still have reached the server: keep the key, so sending the same text again can't post twice. */
      if (!mightHaveArrived(result)) {
        attempt.settle();
      }
      setOutcome({ error: result.error });
      return;
    }
    attempt.settle();
    const { execution } = result.data;
    setOutcome({ args, execution });
    if (execution.status === "succeeded" || execution.status === "duplicate") {
      setDrafts((current) => ({ ...current, [sentTab]: "" }));
      onSent();
    }
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void send();
    }
  };

  /* Arrow keys move between tabs (the WAI-ARIA tabs pattern); Tab moves into the panel. */
  const onTabKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const index = TABS.findIndex((candidate) => candidate.id === tab);
    const next =
      event.key === "ArrowRight" ? (index + 1) % TABS.length : event.key === "ArrowLeft" ? (index - 1 + TABS.length) % TABS.length : event.key === "Home" ? 0 : event.key === "End" ? TABS.length - 1 : -1;
    const target = TABS[next];
    if (target) {
      event.preventDefault();
      setTab(target.id);
      setOutcome(null);
      document.getElementById(`${baseId}-tab-${target.id}`)?.focus();
    }
  };

  const countId = `${baseId}-count`;
  const warningId = `${baseId}-warning`;

  return (
    <section aria-label={`Write on ${ticketKey}`} className="act-composer" data-tab={tab} ref={rootRef}>
      <div aria-label="Where to write" className="act-tabs" onKeyDown={onTabKeyDown} role="tablist">
        {TABS.map((candidate) => (
          <button
            aria-controls={`${baseId}-panel`}
            aria-selected={tab === candidate.id}
            className="act-tab"
            data-kind={candidate.id}
            id={`${baseId}-tab-${candidate.id}`}
            key={candidate.id}
            onClick={() => {
              setTab(candidate.id);
              setOutcome(null);
            }}
            role="tab"
            tabIndex={tab === candidate.id ? 0 : -1}
            type="button"
          >
            <Icon name={candidate.icon} size={12} />
            {candidate.label}
          </button>
        ))}
      </div>

      <div aria-labelledby={`${baseId}-tab-${tab}`} className="act-composer-panel" id={`${baseId}-panel`} role="tabpanel">
        {tab === "public" ? (
          <p className="act-warning" id={warningId}>
            <Icon name="alert" size={13} />
            Visible to the customer on the portal.
          </p>
        ) : null}

        {tab === "slack" ? (
          conversations.length === 0 ? (
            <p className="trk-muted-note">No Slack thread is linked to this ticket yet - link one under Properties, then reply here.</p>
          ) : (
            <div className="act-field">
              <label className="act-field-label" htmlFor={`${baseId}-conversation`}>
                Thread
              </label>
              <select className="act-select" id={`${baseId}-conversation`} onChange={(event) => setConversationId(event.target.value)} value={conversationId}>
                {conversations.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    #{candidate.channelName ?? candidate.channel}
                    {candidate.snippet ? ` - ${candidate.snippet.slice(0, 60)}` : ""}
                  </option>
                ))}
              </select>
            </div>
          )
        ) : null}

        {tab === "firefighters" ? (
          <label className="act-check">
            <input checked={mentionOnCall} onChange={(event) => setMentionOnCall(event.target.checked)} type="checkbox" />
            Tag who&apos;s on call
          </label>
        ) : null}

        <label className="act-visually-hidden" htmlFor={`${baseId}-body`}>
          {TABS.find((candidate) => candidate.id === tab)?.label} on {ticketKey}
        </label>
        <textarea
          aria-describedby={`${countId}${tab === "public" ? ` ${warningId}` : ""}`}
          aria-invalid={tooLong}
          className="act-textarea"
          disabled={tab === "slack" && conversations.length === 0}
          id={`${baseId}-body`}
          onChange={(event) => setDrafts((current) => ({ ...current, [tab]: event.target.value }))}
          onKeyDown={onKeyDown}
          placeholder={PLACEHOLDER[tab]}
          ref={textareaRef}
          rows={4}
          value={body}
        />

        <div className="act-composer-foot">
          <span className="act-count" data-over={tooLong} id={countId}>
            {trimmedLength.toLocaleString("en-US")} / {BODY_MAX_CHARS.toLocaleString("en-US")}
            <span className="act-kbd-hint"> · Ctrl/⌘ + Enter to send</span>
          </span>
          <button className="act-send" data-kind={tab} disabled={!canSend} onClick={() => void send()} type="button">
            {busy ? "Sending…" : SEND_LABEL[tab]}
          </button>
        </div>

        {outcome ? "error" in outcome ? <ErrorNotice message={outcome.error} /> : <ExecutionNotice execution={outcome.execution} /> : null}
      </div>
    </section>
  );
}
