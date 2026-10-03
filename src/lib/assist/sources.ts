import { searchConfluence } from "@/lib/confluenceClient";
import { POD_FIELD } from "@/lib/escalation/policy";
import { createReadOnlyJiraClient, readOnlyJiraConfigFromEnv } from "@/lib/escalation/readOnlyJira";
import { adfToText } from "@/lib/notifications/jiraChanges";
import { loadConversationMessages } from "@/lib/tracker/slackIndex";

import type { AssistToolDeps, CpRead, SimilarTicket, TicketTransition } from "@/lib/assist/tools";
import type { ReadOnlyJiraClient } from "@/lib/escalation/readOnlyJira";
import type { JiraCommentRecord } from "@/lib/notifications/jiraChanges";
import type { OnCallShift } from "@/lib/workspace/types";

/**
 * The live reads behind Assist's tools. Jira goes through the read-only
 * client (src/lib/escalation/readOnlyJira.ts), which physically refuses
 * anything but GETs and the two search POSTs - the agent's lookups can't
 * become writes, whatever the model asks for. Slack goes through the
 * tracker's conversation reader (one-minute cache, throttle-aware), Confluence
 * through the existing search client, on-call through the schedule module.
 */

const CP_FIELDS = ["summary", "status", "resolution", "assignee", "priority", POD_FIELD];
const SIMILAR_FIELDS = ["summary", "status", "resolution", "priority", "updated"];
const CP_COMMENTS = 8;
const COMMENT_CHARS = 1_000;

interface JiraNamed {
  id?: string;
  name?: string;
}

interface CpIssue {
  fields?: {
    assignee?: { displayName?: string } | null;
    priority?: JiraNamed | null;
    resolution?: JiraNamed | null;
    status?: JiraNamed | null;
    summary?: string;
    [field: string]: unknown;
  };
  key: string;
}

interface SimilarIssue {
  fields?: {
    priority?: JiraNamed | null;
    resolution?: JiraNamed | null;
    status?: JiraNamed | null;
    summary?: string;
    updated?: string;
  };
  key: string;
}

interface TransitionsPage {
  transitions?: Array<{ id?: string; name?: string; to?: { name?: string } }>;
}

interface JiraHandle {
  baseUrl: string;
  client: ReadOnlyJiraClient;
}

/*
 * One read-only client per investigation, created on first use: the client
 * keeps a log of every request it sends ("one client per run"), so a
 * module-wide one would grow for the life of a warm instance. Throws when Jira
 * isn't configured - the tools turn that into an error line.
 */
function lazyJira(): () => JiraHandle {
  let handle: JiraHandle | null = null;
  return () => {
    if (!handle) {
      const config = readOnlyJiraConfigFromEnv();
      handle = { baseUrl: config.baseUrl.trim().replace(/\/+$/, ""), client: createReadOnlyJiraClient(config) };
    }
    return handle;
  };
}

export function jiraBaseUrlFromEnv(): string {
  return (process.env.JIRA_BASE_URL ?? "").trim().replace(/\/+$/, "");
}

/* The Pod field is a single-select: {"value": "Pod A", "id": "10021"}. */
function optionValue(field: unknown): string | null {
  if (field && typeof field === "object" && "value" in field) {
    const value = (field as { value?: unknown }).value;
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }
  return null;
}

async function readCp(jira: () => JiraHandle, cpKey: string): Promise<CpRead | null> {
  const { baseUrl, client } = jira();
  const [issue, page] = await Promise.all([
    client.get<CpIssue>(`/rest/api/3/issue/${cpKey}`, { fields: CP_FIELDS.join(",") }),
    client.get<{ comments?: JiraCommentRecord[] }>(`/rest/api/3/issue/${cpKey}/comment`, { maxResults: CP_COMMENTS, orderBy: "-created" }),
  ]);
  if (!issue?.key) {
    return null;
  }
  const fields = issue.fields ?? {};
  return {
    assigneeName: fields.assignee?.displayName ?? null,
    comments: (page?.comments ?? []).map((comment) => ({
      at: comment.created ?? null,
      author: comment.author?.displayName ?? "Someone",
      body: adfToText(comment.body, COMMENT_CHARS),
      ...(comment.id ? { id: comment.id } : {}),
    })),
    key: issue.key,
    podName: optionValue(fields[POD_FIELD]),
    priorityName: fields.priority?.name ?? null,
    resolutionName: fields.resolution?.name ?? null,
    statusName: fields.status?.name ?? "unknown",
    summary: typeof fields.summary === "string" ? fields.summary : null,
    url: `${baseUrl}/browse/${issue.key}`,
  };
}

async function searchTickets(jira: () => JiraHandle, jql: string, limit: number): Promise<SimilarTicket[]> {
  const { baseUrl, client } = jira();
  const issues = await client.searchJql<SimilarIssue>(jql, SIMILAR_FIELDS, { maxTotal: limit });
  return issues.map((issue) => ({
    key: issue.key,
    priorityName: issue.fields?.priority?.name ?? null,
    resolutionName: issue.fields?.resolution?.name ?? null,
    statusName: issue.fields?.status?.name ?? "unknown",
    summary: issue.fields?.summary ?? "",
    updated: issue.fields?.updated ?? null,
    url: `${baseUrl}/browse/${issue.key}`,
  }));
}

/* The transitions Jira offers for a ticket right now (read as the shared account). null when they can't be read. */
async function listTransitions(jira: () => JiraHandle, key: string): Promise<TicketTransition[] | null> {
  try {
    const page = await jira().client.get<TransitionsPage>(`/rest/api/3/issue/${key}/transitions`);
    return (page?.transitions ?? []).flatMap((transition) =>
      transition.id && transition.name ? [{ id: transition.id, name: transition.name, toStatus: transition.to?.name ?? transition.name }] : [],
    );
  } catch (error) {
    console.warn(`Assist: couldn't read the transitions of ${key}.`, error instanceof Error ? error.message : error);
    return null;
  }
}

/*
 * Loaded on first use: the schedule module downloads and parses the team's
 * iCal calendar, and if it can't even load (a bad deploy, a missing env var
 * at import), only get_oncall should fail - as an error line the agent can
 * work around - not every investigation.
 */
async function currentOnCallShifts(): Promise<OnCallShift[]> {
  const { getCurrentOnCallShifts } = await import("@/lib/oncall/schedule");
  return getCurrentOnCallShifts();
}

export interface LiveSources {
  /* Never throws; null when the transitions can't be read. */
  listTransitions: (key: string) => Promise<TicketTransition[] | null>;
  tools: AssistToolDeps;
}

/** The live reads for ONE investigation (they share one read-only Jira client). */
export function liveSources(): LiveSources {
  const jira = lazyJira();
  return {
    listTransitions: (key) => listTransitions(jira, key),
    tools: {
      getOnCallShifts: currentOnCallShifts,
      loadConversation: loadConversationMessages,
      readCp: (cpKey) => readCp(jira, cpKey),
      searchConfluence,
      searchTickets: (jql, limit) => searchTickets(jira, jql, limit),
    },
  };
}
