import { classify } from "@/lib/escalation/classify";
import {
  MAJOR_INCIDENT_FIELD,
  POD_FIELD,
  SUPPORT_TICKET_ISSUE_TYPE_ID,
  TIME_TO_RESOLUTION_FIELD,
  WAITING_FOR_PRODUCT_STATUS_ID,
} from "@/lib/escalation/policy";
import { parseJsmSla } from "@/lib/escalation/slaParser";

import type { ReadOnlyJiraClient } from "@/lib/escalation/readOnlyJira";
import type { ClassificationResult, CpSnapshot, Priority, RoutingRow, StatusCategory, TsLink, TsSnapshot } from "@/lib/escalation/types";

/**
 * Jira reads shared by the dry run (scripts/escalation-dry-run.ts) and the
 * shadow runner (src/lib/escalation/runner.ts). Everything goes through the
 * read-only client, and only keys, statuses, links, pods, priorities, SLAs
 * and assignees are requested - never summaries, descriptions or reporters.
 */

interface JiraNamed {
  id?: string;
  key?: string;
  name?: string;
  value?: string;
}

interface JiraStatus extends JiraNamed {
  statusCategory?: { key?: string };
}

interface JiraLinkedIssue {
  key?: string;
}

export interface JiraIssue {
  fields: Record<string, unknown> & {
    assignee?: { accountId?: string; displayName?: string } | null;
    issuelinks?: Array<{
      inwardIssue?: JiraLinkedIssue;
      outwardIssue?: JiraLinkedIssue;
      type?: JiraNamed;
    }>;
    issuetype?: JiraNamed | null;
    priority?: JiraNamed | null;
    resolution?: JiraNamed | null;
    status?: JiraStatus | null;
  };
  key: string;
}

export interface ChangelogPage {
  isLast?: boolean;
  maxResults?: number;
  startAt?: number;
  total?: number;
  values?: Array<{ created?: string; items?: Array<{ fieldId?: string; field?: string; from?: string; to?: string }> }>;
}

export const TS_FIELDS = ["status", "issuetype", "priority", "assignee", "issuelinks", POD_FIELD, TIME_TO_RESOLUTION_FIELD, MAJOR_INCIDENT_FIELD];
export const CP_FIELDS = ["status", "issuetype", "resolution", "assignee", "priority", POD_FIELD];

const KEY_CHUNK = 50;
const CHANGELOG_CONCURRENCY = 5;

export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        out[index] = await fn(items[index] as T);
      }
    }),
  );
  return out;
}

export function statusCategory(status: JiraStatus | null | undefined): StatusCategory {
  const key = status?.statusCategory?.key;
  return key === "done" ? "done" : key === "indeterminate" ? "indeterminate" : "new";
}

const PRIORITIES = new Set<Priority>(["Critical", "High", "Medium", "Low"]);
function toPriority(name: string | undefined): Priority | null {
  return name && PRIORITIES.has(name as Priority) ? (name as Priority) : null;
}

function optionId(raw: unknown): string | null {
  return raw && typeof raw === "object" && typeof (raw as JiraNamed).id === "string" ? ((raw as JiraNamed).id ?? null) : null;
}

function optionName(raw: unknown): string | null {
  return raw && typeof raw === "object" && typeof (raw as JiraNamed).value === "string" ? ((raw as JiraNamed).value ?? null) : null;
}

export function toTsSnapshot(issue: JiraIssue, baseUrl: string, enteredWfpAt: string | null): TsSnapshot {
  const links: TsLink[] = [];
  for (const link of issue.fields.issuelinks ?? []) {
    const other = link.inwardIssue ?? link.outwardIssue;
    if (other?.key?.startsWith("CP-")) {
      links.push({
        cpKey: other.key,
        direction: link.inwardIssue ? "inward" : "outward",
        linkTypeId: link.type?.id ?? "",
        linkTypeName: link.type?.name ?? "",
      });
    }
  }

  return {
    assigneeAccountId: issue.fields.assignee?.accountId ?? null,
    assigneeName: issue.fields.assignee?.displayName ?? null,
    enteredWfpAt,
    issueTypeId: issue.fields.issuetype?.id ?? "",
    key: issue.key,
    links,
    majorIncident: Boolean(issue.fields[MAJOR_INCIDENT_FIELD]),
    podOptionId: optionId(issue.fields[POD_FIELD]),
    priority: toPriority(issue.fields.priority?.name),
    statusCategory: statusCategory(issue.fields.status),
    statusId: issue.fields.status?.id ?? "",
    statusName: issue.fields.status?.name ?? "",
    ttr: parseJsmSla(issue.fields[TIME_TO_RESOLUTION_FIELD]),
    url: `${baseUrl}/browse/${issue.key}`,
  };
}

export function toCpSnapshot(issue: JiraIssue, baseUrl: string): CpSnapshot {
  return {
    assigneeAccountId: issue.fields.assignee?.accountId ?? null,
    assigneeName: issue.fields.assignee?.displayName ?? null,
    issueTypeId: issue.fields.issuetype?.id ?? "",
    issueTypeName: issue.fields.issuetype?.name ?? "",
    key: issue.key,
    podName: optionName(issue.fields[POD_FIELD]),
    podOptionId: optionId(issue.fields[POD_FIELD]),
    priorityName: issue.fields.priority?.name ?? null,
    resolutionId: issue.fields.resolution?.id ?? null,
    resolutionName: issue.fields.resolution?.name ?? null,
    statusCategory: statusCategory(issue.fields.status),
    statusId: issue.fields.status?.id ?? "",
    statusName: issue.fields.status?.name ?? "",
    url: `${baseUrl}/browse/${issue.key}`,
  };
}

export async function fullChangelog(client: ReadOnlyJiraClient, key: string): Promise<NonNullable<ChangelogPage["values"]>> {
  const all: NonNullable<ChangelogPage["values"]> = [];
  for (let startAt = 0; startAt < 5_000; ) {
    const page = await client.get<ChangelogPage>(`/rest/api/3/issue/${key}/changelog`, { maxResults: 100, startAt });
    const values = page.values ?? [];
    all.push(...values);
    if (page.isLast !== false || values.length === 0) {
      break;
    }
    startAt += values.length;
  }
  return all;
}

export function statusTransitions(changelog: NonNullable<ChangelogPage["values"]>): Array<{ at: string; from: string; to: string }> {
  const out: Array<{ at: string; from: string; to: string }> = [];
  for (const history of changelog) {
    for (const item of history.items ?? []) {
      if ((item.fieldId === "status" || item.field === "status") && history.created) {
        out.push({ at: history.created, from: item.from ?? "", to: item.to ?? "" });
      }
    }
  }
  return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/** Issues by key, 50 per search. Keys that don't come back (deleted, no permission) are simply absent. */
export async function searchByKeys(client: ReadOnlyJiraClient, keys: string[], fields: string[]): Promise<JiraIssue[]> {
  const unique = [...new Set(keys)].sort();
  const out: JiraIssue[] = [];
  for (let i = 0; i < unique.length; i += KEY_CHUNK) {
    const chunk = unique.slice(i, i + KEY_CHUNK);
    out.push(...(await client.searchJql<JiraIssue>(`key in (${chunk.join(",")})`, fields, { maxTotal: KEY_CHUNK * 2 })));
  }
  return out;
}

export interface PilotSweep {
  classification: ClassificationResult;
  /* Every CP linked from a Waiting-for-product ticket, by key, read with its OWN Pod. */
  cps: Map<string, CpSnapshot>;
  cpKeysLinked: number;
  tickets: TsSnapshot[];
  tsApproximateCount: number | null;
  tsInWaitingForProduct: number;
}

/**
 * Every Support Ticket in Waiting for product, the CPs they link to, and the
 * WfP entry time (from the changelog) for each ticket that joins an active
 * escalation, classified against `routing`.
 */
export async function sweepWaitingForProduct(
  client: ReadOnlyJiraClient,
  baseUrl: string,
  routing: RoutingRow[],
  opts: { approximateCount?: boolean } = {},
): Promise<PilotSweep> {
  const tsJql = `issuetype = ${SUPPORT_TICKET_ISSUE_TYPE_ID} AND status = ${WAITING_FOR_PRODUCT_STATUS_ID} ORDER BY key`;
  const [tsIssues, tsApproximateCount] = await Promise.all([
    client.searchJql<JiraIssue>(tsJql, TS_FIELDS, { maxTotal: 1_000 }),
    opts.approximateCount ? client.approximateCount(tsJql) : Promise.resolve(null),
  ]);

  const cpKeys = [...new Set(tsIssues.flatMap((issue) => toTsSnapshot(issue, baseUrl, null).links.map((link) => link.cpKey)))].sort();
  const cpIssues = await searchByKeys(client, cpKeys, CP_FIELDS);
  const cps = new Map(cpIssues.map((issue) => [issue.key, toCpSnapshot(issue, baseUrl)]));

  /* WfP entry from the changelog - only for tickets that actually join an escalation, to keep the sweep cheap. */
  const firstPass = classify(tsIssues.map((issue) => toTsSnapshot(issue, baseUrl, null)), cps, routing);
  const escalatedTsKeys = new Set(firstPass.escalations.flatMap((group) => group.tickets.map((ticket) => ticket.key)));
  const wfpEntry = new Map<string, string | null>();
  await mapLimit([...escalatedTsKeys], CHANGELOG_CONCURRENCY, async (key) => {
    const transitions = statusTransitions(await fullChangelog(client, key));
    const lastInto = [...transitions].reverse().find((transition) => transition.to === WAITING_FOR_PRODUCT_STATUS_ID);
    wfpEntry.set(key, lastInto?.at ?? null);
  });

  const tickets = tsIssues.map((issue) => toTsSnapshot(issue, baseUrl, wfpEntry.get(issue.key) ?? null));

  return {
    classification: classify(tickets, cps, routing),
    cpKeysLinked: cpKeys.length,
    cps,
    tickets,
    tsApproximateCount,
    tsInWaitingForProduct: tsIssues.length,
  };
}
