import type { IconName } from "@/components/Icon";
import type { NotificationView } from "@/lib/notifications/types";

/* Browser-safe display helpers shared by the bell, the toasts and the Notifications page. */

export function timeAgo(iso: string, nowMs: number = Date.now()): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    return "";
  }
  const minutes = Math.floor(Math.max(0, nowMs - ms) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function fullTime(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isNaN(ms)
    ? iso
    : `${new Date(ms).toLocaleString("en-US", { day: "numeric", hour: "numeric", minute: "2-digit", month: "short", timeZone: "America/New_York" })} ET`;
}

export function notificationIcon(item: Pick<NotificationView, "kind" | "source">): IconName {
  if (item.source === "slack") return "message";
  if (item.source === "escalation") return "zap";
  if (item.kind === "tracker_sla") return "clock";
  if (item.kind === "jira_assigned" || item.kind === "cp_assigned") return "user";
  if (item.kind === "jira_status" || item.kind === "cp_status") return "refresh";
  return "ticket";
}

export function sourceLabel(item: Pick<NotificationView, "cpKey" | "source">): string {
  if (item.source === "slack") return "Slack";
  if (item.source === "escalation") return "Escalation";
  return item.cpKey ? "Jira · CP" : "Jira";
}
