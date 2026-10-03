import type { ParsedEmail } from "@/lib/email/mime";

/**
 * What the intake does with one inbound email, as pure rules - tested in
 * scripts/test-email.ts, executed by gmailSync.ts:
 *
 * 1. skip it: mail the support mailbox sent itself, Jira/Atlassian
 *    notifications (JSM already has those), auto-replies and bounces
 * 2. else place it:
 *    - a Gmail thread we already know -> append to that case (and if that
 *      case has no TS ticket yet but this message names one, link it)
 *    - a message naming a TS key ("[JIRA] (TS-123)", "TS-123") whose
 *      ticket is already in the case store -> append to that Jira case
 *    - anything else -> a new email case (carrying the named TS key, if
 *      any, so a later Jira sync of that ticket lands on the same row)
 * Idempotency (one row per Gmail message id) is the store's job.
 */

export type SkipReason = "auto_reply" | "bounce" | "jira_notification" | "no_sender" | "own_mailbox";

/* Free mailbox providers: the domain says nothing about which customer wrote. */
export const PUBLIC_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  "aol.com",
  "att.net",
  "comcast.net",
  "gmail.com",
  "gmx.com",
  "gmx.net",
  "googlemail.com",
  "hotmail.com",
  "icloud.com",
  "live.com",
  "mac.com",
  "mail.com",
  "me.com",
  "msn.com",
  "outlook.com",
  "proton.me",
  "protonmail.com",
  "rediffmail.com",
  "sbcglobal.net",
  "verizon.net",
  "yahoo.co.in",
  "yahoo.com",
  "yandex.com",
  "ymail.com",
  "zoho.com",
]);

const OWN_DOMAIN = "certifyos.com";

function domainOf(email: string): string {
  return email.slice(email.lastIndexOf("@") + 1).toLowerCase();
}

function localPartOf(email: string): string {
  return email.slice(0, email.lastIndexOf("@")).toLowerCase();
}

function isAtlassianDomain(domain: string): boolean {
  return domain === "atlassian.net" || domain.endsWith(".atlassian.net") || domain === "atlassian.com" || domain.endsWith(".atlassian.com");
}

/** Why this message isn't a customer email, or null when it is one. Pure. */
export function skipReason(email: Pick<ParsedEmail, "from" | "headers" | "labelIds" | "subject">, supportAddress: string): SkipReason | null {
  const from = email.from?.email.toLowerCase();
  if (!from) {
    return "no_sender";
  }
  if (from === supportAddress.toLowerCase() || email.labelIds.includes("SENT") || email.labelIds.includes("DRAFT")) {
    return "own_mailbox";
  }
  const local = localPartOf(from);
  const domain = domainOf(from);
  if (local === "mailer-daemon" || local === "postmaster" || /multipart\/report/i.test(email.headers["content-type"] ?? "") || email.headers["x-failed-recipients"]) {
    return "bounce";
  }
  if (isAtlassianDomain(domain) || local === "jira" || email.headers["x-jira-fingerprint"] !== undefined) {
    return "jira_notification";
  }
  const autoSubmitted = (email.headers["auto-submitted"] ?? "").trim().toLowerCase();
  const precedence = (email.headers.precedence ?? "").trim().toLowerCase();
  if (
    (autoSubmitted && autoSubmitted !== "no") ||
    precedence === "bulk" ||
    precedence === "auto_reply" ||
    precedence === "junk" ||
    email.headers["x-autoreply"] !== undefined ||
    email.headers["x-autorespond"] !== undefined ||
    /^(?:automatic reply|auto(?:matic)?[- ]?reply|out of (?:the )?office)\b/i.test(email.subject)
  ) {
    return "auto_reply";
  }
  return null;
}

/** TS keys named in a text, upper-cased, first mention first, once each. Pure. */
export function findTicketKeys(text: string): string[] {
  const keys: string[] = [];
  for (const match of text.matchAll(/(?<![A-Za-z0-9-])TS-(\d{1,7})(?!\d)/gi)) {
    const key = `TS-${match[1]}`;
    if (!keys.includes(key)) {
      keys.push(key);
    }
  }
  return keys;
}

/** The TS ticket a message is about: the subject's first key ("[JIRA] (TS-123) ..."), else the new content's. Quoted history doesn't count. Pure. */
export function intakeTicketKey(email: Pick<ParsedEmail, "newContent" | "subject">): string | null {
  return findTicketKeys(email.subject)[0] ?? findTicketKeys(email.newContent)[0] ?? null;
}

/** The sender's company domain as an account hint, or null for a free-mail or our own domain. Pure. */
export function accountSuggestion(email: string | null | undefined): string | null {
  if (!email || !email.includes("@")) {
    return null;
  }
  const domain = domainOf(email);
  return !domain || PUBLIC_EMAIL_DOMAINS.has(domain) || domain === OWN_DOMAIN ? null : domain;
}

/* ------------------------------------------------------------- placing */

/** A case as far as placement cares. */
export interface CaseRef {
  id: string;
  jiraKey: string | null;
}

export interface IntakeContext {
  /* The case holding this TS key, if the store has one. Only looked up when the message names a key. */
  keyCase: CaseRef | null;
  /* The case this Gmail thread already belongs to. */
  threadCase: CaseRef | null;
}

export type IntakePlan =
  /* linkKey: the thread's case has no TS ticket yet and this message names one - link it (merging into that Jira case if the store has it). */
  | { caseId: string; kind: "append"; linkKey: string | null }
  | { caseId: string; jiraKey: string; kind: "append_to_jira" }
  | { accountSuggestion: string | null; jiraKey: string | null; kind: "create"; summary: string };

const SUMMARY_MAX_CHARS = 1_000;

/** Where one (not skipped) message goes. Pure. */
export function planIntake(email: Pick<ParsedEmail, "from" | "newContent" | "subject">, context: IntakeContext): IntakePlan {
  const key = intakeTicketKey(email);
  if (context.threadCase) {
    const linkKey = !context.threadCase.jiraKey && key && context.keyCase?.id !== context.threadCase.id ? key : null;
    return { caseId: context.threadCase.id, kind: "append", linkKey };
  }
  if (key && context.keyCase) {
    return { caseId: context.keyCase.id, jiraKey: key, kind: "append_to_jira" };
  }
  return {
    accountSuggestion: accountSuggestion(email.from?.email),
    jiraKey: key,
    kind: "create",
    summary: (email.subject || "(no subject)").slice(0, SUMMARY_MAX_CHARS),
  };
}
