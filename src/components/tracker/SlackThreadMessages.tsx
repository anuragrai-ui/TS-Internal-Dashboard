"use client";

import { useState } from "react";

import { Icon } from "@/components/Icon";
import { Avatar } from "@/components/tracker/TrackerBits";
import { fetchSlackThread } from "@/components/tracker/trackerApi";
import { relativeTime } from "@/lib/tracker/views";

import type { SlackConversationRef, SlackThreadMessage } from "@/lib/tracker/types";

type LoadState =
  | { messages: SlackThreadMessage[]; status: "loaded"; truncated: boolean }
  | { message: string; status: "error" }
  | { status: "idle" }
  | { status: "loading" }
  | { status: "rate_limited" };

interface SlackThreadMessagesProps {
  conversation: SlackConversationRef;
  now: number;
}

/**
 * "Open in Slack" + "Load messages" for one conversation. Message text is
 * only ever read live and on demand: the Slack app may be allowed about one
 * history read a minute, so nothing loads until someone asks, and a
 * throttled read says so instead of looking broken.
 */
export function SlackThreadMessages({ conversation, now }: SlackThreadMessagesProps): React.ReactElement {
  const [state, setState] = useState<LoadState>({ status: "idle" });
  const [permalink, setPermalink] = useState(conversation.permalink);

  const load = async (): Promise<void> => {
    setState({ status: "loading" });
    const result = await fetchSlackThread(conversation.channel, conversation.rootTs);
    if (!result.ok) {
      setState({ message: result.error, status: "error" });
      return;
    }
    if (result.data.permalink) {
      setPermalink(result.data.permalink);
    }
    if (result.data.rateLimited) {
      setState({ status: "rate_limited" });
      return;
    }
    if (result.data.error) {
      setState({ message: result.data.error, status: "error" });
      return;
    }
    setState({ messages: result.data.messages, status: "loaded", truncated: Boolean(result.data.truncated) });
  };

  return (
    <div className="trk-thread">
      <div className="trk-thread-actions">
        {permalink ? (
          <a className="trk-btn" href={permalink} rel="noreferrer" target="_blank">
            <Icon name="external-link" size={12} />
            Open in Slack
          </a>
        ) : null}
        <button className="trk-btn" disabled={state.status === "loading"} onClick={() => void load()} type="button">
          <Icon name="message" size={12} />
          {state.status === "loading" ? "Loading…" : state.status === "loaded" ? "Reload messages" : "Load messages"}
        </button>
      </div>

      {state.status === "rate_limited" ? (
        <p className="trk-hint" role="status">
          Slack is only letting the dashboard read about one thread a minute right now. Try again in a minute, or open it in Slack.
        </p>
      ) : null}
      {state.status === "error" ? (
        <p className="trk-hint" data-tone="danger" role="status">
          {state.message}
        </p>
      ) : null}
      {state.status === "loaded" ? (
        state.messages.length === 0 ? (
          <p className="trk-hint">No messages could be read from this thread.</p>
        ) : (
          <ol className="trk-thread-messages">
            {state.messages.map((message) => (
              <li className="trk-thread-message" key={message.ts}>
                {message.isBot ? (
                  <span aria-label={message.userName} className="trk-avatar" data-size="sm" role="img">
                    <Icon name="bot" size={11} />
                  </span>
                ) : (
                  <Avatar name={message.userName} size="sm" />
                )}
                <div className="trk-thread-message-body">
                  <div className="trk-tl-meta">
                    <strong>{message.userName}</strong>
                    <span className="trk-tl-time">{relativeTime(message.at, now)}</span>
                  </div>
                  <p className="trk-tl-text">{message.text}</p>
                </div>
              </li>
            ))}
          </ol>
        )
      ) : null}
      {state.status === "loaded" && state.truncated ? (
        <p className="trk-hint">Showing the first {state.messages.length} messages - open the thread in Slack for the rest.</p>
      ) : null}
    </div>
  );
}
