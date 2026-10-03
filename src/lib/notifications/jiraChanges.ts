import {
  CLOSED_STATUS_ID,
  FIX_READY_STATUS_IDS,
  REJECTED_STATUS_IDS,
  SHIPPED_STATUS_IDS,
} from "@/lib/escalation/policy";

import type { AppNotification } from "@/lib/notifications/types";

/**
 * Pure half of the Jira notification sync (src/lib/notifications/jiraSync.ts):
 * recently-updated issues, with their changelog and newest comments, in -
 * notifications out. No I/O and no clock, so every rule is tested with
 * fixtures in scripts/test-notifications.ts.
 *
 * What is worth a notification:
 * - on a TS ticket: a customer reply (always important), a teammate's
 *   comment (important when it @-mentions the assignee), a status move, a
 *   priority change, being assigned the ticket, a CP getting linked
 * - on a CP linked to someone's TS ticket: status moves (important once a
 *   fix is ready, shipped or rejected), new engineering comments, a new
 *   CP assignee
 * A person's own actions never notify them, and Jira automation ("app"
 * accounts) comments are skipped as noise.
 *
 * Followers (people who follow a ticket on the escalation tracker,
 * src/lib/tracker/follow.ts) hear about a TS ticket like its assignee does,
 * and about the CPs linked to the tickets they follow (or a CP they follow
 * directly). "Assigned to you" stays the new assignee's alone.
 */

export interface JiraUserRef {
  accountId?: string;
  accountType?: string;
  displayName?: string;
}

export interface JiraHistoryItem {
  field?: string;
  fieldId?: string;
  from?: string | null;
  fromString?: string | null;
  to?: string | null;
  toString?: string | null;
}

export interface JiraHistory {
  author?: JiraUserRef;
  created?: string;
  id?: string;
  items?: JiraHistoryItem[];
}

export interface JiraCommentRecord {
  author?: JiraUserRef;
  body?: unknown;
  created?: string;
  id?: string;
  /* JSM: false = internal note, invisible to the customer. Absent on non-JSM projects. */
  jsdPublic?: boolean;
}

export interface WatchedIssue {
  assignee: JiraUserRef | null;
  comments: JiraCommentRecord[];
  histories: JiraHistory[];
  key: string;
  reporterAccountId?: string;
  summary?: string;
}

export interface LinkedTicket {
  /* Null when only followers are listening (the assignee isn't a registered user, or wasn't looked up). */
  assigneeAccountId: string | null;
  key: string;
}

export interface JiraChangeInput {
  baseUrl: string;
  /* CPs updated in the window, each with the registered-user-owned (or followed) TS tickets that link to it. */
  cps: Array<{ issue: WatchedIssue; linkedTickets: LinkedTicket[] }>;
  /* Tracker followers per TS/CP key. Only registered followers are ever notified. */
  followersByKey?: ReadonlyMap<string, string[]>;
  registeredAccountIds: ReadonlySet<string>;
  /* Only history items and comments created at or after this instant count. */
  sinceMs: number;
  /* TS tickets updated in the window and currently assigned to a registered user, or followed by one. */
  tickets: WatchedIssue[];
}

const SNIPPET_MAX_CHARS = 160;
/* JSM automation moves a ticket (Waiting for client -> In Progress) seconds after a customer replies; the reply already says it. */
const AUTOMATION_ECHO_MS = 3 * 60_000;
const IMPORTANT_PRIORITY = /^(critical|highest|blocker)$/i;
const CP_KEY_PATTERN = /\bCP-\d+\b/;
/* CP statuses that mean "engineering has an outcome": fix ready, shipped, closed or rejected. */
const CP_OUTCOME_STATUS_IDS = new Set([...FIX_READY_STATUS_IDS, ...SHIPPED_STATUS_IDS, ...REJECTED_STATUS_IDS, CLOSED_STATUS_ID]);

export function notificationsFromJiraChanges(input: JiraChangeInput): AppNotification[] {
  const out: AppNotification[] = [];

  for (const ticket of input.tickets) {
    out.push(...ticketNotifications(ticket, input));
  }

  for (const { issue, linkedTickets } of input.cps) {
    out.push(...cpNotifications(issue, linkedTickets, input));
  }

  /* One notification per id, even if a CP and its TS arrive in the same batch twice. */
  const seen = new Set<string>();
  return out.filter((item) => (seen.has(item.id) ? false : (seen.add(item.id), true)));
}

/* Registered followers of a key, in a stable order. */
function followersOf(key: string, input: JiraChangeInput): string[] {
  return [...new Set(input.followersByKey?.get(key) ?? [])].filter((id) => input.registeredAccountIds.has(id)).sort();
}

/* ------------------------------------------------------------------- TS */

function ticketNotifications(ticket: WatchedIssue, input: JiraChangeInput): AppNotification[] {
  const assignee = ticket.assignee?.accountId;
  const owner = assignee && input.registeredAccountIds.has(assignee) ? assignee : undefined;
  /* Owner first, so a ticket nobody follows keeps exactly the audience it always had. */
  const listeners = [...new Set([...(owner ? [owner] : []), ...followersOf(ticket.key, input)])];

  if (listeners.length === 0) {
    return [];
  }

  const url = issueUrl(input.baseUrl, ticket.key);
  const out: AppNotification[] = [];
  const customerReplyTimes = ticket.comments
    .filter((comment) => isFromCustomer(comment, ticket))
    .map((comment) => Date.parse(comment.created ?? ""))
    .filter((ms) => !Number.isNaN(ms));

  for (const history of ticket.histories) {
    const at = instantInWindow(history.created, input.sinceMs);
    const audience = listeners.filter((id) => id !== history.author?.accountId);
    if (at === null || audience.length === 0) {
      continue;
    }
    const actor = history.author?.displayName;
    const automationEcho =
      history.author?.accountType === "app" && customerReplyTimes.some((ms) => Math.abs(ms - Date.parse(at)) <= AUTOMATION_ECHO_MS);

    for (const item of history.items ?? []) {
      const field = item.fieldId ?? item.field ?? "";
      const id = `jira:${ticket.key}:h${history.id ?? at}:${field}`;
      const base = { actor, at, audience, id, source: "jira" as const, ticketKey: ticket.key, url };

      if (field === "status") {
        if (!automationEcho) {
          out.push({
            ...base,
            detail: transition(item),
            important: false,
            kind: "jira_status",
            title: `${ticket.key} moved to ${item.toString ?? "a new status"}`,
          });
        }
      } else if (field === "assignee") {
        /* The new assignee is told it's theirs; followers just see who has it now. */
        if (owner && item.to === owner && audience.includes(owner)) {
          out.push({
            ...base,
            audience: [owner],
            detail: ticket.summary,
            important: true,
            kind: "jira_assigned",
            title: `${ticket.key} was assigned to you`,
          });
        }
        /* Followers other than the new assignee; the owner's own rule above is unchanged. */
        const watching = audience.filter((id) => id !== owner && id !== item.to);
        if (watching.length > 0) {
          out.push({
            ...base,
            audience: watching,
            detail: ticket.summary,
            id: `${id}:followers`,
            important: false,
            kind: "jira_assigned",
            title: item.toString ? `${ticket.key} was assigned to ${item.toString}` : `${ticket.key} was unassigned`,
          });
        }
      } else if (field === "priority") {
        out.push({
          ...base,
          detail: transition(item),
          important: IMPORTANT_PRIORITY.test(item.toString ?? ""),
          kind: "jira_priority",
          title: `${ticket.key} priority changed to ${item.toString ?? "none"}`,
        });
      } else if (isLinkField(field)) {
        const linked = (item.toString ?? item.fromString ?? "").match(CP_KEY_PATTERN)?.[0];
        if (linked) {
          const added = Boolean(item.toString);
          out.push({
            ...base,
            cpKey: linked,
            detail: (item.toString ?? item.fromString) || undefined,
            important: false,
            kind: "jira_link",
            title: added ? `${linked} was linked to ${ticket.key}` : `${linked} was unlinked from ${ticket.key}`,
          });
        }
      }
    }
  }

  for (const comment of ticket.comments) {
    const at = instantInWindow(comment.created, input.sinceMs);
    const author = comment.author;
    const audience = listeners.filter((id) => id !== author?.accountId);
    if (at === null || audience.length === 0 || author?.accountType === "app") {
      continue;
    }

    const fromCustomer = isFromCustomer(comment, ticket);
    const mentioned = mentionedAccountIds(comment.body);
    const mentionedListeners = audience.filter((id) => mentioned.has(id));
    /* "mentioned you" only when it's true for everyone the notification goes to. */
    const mentionsEveryone = mentionedListeners.length > 0 && mentionedListeners.length === audience.length;
    const name = author?.displayName ?? (fromCustomer ? "The customer" : "Someone");
    const snippet = adfToText(comment.body, SNIPPET_MAX_CHARS);

    out.push({
      actor: author?.displayName,
      at,
      audience,
      detail: comment.jsdPublic === false ? `Internal note: ${snippet}` : snippet,
      id: `jira:${ticket.key}:c${comment.id ?? at}`,
      important: fromCustomer || mentionedListeners.length > 0,
      kind: fromCustomer ? "jira_customer_reply" : "jira_comment",
      source: "jira",
      ticketKey: ticket.key,
      title: fromCustomer
        ? `${name} replied on ${ticket.key}`
        : mentionsEveryone
          ? `${name} mentioned you on ${ticket.key}`
          : `${name} commented on ${ticket.key}`,
      url: comment.id ? `${url}?focusedCommentId=${encodeURIComponent(comment.id)}` : url,
    });
  }

  return out;
}

/* ------------------------------------------------------------------- CP */

function cpNotifications(cp: WatchedIssue, linkedTickets: LinkedTicket[], input: JiraChangeInput): AppNotification[] {
  /* Everyone listening through each linked TS ticket: its registered owner, then its followers. */
  const listenersByTs = linkedTickets.map((ticket) => ({
    key: ticket.key,
    listeners: [
      ...(ticket.assigneeAccountId && input.registeredAccountIds.has(ticket.assigneeAccountId) ? [ticket.assigneeAccountId] : []),
      ...followersOf(ticket.key, input),
    ],
  }));
  const owners = [...new Set([...listenersByTs.flatMap((entry) => entry.listeners), ...followersOf(cp.key, input)])];

  if (owners.length === 0) {
    return [];
  }

  const tsKeys = [...new Set(listenersByTs.filter((entry) => entry.listeners.length > 0).map((entry) => entry.key))].sort(compareKeys);
  const linkedTo =
    tsKeys.length > 0 ? `linked to ${tsKeys.slice(0, 3).join(", ")}${tsKeys.length > 3 ? ` +${tsKeys.length - 3}` : ""}` : "followed CP";
  const url = issueUrl(input.baseUrl, cp.key);
  const out: AppNotification[] = [];

  for (const history of cp.histories) {
    const at = instantInWindow(history.created, input.sinceMs);
    if (at === null) {
      continue;
    }
    const audience = owners.filter((id) => id !== history.author?.accountId);
    const actor = history.author?.displayName;

    for (const item of history.items ?? []) {
      const field = item.fieldId ?? item.field ?? "";
      const base = {
        actor,
        at,
        audience,
        cpKey: cp.key,
        id: `jira:${cp.key}:h${history.id ?? at}:${field}`,
        source: "jira" as const,
        ticketKey: tsKeys[0],
        url,
      };

      if (field === "status") {
        out.push({
          ...base,
          detail: `${transition(item)} · ${linkedTo}`,
          important: item.to ? CP_OUTCOME_STATUS_IDS.has(item.to) : false,
          kind: "cp_status",
          title: `${cp.key} moved to ${item.toString ?? "a new status"}`,
        });
      } else if (field === "assignee") {
        out.push({
          ...base,
          detail: linkedTo,
          important: false,
          kind: "cp_assigned",
          title: item.toString ? `${cp.key} was assigned to ${item.toString}` : `${cp.key} was unassigned`,
        });
      }
    }
  }

  for (const comment of cp.comments) {
    const at = instantInWindow(comment.created, input.sinceMs);
    const author = comment.author;
    if (at === null || author?.accountType === "app") {
      continue;
    }

    const audience = owners.filter((id) => id !== author?.accountId);
    const mentioned = mentionedAccountIds(comment.body);

    out.push({
      actor: author?.displayName,
      at,
      audience,
      cpKey: cp.key,
      detail: `${adfToText(comment.body, SNIPPET_MAX_CHARS)} · ${linkedTo}`,
      id: `jira:${cp.key}:c${comment.id ?? at}`,
      important: audience.some((id) => mentioned.has(id)),
      kind: "cp_comment",
      source: "jira",
      ticketKey: tsKeys[0],
      title: `${author?.displayName ?? "Someone"} commented on ${cp.key}`,
      url: comment.id ? `${url}?focusedCommentId=${encodeURIComponent(comment.id)}` : url,
    });
  }

  return out.filter((item) => item.audience.length > 0);
}

/* -------------------------------------------------------------- helpers */

/* The reporter is the party the ticket waits on, even when they're an internal teammate - same rule as src/lib/replyTracking.ts. */
function isFromCustomer(comment: JiraCommentRecord, ticket: WatchedIssue): boolean {
  const author = comment.author;
  return author?.accountType === "customer" || (author?.accountId !== undefined && author.accountId === ticket.reporterAccountId);
}

function issueUrl(baseUrl: string, key: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/browse/${key}`;
}

/* Returns the ISO instant when it parses and falls inside the window, else null. */
function instantInWindow(created: string | undefined, sinceMs: number): string | null {
  const ms = created ? Date.parse(created) : Number.NaN;
  return Number.isNaN(ms) || ms < sinceMs ? null : new Date(ms).toISOString();
}

function transition(item: JiraHistoryItem): string {
  return `${item.fromString ?? "none"} → ${item.toString ?? "none"}`;
}

/* Jira's changelog names issue-link changes "Link" (fieldId "issuelinks" on newer sites). */
function isLinkField(field: string): boolean {
  return field === "Link" || field === "issuelinks";
}

function compareKeys(a: string, b: string): number {
  const [projectA = "", numberA = "0"] = a.split("-");
  const [projectB = "", numberB = "0"] = b.split("-");
  return projectA === projectB ? Number(numberA) - Number(numberB) : projectA < projectB ? -1 : 1;
}

interface AdfNode {
  attrs?: { id?: string; shortName?: string; text?: string; url?: string };
  content?: AdfNode[];
  text?: string;
  type?: string;
}

function walkAdf(node: unknown, visit: (node: AdfNode) => void): void {
  if (!node || typeof node !== "object") {
    return;
  }
  const typed = node as AdfNode;
  visit(typed);
  for (const child of Array.isArray(typed.content) ? typed.content : []) {
    walkAdf(child, visit);
  }
}

function mentionedAccountIds(body: unknown): Set<string> {
  const ids = new Set<string>();
  walkAdf(body, (node) => {
    if (node.type === "mention" && typeof node.attrs?.id === "string") {
      ids.add(node.attrs.id);
    }
  });
  return ids;
}

const ADF_BLOCKS = new Set(["blockquote", "bulletList", "codeBlock", "heading", "listItem", "orderedList", "panel", "paragraph", "rule", "table", "tableRow"]);

/** Plain text of a comment body (Atlassian Document Format, or a legacy wiki string), whitespace-collapsed and clipped. */
export function adfToText(body: unknown, maxChars: number): string {
  let text = "";

  if (typeof body === "string") {
    text = body;
  } else {
    const parts: string[] = [];
    walkAdf(body, (node) => {
      if (node.type === "text" && typeof node.text === "string") {
        parts.push(node.text);
      } else if (node.type === "mention") {
        parts.push(node.attrs?.text ?? "@someone");
      } else if (node.type === "emoji") {
        parts.push(node.attrs?.text ?? node.attrs?.shortName ?? "");
      } else if (node.type === "inlineCard" || node.type === "blockCard") {
        parts.push(node.attrs?.url ?? "");
      } else if (node.type === "hardBreak" || (node.type && ADF_BLOCKS.has(node.type))) {
        parts.push(" ");
      } else if (node.type === "mediaSingle" || node.type === "mediaGroup") {
        parts.push(" [attachment] ");
      }
    });
    text = parts.join("");
  }

  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > maxChars ? `${collapsed.slice(0, maxChars - 1).trimEnd()}…` : collapsed;
}
