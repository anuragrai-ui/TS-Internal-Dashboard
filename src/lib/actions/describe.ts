import type { ActionArgs, ActionExecution, ExecutionStatus, ProposalSource } from "@/lib/workspace/types";

/**
 * How an action reads on screen - the review card, the action log and the
 * inline result. Pure and client-safe; the server never builds UI strings.
 */

export type TextActionArgs = Extract<ActionArgs, { body: string }>;

/** The operations a person edits as text before approving (the others are a choice, not prose). */
export function isTextAction(args: ActionArgs): args is TextActionArgs {
  return args.operation === "jira_comment" || args.operation === "slack_thread_reply" || args.operation === "firefighter_escalation" || args.operation === "email_reply";
}

/** One short line: "Reply to the customer", "Move to In Progress", "Assign to Jane Doe". */
export function describeAction(args: ActionArgs, channelName?: string): string {
  switch (args.operation) {
    case "jira_comment":
      return args.visibility === "public" ? "Reply to the customer" : "Add an internal note";
    case "jira_transition":
      return `Change status: ${args.transitionName}`;
    case "jira_assign":
      return args.accountId === null ? "Unassign" : `Assign to ${args.displayName ?? `Jira account ${args.accountId}`}`;
    case "jira_priority":
      return `Set priority to ${args.priority}`;
    case "jira_link_cp":
      return `Link ${args.cpKey}`;
    case "slack_thread_reply":
      return `Reply in the ${channelName ? `#${channelName}` : "Slack"} thread`;
    case "firefighter_escalation":
      return args.mentionOnCall ? "Escalate in #firefighters, tagging on-call" : "Escalate in #firefighters";
    case "email_reply":
      return "Email the customer";
  }
}

export function proposalSourceLabel(source: ProposalSource): string {
  return source.type === "assist" ? "AI Assist" : "Browser agent";
}

export const EXECUTION_STATUS_LABEL: Record<ExecutionStatus, string> = {
  conflict: "Changed since loaded",
  duplicate: "Already done",
  failed: "Failed",
  succeeded: "Done",
  uncertain: "Unconfirmed",
};

/* Which design-token tone each status reads in. */
export const EXECUTION_STATUS_TONE: Record<ExecutionStatus, "danger" | "info" | "success" | "warning"> = {
  conflict: "warning",
  duplicate: "info",
  failed: "danger",
  succeeded: "success",
  uncertain: "warning",
};

/** Where the result can be seen: Jira for Jira writes, Gmail for email replies, Slack for posts. */
export function externalLinkLabel(execution: Pick<ActionExecution, "args">): string {
  if (execution.args.operation === "email_reply") {
    return "Open in Gmail";
  }
  return execution.args.operation.startsWith("jira_") ? "Open in Jira" : "Open in Slack";
}
