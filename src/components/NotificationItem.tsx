"use client";

import { Icon } from "@/components/Icon";
import { fullTime, notificationIcon, sourceLabel, timeAgo } from "@/lib/notifications/format";

import type { NotificationView } from "@/lib/notifications/types";

interface NotificationItemProps {
  item: NotificationView;
  /* Called when the item is opened (link followed or row clicked) - marks it read. */
  onOpen: (item: NotificationView) => void;
}

/* One row in the bell's panel and on the Notifications page. Jira and Slack links open in a new tab. */
export function NotificationItem({ item, onOpen }: NotificationItemProps): React.ReactElement {
  const content = (
    <>
      <span className="notif-item-icon" data-source={item.source}>
        <Icon name={notificationIcon(item)} size={14} />
      </span>
      <span className="notif-item-body">
        <span className="notif-item-title">{item.title}</span>
        {item.detail ? <span className="notif-item-detail">{item.detail}</span> : null}
        <span className="notif-item-meta">
          {sourceLabel(item)}
          {item.actor && !item.title.startsWith(item.actor) ? ` · ${item.actor}` : ""} ·{" "}
          <time dateTime={item.at} title={fullTime(item.at)}>
            {timeAgo(item.at)}
          </time>
        </span>
      </span>
      {item.read ? null : <span aria-label="Unread" className="notif-unread-dot" role="img" />}
    </>
  );

  if (item.url) {
    return (
      <a
        className="notif-item"
        data-important={item.important}
        data-unread={!item.read}
        href={item.url}
        onClick={() => onOpen(item)}
        rel="noreferrer"
        target="_blank"
      >
        {content}
      </a>
    );
  }

  return (
    <button className="notif-item" data-important={item.important} data-unread={!item.read} onClick={() => onOpen(item)} type="button">
      {content}
    </button>
  );
}
