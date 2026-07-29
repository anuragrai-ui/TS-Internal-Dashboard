"""Export historical Jira tickets into the same FormattedIssue shape the
Next.js app uses, so the ML training features are computed from exactly the
same representation the app will pass to the model at inference time.

This mirrors src/lib/jiraClient.ts's JIRA_FIELDS list and formatIssue().
Read-only: only ever calls GET /rest/api/3/search/jql.
"""

import argparse
import base64
import json
import os
import sys
import time
from pathlib import Path

import requests
from dotenv import load_dotenv

REPO_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(REPO_ROOT / ".env")

JIRA_FIELDS = [
    "summary",
    "description",
    "status",
    "priority",
    "assignee",
    "reporter",
    "created",
    "updated",
    "duedate",
    "issuetype",
    "labels",
    "components",
    "comment",
    "attachment",
    "subtasks",
    "project",
    "progress",
    "customfield_10039",  # Affected services
    "customfield_10042",  # Urgency Levels
    "customfield_10043",  # Pending reason
    "customfield_10046",  # Major incident
    "customfield_10048",  # Severity
    "customfield_10054",  # Source
    "customfield_10162",  # Team
    "customfield_10165",  # Pod
    "customfield_10166",  # Support Category
    "customfield_10287",  # Client Support Task Type
    "customfield_10288",  # Client Support Escalation Field
]

PRIORITY_RANK = {
    "Highest": 1,
    "High": 2,
    "Medium": 3,
    "Low": 4,
    "Lowest": 5,
}

RETRYABLE_STATUSES = {429, 500, 502, 503, 504}
MAX_RETRIES = 5


def require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        print(f"Missing required env var {name} (check .env)", file=sys.stderr)
        sys.exit(1)
    return value


def get_option_value(option):
    if isinstance(option, dict):
        return option.get("value")
    return None


def get_option_array_value(items):
    if not isinstance(items, list) or not items:
        return None
    values = [item.get("value") for item in items if isinstance(item, dict) and item.get("value")]
    return ", ".join(values) if values else None


def get_service_array_value(items):
    if not isinstance(items, list) or not items:
        return None
    names = [item.get("name") for item in items if isinstance(item, dict) and item.get("name")]
    return ", ".join(names) if names else None


def get_progress_value(progress):
    if not isinstance(progress, dict):
        return None
    total = progress.get("total")
    if not isinstance(total, (int, float)) or total <= 0:
        return None
    done = progress.get("progress") or 0
    percent = round((done / total) * 100)
    return f"{percent}%"


def format_array_field(items):
    if not isinstance(items, list):
        return []
    return [item.get("name", "") for item in items if isinstance(item, dict) and item.get("name")]


def truncate_text(text, max_length=240):
    if not isinstance(text, str) or len(text) == 0:
        return None
    if len(text) <= max_length:
        return text
    return text[:max_length].strip() + "…"


def format_issue(issue: dict) -> dict:
    """Python port of src/lib/jiraClient.ts formatIssue(), plus status_category
    which the ML feature set needs but the TS app does not (yet)."""
    fields = issue.get("fields", {})
    priority_name = (fields.get("priority") or {}).get("name") or "None"
    status = fields.get("status") or {}

    return {
        "key": issue.get("key"),
        "summary": fields.get("summary"),
        "description": truncate_text(fields.get("description")),
        "status": status.get("name"),
        "status_category": ((status.get("statusCategory") or {}).get("key")),
        "priority": priority_name,
        "priority_sort": PRIORITY_RANK.get(priority_name, 99),
        "assignee": (fields.get("assignee") or {}).get("displayName") or "Unassigned",
        "reporter": (fields.get("reporter") or {}).get("displayName") or "",
        "created": fields.get("created"),
        "updated": fields.get("updated"),
        "duedate": fields.get("duedate"),
        "issue_type": (fields.get("issuetype") or {}).get("name"),
        "labels": fields.get("labels") or [],
        "components": format_array_field(fields.get("components")),
        "comment_count": len(((fields.get("comment") or {}).get("comments")) or []),
        "attachment_count": len(fields.get("attachment") or []),
        "subtask_count": len(fields.get("subtasks") or []),
        "project": (fields.get("project") or {}).get("key"),
        "progress": get_progress_value(fields.get("progress")),
        "affected_services": get_service_array_value(fields.get("customfield_10039")),
        "urgency": get_option_value(fields.get("customfield_10042")),
        "pending_reason": get_option_value(fields.get("customfield_10043")),
        "major_incident": fields.get("customfield_10046"),
        "severity": get_option_value(fields.get("customfield_10048")),
        "source": get_option_value(fields.get("customfield_10054")),
        "team": get_option_array_value(fields.get("customfield_10162")),
        "pod": get_option_value(fields.get("customfield_10165")),
        "support_category": get_option_value(fields.get("customfield_10166")),
        "client_support_task_type": get_option_value(fields.get("customfield_10287")),
        "escalation_field": get_option_value(fields.get("customfield_10288")),
    }


def search_page(base_url: str, auth_header: str, jql: str, page_token: str | None, max_results: int) -> dict:
    params = {
        "jql": jql,
        "maxResults": str(max_results),
        "fields": ",".join(JIRA_FIELDS),
    }
    if page_token:
        params["nextPageToken"] = page_token

    for attempt in range(1, MAX_RETRIES + 1):
        response = requests.get(
            f"{base_url}/rest/api/3/search/jql",
            params=params,
            headers={"Authorization": auth_header, "Accept": "application/json"},
            timeout=30,
        )

        if response.ok:
            return response.json()

        if response.status_code not in RETRYABLE_STATUSES or attempt == MAX_RETRIES:
            response.raise_for_status()

        delay = min(2 ** attempt, 30)
        print(f"  Jira returned {response.status_code}, retrying in {delay}s (attempt {attempt}/{MAX_RETRIES})", file=sys.stderr)
        time.sleep(delay)

    raise RuntimeError("Unreachable")


def main() -> None:
    parser = argparse.ArgumentParser(description="Export Jira TS tickets for ML training")
    parser.add_argument("--max-issues", type=int, default=5000, help="Maximum number of issues to export")
    parser.add_argument("--page-size", type=int, default=100, help="Issues per page (Jira max 100)")
    parser.add_argument(
        "--out",
        type=Path,
        default=REPO_ROOT / "ml" / "data" / "jira_export.jsonl",
        help="Output JSONL path",
    )
    args = parser.parse_args()

    base_url = require_env("JIRA_BASE_URL").rstrip("/")
    email = require_env("JIRA_EMAIL")
    token = require_env("JIRA_API_TOKEN")
    project_key = os.environ.get("JIRA_PROJECT_KEY", "TS")
    auth_header = "Basic " + base64.b64encode(f"{email}:{token}".encode()).decode()
    jql = f"project = {project_key} ORDER BY created DESC"

    args.out.parent.mkdir(parents=True, exist_ok=True)

    exported = 0
    page_token = None
    start = time.time()

    with args.out.open("w", encoding="utf-8") as fh:
        while exported < args.max_issues:
            remaining = args.max_issues - exported
            page_size = min(args.page_size, remaining)
            data = search_page(base_url, auth_header, jql, page_token, page_size)
            issues = data.get("issues", [])

            if not issues:
                break

            for issue in issues:
                formatted = format_issue(issue)
                fh.write(json.dumps(formatted) + "\n")
                exported += 1

            print(f"  exported {exported}/{args.max_issues} ({time.time() - start:.1f}s elapsed)")

            if data.get("isLast"):
                break
            page_token = data.get("nextPageToken")
            if not page_token:
                break

    print(f"Done. Wrote {exported} issues to {args.out}")


if __name__ == "__main__":
    main()
