import { executeActionWith } from "@/lib/actions/service";
import { validateActionArgs } from "@/lib/actions/validate";
import { validateMigrations } from "@/lib/db/migrate";
import { MIGRATIONS } from "@/lib/db/migrations";
import { GmailApiError } from "@/lib/email/gmailApi";
import { gmailSyncTickWith, INITIAL_QUERY, ingestMessage } from "@/lib/email/gmailSync";
import { linkEmailCaseWith } from "@/lib/email/inbox";
import { emailCaseKey } from "@/lib/email/keys";
import {
  decodeEncodedWords,
  decodeQuotedPrintable,
  extractContent,
  htmlToText,
  parseAddressList,
  parseEmailNode,
  parseGmailMessage,
  parseRawMime,
  splitQuotedText,
} from "@/lib/email/mime";
import { accountSuggestion, findTicketKeys, intakeTicketKey, planIntake, skipReason } from "@/lib/email/rules";
import { buildReplyMessage, replySubject, SHADOW_MODE_MESSAGE, sendEmailReply } from "@/lib/email/reply";
import { emptyEmailSyncState } from "@/lib/email/store";

import type { ActionServiceDeps } from "@/lib/actions/service";
import type { ActionStore } from "@/lib/actions/store";
import type { GmailClient, GmailHistoryPage } from "@/lib/email/gmailApi";
import type { EmailSyncLocks } from "@/lib/email/gmailSync";
import type { GmailMessage, ParsedEmail } from "@/lib/email/mime";
import type { EmailReplyDeps, ReplyCase, SentEmailRecord } from "@/lib/email/reply";
import type { CaseRef, IntakePlan } from "@/lib/email/rules";
import type { EmailMessageRecord, EmailStore, EmailSyncState, LinkOutcome } from "@/lib/email/store";
import type { ActionActor, ActionArgs, EmailAddress } from "@/lib/workspace/types";

/**
 * Tests for email intake and replies: MIME parsing (multipart, base64,
 * quoted-printable, charsets, the HTML fallback, attachments), quote
 * stripping, the skip rules, placing mail on cases (thread append, TS-key
 * link, new case, contact and account suggestion, idempotency), the Gmail
 * sync (initial window, history, history expiry, budget), linking, the
 * reply message and its gates (shadow mode, test recipient, key check,
 * leak check through the action pipeline) and migration 0002's text.
 * Fakes only - no Gmail, no Postgres.
 *
 *   npx tsx scripts/test-email.ts
 */

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} failed: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assert(condition: boolean, label: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${label}`);
  }
}

const SUPPORT = "support@certifyos.com";
const NOW = Date.parse("2026-10-03T12:00:00.000Z");

/* ------------------------------------------------------------------- mime */

const MULTIPART = [
  "From: =?UTF-8?Q?Ren=C3=A9e_D=C3=BCrr?= <Renee@Acme-Health.com>",
  'To: "CertifyOS Support" <support@certifyos.com>, ops@acme-health.com',
  "Cc: boss@acme-health.com",
  "Subject: =?UTF-8?B?Q2Fmw6kgcm9zdGVy?= =?UTF-8?B?IGltcG9ydA==?=",
  "Date: Fri, 02 Oct 2026 14:00:00 -0400",
  "Message-ID: <abc123@mail.acme-health.com>",
  "In-Reply-To: <prev1@certifyos.com>",
  "References: <root@certifyos.com>",
  " <prev1@certifyos.com>",
  "MIME-Version: 1.0",
  'Content-Type: multipart/mixed; boundary="outer"',
  "",
  "--outer",
  'Content-Type: multipart/alternative; boundary="inner"',
  "",
  "--inner",
  "Content-Type: text/plain; charset=iso-8859-1",
  "Content-Transfer-Encoding: quoted-printable",
  "",
  "Our caf=E9 roster import failed again. This line is long enough that it =",
  "wraps with a soft break.",
  "",
  "On Thu, Oct 1, 2026 at 9:00 AM CertifyOS Support <support@certifyos.com> wrote:",
  "> We fixed it.",
  "> Thanks",
  "--inner",
  "Content-Type: text/html; charset=utf-8",
  "",
  "<p>Our café roster import failed again.</p>",
  "--inner--",
  "",
  "--outer",
  'Content-Type: application/pdf; name="roster.pdf"',
  'Content-Disposition: attachment; filename="roster.pdf"',
  "Content-Transfer-Encoding: base64",
  "",
  "JVBERi0xLjQKJcfsj6IKNSAwIG9iago=",
  "--outer--",
  "",
].join("\r\n");

function testMime(): void {
  console.log("\n--- Test: MIME - multipart, quoted-printable, base64, charsets, HTML fallback, attachments ---");
  const email = parseEmailNode(parseRawMime(MULTIPART), { gmailId: "m1", threadId: "t1" }, NOW);
  assertEqual(email.from, { email: "renee@acme-health.com", name: "Renée Dürr" }, "From: encoded-word name, email lower-cased");
  assertEqual(email.to.map((to) => to.email), ["support@certifyos.com", "ops@acme-health.com"], "To list split outside quotes");
  assertEqual(email.cc, [{ email: "boss@acme-health.com", name: null }], "Cc");
  assertEqual(email.subject, "Café roster import", "adjacent encoded words joined");
  assertEqual(email.date, "2026-10-02T18:00:00.000Z", "Date header (no internalDate)");
  assertEqual([email.messageId, email.inReplyTo, email.references], ["<abc123@mail.acme-health.com>", "<prev1@certifyos.com>", ["<root@certifyos.com>", "<prev1@certifyos.com>"]], "threading headers (folded References)");
  assert(email.text.startsWith("Our café roster import failed again. This line is long enough that it wraps with a soft break."), "text/plain preferred; QP soft breaks and =E9 in iso-8859-1 decoded");
  assertEqual(email.newContent, "Our café roster import failed again. This line is long enough that it wraps with a soft break.", "quoted history cut");
  assert(email.quoted.includes("We fixed it."), "quoted part kept separately");
  assertEqual(email.attachments, [{ mime: "application/pdf", name: "roster.pdf", size: 23 }], "attachment: metadata only");

  const htmlOnly = [
    "From: x@y.com",
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(
      '<html><head><style>p{color:red}</style><title>t</title></head><body><script>alert("x")</script><p>Hi&nbsp;team,</p><p>Rows &amp; columns: &lt;b&gt;bold&lt;/b&gt; &#8212; &#x2713;</p><ul><li>one</li><li>two</li></ul><br>Thanks<!-- hidden --></body></html>',
      "utf8",
    ).toString("base64"),
  ].join("\r\n");
  const html = extractContent(parseRawMime(htmlOnly));
  assertEqual(html.text, "Hi team,\n\nRows & columns: <b>bold</b> — ✓\n\n- one\n- two\n\nThanks", "HTML fallback: scripts/styles gone, entities decoded, escaped tags stay text");
  assert(!html.text.includes("alert") && !html.text.includes("color:red"), "no script or style text");
  assertEqual(htmlToText("<div>a</div><div>b</div>"), "a\nb", "block ends become line breaks");

  assertEqual(new TextDecoder().decode(decodeQuotedPrintable("a=3Db=\r\nc =C3=A9")), "a=bc é", "QP: =3D, soft break, UTF-8 bytes");
  assertEqual(decodeEncodedWords("=?iso-8859-1?Q?Caf=E9_ouvert?="), "Café ouvert", "Q-encoded word in Latin-1");
  assertEqual(parseAddressList('"Doe, Jane" <jane@x.com>, bob@y.com (Bob)'), [{ email: "jane@x.com", name: "Doe, Jane" }, { email: "bob@y.com", name: "Bob" }], "comma inside a quoted name");

  const gmail: GmailMessage = {
    id: "g1",
    internalDate: String(Date.parse("2026-10-02T10:00:00.000Z")),
    labelIds: ["INBOX", "UNREAD"],
    payload: {
      headers: [
        { name: "From", value: "Jane <jane@acme.com>" },
        { name: "Subject", value: "Help" },
        { name: "Date", value: "Mon, 01 Jan 1990 00:00:00 +0000" },
      ],
      mimeType: "multipart/alternative",
      parts: [
        { body: { data: Buffer.from("Plain body ✓", "utf8").toString("base64url"), size: 14 }, headers: [{ name: "Content-Type", value: "text/plain; charset=UTF-8" }], mimeType: "text/plain" },
        { body: { data: Buffer.from("<b>HTML body</b>", "utf8").toString("base64url"), size: 16 }, headers: [{ name: "Content-Type", value: "text/html" }], mimeType: "text/html" },
        { body: { attachmentId: "att1", size: 2048 }, filename: "logo.png", headers: [{ name: "Content-Type", value: "image/png" }], mimeType: "image/png" },
      ],
    },
    threadId: "th1",
  };
  const parsed = parseGmailMessage(gmail, NOW);
  assertEqual([parsed.text, parsed.date, parsed.labelIds], ["Plain body ✓", "2026-10-02T10:00:00.000Z", ["INBOX", "UNREAD"]], "Gmail payload: base64url, internalDate beats the Date header");
  assertEqual(parsed.attachments, [{ mime: "image/png", name: "logo.png", size: 2048 }], "Gmail attachment: size from Gmail, body never fetched");

  const stillEncoded: GmailMessage = {
    id: "g2",
    payload: {
      body: { data: Buffer.from("caf=C3=A9 au =\r\nlait", "latin1").toString("base64url") },
      headers: [{ name: "Content-Type", value: "text/plain; charset=utf-8" }, { name: "Content-Transfer-Encoding", value: "quoted-printable" }],
      mimeType: "text/plain",
    },
    threadId: "t",
  };
  assertEqual(parseGmailMessage(stillEncoded, NOW).text, "café au lait", "a part that arrives still QP-encoded is decoded");
  console.log("PASS");
}

function testQuotes(): void {
  console.log("\n--- Test: quote stripping ---");
  const cases: Array<[string, string, string]> = [
    ["Thanks, that worked.\n\nOn Tue, 1 Oct 2026 at 10:00, Support <support@certifyos.com> wrote:\n> Try again\n> now", "Thanks, that worked.", "Gmail attribution"],
    ["Still broken.\n\nOn Tue, 1 Oct 2026 at 10:00, CertifyOS Technical Support\n<support@certifyos.com> wrote:\n\n> Try again", "Still broken.", "wrapped attribution"],
    ["See below.\n\n-----Original Message-----\nFrom: Support\nSent: Monday\nSubject: x\n\nold text", "See below.", "Outlook Original Message"],
    ["Any update?\n\n________________________________\nFrom: CertifyOS Support <support@certifyos.com>\nSent: Monday, October 1, 2026 9:00 AM\nTo: Jane\nSubject: RE: roster\n\nold", "Any update?", "Outlook rule + From"],
    ["Quick question.\n\nFrom: CertifyOS Support <support@certifyos.com>\nSent: Monday, October 1, 2026 9:00 AM\nTo: Jane\n\nold", "Quick question.", "Outlook From/Sent block"],
    ["On Tue, 1 Oct 2026, Support wrote:\n> Is it fixed?\n\nYes, fixed now.\n\n> Anything else?\n\nNo.", "Yes, fixed now.\n\nNo.", "bottom-posting keeps the answers"],
    ["> only a quote\n> nothing else", "> only a quote\n> nothing else", "nothing new: the whole text"],
  ];
  for (const [input, expected, label] of cases) {
    assertEqual(splitQuotedText(input).newContent, expected, label);
  }
  console.log("PASS");
}

/* ------------------------------------------------------------------ rules */

function parsed(overrides: Partial<ParsedEmail> = {}): ParsedEmail {
  return {
    attachments: [],
    cc: [],
    date: "2026-10-02T10:00:00.000Z",
    from: { email: "jane@acme-health.com", name: "Jane Doe" },
    gmailId: "m1",
    headers: {},
    inReplyTo: null,
    labelIds: ["INBOX"],
    messageId: "<m1@acme-health.com>",
    newContent: "Roster import fails.",
    quoted: "",
    references: [],
    replyTo: [],
    subject: "Roster import",
    text: "Roster import fails.",
    threadId: "t1",
    to: [{ email: SUPPORT, name: null }],
    ...overrides,
  };
}

function testRules(): void {
  console.log("\n--- Test: skip rules, TS keys, account suggestion, placement ---");
  assertEqual(skipReason(parsed(), SUPPORT), null, "a customer email is kept");
  assertEqual(skipReason(parsed({ from: { email: "support@certifyos.com", name: null } }), "Support@CertifyOS.com"), "own_mailbox", "our own mail");
  assertEqual(skipReason(parsed({ labelIds: ["SENT"] }), SUPPORT), "own_mailbox", "SENT label");
  assertEqual(skipReason(parsed({ from: { email: "jira@certifyos.atlassian.net", name: "Jira" } }), SUPPORT), "jira_notification", "Jira notification");
  assertEqual(skipReason(parsed({ headers: { "x-jira-fingerprint": "abc" } }), SUPPORT), "jira_notification", "Jira fingerprint header");
  assertEqual(skipReason(parsed({ headers: { "auto-submitted": "auto-replied" } }), SUPPORT), "auto_reply", "Auto-Submitted");
  assertEqual(skipReason(parsed({ headers: { "auto-submitted": "no" } }), SUPPORT), null, "Auto-Submitted: no is a person");
  assertEqual(skipReason(parsed({ headers: { precedence: "bulk" } }), SUPPORT), "auto_reply", "Precedence: bulk");
  assertEqual(skipReason(parsed({ headers: { precedence: "auto_reply" } }), SUPPORT), "auto_reply", "Precedence: auto_reply");
  assertEqual(skipReason(parsed({ headers: { "x-autoreply": "yes" } }), SUPPORT), "auto_reply", "X-Autoreply");
  assertEqual(skipReason(parsed({ subject: "Automatic reply: Roster import" }), SUPPORT), "auto_reply", "Outlook auto-reply subject");
  assertEqual(skipReason(parsed({ from: { email: "MAILER-DAEMON@googlemail.com", name: null } }), SUPPORT), "bounce", "mailer-daemon");
  assertEqual(skipReason(parsed({ from: { email: "postmaster@acme.com", name: null } }), SUPPORT), "bounce", "postmaster");
  assertEqual(skipReason(parsed({ from: null }), SUPPORT), "no_sender", "no sender");

  assertEqual(findTicketKeys("[JIRA] (TS-123) Roster; see ts-45 and TS-123, not XTS-9 or TS-1234567890"), ["TS-123", "TS-45"], "TS keys, once each, word-bounded");
  assertEqual(intakeTicketKey(parsed({ newContent: "about TS-9", subject: "Re: [JIRA] (TS-123) Roster" })), "TS-123", "the subject's key wins");
  assertEqual(intakeTicketKey(parsed({ newContent: "This is about TS-77", quoted: "TS-1" })), "TS-77", "else the new content's (quotes don't count)");
  assertEqual([accountSuggestion("jane@Acme-Health.com"), accountSuggestion("jane@gmail.com"), accountSuggestion("a@certifyos.com"), accountSuggestion(null)], ["acme-health.com", null, null, null], "account suggestion: company domains only");

  const thread: CaseRef = { id: "case-thread", jiraKey: null };
  const jira: CaseRef = { id: "case-jira", jiraKey: "TS-123" };
  assertEqual(planIntake(parsed(), { keyCase: null, threadCase: thread }), { caseId: "case-thread", kind: "append", linkKey: null }, "known thread: append");
  assertEqual(planIntake(parsed({ subject: "Re: TS-123" }), { keyCase: jira, threadCase: thread }), { caseId: "case-thread", kind: "append", linkKey: "TS-123" }, "known unlinked thread naming a key: append, then link");
  assertEqual(planIntake(parsed({ subject: "Re: TS-123" }), { keyCase: null, threadCase: { id: "x", jiraKey: "TS-9" } }), { caseId: "x", kind: "append", linkKey: null }, "already-linked thread stays");
  assertEqual(planIntake(parsed({ subject: "[JIRA] (TS-123) Roster" }), { keyCase: jira, threadCase: null }), { caseId: "case-jira", jiraKey: "TS-123", kind: "append_to_jira" }, "TS key with a stored Jira case: append there");
  assertEqual(
    planIntake(parsed({ subject: "About TS-555" }), { keyCase: null, threadCase: null }),
    { accountSuggestion: "acme-health.com", jiraKey: "TS-555", kind: "create", summary: "About TS-555" },
    "TS key not in the store: a case carrying the key",
  );
  assertEqual(
    planIntake(parsed({ from: { email: "x@gmail.com", name: null }, subject: "" }), { keyCase: null, threadCase: null }),
    { accountSuggestion: null, jiraKey: null, kind: "create", summary: "(no subject)" },
    "new email case",
  );
  console.log("PASS");
}

/* ------------------------------------------------------------- fake store */

interface FakeCase {
  accountSuggestion: string | null;
  id: string;
  jiraKey: string | null;
  source: "email" | "jira";
  summary: string;
  threadId: string | null;
}

class FakeStore implements EmailStore {
  cases = new Map<string, FakeCase>();
  contacts = new Map<string, string>();
  messages = new Map<string, { caseId: string; record: EmailMessageRecord }>();
  state: EmailSyncState = emptyEmailSyncState();
  private next = 0;

  addJiraCase(key: string): string {
    const id = `jira-${key}`;
    this.cases.set(id, { accountSuggestion: null, id, jiraKey: key, source: "jira", summary: key, threadId: null });
    return id;
  }

  applyIntake(plan: IntakePlan, record: EmailMessageRecord, contact: EmailAddress | null): Promise<{ caseId: string }> {
    if (contact && !this.contacts.has(contact.email)) {
      this.contacts.set(contact.email, contact.name ?? contact.email);
    }
    let caseId: string;
    if (plan.kind === "create") {
      const existing = [...this.cases.values()].find((c) => c.threadId === record.metadata.thread_id);
      caseId = existing?.id ?? `00000000-0000-4000-8000-${String(++this.next).padStart(12, "0")}`;
      if (!existing) {
        this.cases.set(caseId, { accountSuggestion: plan.accountSuggestion, id: caseId, jiraKey: plan.jiraKey, source: "email", summary: plan.summary, threadId: record.metadata.thread_id });
      }
    } else {
      caseId = plan.caseId;
    }
    if (!this.messages.has(record.gmailId)) {
      this.messages.set(record.gmailId, { caseId, record });
    }
    return Promise.resolve({ caseId });
  }

  findCaseByJiraKey(jiraKey: string): Promise<CaseRef | null> {
    const found = [...this.cases.values()].find((c) => c.jiraKey === jiraKey);
    return Promise.resolve(found ? { id: found.id, jiraKey: found.jiraKey } : null);
  }

  findCaseByThread(threadId: string): Promise<CaseRef | null> {
    const own = [...this.cases.values()].find((c) => c.threadId === threadId);
    const viaMessage = [...this.messages.values()].find((m) => m.record.metadata.thread_id === threadId);
    const found = own ?? (viaMessage ? this.cases.get(viaMessage.caseId) : undefined);
    return Promise.resolve(found ? { id: found.id, jiraKey: found.jiraKey } : null);
  }

  hasMessage(gmailId: string): Promise<boolean> {
    return Promise.resolve(this.messages.has(gmailId));
  }

  linkCase(caseId: string, jiraKey: string): Promise<LinkOutcome> {
    const current = this.cases.get(caseId);
    if (!current) return Promise.resolve({ error: "missing", ok: false });
    if (current.jiraKey === jiraKey) return Promise.resolve({ caseId, merged: false, ok: true });
    if (current.jiraKey) return Promise.resolve({ error: `This case is already linked to ${current.jiraKey}.`, ok: false });
    const target = [...this.cases.values()].find((c) => c.jiraKey === jiraKey);
    if (!target) {
      current.jiraKey = jiraKey;
      return Promise.resolve({ caseId, merged: false, ok: true });
    }
    for (const message of this.messages.values()) {
      if (message.caseId === caseId) message.caseId = target.id;
    }
    this.cases.delete(caseId);
    target.threadId ??= current.threadId;
    return Promise.resolve({ caseId: target.id, merged: true, ok: true });
  }

  loadState(): Promise<EmailSyncState> {
    return Promise.resolve(structuredClone(this.state));
  }

  saveState(state: EmailSyncState): Promise<void> {
    this.state = structuredClone(state);
    return Promise.resolve();
  }
}

/* ------------------------------------------------------------- fake gmail */

function gmailMessage(id: string, threadId: string, from: string, subject: string, body: string, extra: { headers?: Record<string, string>; labelIds?: string[] } = {}): GmailMessage {
  return {
    id,
    internalDate: String(NOW - 60_000),
    labelIds: extra.labelIds ?? ["INBOX"],
    payload: {
      body: { data: Buffer.from(body, "utf8").toString("base64url") },
      headers: [
        { name: "From", value: from },
        { name: "To", value: SUPPORT },
        { name: "Subject", value: subject },
        { name: "Message-ID", value: `<${id}@mail.example>` },
        ...Object.entries(extra.headers ?? {}).map(([name, value]) => ({ name, value })),
      ],
      mimeType: "text/plain",
    },
    threadId,
  };
}

class FakeGmail implements GmailClient {
  calls: string[] = [];
  historyError: GmailApiError | null = null;
  historyPages: GmailHistoryPage[] = [];
  inbox: string[] = [];
  messages = new Map<string, GmailMessage>();
  profileHistoryId = "500";
  sent: Array<{ raw: string; threadId: string | null }> = [];

  add(message: GmailMessage): void {
    this.messages.set(message.id, message);
  }

  getMessage(id: string): Promise<GmailMessage> {
    this.calls.push(`get:${id}`);
    const message = this.messages.get(id);
    return message ? Promise.resolve(message) : Promise.reject(new GmailApiError("Gmail says that doesn't exist (404).", 404));
  }

  getProfile(): Promise<{ emailAddress: string; historyId: string }> {
    this.calls.push("profile");
    return Promise.resolve({ emailAddress: SUPPORT, historyId: this.profileHistoryId });
  }

  listHistory(startHistoryId: string): Promise<GmailHistoryPage> {
    this.calls.push(`history:${startHistoryId}`);
    if (this.historyError) return Promise.reject(this.historyError);
    return Promise.resolve(this.historyPages.shift() ?? { historyId: startHistoryId });
  }

  listMessages(query: string): Promise<{ messages?: Array<{ id: string; threadId: string }> }> {
    this.calls.push(`list:${query}`);
    /* Newest first, like Gmail. */
    return Promise.resolve({ messages: [...this.inbox].reverse().map((id) => ({ id, threadId: this.messages.get(id)?.threadId ?? "" })) });
  }

  send(raw: string, threadId: string | null): Promise<{ id: string; threadId: string }> {
    this.sent.push({ raw, threadId });
    return Promise.resolve({ id: `sent-${this.sent.length}`, threadId: threadId ?? "new" });
  }
}

function locks(): EmailSyncLocks & { held: Set<string> } {
  const held = new Set<string>();
  return {
    del: (key) => {
      held.delete(key);
      return Promise.resolve();
    },
    held,
    setIfAbsent: (key) => {
      if (held.has(key)) return Promise.resolve(false);
      held.add(key);
      return Promise.resolve(true);
    },
  };
}

async function testIngest(): Promise<void> {
  console.log("\n--- Test: ingest - new case, thread append, TS-key link, contacts, idempotency ---");
  const store = new FakeStore();
  const gmail = new FakeGmail();
  const jiraCase = store.addJiraCase("TS-123");
  const deps = { gmail, now: () => NOW, store, supportAddress: SUPPORT };

  gmail.add(gmailMessage("m1", "t1", "Jane Doe <jane@acme-health.com>", "Roster import fails", "Our roster import fails."));
  const first = await ingestMessage(deps, "m1");
  assert(first.kind === "stored", "stored");
  const created = [...store.cases.values()].find((c) => c.source === "email");
  assertEqual(
    [created?.jiraKey, created?.summary, created?.accountSuggestion, created?.threadId],
    [null, "Roster import fails", "acme-health.com", "t1"],
    "new email case: no Jira key, subject as summary, domain suggested",
  );
  assertEqual(store.contacts.get("jane@acme-health.com"), "Jane Doe", "contact upserted by sender email");
  const record = store.messages.get("m1")?.record;
  assertEqual([record?.metadata.direction, record?.metadata.message_id, record?.metadata.thread_id, record?.bodyText], ["inbound", "<m1@mail.example>", "t1", "Our roster import fails."], "message metadata");

  assertEqual(await ingestMessage(deps, "m1"), { kind: "duplicate" }, "the same Gmail message again: nothing written");
  assertEqual(gmail.calls.filter((call) => call === "get:m1").length, 1, "...and not even fetched again");

  gmail.add(gmailMessage("m2", "t1", "Jane Doe <jane@acme-health.com>", "Re: Roster import fails", "Any update?\n\nOn Thu, Support wrote:\n> Looking"));
  await ingestMessage(deps, "m2");
  assertEqual(store.messages.get("m2")?.caseId, created?.id, "same thread: appended to the case");
  assertEqual(store.messages.get("m2")?.record.bodyText, "Any update?", "quoted history not stored as the message");

  gmail.add(gmailMessage("m3", "t2", "Bob <bob@other.org>", "[JIRA] (TS-123) Roster import", "Following up on this ticket."));
  await ingestMessage(deps, "m3");
  assertEqual(store.messages.get("m3")?.caseId, jiraCase, "names a stored TS ticket: appended to the Jira case");
  assertEqual([...store.cases.values()].filter((c) => c.source === "email").length, 1, "...no separate case");
  gmail.add(gmailMessage("m4", "t2", "Bob <bob@other.org>", "Re: [JIRA] (TS-123) Roster import", "Thanks"));
  await ingestMessage(deps, "m4");
  assertEqual(store.messages.get("m4")?.caseId, jiraCase, "later mail in that thread finds the Jira case by thread");

  gmail.add(gmailMessage("m5", "t1", "Jane Doe <jane@acme-health.com>", "Re: Roster import fails - this is TS-123", "See subject"));
  const linked = await ingestMessage(deps, "m5");
  assertEqual(linked, { caseId: jiraCase, kind: "stored" }, "unlinked thread naming a stored ticket: merged into the Jira case");
  assert(!store.cases.has(created?.id ?? ""), "the email shell is gone");
  assertEqual(["m1", "m2", "m5"].map((id) => store.messages.get(id)?.caseId), [jiraCase, jiraCase, jiraCase], "its messages moved");

  gmail.add(gmailMessage("m6", "t9", "auto@acme.com", "Out of office", "Away", { headers: { "Auto-Submitted": "auto-replied" } }));
  assertEqual(await ingestMessage(deps, "m6"), { kind: "skipped", reason: "auto_reply" }, "auto-reply skipped");
  gmail.add(gmailMessage("m7", "t9", "CertifyOS Technical Support <support@certifyos.com>", "Re: x", "our reply"));
  assertEqual(await ingestMessage(deps, "m7"), { kind: "skipped", reason: "own_mailbox" }, "our own reply skipped");
  console.log("PASS");
}

async function testSync(): Promise<void> {
  console.log("\n--- Test: sync - initial window, history, history expiry, budget, throttle ---");
  const store = new FakeStore();
  const gmail = new FakeGmail();
  for (const id of ["a1", "a2", "a3"]) {
    gmail.add(gmailMessage(id, `t-${id}`, "Jane <jane@acme.com>", `Subject ${id}`, `Body ${id}`));
    gmail.inbox.push(id);
  }
  let now = NOW;
  const lockStore = locks();
  const deps = { gmail, locks: lockStore, now: () => now, store, supportAddress: SUPPORT };

  const first = await gmailSyncTickWith(deps);
  assert(first.ok && first.summary?.processed === 3, "initial sync stores the window");
  assertEqual(gmail.calls.slice(0, 2), ["profile", `list:${INITIAL_QUERY}`], "history id pinned BEFORE listing in:inbox newer_than:14d");
  assertEqual(gmail.calls.filter((call) => call.startsWith("get:")), ["get:a1", "get:a2", "get:a3"], "oldest first");
  assertEqual([store.state.historyId, store.state.pending.length, store.state.initialSyncAt], ["500", 0, new Date(NOW).toISOString()], "history id saved, nothing pending");
  assert(!lockStore.held.has("email:sync:lock"), "lock released");

  assertEqual(await gmailSyncTickWith(deps), { ok: true, skipped: "throttled" }, "within 2 minutes: throttled");
  lockStore.held.delete("email:sync:throttle");

  gmail.add(gmailMessage("b1", "t-b1", "Bob <bob@beta.io>", "New issue", "Help"));
  gmail.add(gmailMessage("d1", "t-d1", "Jane <jane@acme.com>", "draft", "draft", { labelIds: ["DRAFT"] }));
  gmail.historyPages = [{ history: [{ id: "510", messagesAdded: [{ message: { id: "b1", labelIds: ["INBOX"] } }, { message: { id: "d1", labelIds: ["DRAFT"] } }, { message: { id: "a1", labelIds: ["INBOX"] } }] }], historyId: "520" }];
  gmail.calls = [];
  const second = await gmailSyncTickWith(deps);
  assertEqual(gmail.calls, ["history:500", "get:b1"], "history from the saved id; drafts ignored; stored ids not refetched");
  assert(second.summary?.processed === 1 && store.state.historyId === "520", "history id advanced");

  lockStore.held.delete("email:sync:throttle");
  gmail.historyError = new GmailApiError("Gmail says that doesn't exist (404).", 404);
  gmail.profileHistoryId = "900";
  gmail.add(gmailMessage("c1", "t-c1", "Carol <carol@gamma.com>", "Missed while away", "Hello"));
  gmail.inbox.push("b1", "c1");
  gmail.calls = [];
  const expired = await gmailSyncTickWith(deps);
  assertEqual(gmail.calls, ["history:520", "profile", `list:${INITIAL_QUERY}`, "get:c1"], "history expired (404): the 14-day window again, only the new message fetched");
  assert(expired.ok && store.state.historyId === "900" && (expired.summary?.errors[0] ?? "").includes("expired"), "re-pinned, and the expiry is recorded");
  assertEqual(store.messages.size, 5, "no duplicates after the resync");

  /* Budget: a slow clock leaves the rest queued for the next tick. */
  gmail.historyError = null;
  lockStore.held.delete("email:sync:throttle");
  for (const id of ["s1", "s2", "s3"]) {
    gmail.add(gmailMessage(id, `t-${id}`, "Slow <slow@delta.com>", id, id));
  }
  gmail.historyPages = [{ history: [{ id: "910", messagesAdded: ["s1", "s2", "s3"].map((id) => ({ message: { id, labelIds: ["INBOX"] } })) }], historyId: "920" }];
  const slowDeps = {
    ...deps,
    gmail: Object.assign(Object.create(Object.getPrototypeOf(gmail) as object) as FakeGmail, gmail, {
      getMessage: (id: string) => {
        now += 20_000;
        return gmail.getMessage(id);
      },
    }),
  };
  const slow = await gmailSyncTickWith(slowDeps, { budgetMs: 35_000 });
  /* 35s budget, 4s reserve, 20s per fetch: s1 at 0s, s2 at 20s, s3 would start at 40s - past 31s. */
  assertEqual([slow.summary?.processed, store.state.pending.map((entry) => entry.id)], [2, ["s3"]], "out of budget: the rest stays pending");
  lockStore.held.delete("email:sync:throttle");
  const resumed = await gmailSyncTickWith({ ...deps, now: () => now });
  assertEqual([resumed.summary?.processed, store.state.pending.length], [1, 0], "the next tick finishes them");

  /* A failing message is retried, then given up on. */
  lockStore.held.delete("email:sync:throttle");
  store.state.pending = [{ attempts: 2, id: "boom" }];
  const failing = { ...deps, gmail: Object.assign(Object.create(Object.getPrototypeOf(gmail) as object) as FakeGmail, gmail, { getMessage: () => Promise.reject(new GmailApiError("Gmail answered HTTP 500.", 500)) }) };
  const gaveUp = await gmailSyncTickWith(failing);
  assert(gaveUp.ok && store.state.pending.length === 0 && (store.state.lastError?.message ?? "").includes("HTTP 500"), "third failure: dropped, error recorded");

  /* A held lock means another instance is mid-tick. */
  lockStore.held.add("email:sync:lock");
  assertEqual(await gmailSyncTickWith(deps, { force: true }), { ok: true, skipped: "already_running" }, "lock held: skipped");
  console.log("PASS");
}

async function testLink(): Promise<void> {
  console.log("\n--- Test: link an email case to a Jira ticket ---");
  const store = new FakeStore();
  const caseId = "11111111-2222-4333-8444-555555555555";
  store.cases.set(caseId, { accountSuggestion: null, id: caseId, jiraKey: null, source: "email", summary: "x", threadId: "t" });
  const actor = { accountId: "acc-jane", displayName: "Jane Doe" };
  const lookups: string[] = [];
  const deps = {
    jiraLookup: (key: string) => {
      lookups.push(key);
      return Promise.resolve(key === "TS-404" ? ("missing" as const) : key === "TS-500" ? { error: "HTTP 500" } : ("exists" as const));
    },
    store,
  };
  assertEqual(await linkEmailCaseWith(deps, caseId, "CP-1", actor), { error: "Enter a TS ticket key like TS-123.", ok: false, status: 400 }, "key format checked");
  assertEqual(lookups.length, 0, "...before asking Jira");
  const missing = await linkEmailCaseWith(deps, caseId, "ts-404", actor);
  assert(!missing.ok && missing.status === 404, "unknown ticket refused");
  const down = await linkEmailCaseWith(deps, caseId, "TS-500", actor);
  assert(!down.ok && down.status === 502, "Jira unreachable: nothing linked");
  assertEqual(await linkEmailCaseWith(deps, caseId, " ts-77 ", actor), { caseId, key: "TS-77", merged: false, ok: true }, "linked (normalized key)");
  assertEqual(store.cases.get(caseId)?.jiraKey, "TS-77", "stored");
  const again = await linkEmailCaseWith(deps, caseId, "TS-78", actor);
  assert(!again.ok && again.error.includes("already linked to TS-77"), "can't silently re-link");
  assertEqual(emailCaseKey(caseId, null), "EM-1111111122", "EM key from the uuid");
  assertEqual(emailCaseKey(caseId, "TS-77"), "TS-77", "a linked case's key is its Jira key");
  console.log("PASS");
}

/* ------------------------------------------------------------------ reply */

const CASE_ID = "abcdef01-2345-4678-9abc-def012345678";
const EM_KEY = "EM-ABCDEF0123";
const ACTOR: ActionActor = { accountId: "acc-jane", displayName: "Jane Doe" };

function replyCase(overrides: Partial<ReplyCase> = {}): ReplyCase {
  return {
    caseId: CASE_ID,
    jiraKey: null,
    lastInbound: {
      from: { email: "renee@acme-health.com", name: "Renée Dürr" },
      messageId: "<abc123@mail.acme-health.com>",
      references: ["<root@certifyos.com>", "<prev1@certifyos.com>"],
      subject: "Café roster import",
      threadId: "thread-1",
    },
    summary: "Café roster import",
    ...overrides,
  };
}

function replyDeps(env: Record<string, string | undefined>, overrides: Partial<EmailReplyDeps> = {}): EmailReplyDeps & { recorded: SentEmailRecord[]; sends: Array<{ raw: string; threadId: string }> } {
  const recorded: SentEmailRecord[] = [];
  const sends: Array<{ raw: string; threadId: string }> = [];
  return {
    env: { SUPPORT_MAILBOX_ADDRESS: SUPPORT, ...env },
    loadCase: () => Promise.resolve(replyCase()),
    now: () => new Date(NOW),
    record: (sent) => {
      recorded.push(sent);
      return Promise.resolve();
    },
    recorded,
    send: (raw, threadId) => {
      sends.push({ raw, threadId });
      return Promise.resolve({ id: "sent-1", threadId });
    },
    sends,
    ...overrides,
  };
}

function decodeRaw(raw: string): { body: string; headers: string } {
  const text = Buffer.from(raw, "base64url").toString("utf8");
  const [headers = "", body = ""] = text.split("\r\n\r\n");
  return { body: Buffer.from(body.replace(/\r\n/g, ""), "base64").toString("utf8"), headers };
}

const REPLY: Extract<ActionArgs, { operation: "email_reply" }> = { body: "We re-ran the import - it's fixed.", caseId: CASE_ID, operation: "email_reply" };

async function testReply(): Promise<void> {
  console.log("\n--- Test: reply - message, headers, threadId, gates, test recipient ---");
  const raw = buildReplyMessage({
    body: "Hi\n— Jane",
    date: new Date(NOW),
    from: SUPPORT,
    inReplyTo: "<abc@x>",
    references: ["<root@x>", "<abc@x>", "not-an-id"],
    subject: "Re: Help\r\nBcc: attacker@evil.com",
    to: { email: "jane@acme.com", name: 'Jane "J" Doe' },
  });
  const [headerBlock = ""] = raw.split("\r\n\r\n");
  assert(!/^Bcc:/im.test(headerBlock), "a newline in the subject can't add a header");
  assert(headerBlock.includes("Subject: Re: Help Bcc: attacker@evil.com"), "...it stays in the subject line");
  assert(headerBlock.includes("References: <root@x> <abc@x>") && headerBlock.includes("In-Reply-To: <abc@x>"), "threading headers, malformed ids dropped, no repeats");
  assert(headerBlock.includes("From: CertifyOS Technical Support <support@certifyos.com>") && headerBlock.includes("To: Jane 'J' Doe <jane@acme.com>"), "From the mailbox, To the customer");
  assert(headerBlock.includes('Content-Type: text/plain; charset="UTF-8"') && headerBlock.includes("Content-Transfer-Encoding: base64"), "plain text, UTF-8");
  assertEqual([replySubject("Re: x"), replySubject("RE: x"), replySubject("x"), replySubject("")], ["Re: x", "RE: x", "Re: x", "Re: Your support request"], "Re: once");

  const shadow = replyDeps({});
  assertEqual(await sendEmailReply(REPLY, { actor: ACTOR, ticketKey: EM_KEY }, shadow), { error: SHADOW_MODE_MESSAGE, status: "failed" }, "EMAIL_SEND_ENABLED unset: shadow mode");
  assertEqual(SHADOW_MODE_MESSAGE, "Email sending is off (shadow mode) - set EMAIL_SEND_ENABLED=true in Vercel to go live", "the exact message");
  assertEqual(shadow.sends.length, 0, "nothing sent");
  const notTrue = replyDeps({ EMAIL_SEND_ENABLED: "1" });
  assert((await sendEmailReply(REPLY, { actor: ACTOR, ticketKey: EM_KEY }, notTrue)).status === "failed", "only the string true turns it on");

  const live = replyDeps({ EMAIL_SEND_ENABLED: "true" });
  const sent = await sendEmailReply(REPLY, { actor: ACTOR, ticketKey: EM_KEY }, live);
  assert(sent.status === "succeeded" && !sent.redirectedToTestChannel && sent.externalId === "sent-1", "sent");
  assertEqual(live.sends[0]?.threadId, "thread-1", "into the customer's Gmail thread");
  const message = decodeRaw(live.sends[0]?.raw ?? "");
  assert(message.headers.includes("To: =?UTF-8?B?") && message.headers.includes("<renee@acme-health.com>"), "To the last customer sender (non-ASCII name encoded)");
  assert(message.headers.includes("Subject: =?UTF-8?B?"), "non-ASCII subject encoded");
  assert(message.headers.includes("In-Reply-To: <abc123@mail.acme-health.com>") && message.headers.includes("References: <root@certifyos.com> <prev1@certifyos.com> <abc123@mail.acme-health.com>"), "In-Reply-To / References");
  assertEqual(message.body, "We re-ran the import - it's fixed.\n\n— Jane Doe, CertifyOS Technical Support\n", "plain-text body with the sign-off");
  assertEqual([live.recorded[0]?.metadata.direction, live.recorded[0]?.metadata.sent_by, live.recorded[0]?.gmailId, live.recorded[0]?.caseId], ["outbound", "Jane Doe", "sent-1", CASE_ID], "recorded on the case");

  const test = replyDeps({ EMAIL_SEND_ENABLED: "true", EMAIL_TEST_RECIPIENT: "QA@certifyos.com" });
  const redirected = await sendEmailReply(REPLY, { actor: ACTOR, ticketKey: EM_KEY }, test);
  assert(redirected.status === "succeeded" && redirected.redirectedToTestChannel, "test recipient: marked redirected");
  const testMessage = decodeRaw(test.sends[0]?.raw ?? "");
  assert(testMessage.headers.includes("To: qa@certifyos.com") && !testMessage.headers.includes("renee@"), "sent to the test recipient only");
  assert(testMessage.body.startsWith("[Test mode - this reply would have gone to renee@acme-health.com]"), "says who it was meant for");

  const wrongKey = await sendEmailReply(REPLY, { actor: ACTOR, ticketKey: "TS-1" }, replyDeps({ EMAIL_SEND_ENABLED: "true" }));
  assert(wrongKey.status === "failed" && wrongKey.error.includes("EM-ABCDEF0123"), "the key must be the case's own");
  const linkedCase = replyDeps({ EMAIL_SEND_ENABLED: "true" }, { loadCase: () => Promise.resolve(replyCase({ jiraKey: "TS-123" })) });
  assert((await sendEmailReply(REPLY, { actor: ACTOR, ticketKey: "TS-123" }, linkedCase)).status === "succeeded", "a linked case replies under its Jira key");
  const stale = await sendEmailReply(REPLY, { actor: ACTOR, ticketKey: EM_KEY }, linkedCase);
  assert(stale.status === "failed" && stale.error.includes("TS-123"), "a stale EM key after linking is refused");
  const nobody = await sendEmailReply(REPLY, { actor: ACTOR, ticketKey: EM_KEY }, replyDeps({ EMAIL_SEND_ENABLED: "true" }, { loadCase: () => Promise.resolve(replyCase({ lastInbound: null })) }));
  assert(nobody.status === "failed" && nobody.error.includes("No customer email"), "nobody to reply to");

  const refused = replyDeps({ EMAIL_SEND_ENABLED: "true" }, { send: () => Promise.reject(new GmailApiError("Gmail answered HTTP 400.", 400)) });
  assertEqual((await sendEmailReply(REPLY, { actor: ACTOR, ticketKey: EM_KEY }, refused)).status, "failed", "Gmail said no: failed");
  const timedOut = replyDeps({ EMAIL_SEND_ENABLED: "true" }, { send: () => Promise.reject(new GmailApiError("Gmail didn't answer within 15 seconds.", null)) });
  const uncertain = await sendEmailReply(REPLY, { actor: ACTOR, ticketKey: EM_KEY }, timedOut);
  assert(uncertain.status === "uncertain" && uncertain.error.includes("Sent folder"), "no answer: uncertain, check Sent");
  console.log("PASS");
}

function memoryActionStore(): ActionStore {
  const raw = new Map<string, unknown>();
  const lists = new Map<string, unknown[]>();
  return {
    del: (key) => {
      raw.delete(key);
      return Promise.resolve();
    },
    get: <T>(key: string) => Promise.resolve(raw.has(key) ? (structuredClone(raw.get(key)) as T) : null),
    incr: (key) => {
      const next = ((raw.get(key) as number | undefined) ?? 0) + 1;
      raw.set(key, next);
      return Promise.resolve(next);
    },
    mget: <T>(keys: string[]) => Promise.resolve(keys.map((key) => (raw.has(key) ? (structuredClone(raw.get(key)) as T) : null))),
    pushCapped: (key, value, keep) => {
      lists.set(key, [value, ...(lists.get(key) ?? [])].slice(0, keep));
      return Promise.resolve();
    },
    range: <T>(key: string, count: number) => Promise.resolve((lists.get(key) ?? []).slice(0, count) as T[]),
    set: (key, value) => {
      raw.set(key, structuredClone(value));
      return Promise.resolve();
    },
    setIfAbsent: (key, value) => {
      if (raw.has(key)) return Promise.resolve(false);
      raw.set(key, structuredClone(value));
      return Promise.resolve(true);
    },
  };
}

async function testPipeline(): Promise<void> {
  console.log("\n--- Test: email_reply through the action pipeline - validation, leak check, idempotency ---");
  assert(validateActionArgs(EM_KEY, REPLY).ok, "EM key + email_reply validates");
  assert(validateActionArgs("TS-123", REPLY).ok, "TS key + email_reply validates (linked case)");
  const wrongOp = validateActionArgs(EM_KEY, { body: "x", operation: "jira_comment", visibility: "public" });
  assert(!wrongOp.ok && wrongOp.error.includes("TS tickets"), "an EM key only carries email replies");
  assert(!validateActionArgs(EM_KEY, { ...REPLY, caseId: "not-a-uuid" }).ok, "caseId must be a uuid");
  assert(!validateActionArgs("EM-XYZ", REPLY).ok, "malformed EM key refused");
  const upper = validateActionArgs(EM_KEY, { ...REPLY, caseId: CASE_ID.toUpperCase() });
  assert(upper.ok && upper.args.operation === "email_reply" && upper.args.caseId === CASE_ID, "caseId normalized to lower case");

  const replies: ActionArgs[] = [];
  const deps: ActionServiceDeps = {
    credentials: () => Promise.resolve(null),
    email: {
      reply: (args) => {
        replies.push(args);
        return Promise.resolve({ externalId: "sent-9", redirectedToTestChannel: false, status: "succeeded" });
      },
    },
    invalidate: () => Promise.resolve(),
    jira: {
      getVersion: () => Promise.reject(new Error("must not be called")),
      userName: () => Promise.reject(new Error("must not be called")),
      write: () => Promise.reject(new Error("must not be called")),
    },
    newId: () => `exec-${Math.random().toString(36).slice(2, 10)}`,
    now: () => new Date(NOW),
    slack: { linkedConversation: () => Promise.resolve(null), write: () => Promise.reject(new Error("must not be called")) },
    store: memoryActionStore(),
    ticket: () => Promise.reject(new Error("must not be called")),
  };
  const leak = await executeActionWith(deps, { args: { ...REPLY, body: "Engineering is on TS-999 and CP-55" }, idempotencyKey: "leak-key-0001", ticketKey: EM_KEY }, ACTOR);
  assert(leak.ok && leak.execution.status === "failed" && (leak.execution.error ?? "").includes("TS-999") && replies.length === 0, "naming another ticket is refused before sending");
  const wiki = await executeActionWith(deps, { args: { ...REPLY, body: "See https://certifyos.atlassian.net/wiki/x" }, idempotencyKey: "leak-key-0002", ticketKey: EM_KEY }, ACTOR);
  assert(wiki.ok && wiki.execution.status === "failed" && replies.length === 0, "wiki links refused");

  const okRun = await executeActionWith(deps, { args: REPLY, idempotencyKey: "send-key-0001", ticketKey: EM_KEY }, ACTOR);
  assert(okRun.ok && okRun.execution.status === "succeeded" && okRun.execution.ticketKey === EM_KEY && replies.length === 1, "sent through the pipeline");
  const resend = await executeActionWith(deps, { args: REPLY, idempotencyKey: "send-key-0001", ticketKey: EM_KEY }, ACTOR);
  assert(resend.ok && resend.execution.status === "duplicate" && replies.length === 1, "same idempotency key: never sent twice");
  const own = await executeActionWith(deps, { args: { ...REPLY, body: "Your ticket TS-123 is fixed." }, idempotencyKey: "send-key-0002", ticketKey: "TS-123" }, ACTOR);
  assert(own.ok && own.execution.status === "succeeded", "a linked case may name its own ticket");
  console.log("PASS");
}

/* -------------------------------------------------------------- migration */

function testMigration(): void {
  console.log("\n--- Test: migration 0002 ---");
  validateMigrations(MIGRATIONS);
  const v2 = MIGRATIONS[1];
  assertEqual([v2?.version, v2?.name], [2, "email_intake"], "appended as version 2");
  const text = (v2?.statements ?? []).join("\n");
  for (const fragment of [
    "ALTER TABLE cases ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'jira'",
    "CHECK (source IN ('jira', 'email'))",
    "ALTER TABLE cases ALTER COLUMN jira_key DROP NOT NULL",
    "ADD COLUMN IF NOT EXISTS email_thread_id text UNIQUE",
    "ADD COLUMN IF NOT EXISTS account_suggestion text",
    "CHECK (jira_key IS NOT NULL OR email_thread_id IS NOT NULL)",
    "DROP CONSTRAINT IF EXISTS case_messages_source_check",
    "CHECK (source IN ('jira_comment', 'slack', 'dashboard', 'email'))",
    "ALTER TABLE case_messages ADD COLUMN IF NOT EXISTS metadata jsonb",
    "ON case_messages ((metadata->>'thread_id')) WHERE source = 'email'",
  ]) {
    assert(text.includes(fragment), `migration has: ${fragment}`);
  }
  assert(
    (v2?.statements ?? []).every((statement) => !(/DROP (?:CONSTRAINT|INDEX)/i.test(statement) && /jira_key/i.test(statement))),
    "the jira_key unique constraint jiraSync upserts on is untouched",
  );
  assert(MIGRATIONS[0]?.statements.some((statement) => statement.includes("jira_key text NOT NULL UNIQUE")) === true, "version 1 is unchanged");
  assert((v2?.statements ?? []).every((statement) => !statement.includes("--") && !statement.includes(";")), "one statement per entry, no comments");
  console.log("PASS");
}

async function main(): Promise<void> {
  testMime();
  testQuotes();
  testRules();
  await testIngest();
  await testSync();
  await testLink();
  await testReply();
  await testPipeline();
  testMigration();
}

main()
  .then(() => {
    console.log("\nAll email tests passed.");
    process.exit(0);
  })
  .catch((error: unknown) => {
    console.error("\nEmail test failed:", error);
    process.exit(1);
  });
