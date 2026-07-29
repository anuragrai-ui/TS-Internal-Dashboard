"""Shared feature contract for the escalation-risk anomaly model.

This module is the single source of truth for how a FormattedIssue (+ recent
comments) becomes the numeric feature vector fed to the IsolationForest
model. src/lib/mlEscalationModel.ts re-implements this same contract in
TypeScript at inference time, reading the keyword lists/severity map this
module writes into ml/model/feature_manifest.json so the two never drift
out of a hardcoded second copy.

Text features (text_immediate_hits / text_watch_hits) are computed from
summary + description only, never from comment bodies - the bulk Jira
export used for training has no comment text (fetching per-ticket comments
for thousands of tickets isn't practical), so keeping inference features
identical to training features means the app must not use comment text
here either, to avoid train/inference skew.
"""

from datetime import datetime, timezone

FEATURE_ORDER = [
    "priority_rank",
    "severity_rank",
    "has_major_incident",
    "has_escalation_field",
    "is_done",
    "days_since_created",
    "days_since_updated",
    "comment_count",
    "attachment_count",
    "subtask_count",
    "labels_count",
    "text_immediate_hits",
    "text_watch_hits",
    "team_present",
    "pod_present",
    "support_category_present",
    "source_present",
    "urgency_present",
    "affected_services_count",
]

IMMEDIATE_KEYWORDS = [
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
]

WATCH_KEYWORDS = [
    "follow up",
    "following up",
    "eta",
    "waiting",
    "reminder",
    "pending",
    "need update",
    "status update",
]

SEVERITY_RANK_KEYWORDS = [
    (1, ["critical", "blocker", "sev1", "sev 1"]),
    (2, ["major", "high", "sev2", "sev 2"]),
    (3, ["moderate", "medium", "sev3", "sev 3"]),
    (4, ["minor", "low", "sev4", "sev 4"]),
    (5, ["trivial", "sev5", "sev 5"]),
]

NEGATIVE_TOKENS = {"no", "none", "n/a", "na", "false"}


def _severity_rank(severity: str | None) -> int:
    if not severity:
        return 0
    text = severity.lower()
    for rank, keywords in SEVERITY_RANK_KEYWORDS:
        if any(keyword in text for keyword in keywords):
            return rank
    return 3


def _has_value(value: str | None) -> int:
    if not value:
        return 0
    return 0 if value.strip().lower() in NEGATIVE_TOKENS else 1


def _count_hits(text: str, keywords: list[str]) -> int:
    return sum(1 for keyword in keywords if keyword in text)


def _days_between(iso_a: str | None, now: datetime) -> float:
    if not iso_a:
        return 0.0
    try:
        parsed = datetime.fromisoformat(iso_a.replace("Z", "+00:00"))
    except ValueError:
        return 0.0
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    delta = now - parsed
    return max(0.0, delta.total_seconds() / 86400)


def compute_features(issue: dict, now: datetime | None = None) -> list[float]:
    """issue is a FormattedIssue-shaped dict (see export_jira_data.format_issue
    / src/lib/jiraClient.ts formatIssue)."""
    now = now or datetime.now(timezone.utc)

    signal_text = " ".join(
        filter(None, [issue.get("summary"), issue.get("description")])
    ).lower()

    affected_services = issue.get("affected_services")
    affected_services_count = (
        len([part for part in affected_services.split(", ") if part]) if affected_services else 0
    )

    values = {
        "priority_rank": issue.get("priority_sort", 99),
        "severity_rank": _severity_rank(issue.get("severity")),
        "has_major_incident": _has_value(issue.get("major_incident")),
        "has_escalation_field": _has_value(issue.get("escalation_field")),
        "is_done": 1 if issue.get("status_category") == "done" else 0,
        "days_since_created": _days_between(issue.get("created"), now),
        "days_since_updated": _days_between(issue.get("updated"), now),
        "comment_count": issue.get("comment_count", 0),
        "attachment_count": issue.get("attachment_count", 0),
        "subtask_count": issue.get("subtask_count", 0),
        "labels_count": len(issue.get("labels") or []),
        "text_immediate_hits": _count_hits(signal_text, IMMEDIATE_KEYWORDS),
        "text_watch_hits": _count_hits(signal_text, WATCH_KEYWORDS),
        "team_present": _has_value(issue.get("team")),
        "pod_present": _has_value(issue.get("pod")),
        "support_category_present": _has_value(issue.get("support_category")),
        "source_present": _has_value(issue.get("source")),
        "urgency_present": _has_value(issue.get("urgency")),
        "affected_services_count": affected_services_count,
    }

    return [float(values[name]) for name in FEATURE_ORDER]
