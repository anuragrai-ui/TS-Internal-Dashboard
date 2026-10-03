import type { EmailAddress, EmailAttachmentMeta } from "@/lib/workspace/types";

/**
 * Email -> plain text, for the support inbox. Pure, no dependencies.
 *
 * Two inputs end up in the same tree (MimeNode):
 * - a Gmail API message (format=full): Gmail has already undone each
 *   part's Content-Transfer-Encoding and hands the bytes over as base64url
 * - a raw RFC 5322 message (tests, and anything that arrives as source):
 *   parsed here, including base64 / quoted-printable bodies
 * Then one walk picks the text: text/plain when there is one, else the
 * text/html converted to plain text (tags, scripts and styles dropped,
 * entities decoded). Nothing here ever returns HTML - the inbox renders
 * message text as text, and an email's HTML is never shown.
 *
 * Attachments are metadata only (name, size, type); their bytes are never
 * read, kept or decoded.
 */

const BODY_MAX_CHARS = 200_000;

export interface GmailHeader {
  name: string;
  value: string;
}

/** The parts of a Gmail API MessagePart this reads. */
export interface GmailMessagePart {
  body?: { attachmentId?: string; data?: string; size?: number };
  filename?: string;
  headers?: GmailHeader[];
  mimeType?: string;
  partId?: string;
  parts?: GmailMessagePart[];
}

/** The parts of a Gmail API Message (format=full) this reads. */
export interface GmailMessage {
  historyId?: string;
  id: string;
  internalDate?: string;
  labelIds?: string[];
  payload?: GmailMessagePart;
  snippet?: string;
  threadId: string;
}

export interface MimeNode {
  body: Uint8Array;
  /* Content-Disposition's type ("attachment" / "inline"), lower-cased. */
  disposition: string | null;
  filename: string | null;
  /* Lower-cased names; the first occurrence wins. */
  headers: Map<string, string>;
  mimeType: string;
  params: Record<string, string>;
  parts: MimeNode[];
  /* Bytes of the part's content (attachments report Gmail's size; their body isn't fetched). */
  size: number;
}

/** A message reduced to what the inbox stores. */
export interface ParsedEmail {
  attachments: EmailAttachmentMeta[];
  cc: EmailAddress[];
  /* ISO: the Date header, else Gmail's internalDate, else now. */
  date: string;
  from: EmailAddress | null;
  gmailId: string;
  /* Lower-cased header names -> raw values, for the skip rules. */
  headers: Record<string, string>;
  inReplyTo: string | null;
  labelIds: string[];
  messageId: string | null;
  /* What this message adds - quoted history cut off. Never empty when `text` isn't. */
  newContent: string;
  quoted: string;
  references: string[];
  replyTo: EmailAddress[];
  subject: string;
  /* The whole plain-text body. */
  text: string;
  threadId: string;
  to: EmailAddress[];
}

/* ------------------------------------------------------------- decoding */

/** base64url (or plain base64) -> bytes. Tolerates missing padding and whitespace. Pure. */
export function decodeBase64Url(data: string): Uint8Array {
  const clean = data.replace(/[\s]/g, "").replace(/-/g, "+").replace(/_/g, "/");
  return new Uint8Array(Buffer.from(clean, "base64"));
}

/** Quoted-printable -> bytes (RFC 2045 6.7): soft line breaks removed, =XX decoded, anything else kept as UTF-8. Pure. */
export function decodeQuotedPrintable(text: string): Uint8Array {
  const unfolded = text.replace(/=\r?\n/g, "");
  const bytes: number[] = [];
  for (let index = 0; index < unfolded.length; index += 1) {
    const char = unfolded[index] ?? "";
    if (char === "=" && /^[0-9A-Fa-f]{2}$/.test(unfolded.slice(index + 1, index + 3))) {
      bytes.push(parseInt(unfolded.slice(index + 1, index + 3), 16));
      index += 2;
      continue;
    }
    const code = char.charCodeAt(0);
    if (code < 0x80) {
      bytes.push(code);
    } else {
      bytes.push(...Buffer.from(char, "utf8"));
    }
  }
  return new Uint8Array(bytes);
}

/** Bytes in a declared charset -> string; an unknown or missing charset reads as UTF-8 (with replacement characters, never an exception). Pure. */
export function decodeCharset(bytes: Uint8Array, charset: string | undefined): string {
  const label = (charset ?? "utf-8").trim().replace(/^"|"$/g, "").toLowerCase() || "utf-8";
  /* Mail calls Latin-1 by many names; browsers (and so TextDecoder) read all of them as windows-1252, which is a superset. */
  const normalized = label === "ascii" || label === "us-ascii" ? "utf-8" : label;
  try {
    return new TextDecoder(normalized, { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }
}

/** RFC 2047 encoded words in a header ("=?UTF-8?B?...?=", "=?iso-8859-1?Q?...?="). Pure. */
export function decodeEncodedWords(value: string): string {
  /* Whitespace between two adjacent encoded words is not part of the text (RFC 2047 6.2). */
  const joined = value.replace(/(=\?[^?]+\?[BbQq]\?[^?]*\?=)\s+(?==\?[^?]+\?[BbQq]\?[^?]*\?=)/g, "$1");
  return joined.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_match, charset: string, encoding: string, text: string) => {
    const cleanCharset = charset.split("*")[0];
    if (encoding.toUpperCase() === "B") {
      return decodeCharset(decodeBase64Url(text), cleanCharset);
    }
    return decodeCharset(decodeQuotedPrintable(text.replace(/_/g, " ")), cleanCharset);
  });
}

/* ------------------------------------------------------------- headers */

/** "text/plain; charset=\"utf-8\"; format=flowed" -> type + lower-cased params (RFC 2231 continuations not needed for what's read here). Pure. */
export function parseHeaderParams(value: string): { params: Record<string, string>; value: string } {
  const [head, ...rest] = splitOutsideQuotes(value, ";");
  const params: Record<string, string> = {};
  for (const part of rest) {
    const eq = part.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const name = part.slice(0, eq).trim().toLowerCase();
    let paramValue = part.slice(eq + 1).trim();
    if (paramValue.startsWith('"') && paramValue.endsWith('"') && paramValue.length >= 2) {
      paramValue = paramValue.slice(1, -1).replace(/\\(.)/g, "$1");
    }
    /* filename*=UTF-8''na%C3%AFve.pdf */
    if (name.endsWith("*")) {
      const match = /^([^']*)'[^']*'(.*)$/.exec(paramValue);
      if (match) {
        try {
          params[name.slice(0, -1)] = decodeURIComponent(match[2] ?? "");
          continue;
        } catch {
          /* Fall through to the raw value. */
        }
      }
    }
    params[name] = decodeEncodedWords(paramValue);
  }
  return { params, value: (head ?? "").trim().toLowerCase() };
}

function splitOutsideQuotes(value: string, separator: string): string[] {
  const out: string[] = [];
  let current = "";
  let quoted = false;
  let angle = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index] ?? "";
    if (char === "\\" && quoted) {
      current += char + (value[index + 1] ?? "");
      index += 1;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
    } else if (!quoted && char === "<") {
      angle += 1;
    } else if (!quoted && char === ">") {
      angle = Math.max(0, angle - 1);
    }
    if (char === separator && !quoted && angle === 0) {
      out.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  out.push(current);
  return out;
}

const EMAIL_PATTERN = /[^\s<>"(),;:]+@[^\s<>"(),;:]+\.[^\s<>"(),;:]+/;

/** One address: `"Jane Doe" <jane@x.com>`, `Jane <jane@x.com>`, `jane@x.com (Jane)`. Email lower-cased. Pure. */
export function parseAddress(value: string): EmailAddress | null {
  const decoded = decodeEncodedWords(value).trim();
  if (!decoded) {
    return null;
  }
  const angle = /<([^<>]+)>/.exec(decoded);
  const email = (angle?.[1] ?? EMAIL_PATTERN.exec(decoded)?.[0] ?? "").trim().toLowerCase();
  if (!EMAIL_PATTERN.test(email)) {
    return null;
  }
  let name = angle ? decoded.slice(0, angle.index).trim() : (/\(([^)]*)\)/.exec(decoded)?.[1] ?? "").trim();
  name = name.replace(/^"(.*)"$/, "$1").replace(/\\(.)/g, "$1").trim();
  return { email, name: name && name.toLowerCase() !== email ? name : null };
}

/** A To/Cc/From list, comma-separated outside quotes and angle brackets. Pure. */
export function parseAddressList(value: string | undefined): EmailAddress[] {
  if (!value) {
    return [];
  }
  return splitOutsideQuotes(value, ",")
    .map(parseAddress)
    .filter((address): address is EmailAddress => address !== null);
}

/** "<a@x> <b@y>" -> ["<a@x>", "<b@y>"]. Pure. */
export function parseMessageIds(value: string | undefined): string[] {
  return value?.match(/<[^<>\s]+>/g) ?? [];
}

/* --------------------------------------------------------------- trees */

function headerMap(headers: readonly GmailHeader[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const header of headers) {
    const name = header.name.toLowerCase();
    if (!map.has(name)) {
      map.set(name, header.value);
    }
  }
  return map;
}

function nodeFrom(headers: Map<string, string>, mimeTypeFallback: string, filenameFallback: string | null, body: Uint8Array, size: number, parts: MimeNode[]): MimeNode {
  const contentType = parseHeaderParams(headers.get("content-type") ?? mimeTypeFallback);
  const disposition = headers.has("content-disposition") ? parseHeaderParams(headers.get("content-disposition") ?? "") : null;
  const filename = disposition?.params.filename ?? contentType.params.name ?? filenameFallback;
  return {
    body,
    disposition: disposition?.value || null,
    filename: filename ? decodeEncodedWords(filename) : null,
    headers,
    mimeType: contentType.value || mimeTypeFallback,
    params: contentType.params,
    parts,
    size,
  };
}

/** A Gmail API payload as a MimeNode tree. Pure. */
export function nodeFromGmailPart(part: GmailMessagePart): MimeNode {
  const headers = headerMap(part.headers ?? []);
  let body = part.body?.data ? decodeBase64Url(part.body.data) : new Uint8Array();
  /*
   * Gmail returns each part already transfer-decoded. A soft line break
   * ("=" at the end of a line) can only exist in still-encoded
   * quoted-printable, so if one shows up the part reached us encoded after
   * all - decode it rather than show "=3D" to a person.
   */
  if ((headers.get("content-transfer-encoding") ?? "").toLowerCase().trim() === "quoted-printable") {
    const latin = Buffer.from(body).toString("latin1");
    if (/=\r?\n/.test(latin)) {
      body = decodeQuotedPrintable(latin);
    }
  }
  return nodeFrom(
    headers,
    (part.mimeType ?? "text/plain").toLowerCase(),
    part.filename || null,
    body,
    part.body?.size ?? body.byteLength,
    (part.parts ?? []).map(nodeFromGmailPart),
  );
}

function unfoldHeaders(block: string): GmailHeader[] {
  const headers: GmailHeader[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && headers.length > 0) {
      const last = headers[headers.length - 1];
      if (last) {
        last.value += ` ${line.trim()}`;
      }
      continue;
    }
    const colon = line.indexOf(":");
    if (colon > 0) {
      headers.push({ name: line.slice(0, colon).trim(), value: line.slice(colon + 1).trim() });
    }
  }
  return headers;
}

function textBytes(text: string): Uint8Array {
  /* A raw message read as a JS string: chars < 256 are its bytes; anything wider came from an already-decoded string. */
  // eslint-disable-next-line no-control-regex
  return /^[\u0000-ÿ]*$/.test(text) ? new Uint8Array(Buffer.from(text, "latin1")) : new Uint8Array(Buffer.from(text, "utf8"));
}

/** A raw RFC 5322 message (or one MIME entity of it) as a MimeNode tree. Pure. */
export function parseRawMime(raw: string, depth = 0): MimeNode {
  const split = /\r?\n\r?\n/.exec(raw);
  const headerBlock = split ? raw.slice(0, split.index) : raw;
  const bodyText = split ? raw.slice(split.index + split[0].length) : "";
  const headers = headerMap(unfoldHeaders(headerBlock));
  const contentType = parseHeaderParams(headers.get("content-type") ?? "text/plain");

  if (contentType.value.startsWith("multipart/") && contentType.params.boundary && depth < 20) {
    const boundary = contentType.params.boundary;
    const parts: MimeNode[] = [];
    const delimiter = new RegExp(`^--${boundary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(--)?[ \\t]*$`, "m");
    let rest = bodyText;
    let first = true;
    for (;;) {
      const match = delimiter.exec(rest);
      if (!match) {
        if (!first && rest.trim()) {
          parts.push(parseRawMime(rest.replace(/\r?\n$/, ""), depth + 1));
        }
        break;
      }
      const chunk = rest.slice(0, match.index).replace(/\r?\n$/, "");
      if (!first) {
        parts.push(parseRawMime(chunk, depth + 1));
      }
      first = false;
      rest = rest.slice(match.index + match[0].length).replace(/^\r?\n/, "");
      if (match[1] === "--") {
        break;
      }
    }
    return nodeFrom(headers, contentType.value, null, new Uint8Array(), 0, parts);
  }

  const encoding = (headers.get("content-transfer-encoding") ?? "7bit").toLowerCase().trim();
  const body = encoding === "base64" ? decodeBase64Url(bodyText) : encoding === "quoted-printable" ? decodeQuotedPrintable(bodyText) : textBytes(bodyText);
  return nodeFrom(headers, contentType.value || "text/plain", null, body, body.byteLength, []);
}

/* ------------------------------------------------------------ html, text */

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  apos: "'",
  bull: "•",
  copy: "©",
  gt: ">",
  hellip: "…",
  laquo: "«",
  ldquo: "“",
  lsquo: "‘",
  lt: "<",
  mdash: "—",
  middot: "·",
  nbsp: " ",
  ndash: "–",
  quot: '"',
  raquo: "»",
  rdquo: "”",
  reg: "®",
  rsquo: "’",
  trade: "™",
  zwnj: "",
  zwj: "",
};

/** &amp; &#39; &#x2019; &nbsp; ... -> characters. Unknown names stay as written. Pure. */
export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (match, entity: string) => {
    if (entity.startsWith("#")) {
      const code = entity[1]?.toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/**
 * HTML mail -> readable plain text. Scripts, styles, the head and comments
 * go entirely; block ends and <br> become line breaks; list items get a
 * dash; every other tag is dropped; entities are decoded last (so an
 * escaped "&lt;b&gt;" stays visible text, never markup). Pure.
 */
export function htmlToText(html: string): string {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|head|title|template|noscript)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<(script|style)\b[^>]*>[\s\S]*$/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/(p|div|tr|ul|ol|h[1-6]|table|blockquote|section|article|header|footer)\s*>/gi, "\n")
    /* A paragraph opens with a blank line; a div (Gmail writes one per line) only ends its line. */
    .replace(/<(p|h[1-6]|table|blockquote)\b[^>]*>/gi, "\n")
    .replace(/<\/t[dh]\s*>/gi, "\t")
    .replace(/<[^>]*>/g, "");
  return normalizeText(decodeHtmlEntities(text));
}

function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isAttachment(node: MimeNode): boolean {
  if (node.disposition === "attachment") {
    return true;
  }
  /* A named part that isn't body text (an inline image, a PDF) is an attachment for our purposes. */
  return Boolean(node.filename) && !(node.mimeType === "text/plain" || node.mimeType === "text/html");
}

/** Walks a tree: the body as plain text (text/plain preferred, else converted HTML) and attachment metadata. Pure. */
export function extractContent(root: MimeNode): { attachments: EmailAttachmentMeta[]; text: string } {
  const plain: string[] = [];
  const html: string[] = [];
  const attachments: EmailAttachmentMeta[] = [];
  const walk = (node: MimeNode): void => {
    if (node.parts.length > 0) {
      node.parts.forEach(walk);
      return;
    }
    if (isAttachment(node)) {
      attachments.push({ mime: node.mimeType, name: (node.filename ?? "attachment").slice(0, 200), size: node.size });
      return;
    }
    if (node.mimeType === "text/plain") {
      plain.push(decodeCharset(node.body, node.params.charset));
    } else if (node.mimeType === "text/html") {
      html.push(decodeCharset(node.body, node.params.charset));
    }
  };
  walk(root);
  const text = plain.length > 0 ? normalizeText(plain.join("\n\n")) : html.length > 0 ? htmlToText(html.join("\n")) : "";
  return { attachments, text: text.length > BODY_MAX_CHARS ? text.slice(0, BODY_MAX_CHARS) : text };
}

/* ------------------------------------------------------- quoted history */

const WROTE_LINE = /\bwrote:\s*$/i;
const ORIGINAL_MESSAGE = /^\s*-{2,}\s*(?:original message|forwarded by|reply message)\s*-{2,}\s*$/i;
const OUTLOOK_RULE = /^\s*_{8,}\s*$/;
const OUTLOOK_FROM = /^\s*\*?From:\*?\s+\S/i;
const OUTLOOK_META = /^\s*\*?(?:Sent|Date|To|Subject):\*?\s/i;

function isQuoteLine(line: string): boolean {
  return /^\s*>/.test(line);
}

/**
 * Splits a reply into what's new and the history it quotes. Recognized:
 * Gmail/Apple "On <date>, <name> wrote:" (also wrapped over two or three
 * lines), "-----Original Message-----", Outlook's rule-then-"From:" and its
 * "From: / Sent: / To:" block, and ">" quoted lines. A reply written
 * between or below quotes keeps its own lines - only the quotes go. If
 * nothing is left, the whole text is the new content. Pure.
 */
export function splitQuotedText(text: string): { newContent: string; quoted: string } {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let cut = lines.length;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (ORIGINAL_MESSAGE.test(line)) {
      cut = index;
      break;
    }
    if (OUTLOOK_RULE.test(line) && OUTLOOK_FROM.test(lines.slice(index + 1).find((next) => next.trim()) ?? "")) {
      cut = index;
      break;
    }
    if (OUTLOOK_FROM.test(line) && (index === 0 || !(lines[index - 1] ?? "").trim()) && lines.slice(index + 1, index + 5).some((next) => OUTLOOK_META.test(next))) {
      cut = index;
      break;
    }
    /* "On Tue, 1 Oct 2026 at 10:00, Jane <jane@x.com> wrote:" - possibly wrapped. */
    if (/^\s*On\s/i.test(line)) {
      const span = [0, 1, 2].find((extra) => WROTE_LINE.test(lines.slice(index, index + extra + 1).join(" ")));
      if (span !== undefined) {
        const after = lines.slice(index + span + 1);
        /* Bottom-posting: unquoted text after the quote block belongs to the reply. Then only the attribution goes. */
        const firstQuoted = after.findIndex((next) => next.trim());
        const quotedBlockThenMore =
          firstQuoted >= 0 && isQuoteLine(after[firstQuoted] ?? "") && after.slice(firstQuoted).some((next) => next.trim() && !isQuoteLine(next));
        if (!quotedBlockThenMore) {
          cut = index;
          break;
        }
        lines.splice(index, span + 1, ...Array.from({ length: span + 1 }, () => "\u0000"));
      }
    }
  }

  const kept = lines.slice(0, cut);
  const quotedLines = [...lines.slice(cut), ...kept.filter((line) => isQuoteLine(line))].filter((line) => line !== "\u0000");
  const newLines = kept.filter((line) => !isQuoteLine(line) && line !== "\u0000");
  const newContent = normalizeText(newLines.join("\n"));
  const quoted = normalizeText(quotedLines.join("\n"));
  return newContent ? { newContent, quoted } : { newContent: normalizeText(text), quoted: "" };
}

/* -------------------------------------------------------------- message */

function isoDate(value: string | undefined, fallbackMs: number): string {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return new Date(Number.isNaN(parsed) ? fallbackMs : parsed).toISOString();
}

/* Only the headers the skip rules and the stored metadata use - not the whole envelope. */
const KEPT_HEADERS = [
  "auto-submitted",
  "content-type",
  "list-id",
  "list-unsubscribe",
  "precedence",
  "return-path",
  "x-auto-response-suppress",
  "x-autoreply",
  "x-autorespond",
  "x-failed-recipients",
  "x-jira-fingerprint",
];

/** A MimeNode tree plus Gmail's ids -> ParsedEmail. `nowMs` dates a message with no usable Date. Pure. */
export function parseEmailNode(root: MimeNode, meta: { gmailId: string; internalDate?: string; labelIds?: string[]; threadId: string }, nowMs: number): ParsedEmail {
  const header = (name: string): string | undefined => root.headers.get(name);
  const { attachments, text } = extractContent(root);
  const { newContent, quoted } = splitQuotedText(text);
  const internalMs = meta.internalDate && /^\d+$/.test(meta.internalDate) ? Number(meta.internalDate) : nowMs;
  const headers: Record<string, string> = {};
  for (const name of KEPT_HEADERS) {
    const value = header(name);
    if (value !== undefined) {
      headers[name] = value.slice(0, 500);
    }
  }
  return {
    attachments,
    cc: parseAddressList(header("cc")),
    /* Gmail's internalDate is when the mailbox received it - harder to fake than a Date header, so it wins when present. */
    date: meta.internalDate ? new Date(internalMs).toISOString() : isoDate(header("date"), nowMs),
    from: parseAddressList(header("from"))[0] ?? null,
    gmailId: meta.gmailId,
    headers,
    inReplyTo: parseMessageIds(header("in-reply-to"))[0] ?? null,
    labelIds: meta.labelIds ?? [],
    messageId: parseMessageIds(header("message-id"))[0] ?? null,
    newContent,
    quoted,
    references: parseMessageIds(header("references")).slice(-30),
    replyTo: parseAddressList(header("reply-to")),
    subject: decodeEncodedWords(header("subject") ?? "").replace(/\s+/g, " ").trim(),
    text,
    threadId: meta.threadId,
    to: parseAddressList(header("to")),
  };
}

/** A Gmail API message (format=full) -> ParsedEmail. Pure. */
export function parseGmailMessage(message: GmailMessage, nowMs: number): ParsedEmail {
  const root = nodeFromGmailPart(message.payload ?? {});
  return parseEmailNode(root, { gmailId: message.id, internalDate: message.internalDate, labelIds: message.labelIds, threadId: message.threadId }, nowMs);
}
