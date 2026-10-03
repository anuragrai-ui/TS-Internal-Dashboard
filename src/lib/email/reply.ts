import { getDb, sql, textOrNull } from "@/lib/db/client";
import { createGmailClient, GmailApiError } from "@/lib/email/gmailApi";
import { emailCaseKey } from "@/lib/email/keys";
import { defaultGoogleDeps, getGoogleAccessToken, invalidateGoogleAccessToken, supportMailboxAddress } from "@/lib/google/oauth";

import type { SqlExecutor } from "@/lib/db/client";
import type { EmailMessageMetadata } from "@/lib/email/store";
import type { ActionActor, ActionArgs, EmailAddress } from "@/lib/workspace/types";

/**
 * email_reply: a person's reply to the customer, sent from the support
 * mailbox through Gmail (users.messages.send) into the customer's thread.
 * It runs inside the action pipeline (src/lib/actions/service.ts), which has
 * already done validation, idempotency, the rate limit and the customer
 * leak check; this adds the email-specific gates and the send:
 *
 * - EMAIL_SEND_ENABLED must be "true" - until then the inbox is read-only
 *   (shadow mode) and every reply fails with a message saying how to go live
 * - EMAIL_TEST_RECIPIENT, when set, receives every reply instead of the
 *   customer (the execution is marked redirectedToTestChannel), with a line
 *   at the top naming who it would have gone to
 *
 * The message: From the support mailbox, To the last customer who wrote,
 * "Re: <subject>", In-Reply-To / References from that customer message (so
 * every mail client threads it), plain text with the sender's name, and
 * Gmail's threadId so it lands in the same Gmail thread. Then it is recorded
 * as a public case_message (source 'email').
 */

export const SHADOW_MODE_MESSAGE = "Email sending is off (shadow mode) - set EMAIL_SEND_ENABLED=true in Vercel to go live";
const SUPPORT_DISPLAY_NAME = "CertifyOS Technical Support";
const UNCONFIRMED = "Gmail didn't confirm the send - it may have gone out. Check the support mailbox's Sent folder before replying again.";

/* What a reply needs to know about its case. */
export interface ReplyCase {
  caseId: string;
  jiraKey: string | null;
  /* The latest message from someone other than the support mailbox. Null: nobody to reply to. */
  lastInbound: { from: EmailAddress; messageId: string | null; references: string[]; subject: string; threadId: string } | null;
  summary: string;
}

export type EmailWriteResult =
  | { error: string; redirectedToTestChannel?: boolean; status: "failed" | "uncertain" }
  | { externalId: string; externalUrl?: string; redirectedToTestChannel: boolean; status: "succeeded" };

export interface SentEmailRecord {
  actorName: string;
  bodyText: string;
  caseId: string;
  createdAt: string;
  gmailId: string;
  metadata: EmailMessageMetadata;
}

export interface EmailReplyDeps {
  env: Record<string, string | undefined>;
  loadCase: (caseId: string) => Promise<ReplyCase | null>;
  now: () => Date;
  record: (sent: SentEmailRecord) => Promise<void>;
  /* Throws GmailApiError: status null = no answer (may have been sent). */
  send: (raw: string, threadId: string) => Promise<{ id: string; threadId: string }>;
}

/* ------------------------------------------------------------ pure text */

/** A header value with line breaks removed - nothing a person or a customer typed can add a header. Pure. */
export function headerSafe(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

/** RFC 2047 for non-ASCII header text (a subject with "é", a name with "ü"); ASCII is left as is. Pure. */
export function encodeHeaderWord(value: string): string {
  const safe = headerSafe(value);
  return /^[\x20-\x7e]*$/.test(safe) ? safe : `=?UTF-8?B?${Buffer.from(safe, "utf8").toString("base64")}?=`;
}

/** "Re: <subject>", without stacking "Re: Re:". Pure. */
export function replySubject(subject: string): string {
  const clean = headerSafe(subject) || "Your support request";
  return /^re:/i.test(clean) ? clean : `Re: ${clean}`;
}

/** The body as sent: the reply, then the sign-off with the person's name. Pure. */
export function replyBodyText(body: string, actorName: string): string {
  return `${body.replace(/\r\n?/g, "\n").trimEnd()}\n\n— ${actorName.trim() || "The support team"}, CertifyOS Technical Support\n`;
}

function formatAddress(address: EmailAddress): string {
  const email = headerSafe(address.email).replace(/[<>]/g, "");
  return address.name ? `${encodeHeaderWord(address.name.replace(/"/g, "'"))} <${email}>` : email;
}

function base64Lines(text: string): string {
  return (Buffer.from(text, "utf8").toString("base64").match(/.{1,76}/g) ?? []).join("\r\n");
}

/* Only well-formed message ids go into In-Reply-To / References. */
function messageIds(ids: readonly string[]): string[] {
  return ids.filter((id) => /^<[^<>\s]{1,500}>$/.test(id));
}

export interface ReplyMessageInput {
  body: string;
  date: Date;
  from: string;
  inReplyTo: string | null;
  references: string[];
  subject: string;
  to: EmailAddress;
}

/** The RFC 2822 message (CRLF line ends, UTF-8 body in base64). Pure. */
export function buildReplyMessage(input: ReplyMessageInput): string {
  const references = messageIds([...input.references, ...(input.inReplyTo ? [input.inReplyTo] : [])]);
  const unique = references.filter((id, index) => references.indexOf(id) === index).slice(-20);
  const headers = [
    `From: ${formatAddress({ email: input.from, name: SUPPORT_DISPLAY_NAME })}`,
    `To: ${formatAddress(input.to)}`,
    `Subject: ${encodeHeaderWord(replySubject(input.subject))}`,
    `Date: ${input.date.toUTCString().replace("GMT", "+0000")}`,
    ...(input.inReplyTo && messageIds([input.inReplyTo]).length > 0 ? [`In-Reply-To: ${input.inReplyTo}`] : []),
    ...(unique.length > 0 ? [`References: ${unique.join(" ")}`] : []),
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
  ];
  return `${headers.join("\r\n")}\r\n\r\n${base64Lines(input.body)}\r\n`;
}

/** base64url, as users.messages.send wants `raw`. Pure. */
export function toBase64Url(text: string): string {
  return Buffer.from(text, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Where a person with access to the support mailbox can see the thread. Pure. */
export function gmailThreadUrl(supportAddress: string, threadId: string): string {
  return `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(supportAddress)}#all/${encodeURIComponent(threadId)}`;
}

/* ------------------------------------------------------------------ send */

/** Sends one email_reply. Never throws. */
export async function sendEmailReply(args: ActionArgs, context: { actor: ActionActor; ticketKey: string }, deps: EmailReplyDeps): Promise<EmailWriteResult> {
  if (args.operation !== "email_reply") {
    return { error: `${args.operation} isn't an email action.`, status: "failed" };
  }
  if (deps.env.EMAIL_SEND_ENABLED?.trim() !== "true") {
    return { error: SHADOW_MODE_MESSAGE, status: "failed" };
  }
  const supportAddress = supportMailboxAddress(deps.env);
  if (!supportAddress) {
    return { error: "SUPPORT_MAILBOX_ADDRESS isn't set on the server.", status: "failed" };
  }

  let replyCase: ReplyCase | null;
  try {
    replyCase = await deps.loadCase(args.caseId);
  } catch {
    return { error: "Couldn't read the email case - nothing was sent. Try again in a moment.", status: "failed" };
  }
  if (!replyCase) {
    return { error: "That email case doesn't exist (any more) - nothing was sent.", status: "failed" };
  }
  /* The key in the audit trail must be this case's: a stale EM- key after a link, or another ticket's key, is refused. */
  const expectedKey = emailCaseKey(replyCase.caseId, replyCase.jiraKey);
  if (expectedKey !== context.ticketKey) {
    return { error: `This email case is ${expectedKey} now, not ${context.ticketKey} - reload the inbox and send again.`, status: "failed" };
  }
  const inbound = replyCase.lastInbound;
  if (!inbound) {
    return { error: "No customer email on this case to reply to - nothing was sent.", status: "failed" };
  }

  const testRecipient = deps.env.EMAIL_TEST_RECIPIENT?.trim().toLowerCase() || null;
  const to: EmailAddress = testRecipient ? { email: testRecipient, name: null } : inbound.from;
  const signed = replyBodyText(args.body, context.actor.displayName);
  const body = testRecipient ? `[Test mode - this reply would have gone to ${inbound.from.email}]\n\n${signed}` : signed;
  const subject = inbound.subject || replyCase.summary;
  const now = deps.now();
  const raw = buildReplyMessage({ body, date: now, from: supportAddress, inReplyTo: inbound.messageId, references: inbound.references, subject, to });

  let sent: { id: string; threadId: string };
  try {
    sent = await deps.send(toBase64Url(raw), inbound.threadId);
  } catch (error) {
    if (error instanceof GmailApiError && error.status !== null) {
      return { error: `Not sent: ${error.message}`, redirectedToTestChannel: Boolean(testRecipient), status: "failed" };
    }
    return { error: UNCONFIRMED, redirectedToTestChannel: Boolean(testRecipient), status: "uncertain" };
  }

  try {
    await deps.record({
      actorName: context.actor.displayName,
      bodyText: body,
      caseId: replyCase.caseId,
      createdAt: now.toISOString(),
      gmailId: sent.id,
      metadata: {
        attachments: [],
        cc: [],
        date: now.toISOString(),
        direction: "outbound",
        from: { email: supportAddress, name: SUPPORT_DISPLAY_NAME },
        gmail_id: sent.id,
        in_reply_to: inbound.messageId,
        message_id: null,
        references: messageIds([...inbound.references, ...(inbound.messageId ? [inbound.messageId] : [])]),
        sent_by: context.actor.displayName,
        subject: replySubject(subject),
        thread_id: sent.threadId || inbound.threadId,
        to: [to],
      },
    });
  } catch (error) {
    /* Sent is sent; the intake will also see it in the mailbox (and skip it as our own mail), so only the inbox copy is late. */
    console.warn(`Email reply: sent ${sent.id} but couldn't record it on case ${replyCase.caseId}.`, error instanceof Error ? error.name : "unknown");
  }
  return {
    externalId: sent.id,
    externalUrl: gmailThreadUrl(supportAddress, sent.threadId || inbound.threadId),
    redirectedToTestChannel: Boolean(testRecipient),
    status: "succeeded",
  };
}

/* --------------------------------------------------------------- wiring */

/** The case and its latest customer email, from the case store. Throws on a database failure. */
export async function loadReplyCase(db: SqlExecutor, caseId: string, supportAddress: string): Promise<ReplyCase | null> {
  const cases = await db.query(sql("email.reply.case", "SELECT id, jira_key, summary FROM cases WHERE id = $1::uuid", [caseId]));
  const row = cases[0];
  if (!row) {
    return null;
  }
  const messages = await db.query<{ created_at: unknown; metadata: unknown }>(
    sql(
      "email.reply.last_inbound",
      `SELECT metadata, created_at FROM case_messages
       WHERE case_id = $1::uuid AND source = 'email' AND metadata->>'direction' = 'inbound'
         AND lower(coalesce(metadata->'from'->>'email', '')) <> $2
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      [caseId, supportAddress],
    ),
  );
  const raw = messages[0]?.metadata;
  const meta = (typeof raw === "string" ? JSON.parse(raw) : raw) as Partial<EmailMessageMetadata> | null | undefined;
  const from = meta?.from && typeof meta.from.email === "string" ? meta.from : null;
  return {
    caseId: String(row.id),
    jiraKey: textOrNull(row.jira_key),
    lastInbound:
      meta && from && typeof meta.thread_id === "string"
        ? {
            from,
            messageId: typeof meta.message_id === "string" ? meta.message_id : null,
            references: Array.isArray(meta.references) ? meta.references.filter((id): id is string => typeof id === "string") : [],
            subject: typeof meta.subject === "string" ? meta.subject : "",
            threadId: meta.thread_id,
          }
        : null,
    summary: textOrNull(row.summary) ?? "",
  };
}

/** Records a sent reply as a public email message on its case. Throws on a database failure. */
export async function recordSentReply(db: SqlExecutor, sent: SentEmailRecord): Promise<void> {
  await db.query(
    sql(
      "email.reply.record",
      `INSERT INTO case_messages (case_id, source, external_id, author_name, author_account_id, visibility, body_text, created_at, metadata)
       VALUES ($1::uuid, 'email', $2, $3, NULL, 'public', $4, $5::timestamptz, $6::jsonb)
       ON CONFLICT (source, external_id) DO NOTHING`,
      [sent.caseId, sent.gmailId, sent.actorName.slice(0, 200), sent.bodyText.slice(0, 20_000), sent.createdAt, JSON.stringify(sent.metadata)],
    ),
  );
}

/** The real database, Gmail and env. */
export function defaultEmailReplyDeps(): EmailReplyDeps {
  const google = defaultGoogleDeps();
  const gmail = createGmailClient({ accessToken: () => getGoogleAccessToken(google, "mailbox"), onUnauthorized: () => invalidateGoogleAccessToken(google, "mailbox") });
  const requireDb = (): SqlExecutor => {
    const db = getDb();
    if (!db) {
      throw new Error("The case store database is not configured (DATABASE_URL is unset).");
    }
    return db;
  };
  return {
    env: process.env,
    loadCase: (caseId) => loadReplyCase(requireDb(), caseId, supportMailboxAddress() ?? ""),
    now: () => new Date(),
    record: (sent) => recordSentReply(requireDb(), sent),
    send: (raw, threadId) => gmail.send(raw, threadId),
  };
}
