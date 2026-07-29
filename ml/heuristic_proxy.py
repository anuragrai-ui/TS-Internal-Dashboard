"""Python port of src/lib/escalationHeuristics.ts getLocalHeuristicAnalysis().

Used ONLY as an evaluation proxy signal for the unsupervised anomaly model
(there is no real "did this ticket actually escalate" label anywhere in this
project) - never fed into IsolationForest as a training feature, since that
would just teach the model to reproduce the rule-based heuristic rather than
add anything beyond it.
"""

IMMEDIATE_SIGNALS = [
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

WATCH_SIGNALS = [
    "follow up",
    "following up",
    "eta",
    "waiting",
    "reminder",
    "pending",
    "need update",
    "status update",
]


def heuristic_risk_level(issue: dict) -> tuple[str, int]:
    signal_text = " ".join(
        filter(
            None,
            [issue.get("summary"), issue.get("status"), issue.get("priority"), issue.get("reporter")],
        )
    ).lower()

    immediate_hits = sum(1 for s in IMMEDIATE_SIGNALS if s in signal_text)
    watch_hits = sum(1 for s in WATCH_SIGNALS if s in signal_text)
    priority = issue.get("priority")
    priority_boost = 35 if priority == "Highest" else 25 if priority == "High" else 0
    score = min(100, priority_boost + immediate_hits * 20 + watch_hits * 10)

    if score >= 65:
        return "immediate", score
    if score >= 25:
        return "watch", score
    return "normal", score
