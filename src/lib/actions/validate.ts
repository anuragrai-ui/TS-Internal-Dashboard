import type { TrackerPriority } from "@/lib/tracker/types";
import type { ActionArgs, ActionOperation } from "@/lib/workspace/types";

/**
 * The one gate every write goes through before anything is sent: a person's
 * own click (POST /api/actions), an AI Assist proposal, a browser-agent
 * proposal and an edited proposal all land here. Pure, and client-safe, so
 * the composer can show the same limits the server enforces.
 *
 * It returns a fresh object holding only the fields the operation uses
 * (trimmed), never the caller's object: whatever an agent stuffed next to
 * the real fields can't ride along into the audit log or a Jira body.
 */

export const TICKET_KEY_PATTERN = /^TS-\d+$/;
export const CP_KEY_PATTERN = /^CP-\d+$/;
/* Public (C) and private (G) channels only - never a DM. */
export const SLACK_CHANNEL_PATTERN = /^[CG][A-Z0-9]{6,}$/;
export const SLACK_TS_PATTERN = /^\d{9,11}\.\d{1,6}$/;
/* Client-generated per intended write (crypto.randomUUID() is 36 chars). */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_.:-]{8,128}$/;
/* Jira Cloud account ids: "5b10ac8d82e05b22cc7d4ef5" or "712020:2c0f0b1e-...". */
const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9:_-]{1,128}$/;

export const BODY_MAX_CHARS = 10_000;
const NAME_MAX_CHARS = 200;

export const ACTION_PRIORITIES: readonly TrackerPriority[] = ["Critical", "High", "Medium", "Low"];

const FIELDS: Record<ActionOperation, { optional: readonly string[]; required: readonly string[] }> = {
  firefighter_escalation: { optional: [], required: ["body", "mentionOnCall"] },
  jira_assign: { optional: ["displayName"], required: ["accountId"] },
  jira_comment: { optional: [], required: ["body", "visibility"] },
  jira_link_cp: { optional: [], required: ["cpKey"] },
  jira_priority: { optional: [], required: ["priority"] },
  jira_transition: { optional: [], required: ["transitionId", "transitionName"] },
  slack_thread_reply: { optional: [], required: ["body", "channel", "threadTs"] },
};

export const ACTION_OPERATIONS = Object.keys(FIELDS) as ActionOperation[];

export type ValidateResult = { args: ActionArgs; ok: true } | { error: string; ok: false };

export function isActionOperation(value: unknown): value is ActionOperation {
  return typeof value === "string" && Object.hasOwn(FIELDS, value);
}

export function isIdempotencyKey(value: unknown): value is string {
  return typeof value === "string" && IDEMPOTENCY_KEY_PATTERN.test(value);
}

/* Jira writes go out with the person's own token and get the version check; the rest are Slack posts by the bot. */
export function isJiraOperation(operation: ActionOperation): boolean {
  return operation.startsWith("jira_");
}

class Invalid extends Error {}

function text(record: Record<string, unknown>, field: string, max: number): string {
  const value = record[field];
  if (typeof value !== "string") {
    throw new Invalid(`"${field}" must be a string.`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Invalid(`"${field}" can't be empty.`);
  }
  if (trimmed.length > max) {
    throw new Invalid(`"${field}" is ${trimmed.length.toLocaleString("en-US")} characters; the limit is ${max.toLocaleString("en-US")}.`);
  }
  return trimmed;
}

function matching(record: Record<string, unknown>, field: string, pattern: RegExp, hint: string, normalize: (value: string) => string = (value) => value): string {
  const value = record[field];
  const normalized = typeof value === "string" ? normalize(value.trim()) : "";
  if (!pattern.test(normalized)) {
    throw new Invalid(`"${field}" must be ${hint}.`);
  }
  return normalized;
}

function argsFor(operation: ActionOperation, record: Record<string, unknown>): ActionArgs {
  switch (operation) {
    case "jira_comment": {
      const visibility = record.visibility;
      if (visibility !== "internal" && visibility !== "public") {
        throw new Invalid('"visibility" must be "internal" or "public".');
      }
      return { body: text(record, "body", BODY_MAX_CHARS), operation, visibility };
    }
    case "jira_transition": {
      const transitionId = matching(record, "transitionId", /^\d{1,10}$/, "a numeric Jira transition id");
      return { operation, transitionId, transitionName: text(record, "transitionName", NAME_MAX_CHARS) };
    }
    case "jira_assign": {
      const accountId = record.accountId === null ? null : matching(record, "accountId", ACCOUNT_ID_PATTERN, "a Jira account id, or null to unassign");
      if (record.displayName !== undefined && typeof record.displayName !== "string") {
        throw new Invalid('"displayName" must be a string when given.');
      }
      const displayName = typeof record.displayName === "string" ? record.displayName.trim().slice(0, NAME_MAX_CHARS) : "";
      return { accountId, ...(displayName && accountId !== null ? { displayName } : {}), operation };
    }
    case "jira_priority": {
      const priority = record.priority;
      if (typeof priority !== "string" || !ACTION_PRIORITIES.includes(priority as TrackerPriority)) {
        throw new Invalid(`"priority" must be one of ${ACTION_PRIORITIES.join(", ")}.`);
      }
      return { operation, priority: priority as TrackerPriority };
    }
    case "jira_link_cp":
      return { cpKey: matching(record, "cpKey", CP_KEY_PATTERN, "a CP key like CP-123", (value) => value.toUpperCase()), operation };
    case "slack_thread_reply":
      return {
        body: text(record, "body", BODY_MAX_CHARS),
        channel: matching(record, "channel", SLACK_CHANNEL_PATTERN, "a Slack channel id like C0123ABCD"),
        operation,
        threadTs: matching(record, "threadTs", SLACK_TS_PATTERN, 'a Slack message ts like "1727881200.000100"'),
      };
    case "firefighter_escalation":
      if (typeof record.mentionOnCall !== "boolean") {
        throw new Invalid('"mentionOnCall" must be true or false.');
      }
      return { body: text(record, "body", BODY_MAX_CHARS), mentionOnCall: record.mentionOnCall, operation };
  }
}

/** Checks a ticket key and one operation's arguments; returns a clean copy of the args, or a message saying what's wrong. Pure. */
export function validateActionArgs(ticketKey: string, args: unknown): { ok: true; args: ActionArgs } | { ok: false; error: string } {
  if (typeof ticketKey !== "string" || !TICKET_KEY_PATTERN.test(ticketKey)) {
    return { error: "Actions only apply to TS tickets (a key like TS-123).", ok: false };
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return { error: "Expected the action's arguments as an object.", ok: false };
  }

  const record = args as Record<string, unknown>;
  const operation = record.operation;
  if (!isActionOperation(operation)) {
    return {
      error: `Unknown operation ${typeof operation === "string" ? `"${operation.slice(0, 40)}"` : "(missing)"}. Expected one of ${ACTION_OPERATIONS.join(", ")}.`,
      ok: false,
    };
  }

  const { optional, required } = FIELDS[operation];
  const allowed = new Set(["operation", ...required, ...optional]);
  const unexpected = Object.keys(record).filter((field) => !allowed.has(field));
  if (unexpected.length > 0) {
    return { error: `Unexpected field${unexpected.length === 1 ? "" : "s"} for ${operation}: ${unexpected.slice(0, 5).join(", ")}.`, ok: false };
  }
  const missing = required.filter((field) => record[field] === undefined);
  if (missing.length > 0) {
    return { error: `Missing for ${operation}: ${missing.join(", ")}.`, ok: false };
  }

  try {
    return { args: argsFor(operation, record), ok: true };
  } catch (error) {
    if (error instanceof Invalid) {
      return { error: `${operation}: ${error.message}`, ok: false };
    }
    throw error;
  }
}
