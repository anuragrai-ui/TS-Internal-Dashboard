import type { FormattedIssue } from "@/lib/jiraClient";
import type { TicketEscalationAnalysis } from "@/lib/openrouterEscalation";

export interface SlackMentionSummary {
  channel_id: string;
  message_ts: string;
  text_snippet?: string;
}

export interface IssueRow {
  ageDays: number | null;
  analysis?: TicketEscalationAnalysis;
  cooldownActive: boolean;
  scheduledFollowup?: {
    draft: string;
    generatedAt: string;
    state: string;
  };
  issue: FormattedIssue;
  slackMention?: SlackMentionSummary;
}

interface ToIssueRowExtras {
  analysis?: TicketEscalationAnalysis;
  cooldownActive?: boolean;
  scheduledFollowup?: IssueRow["scheduledFollowup"];
  slackMention?: SlackMentionSummary;
}

function daysSince(iso: string | undefined): number | null {
  if (!iso) {
    return null;
  }

  const then = new Date(iso).getTime();

  if (Number.isNaN(then)) {
    return null;
  }

  return Math.max(0, (Date.now() - then) / (1000 * 60 * 60 * 24));
}

export function toIssueRow(issue: FormattedIssue, extras: ToIssueRowExtras = {}): IssueRow {
  return {
    ageDays: daysSince(issue.created),
    analysis: extras.analysis,
    cooldownActive: extras.cooldownActive ?? false,
    issue,
    scheduledFollowup: extras.scheduledFollowup,
    slackMention: extras.slackMention,
  };
}

export function formatAge(ageDays: number | null): string {
  if (ageDays === null) {
    return "—";
  }

  if (ageDays < 1) {
    return `${Math.max(1, Math.round(ageDays * 24))}h`;
  }

  const days = Math.floor(ageDays);
  const hours = Math.round((ageDays - days) * 24);

  return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
}

export function formatShortDate(iso: string | undefined): string {
  if (!iso) {
    return "—";
  }

  const date = new Date(iso);

  if (Number.isNaN(date.getTime())) {
    return iso;
  }

  return date.toLocaleDateString("en-US", { day: "2-digit", month: "short" });
}

export function formatRelativeTime(iso: string | undefined): string {
  if (!iso) {
    return "—";
  }

  const then = new Date(iso).getTime();

  if (Number.isNaN(then)) {
    return iso;
  }

  const diffMinutes = Math.round((Date.now() - then) / 60000);

  if (diffMinutes < 1) {
    return "just now";
  }
  if (diffMinutes < 60) {
    return `${diffMinutes}m ago`;
  }

  const diffHours = Math.round(diffMinutes / 60);

  if (diffHours < 24) {
    return `${diffHours}h ago`;
  }

  const diffDays = Math.round(diffHours / 24);

  return `${diffDays}d ago`;
}

export interface BreakdownEntry {
  count: number;
  label: string;
}

export function computeBreakdown(
  rows: IssueRow[],
  getValue: (row: IssueRow) => string | undefined,
): BreakdownEntry[] {
  const counts = new Map<string, number>();

  rows.forEach((row) => {
    const value = getValue(row) || "Unspecified";
    counts.set(value, (counts.get(value) ?? 0) + 1);
  });

  return Array.from(counts.entries())
    .map(([label, count]) => ({ count, label }))
    .sort((a, b) => b.count - a.count);
}

export const PRIORITY_ORDER: Record<string, number> = {
  High: 2,
  Highest: 1,
  Low: 4,
  Lowest: 5,
  Medium: 3,
};

export function distinctValues(rows: IssueRow[], getValue: (row: IssueRow) => string | undefined): string[] {
  const values = new Set<string>();
  rows.forEach((row) => {
    const value = getValue(row);
    if (value) {
      values.add(value);
    }
  });
  return Array.from(values).sort((a, b) => a.localeCompare(b));
}
