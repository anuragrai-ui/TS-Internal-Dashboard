import type { TicketEscalationAnalysis } from "@/lib/openrouterEscalation";
import type { FormattedIssue, TicketCommentContext } from "@/lib/jiraClient";

export function getLocalHeuristicAnalysis(
  issue: FormattedIssue,
  comments: TicketCommentContext[] = [],
): TicketEscalationAnalysis {
  const signalText = [
    issue.summary,
    issue.status,
    issue.priority,
    issue.reporter,
    issue.latest_comment_created,
    ...comments.map((comment) => comment.body),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const immediateSignals = [
    "escalat",
    "urgent",
    "blocker",
    "blocked",
    "production",
    "prod",
    "client is waiting",
    "customer is waiting",
    "sla",
    "breach",
    "asap",
    "critical",
    "unhappy",
    "frustrated",
    "delay",
  ];
  const watchSignals = [
    "follow up",
    "following up",
    "eta",
    "waiting",
    "reminder",
    "pending",
    "need update",
    "status update",
  ];
  const immediateHits = immediateSignals.filter((signal) =>
    signalText.includes(signal),
  ).length;
  const watchHits = watchSignals.filter((signal) => signalText.includes(signal)).length;
  const priorityBoost =
    issue.priority === "Highest" ? 35 : issue.priority === "High" ? 25 : 0;
  const score = Math.min(100, priorityBoost + immediateHits * 20 + watchHits * 10);

  if (score >= 65) {
    return {
      key: issue.key,
      next_action: "Prioritize response and confirm ownership, ETA, and next step.",
      reason: "Local signals suggest escalation risk from priority, status, or comment wording.",
      risk_level: "immediate",
      risk_score: score,
    };
  }

  if (score >= 25) {
    return {
      key: issue.key,
      next_action: "Review today and send an update if the ticket is waiting on you.",
      reason: "Local signals suggest the ticket should stay on watch.",
      risk_level: "watch",
      risk_score: score,
    };
  }

  return {
    key: issue.key,
    next_action: "Handle through the normal queue unless new client activity appears.",
    reason: "Local signals did not indicate immediate escalation risk.",
    risk_level: "normal",
    risk_score: score,
  };
}
