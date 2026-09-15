import { searchConfluence } from "@/lib/confluenceClient";
import { getIssueByKey, searchIssuesSummary } from "@/lib/jiraClient";
import type { ToolDefinition } from "@/lib/llmClient";

function stringArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  return typeof value === "string" ? value.trim() : "";
}

function formatIssueSummaries(issues: Awaited<ReturnType<typeof searchIssuesSummary>>): string {
  if (issues.length === 0) {
    return "No matching issues found.";
  }

  return issues
    .map(
      (issue) =>
        `${issue.key} [${issue.status ?? "?"}, ${issue.priority}]: ${issue.summary ?? ""} (updated ${issue.updated ?? "?"})`,
    )
    .join("\n");
}

/**
 * Read-only tools for follow-up drafting (see src/lib/followupDraft.ts).
 * Deliberately no write tool here - posting comments or transitioning
 * tickets stays human-confirmed via the existing send routes, not something
 * the model can trigger mid-draft.
 */
export function getFollowUpTools(): ToolDefinition[] {
  return [
    {
      description:
        'Search Jira issues with a JQL query. Use this to find related or similar past tickets - e.g. same reporter, same component, or similar summary text. Returns up to 5 lightweight summaries (key, status, priority, summary, last updated), not full detail. Example jql: \'project = TS AND summary ~ "PSV" ORDER BY updated DESC\'.',
      handler: async (args) => {
        const jql = stringArg(args, "jql");
        if (!jql) {
          return "Error: jql argument was empty.";
        }
        const issues = await searchIssuesSummary(jql, 5);
        return formatIssueSummaries(issues);
      },
      name: "search_jira_issues",
      parameters: {
        properties: {
          jql: {
            description: "A valid Jira JQL query.",
            type: "string",
          },
        },
        required: ["jql"],
        type: "object",
      },
    },
    {
      description:
        "Get full detail on one specific Jira ticket by its key (e.g. TS-12345 or CP-6789). Use this to inspect a linked ticket, or a ticket found via search_jira_issues, more closely.",
      handler: async (args) => {
        const key = stringArg(args, "key");
        if (!key) {
          return "Error: key argument was empty.";
        }
        const issue = await getIssueByKey(key);
        if (!issue) {
          return `No ticket found with key ${key}.`;
        }
        return [
          `${issue.key} [${issue.status ?? "?"}]: ${issue.summary ?? ""}`,
          `Priority: ${issue.priority}. Assignee: ${issue.assignee || "Unassigned"}. Reporter: ${issue.reporter}.`,
          `Pending reason: ${issue.pending_reason ?? "none"}.`,
          `Description: ${(issue.description ?? "").slice(0, 500)}`,
        ].join("\n");
      },
      name: "get_jira_issue",
      parameters: {
        properties: {
          key: {
            description: 'Ticket key, e.g. "TS-12345".',
            type: "string",
          },
        },
        required: ["key"],
        type: "object",
      },
    },
    {
      description:
        "Full-text search Confluence pages (runbooks, known-issue docs, process pages) on the same Atlassian site. Use this to check for a documented process or known issue relevant to this ticket.",
      handler: async (args) => {
        const query = stringArg(args, "query");
        if (!query) {
          return "Error: query argument was empty.";
        }
        const pages = await searchConfluence(query, 5);
        if (pages.length === 0) {
          return "No matching Confluence pages found.";
        }
        return pages.map((page) => `"${page.title}" (${page.url}): ${page.excerpt}`).join("\n");
      },
      name: "search_confluence",
      parameters: {
        properties: {
          query: {
            description: 'Plain-text search query, e.g. "credentialing PSV process".',
            type: "string",
          },
        },
        required: ["query"],
        type: "object",
      },
    },
  ];
}
