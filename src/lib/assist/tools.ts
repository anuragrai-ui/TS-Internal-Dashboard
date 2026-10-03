import type { ConfluenceSearchResult } from "@/lib/confluenceClient";
import type { ToolDefinition } from "@/lib/llmClient";
import type { SlackThreadResponse, TimelineItem, TrackerDetail, TrackerSla } from "@/lib/tracker/types";
import type { AssistSource, OnCallShift } from "@/lib/workspace/types";

/**
 * The investigation agent's tools: read-only, and scoped to ONE ticket - the
 * run's. The model can read that ticket, the Slack conversations and CPs
 * already linked to it, a fixed-shape search for similar TS tickets,
 * Confluence and the on-call schedule. It can't name an arbitrary channel,
 * issue or JQL query: every id it passes is checked against the ticket's own
 * detail first, and the only JQL is built here from plain words.
 *
 * Everything that came from Jira, Slack or Confluence is wrapped in
 * <untrusted_data> so the system prompt can tell the model to treat it as
 * data (a customer comment saying "ignore your instructions" is just text).
 * Errors produced here are plain "Error: ..." strings, never wrapped.
 *
 * Each item carries a ready-made `source: {...}` line (kind, label, url, at)
 * that the model copies into its facts; the investigation then keeps only
 * URLs that really appeared in these outputs.
 *
 * Pure apart from the injected deps (src/lib/assist/sources.ts wires the live
 * ones), so scripts/test-assist.ts drives it with fakes.
 */

export interface CpComment {
  at: string | null;
  author: string;
  /* Plain text, already converted from ADF. */
  body: string;
  id?: string;
}

/** One CP as get_cp reads it. */
export interface CpRead {
  assigneeName: string | null;
  /* Newest first. */
  comments: CpComment[];
  key: string;
  podName: string | null;
  priorityName: string | null;
  resolutionName: string | null;
  statusName: string;
  summary: string | null;
  url: string;
}

export interface SimilarTicket {
  key: string;
  priorityName: string | null;
  resolutionName: string | null;
  statusName: string;
  summary: string;
  updated: string | null;
  url: string;
}

export interface AssistToolDeps {
  getOnCallShifts(): Promise<OnCallShift[]>;
  loadConversation(channel: string, rootTs: string): Promise<SlackThreadResponse>;
  /* null = Jira couldn't be read. */
  readCp(cpKey: string): Promise<CpRead | null>;
  searchConfluence(query: string, limit: number): Promise<ConfluenceSearchResult[]>;
  searchTickets(jql: string, limit: number): Promise<SimilarTicket[]>;
}

/** A workflow transition Jira offers for the ticket (GET .../transitions). */
export interface TicketTransition {
  id: string;
  name: string;
  toStatus: string;
}

export interface AssistToolScope {
  /* The run's ticket, as getTrackerDetail returned it when the run started. */
  detail: TrackerDetail;
  jiraBaseUrl: string;
  ticketKey: string;
  /* What Jira offered when the run started; null when they couldn't be read. */
  transitions: TicketTransition[] | null;
}

export const TS_KEY = /^TS-\d+$/;
const CP_KEY = /^CP-\d+$/;
const TIMELINE_ITEMS = 40;
const TIMELINE_BODY_CHARS = 400;
const SLACK_MESSAGES = 40;
const SLACK_MESSAGE_CHARS = 500;
const CP_COMMENTS = 8;
const CP_COMMENT_CHARS = 600;
const SIMILAR_MAX = 5;
const CONFLUENCE_MAX = 5;
const SEARCH_TEXT_MAX = 100;
const TOOL_OUTPUT_MAX = 14_000;

/* ------------------------------------------------------------- helpers */

export function clip(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1).trimEnd()}…` : collapsed;
}

/* A long output is cut at a line break, so the last source line isn't half a JSON object. */
function clipBlock(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  const cut = text.lastIndexOf("\n", max);
  return `${text.slice(0, cut > max / 2 ? cut : max)}\n[...output clipped]`;
}

/**
 * Wraps tool output that came from Jira / Slack / Confluence. A closing tag
 * inside the data is defused so the data can't end the block early and pose
 * as instructions after it.
 */
export function wrapUntrusted(source: string, body: string): string {
  const safeSource = source.replace(/["<>&\n\r]/g, "").slice(0, 120);
  /* Also the investigation's own <evidence> wrapper (investigate.ts), so data can't close that block either. */
  const safeBody = body.replace(/<(\s*\/?\s*(?:untrusted_data|evidence))/gi, "&lt;$1");
  return `<untrusted_data source="${safeSource}">\n${safeBody}\n</untrusted_data>`;
}

function shortDate(iso: string | null | undefined): string {
  const ms = iso ? Date.parse(iso) : Number.NaN;
  return Number.isNaN(ms) ? "" : new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}

/** The `source: {...}` line the model copies into a fact. */
export function sourceLine(source: AssistSource): string {
  const ordered: AssistSource = { kind: source.kind, label: clip(source.label, 160) };
  if (source.url) {
    ordered.url = source.url;
  }
  if (source.at) {
    ordered.at = source.at;
  }
  return `source: ${JSON.stringify(ordered)}`;
}

function stringArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  return typeof value === "string" ? value.trim() : "";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function browseUrl(baseUrl: string, key: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/browse/${key}`;
}

function duration(ms: number): string {
  const minutes = Math.round(Math.abs(ms) / 60_000);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h ${minutes % 60}m` : `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function slaText(sla: TrackerSla): string {
  if (sla.state === "none") {
    return "no SLA";
  }
  if (sla.state === "completed_only") {
    return sla.breached ? "completed, breached" : "completed";
  }
  const left = sla.remainingMs === null ? "" : sla.remainingMs < 0 ? `, ${duration(sla.remainingMs)} over` : `, ${duration(sla.remainingMs)} left`;
  return `${sla.state}${sla.breached ? ", BREACHED" : ""}${left}`;
}

/* ------------------------------------------------------ source mapping */

function timelineSourceKind(item: TimelineItem): AssistSource["kind"] {
  switch (item.kind) {
    case "jira_comment":
    case "jira_internal_note":
      return "jira_comment";
    case "cp_comment":
    case "cp_status":
      return "cp";
    case "slack_conversation":
    case "slack_message":
    case "bot_escalation":
      return "slack_message";
    case "notification":
    case "system":
      return item.source === "slack" || item.source === "bot" ? "slack_message" : item.source === "cp" ? "cp" : "jira_field";
    default:
      return "jira_field";
  }
}

function timelineLabel(item: TimelineItem): string {
  const date = shortDate(item.at);
  const by = item.actor ? ` by ${item.actor}` : "";
  switch (item.kind) {
    case "jira_comment":
      return `${item.sourceLabel} comment${by}, ${date}`;
    case "jira_internal_note":
      return `${item.sourceLabel} internal note${by}, ${date}`;
    case "cp_comment":
      return `${item.sourceLabel} comment${by}, ${date}`;
    case "slack_conversation":
      return `${item.sourceLabel} thread${by}, ${date}`;
    default:
      return `${item.sourceLabel}: ${item.title}, ${date}`;
  }
}

/* --------------------------------------------------------- formatting */

/** get_ticket_context's text: the ticket's fields, signals, SLAs, CPs, linked conversations and recent activity. */
export function formatTicketContext(detail: TrackerDetail, jiraBaseUrl: string, transitions: TicketTransition[] | null = null): string {
  const t = detail.ticket;
  const lines: string[] = [];
  const ticketUrl = browseUrl(jiraBaseUrl, t.key);

  lines.push(`Ticket ${t.key}: ${t.summary}`);
  lines.push(sourceLine({ kind: "jira_field", label: `${t.key} fields`, url: ticketUrl }));
  lines.push(`Status: ${t.statusName} (${t.statusCategory}) · Priority: ${t.priority} · Whose move: ${t.whoseMove}`);
  lines.push(
    `Account: ${t.account ?? "unknown"} · Pod: ${t.pod ?? "none"} · Assignee: ${t.assignee ? `${t.assignee.name} (accountId ${t.assignee.accountId})` : "unassigned"} · Reporter: ${t.reporterName ?? "unknown"}`,
  );
  lines.push(`Created ${t.created} · Jira updated ${t.updated} · Last activity ${t.lastActivityAt}${t.resolvedAt ? ` · Resolved ${t.resolvedAt}` : ""}`);
  lines.push(`First response SLA: ${slaText(t.firstResponse)} · Time to resolution SLA: ${slaText(t.ttr)}`);
  lines.push(
    transitions === null
      ? "Workflow transitions: couldn't be read (don't propose jira_transition)."
      : transitions.length === 0
        ? "Workflow transitions: none available."
        : `Workflow transitions available now: ${transitions.map((tr) => `id ${tr.id} "${tr.name}" -> ${tr.toStatus}`).join("; ")}`,
  );

  lines.push("");
  lines.push(t.signals.length > 0 ? "Escalation signals:" : "Escalation signals: none");
  for (const signal of t.signals) {
    lines.push(`- [tier ${signal.tier}] ${signal.label}${signal.at ? ` (${signal.at})` : ""}${signal.detail ? ` - ${clip(signal.detail, 200)}` : ""}`);
  }

  lines.push("");
  lines.push(t.cps.length > 0 ? "Linked CPs (read one with get_cp):" : "Linked CPs: none");
  for (const cp of t.cps) {
    lines.push(
      `- ${cp.key}${cp.isEpic ? " (epic)" : ""}: ${cp.summary ? `"${clip(cp.summary, 160)}"` : "(no summary)"} - status ${cp.statusName} (${cp.outcome}), pod ${cp.podName ?? "none"}, assignee ${cp.assigneeName ?? "unassigned"}`,
    );
    lines.push(`  ${sourceLine({ kind: "cp", label: `${cp.key} status`, url: browseUrl(jiraBaseUrl, cp.key) })}`);
  }
  if (t.botEscalation) {
    lines.push(`Escalation bot: thread for ${t.botEscalation.cpKey}, state ${t.botEscalation.state}, level ${t.botEscalation.levelSent} sent`);
  }

  lines.push("");
  lines.push(detail.conversations.length > 0 ? "Linked Slack conversations (read one with read_slack_conversation and its id):" : "Linked Slack conversations: none");
  for (const conv of detail.conversations) {
    lines.push(
      `- id ${conv.id} · #${conv.channelName ?? conv.channel} · started by ${conv.startedByName ?? "someone"} · ${conv.replyCount} replies · last activity ${conv.lastActivityAt}${conv.escalationHint ? " · escalation language" : ""}${conv.snippet ? ` · "${clip(conv.snippet, 140)}"` : ""}`,
    );
    lines.push(
      `  ${sourceLine({ at: conv.lastActivityAt, kind: "slack_message", label: `#${conv.channelName ?? conv.channel} thread`, url: conv.permalink })}`,
    );
  }

  const recent = detail.timeline.slice(-TIMELINE_ITEMS);
  lines.push("");
  lines.push(`Recent activity, oldest first (${recent.length} of ${detail.timeline.length} items):`);
  for (const item of recent) {
    const visibility = item.internal ? "internal" : "customer-visible";
    const body = item.body ? `: ${clip(item.body, TIMELINE_BODY_CHARS)}` : "";
    lines.push(`- ${item.at} [${item.kind}, ${visibility}] ${item.title}${body}`);
    lines.push(`  ${sourceLine({ at: item.at, kind: timelineSourceKind(item), label: timelineLabel(item), url: item.url })}`);
  }

  if (detail.errors.length > 0) {
    lines.push("");
    lines.push(`Parts that couldn't be read: ${detail.errors.map((error) => clip(error, 160)).join(" · ")}`);
  }
  return clipBlock(lines.join("\n"), TOOL_OUTPUT_MAX);
}

/** read_slack_conversation's text: the root message plus the latest replies. */
export function formatConversation(args: { channelName: string; permalink?: string; thread: SlackThreadResponse }): string {
  const messages = args.thread.messages;
  const kept = messages.length > SLACK_MESSAGES ? [...messages.slice(0, 1), ...messages.slice(-(SLACK_MESSAGES - 1))] : messages;
  const permalink = args.thread.permalink ?? args.permalink;
  const lines = [`Slack thread in #${args.channelName} (${messages.length} messages${args.thread.truncated ? ", more not read" : ""}${kept.length < messages.length ? `, showing the first and the latest ${kept.length - 1}` : ""}):`];
  for (const message of kept) {
    lines.push(`- ${message.at} ${message.userName}${message.isBot ? " (bot)" : ""}: ${clip(message.text, SLACK_MESSAGE_CHARS)}`);
    lines.push(`  ${sourceLine({ at: message.at, kind: "slack_message", label: `#${args.channelName}, ${message.userName}, ${shortDate(message.at)}`, url: permalink })}`);
  }
  return clipBlock(lines.join("\n"), TOOL_OUTPUT_MAX);
}

/** get_cp's text. */
export function formatCp(cp: CpRead): string {
  const lines = [
    `${cp.key}: ${cp.summary ?? "(no summary)"}`,
    `Status: ${cp.statusName}${cp.resolutionName ? ` (resolution ${cp.resolutionName})` : ""} · Priority: ${cp.priorityName ?? "none"} · Pod: ${cp.podName ?? "none"} · Assignee: ${cp.assigneeName ?? "unassigned"}`,
    sourceLine({ kind: "cp", label: `${cp.key} status`, url: cp.url }),
    "",
    cp.comments.length > 0 ? `Latest comments, newest first (${Math.min(cp.comments.length, CP_COMMENTS)}):` : "No comments.",
  ];
  for (const comment of cp.comments.slice(0, CP_COMMENTS)) {
    lines.push(`- ${comment.at ?? "unknown time"} ${comment.author}: ${clip(comment.body, CP_COMMENT_CHARS)}`);
    const url = comment.id ? `${cp.url}?focusedCommentId=${encodeURIComponent(comment.id)}` : cp.url;
    lines.push(`  ${sourceLine({ at: comment.at ?? undefined, kind: "cp", label: `${cp.key} comment by ${comment.author}, ${shortDate(comment.at)}`, url })}`);
  }
  return clipBlock(lines.join("\n"), TOOL_OUTPUT_MAX);
}

/* ----------------------------------------------------------- searches */

/*
 * Inside `text ~ "..."` Jira hands the phrase to Lucene, where + - & | ! ( )
 * { } [ ] ^ " ~ * ? : \ / are syntax and upper-case AND/OR/NOT are operators.
 * For a "tickets that read like this one" search the words are all that
 * matter, so this keeps an allowlist - letters, digits, whitespace and the
 * inert . _ ' @ # - turns everything else into a space, and lower-cases the
 * rest: nothing the model writes can close the string, add a clause or change
 * the project. Tabs, newlines and control characters become spaces as well.
 */
const NOT_SEARCHABLE = /[^\p{L}\p{N} ._'@#]/gu;

/** Plain search words: no query syntax, no control characters, at most `max` chars. */
export function searchWords(text: string, max = SEARCH_TEXT_MAX): string {
  return text.replace(NOT_SEARCHABLE, " ").replace(/\s+/g, " ").trim().toLowerCase().slice(0, max).trim();
}

/** The one JQL search_similar_tickets runs. null when the text has no searchable words. */
export function similarTicketsJql(ticketKey: string, text: string): string | null {
  const words = searchWords(text);
  if (!TS_KEY.test(ticketKey) || !words) {
    return null;
  }
  return `project = TS AND text ~ "${words}" AND key != ${ticketKey} ORDER BY updated DESC`;
}

/* --------------------------------------------------------------- tools */

const NO_ARGS = { additionalProperties: false, properties: {}, type: "object" };

/** The tools for one investigation, bound to its ticket. */
export function buildAssistTools(scope: AssistToolScope, deps: AssistToolDeps): ToolDefinition[] {
  const { detail, jiraBaseUrl, ticketKey, transitions } = scope;
  const conversations = new Map(detail.conversations.map((conv) => [conv.id, conv]));
  const cpKeys = new Set(detail.ticket.cps.map((cp) => cp.key));

  const getTicketContext: ToolDefinition = {
    description: `Read ${ticketKey}: its fields, SLAs, escalation signals, linked CPs, linked Slack conversations (with their ids) and the last ${TIMELINE_ITEMS} activity items (Jira comments and internal notes, status/priority/assignee changes, CP activity, Slack threads). Call this first.`,
    handler: () => Promise.resolve(wrapUntrusted(`jira:${ticketKey}`, formatTicketContext(detail, jiraBaseUrl, transitions))),
    name: "get_ticket_context",
    parameters: NO_ARGS,
  };

  const readSlackConversation: ToolDefinition = {
    description: `Read the messages of one Slack conversation linked to ${ticketKey}. conversation_id must be one of the ids get_ticket_context lists (like "C0123ABCD:1727881200.000100").`,
    handler: async (args) => {
      const id = stringArg(args, "conversation_id");
      const conv = conversations.get(id);
      if (!conv) {
        const known = [...conversations.keys()];
        return `Error: "${clip(id, 80)}" is not a Slack conversation linked to ${ticketKey}. ${known.length > 0 ? `Linked ids: ${known.join(", ")}.` : "This ticket has no linked Slack conversations."}`;
      }
      try {
        const thread = await deps.loadConversation(conv.channel, conv.rootTs);
        if (thread.rateLimited) {
          return "Error: Slack is throttling reads right now - this conversation can't be read in this run. Use the snippet from get_ticket_context.";
        }
        if (thread.error || thread.messages.length === 0) {
          return `Error: ${thread.error ?? "no messages could be read from this conversation."}`;
        }
        const channelName = conv.channelName ?? conv.channel;
        return wrapUntrusted(`slack:#${channelName}`, formatConversation({ channelName, permalink: conv.permalink, thread }));
      } catch (error) {
        return `Error: couldn't read this conversation (${clip(errorText(error), 160)}).`;
      }
    },
    name: "read_slack_conversation",
    parameters: {
      additionalProperties: false,
      properties: { conversation_id: { description: "A conversation id from get_ticket_context.", type: "string" } },
      required: ["conversation_id"],
      type: "object",
    },
  };

  const getCp: ToolDefinition = {
    description: `Read one CP (engineering ticket) linked to ${ticketKey}: summary, status, resolution, assignee, pod and its latest ${CP_COMMENTS} comments. Only CPs listed by get_ticket_context.`,
    handler: async (args) => {
      const key = stringArg(args, "cp_key").toUpperCase();
      if (!CP_KEY.test(key) || !cpKeys.has(key)) {
        return `Error: "${clip(key, 40)}" is not a CP linked to ${ticketKey}. ${cpKeys.size > 0 ? `Linked CPs: ${[...cpKeys].join(", ")}.` : "This ticket has no linked CPs."}`;
      }
      try {
        const cp = await deps.readCp(key);
        return cp ? wrapUntrusted(`jira:${key}`, formatCp(cp)) : `Error: couldn't read ${key} from Jira right now.`;
      } catch (error) {
        return `Error: couldn't read ${key} (${clip(errorText(error), 160)}).`;
      }
    },
    name: "get_cp",
    parameters: {
      additionalProperties: false,
      properties: { cp_key: { description: 'A linked CP key, e.g. "CP-55".', type: "string" } },
      required: ["cp_key"],
      type: "object",
    },
  };

  const searchSimilar: ToolDefinition = {
    description: `Find up to ${SIMILAR_MAX} other TS tickets whose text matches a few words (error messages, feature names, symptoms), most recently updated first, with their status and resolution. Pass plain words, not JQL.`,
    handler: async (args) => {
      const jql = similarTicketsJql(ticketKey, stringArg(args, "text"));
      if (!jql) {
        return "Error: give a few plain words to search for.";
      }
      try {
        const tickets = await deps.searchTickets(jql, SIMILAR_MAX);
        if (tickets.length === 0) {
          return "No similar TS tickets found.";
        }
        const lines = tickets.slice(0, SIMILAR_MAX).flatMap((ticket) => [
          `- ${ticket.key} [${ticket.statusName}${ticket.resolutionName ? ` / ${ticket.resolutionName}` : ""}${ticket.priorityName ? `, ${ticket.priorityName}` : ""}] ${clip(ticket.summary, 200)}${ticket.updated ? ` (updated ${ticket.updated})` : ""}`,
          `  ${sourceLine({ at: ticket.updated ?? undefined, kind: "jira_search", label: `${ticket.key} (similar ticket)`, url: ticket.url })}`,
        ]);
        return wrapUntrusted("jira:similar-tickets", `Similar TS tickets for "${searchWords(stringArg(args, "text"))}":\n${lines.join("\n")}`);
      } catch (error) {
        return `Error: the Jira search failed (${clip(errorText(error), 160)}).`;
      }
    },
    name: "search_similar_tickets",
    parameters: {
      additionalProperties: false,
      properties: { text: { description: `A few plain words, at most ${SEARCH_TEXT_MAX} characters.`, type: "string" } },
      required: ["text"],
      type: "object",
    },
  };

  const searchConfluence: ToolDefinition = {
    description: `Search the internal Confluence wiki (runbooks, known issues, product docs) for up to ${CONFLUENCE_MAX} pages. Internal only - never quote these to the customer.`,
    handler: async (args) => {
      const query = searchWords(stringArg(args, "query"));
      if (!query) {
        return "Error: give a few plain words to search for.";
      }
      try {
        const pages = await deps.searchConfluence(query, CONFLUENCE_MAX);
        if (pages.length === 0) {
          return "No Confluence pages matched.";
        }
        const lines = pages.slice(0, CONFLUENCE_MAX).flatMap((page) => [
          `- ${clip(page.title, 160)}: ${clip(page.excerpt, 400)}`,
          `  ${sourceLine({ kind: "confluence", label: clip(page.title, 160), url: page.url })}`,
        ]);
        return wrapUntrusted("confluence", `Confluence pages for "${query}":\n${lines.join("\n")}`);
      } catch (error) {
        return `Error: the Confluence search failed (${clip(errorText(error), 160)}).`;
      }
    },
    name: "search_confluence",
    parameters: {
      additionalProperties: false,
      properties: { query: { description: "A few plain words.", type: "string" } },
      required: ["query"],
      type: "object",
    },
  };

  const getOnCall: ToolDefinition = {
    description: "Who is on call (firefighter) right now, per region, from the team's on-call calendar.",
    handler: async () => {
      try {
        const shifts = await deps.getOnCallShifts();
        if (shifts.length === 0) {
          return "No on-call shift is known right now (the schedule may not be configured).";
        }
        const lines = shifts.flatMap((shift) => [
          `- ${shift.region}: ${shift.people.map((person) => person.name).join(", ") || "nobody named"} (${shift.start} to ${shift.end})`,
          `  ${sourceLine({ at: shift.start, kind: "oncall", label: `On-call calendar: ${shift.region} shift` })}`,
        ]);
        return wrapUntrusted("oncall-calendar", `On call now:\n${lines.join("\n")}`);
      } catch (error) {
        return `Error: the on-call schedule couldn't be read (${clip(errorText(error), 160)}).`;
      }
    },
    name: "get_oncall",
    parameters: NO_ARGS,
  };

  return [getTicketContext, readSlackConversation, getCp, searchSimilar, searchConfluence, getOnCall];
}
