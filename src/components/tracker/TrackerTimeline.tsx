"use client";

import { useState } from "react";

import { Icon } from "@/components/Icon";
import { SlackThreadMessages } from "@/components/tracker/SlackThreadMessages";
import { Avatar } from "@/components/tracker/TrackerBits";
import { relativeTime } from "@/lib/tracker/views";

import type { IconName } from "@/components/Icon";
import type { SlackConversationRef, TimelineItem } from "@/lib/tracker/types";

/* Long bodies are clipped to this many characters until "Show more". */
const BODY_PREVIEW_CHARS = 420;

const SOURCE_ICON: Record<TimelineItem["source"], IconName> = {
  bot: "bot",
  cp: "wrench",
  jira: "ticket",
  slack: "hash",
  system: "clock",
};

function TimelineBody({ body }: { body: string }): React.ReactElement {
  const [expanded, setExpanded] = useState(false);
  const long = body.length > BODY_PREVIEW_CHARS;
  return (
    <>
      <p className="trk-tl-text">{long && !expanded ? `${body.slice(0, BODY_PREVIEW_CHARS).trimEnd()}…` : body}</p>
      {long ? (
        <button className="trk-link-btn" onClick={() => setExpanded((previous) => !previous)} type="button">
          {expanded ? "Show less" : "Show more"}
        </button>
      ) : null}
    </>
  );
}

function ItemAvatar({ item }: { item: TimelineItem }): React.ReactElement {
  if (item.actor && item.source !== "bot") {
    return <Avatar name={item.actor} />;
  }
  return (
    <span aria-hidden="true" className="trk-avatar trk-avatar-source" data-source={item.source}>
      <Icon name={SOURCE_ICON[item.source]} size={12} />
    </span>
  );
}

interface TimelineRowProps {
  /* Set only where the row should offer its own "Load messages" (the All activity tab). */
  conversation: SlackConversationRef | undefined;
  item: TimelineItem;
  now: number;
}

function TimelineRow({ conversation, item, now }: TimelineRowProps): React.ReactElement {
  if (item.kind === "system") {
    return (
      <li className="trk-tl-system">
        {item.title} · <time dateTime={item.at}>{relativeTime(item.at, now)}</time>
      </li>
    );
  }
  return (
    <li className="trk-tl-item" data-internal={item.internal}>
      <ItemAvatar item={item} />
      <div className="trk-tl-main">
        <div className="trk-tl-meta">
          {item.internal ? (
            <span aria-label="Internal" className="trk-tl-note" role="img">
              <Icon name="note" size={12} />
            </span>
          ) : null}
          {item.actor ? <strong>{item.actor}</strong> : null}
          <span className="trk-tl-time">
            <time dateTime={item.at} title={new Date(item.at).toLocaleString()}>
              {relativeTime(item.at, now)}
            </time>
          </span>
          <span className="trk-tl-source">{item.sourceLabel}</span>
        </div>
        <div className="trk-tl-title">
          {item.url ? (
            <a href={item.url} rel="noreferrer" target="_blank">
              {item.title}
            </a>
          ) : (
            item.title
          )}
        </div>
        {item.body ? <TimelineBody body={item.body} /> : null}
        {item.kind === "slack_conversation" && conversation ? <SlackThreadMessages conversation={conversation} now={now} /> : null}
      </div>
    </li>
  );
}

interface TrackerTimelineProps {
  /* Conversations whose rows get a "Load messages" button; empty inside a conversation's own tab, which has one at the top. */
  conversations: SlackConversationRef[];
  items: TimelineItem[];
  now: number;
}

/* Newest first: the panel is for "what happened lately", the full history is one scroll away. */
export function TrackerTimeline({ conversations, items, now }: TrackerTimelineProps): React.ReactElement {
  const sorted = [...items].sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));
  const byId = new Map(conversations.map((conversation) => [conversation.id, conversation]));
  if (sorted.length === 0) {
    return <p className="trk-empty-inline">No activity to show here yet.</p>;
  }
  return (
    <ol aria-label="Activity" className="trk-timeline">
      {sorted.map((item) => (
        <TimelineRow conversation={item.thread ? byId.get(item.thread) : undefined} item={item} key={item.id} now={now} />
      ))}
    </ol>
  );
}
