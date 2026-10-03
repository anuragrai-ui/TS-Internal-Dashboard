import {
  backfillJql,
  buildCaseBundle,
  caseContentHash,
  caseWriteStatements,
  commentVisibility,
  fetchAllComments,
  incrementalJql,
  isInCasePod,
  mapCaseFields,
  mapEvents,
  mapLinks,
  normalizeSyncState,
  runManualSync,
  SYNC_STATE_KEY,
  syncTick,
} from "@/lib/cases/jiraSync";
import { summarizeParity } from "@/lib/cases/read";
import { computeFirstResponseClock, computeResolutionClock, firstAgentResponseAt, isPauseStatus, parityMismatch, runClock } from "@/lib/cases/sla";
import { ensureMigrated, migrationTransaction, pendingMigrations, runMigrations, validateMigrations } from "@/lib/db/migrate";
import { MIGRATIONS } from "@/lib/db/migrations";
import { redactDbError } from "@/lib/db/client";
import { CERTIFY_SUPPORT_CALENDAR } from "@/lib/escalation/policy";

import type { CaseSyncDeps, RawCaseIssue, RawComment, SyncLockStore } from "@/lib/cases/jiraSync";
import type { CaseSyncState, SlaClock } from "@/lib/cases/types";
import type { SqlExecutor, SqlStatement } from "@/lib/db/client";
import type { Migration } from "@/lib/db/migrations";
import type { QueryParams, ReadOnlyJiraClient, RequestLogEntry } from "@/lib/escalation/readOnlyJira";
import type { JiraHistory } from "@/lib/notifications/jiraChanges";

/* Run with: npx tsx scripts/test-cases.ts - a fake SQL layer and a fake Jira; nothing touches Postgres, Redis or Jira. */

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

const HOUR = 3_600_000;
const CAL = CERTIFY_SUPPORT_CALENDAR;
const at = (iso: string): number => Date.parse(iso);
const POD = { id: "12448", value: "Credentialing" };

/* ------------------------------------------------------------ fixtures */

function issue(key: string, overrides: Partial<RawCaseIssue["fields"]> = {}): RawCaseIssue {
  return {
    fields: {
      assignee: { accountId: "agent-1", displayName: "Alice Agent" },
      created: "2026-10-05T13:00:00.000Z",
      customfield_10002: [{ name: "CertifyOS" }, { name: "Acme Health" }],
      customfield_10059: { ongoingCycle: { breached: false, goalDuration: { millis: 4 * HOUR }, paused: false, remainingTime: { millis: 3 * HOUR } } },
      customfield_10165: POD,
      customfield_10650: { ongoingCycle: { breached: false, goalDuration: { millis: 45 * HOUR }, paused: false, remainingTime: { millis: 40 * HOUR } } },
      description: { content: [{ content: [{ text: "Provider stuck", type: "text" }], type: "paragraph" }], type: "doc" },
      issuelinks: [{ outwardIssue: { key: "CP-9" }, type: { name: "Blocks" } }],
      priority: { name: "High" },
      reporter: { accountId: "cust-1", accountType: "customer", displayName: "Carl Customer", emailAddress: "carl@acme.test" },
      resolutiondate: null,
      status: { id: "3", name: "In Progress", statusCategory: { key: "indeterminate" } },
      summary: `Ticket ${key}`,
      updated: "2026-10-05T14:00:00.000Z",
      ...overrides,
    },
    key,
  };
}

function comment(id: string, created: string, extra: Partial<RawComment> = {}): RawComment {
  return { author: { accountId: "agent-1", accountType: "atlassian", displayName: "Alice Agent" }, body: `comment ${id}`, created, id, ...extra };
}

/* ------------------------------------------------------------ fake Jira */

interface FakeIssueData {
  comments: RawComment[];
  histories: JiraHistory[];
  issue: RawCaseIssue;
}

function fakeJira(data: Map<string, FakeIssueData>, now: () => number): ReadOnlyJiraClient & { searches: string[] } {
  const searches: string[] = [];
  const keyNum = (key: string): number => Number(key.split("-")[1]);
  const requestLog: RequestLogEntry[] = [];

  function searchJql<T>(jql: string, _fields: string[], opts: { maxTotal?: number } = {}): Promise<T[]> {
    searches.push(jql);
    let issues = [...data.values()].map((entry) => entry.issue);
    const inList = /key in \(([^)]*)\)/.exec(jql);
    if (inList) {
      const keys = new Set((inList[1] ?? "").split(","));
      issues = issues.filter((item) => keys.has(item.key));
    }
    const after = /key > (TS-\d+)/.exec(jql);
    if (after) {
      issues = issues.filter((item) => keyNum(item.key) > keyNum(after[1] ?? ""));
    }
    const minutes = /updated >= -(\d+)m/.exec(jql);
    if (minutes) {
      const since = now() - Number(minutes[1]) * 60_000;
      issues = issues.filter((item) => Date.parse(item.fields.updated ?? "") >= since);
      issues.sort((a, b) => Date.parse(a.fields.updated ?? "") - Date.parse(b.fields.updated ?? "") || keyNum(a.key) - keyNum(b.key));
    } else {
      issues.sort((a, b) => keyNum(a.key) - keyNum(b.key));
    }
    return Promise.resolve(issues.slice(0, opts.maxTotal ?? 2000).map((item) => structuredClone(item)) as T[]);
  }

  function get<T>(path: string, params: QueryParams = {}): Promise<T> {
    const match = /^\/rest\/api\/3\/issue\/([A-Z]+-\d+)\/(comment|changelog)$/.exec(path);
    const entry = match ? data.get(match[1] ?? "") : undefined;
    if (!match || !entry) {
      return Promise.reject(new Error(`fake Jira: unexpected GET ${path}`));
    }
    const startAt = Number(params.startAt ?? 0);
    const max = Number(params.maxResults ?? 100);
    if (match[2] === "comment") {
      return Promise.resolve({ comments: entry.comments.slice(startAt, startAt + max), total: entry.comments.length } as T);
    }
    const values = entry.histories.slice(startAt, startAt + max);
    return Promise.resolve({ isLast: startAt + values.length >= entry.histories.length, values } as T);
  }

  return {
    approximateCount: () => Promise.resolve(data.size),
    get,
    request: () => Promise.reject(new Error("fake Jira: request not supported")),
    requestLog,
    searches,
    searchJql,
  };
}

/* ------------------------------------------------------------- fake SQL */

interface FakeCase {
  contentHash: string;
  fields: Record<string, unknown>;
  version: number;
}

class FakeDb implements SqlExecutor {
  readonly accounts = new Set<string>();
  readonly audit: unknown[] = [];
  readonly cases = new Map<string, FakeCase>();
  readonly contacts = new Map<string, { accountName: unknown; email: unknown; name: unknown }>();
  readonly events = new Map<string, Record<string, unknown>>();
  readonly links = new Map<string, Map<string, Record<string, unknown>>>();
  readonly log: string[] = [];
  readonly messages = new Map<string, Record<string, unknown>>();
  readonly migrations = new Set<number>();
  readonly sla = new Map<string, Record<string, unknown>>();
  readonly state = new Map<string, unknown>();
  failTransactionsFor: string | null = null;

  query<T extends object>(statement: SqlStatement): Promise<T[]> {
    return Promise.resolve(this.run(statement) as T[]);
  }

  transaction(statements: SqlStatement[]): Promise<Array<Array<Record<string, unknown>>>> {
    if (this.failTransactionsFor && statements.some((statement) => statement.params[0] === this.failTransactionsFor)) {
      return Promise.reject(new Error("boom at postgres://user:secret@host/db"));
    }
    /* All or nothing: run against a snapshot, commit only if every statement succeeds. */
    const snapshot = this.snapshot();
    try {
      return Promise.resolve(statements.map((statement) => this.run(statement)));
    } catch (error) {
      this.restore(snapshot);
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private snapshot(): string {
    return JSON.stringify({
      cases: [...this.cases],
      events: [...this.events],
      links: [...this.links].map(([k, v]) => [k, [...v]]),
      messages: [...this.messages],
      migrations: [...this.migrations],
      sla: [...this.sla],
    });
  }

  private restore(json: string): void {
    const parsed = JSON.parse(json) as {
      cases: Array<[string, FakeCase]>;
      events: Array<[string, Record<string, unknown>]>;
      links: Array<[string, Array<[string, Record<string, unknown>]>]>;
      messages: Array<[string, Record<string, unknown>]>;
      migrations: number[];
      sla: Array<[string, Record<string, unknown>]>;
    };
    const reset = <K, V>(target: Map<K, V>, entries: Array<[K, V]>): void => {
      target.clear();
      entries.forEach(([k, v]) => target.set(k, v));
    };
    reset(this.cases, parsed.cases);
    reset(this.events, parsed.events);
    reset(this.messages, parsed.messages);
    reset(this.sla, parsed.sla);
    this.links.clear();
    parsed.links.forEach(([k, v]) => this.links.set(k, new Map(v)));
    this.migrations.clear();
    parsed.migrations.forEach((v) => this.migrations.add(v));
  }

  private run(statement: SqlStatement): Array<Record<string, unknown>> {
    this.log.push(statement.name);
    const p = statement.params;
    const rows = (index: number): Array<Record<string, unknown>> => JSON.parse(String(p[index])) as Array<Record<string, unknown>>;
    switch (statement.name) {
      case "migrations.create_table":
      case "migrations.lock":
        return [];
      case "migrations.list_applied":
        return [...this.migrations].sort().map((version) => ({ version: String(version) }));
      case "migrations.record": {
        const version = Number(p[0]);
        if (this.migrations.has(version)) throw new Error("duplicate key schema_migrations_pkey");
        this.migrations.add(version);
        return [];
      }
      case "accounts.upsert":
        this.accounts.add(String(p[0]));
        return [];
      case "contacts.upsert":
        this.contacts.set(String(p[3]), { accountName: p[0], email: p[2], name: p[1] });
        return [];
      case "cases.upsert": {
        const key = String(p[0]);
        const existing = this.cases.get(key);
        const fields = { accountName: p[1], jiraUpdated: p[15], statusName: p[5], summary: p[10] };
        const hash = String(p[12]);
        this.cases.set(key, { contentHash: hash, fields, version: existing ? existing.version + (existing.contentHash === hash ? 0 : 1) : 1 });
        return [];
      }
      case "case_messages.upsert":
        rows(1).forEach((row) => this.messages.set(`${String(row.source)}:${String(row.external_id)}`, { ...row, case: p[0] }));
        return [];
      case "case_events.insert":
        rows(1).forEach((row) => {
          if (!this.events.has(String(row.external_id))) this.events.set(String(row.external_id), { ...row, case: p[0] });
        });
        return [];
      case "case_links.prune": {
        const keep = new Set(rows(1).map((row) => `${String(row.linked_key)}|${String(row.link_type)}`));
        const current = this.links.get(String(p[0])) ?? new Map<string, Record<string, unknown>>();
        [...current.keys()].filter((id) => !keep.has(id)).forEach((id) => current.delete(id));
        this.links.set(String(p[0]), current);
        return [];
      }
      case "case_links.upsert": {
        const current = this.links.get(String(p[0])) ?? new Map<string, Record<string, unknown>>();
        rows(1).forEach((row) => current.set(`${String(row.linked_key)}|${String(row.link_type)}`, row));
        this.links.set(String(p[0]), current);
        return [];
      }
      case "sla_clocks.upsert":
        rows(1).forEach((row) => this.sla.set(`${String(p[0])}:${String(row.metric)}`, row));
        return [];
      case "sync_state.get":
        return this.state.has(String(p[0])) ? [{ value: this.state.get(String(p[0])) }] : [];
      case "sync_state.put":
        this.state.set(String(p[0]), JSON.parse(String(p[1])));
        return [];
      case "cases.jira_updated_for_keys": {
        const keys = JSON.parse(String(p[0])) as string[];
        return keys.flatMap((key) => {
          const found = this.cases.get(key);
          return found ? [{ jira_key: key, jira_updated: found.fields.jiraUpdated }] : [];
        });
      }
      case "audit_log.insert":
        this.audit.push(p);
        return [];
      default:
        if (statement.name.startsWith("migrations.v")) return [];
        throw new Error(`FakeDb: unexpected statement ${statement.name}`);
    }
  }
}

function fakeLocks(): SyncLockStore & { keys: Map<string, number> } {
  const keys = new Map<string, number>();
  return {
    del: (key) => {
      keys.delete(key);
      return Promise.resolve();
    },
    keys,
    setIfAbsent: (key, ttl) => {
      if (keys.has(key)) return Promise.resolve(false);
      keys.set(key, ttl);
      return Promise.resolve(true);
    },
  };
}

/* ================================================================ tests */

async function main(): Promise<void> {
  /* ---------------------------------------------------------- mapping */
  {
    const raw = issue("TS-1");
    const fields = mapCaseFields(raw);
    assertEqual(fields.accountName, "Acme Health", "internal CertifyOS org is skipped for the account");
    assertEqual(fields.pod, "Credentialing", "pod is the option value");
    assertEqual(fields.reporter, { accountId: "cust-1", email: "carl@acme.test", isCustomer: true, name: "Carl Customer" }, "reporter contact");
    assertEqual(fields.descriptionText, "Provider stuck", "description ADF to text");
    assertEqual(fields.statusCategory, "indeterminate", "status category");
    assertEqual(mapCaseFields(issue("TS-2", { customfield_10002: [{ name: "CertifyOS" }] })).accountName, null, "only-internal org -> no account");
    assert(isInCasePod(raw), "pod by option id");
    assert(!isInCasePod(issue("TS-3", { customfield_10165: { id: "12446", value: "AI/ML" } })), "other pod rejected");
    assert(isInCasePod(issue("TS-3", { customfield_10165: { value: "Credentialing" } })), "pod by value when id missing");
    const moved = mapCaseFields(issue("TS-1", { updated: "2026-10-06T00:00:00.000Z" }));
    assertEqual(caseContentHash(moved), caseContentHash(fields), "jiraUpdated alone is not a real change");
    assert(caseContentHash(mapCaseFields(issue("TS-1", { summary: "changed" }))) !== caseContentHash(fields), "summary change changes the hash");
    assertEqual(mapLinks(raw), [{ direction: "outward", linkType: "Blocks", linkedKey: "CP-9" }], "links");
  }

  /* -------------------------------------------------- comment visibility */
  {
    assertEqual(commentVisibility(comment("1", "2026-10-05T14:00:00Z", { jsdPublic: false })), "internal", "jsdPublic false");
    assertEqual(commentVisibility(comment("2", "2026-10-05T14:00:00Z", { jsdPublic: true })), "public", "jsdPublic true");
    assertEqual(
      commentVisibility(comment("3", "2026-10-05T14:00:00Z", { properties: [{ key: "sd.public.comment", value: { internal: true } }] })),
      "internal",
      "sd.public.comment property",
    );
    assertEqual(commentVisibility(comment("4", "2026-10-05T14:00:00Z", { visibility: { type: "role", value: "Developers" } })), "internal", "role restriction");
    assertEqual(commentVisibility(comment("5", "2026-10-05T14:00:00Z")), "public", "default public");
  }

  /* --------------------------------------------- changelog -> events */
  {
    const histories: JiraHistory[] = [
      {
        author: { accountId: "agent-1", displayName: "Alice Agent" },
        created: "2026-10-05T15:00:00.000Z",
        id: "100",
        items: [
          { field: "status", fieldId: "status", from: "1", fromString: "Open", to: "10633", toString: "Waiting for product" },
          { field: "Labels", fieldId: "labels", fromString: "", toString: "x" },
        ],
      },
      { created: "2026-10-05T16:00:00.000Z", id: "101", items: [{ field: "resolution", fieldId: "resolution", to: "10000", toString: "Done" }] },
    ];
    const events = mapEvents(issue("TS-1"), histories, [comment("c1", "2026-10-05T15:30:00.000Z", { jsdPublic: false })]);
    assertEqual(
      events.map((e) => [e.kind, e.externalId, e.toValue]),
      [
        ["created", "jira:TS-1:created", "Open"],
        ["status", "jira:TS-1:h100:status:0", "Waiting for product"],
        ["comment", "jira:TS-1:cc1", "internal"],
        ["resolved", "jira:TS-1:h101:resolution:0", "Done"],
      ],
      "changelog -> events (unknown fields dropped, created status from first transition)",
    );
  }

  /* ------------------------------------------------ comment pagination */
  {
    const data = new Map<string, FakeIssueData>();
    const many = Array.from({ length: 150 }, (_unused, i) => comment(`m${i}`, new Date(at("2026-10-05T14:00:00Z") + i * 60_000).toISOString()));
    data.set("TS-1", { comments: many, histories: [], issue: issue("TS-1") });
    const jira = fakeJira(data, () => at("2026-10-06T00:00:00Z"));
    assertEqual((await fetchAllComments(jira, "TS-1")).length, 150, "all comment pages are read");
  }

  /* ------------------------------------------------------- sync ticks */
  {
    let nowMs = at("2026-10-06T14:00:00.000Z");
    const now = (): number => nowMs;
    const data = new Map<string, FakeIssueData>();
    for (const n of [1, 2, 3]) {
      data.set(`TS-${n}`, {
        comments: [comment(`c${n}`, "2026-10-05T13:30:00.000Z"), comment(`n${n}`, "2026-10-05T13:40:00.000Z", { jsdPublic: false })],
        histories: [],
        issue: issue(`TS-${n}`),
      });
    }
    const db = new FakeDb();
    const locks = fakeLocks();
    const jira = fakeJira(data, now);
    const deps: CaseSyncDeps = { db, jira, locks, now };
    const state = (): CaseSyncState => normalizeSyncState(db.state.get(SYNC_STATE_KEY));

    const first = await syncTick({ force: true, maxIssues: 2 }, deps);
    assert(first.ok, `first tick ok: ${JSON.stringify(first)}`);
    assertEqual(first.summary?.processed, 2, "first tick bounded by maxIssues");
    assertEqual(state().backfill.afterKey, "TS-2", "backfill cursor after first page");
    assertEqual(state().backfill.done, false, "backfill not done yet");
    assert(!locks.keys.has("cases:sync:lock"), "lock released");
    assert(jira.searches[0] === backfillJql(null), "first backfill search has no cursor");

    const throttled = await syncTick({ maxIssues: 2 }, deps);
    assertEqual(throttled.skipped, "throttled", "2-minute throttle");
    locks.keys.set("cases:sync:lock", 120);
    assertEqual((await syncTick({ force: true }, deps)).skipped, "already_running", "lock held -> already running");
    locks.keys.delete("cases:sync:lock");

    nowMs += 3 * 60_000;
    const second = await syncTick({ force: true, maxIssues: 2 }, deps);
    assertEqual(second.summary?.phase, "backfill+incremental", "backfill hands off to incremental in the same tick");
    assertEqual(state().backfill.done, true, "backfill done");
    assertEqual(db.cases.size, 3, "three cases");
    assertEqual(db.messages.size, 6, "six messages");
    assertEqual(db.events.size, 9, "created + two comment events per case");
    assertEqual(
      [...db.messages.values()].map((m) => m.visibility).sort(),
      ["internal", "internal", "internal", "public", "public", "public"],
      "visibility stored",
    );
    assertEqual(db.sla.size, 6, "two clocks per case");
    assert(String(jira.searches.at(-1)).includes("updated >= -"), "incremental search ran after backfill");
    const cursorAfterHandoff = state().incremental.cursor;
    assert(cursorAfterHandoff !== null && Date.parse(cursorAfterHandoff) >= at("2026-10-06T14:00:00.000Z"), "incremental cursor starts at backfill start");

    /* Idempotent: a re-sync of unchanged issues writes nothing new and bumps no version. */
    nowMs += 3 * 60_000;
    const third = await syncTick({ force: true }, deps);
    assertEqual(third.summary?.processed, 0, "nothing changed -> nothing synced");
    assertEqual([...db.cases.values()].map((c) => c.version), [1, 1, 1], "versions untouched");

    /* A real change on TS-2 (status) plus a new comment; TS-3 only gets a new comment. */
    nowMs += 3 * 60_000;
    const ts2 = data.get("TS-2");
    const ts3 = data.get("TS-3");
    if (!ts2 || !ts3) throw new Error("fixture missing");
    ts2.issue.fields.status = { id: "10633", name: "Waiting for product", statusCategory: { key: "indeterminate" } };
    ts2.issue.fields.updated = new Date(nowMs - 60_000).toISOString();
    ts2.histories.push({ created: ts2.issue.fields.updated, id: "200", items: [{ field: "status", from: "3", fromString: "In Progress", to: "10633", toString: "Waiting for product" }] });
    ts3.issue.fields.updated = new Date(nowMs - 30_000).toISOString();
    ts3.comments.push(comment("c3b", ts3.issue.fields.updated));
    ts3.issue.fields.issuelinks = [];
    const fourth = await syncTick({ force: true }, deps);
    assertEqual(fourth.summary?.processed, 2, "two changed issues re-synced");
    assertEqual(db.cases.get("TS-2")?.version, 2, "status change bumps version");
    assertEqual(db.cases.get("TS-3")?.version, 1, "a new comment alone does not bump version");
    assertEqual(db.messages.size, 7, "one new message");
    assertEqual(db.events.size, 11, "status event + comment event added, nothing duplicated");
    assertEqual(db.links.get("TS-3")?.size ?? 0, 0, "removed link pruned");
    assertEqual(db.sla.get("TS-2:resolution")?.state, "paused", "our resolution clock pauses in WfP");
    assert(Date.parse(state().incremental.cursor ?? "") > Date.parse(cursorAfterHandoff ?? ""), "incremental cursor advanced");

    /* A failing write is queued for retry, the cursor still advances, and a later tick retries it. */
    nowMs += 3 * 60_000;
    const ts1 = data.get("TS-1");
    if (!ts1) throw new Error("fixture missing");
    ts1.issue.fields.summary = "renamed";
    ts1.issue.fields.updated = new Date(nowMs - 10_000).toISOString();
    db.failTransactionsFor = "TS-1";
    const failing = await syncTick({ force: true }, deps);
    assert(failing.ok && (failing.summary?.errors.length ?? 0) === 1, "failure recorded as a tick error, tick still ok");
    assert(!JSON.stringify(state()).includes("secret"), "connection string redacted from sync_state");
    assertEqual(state().retry.map((r) => r.key), ["TS-1"], "failed issue queued for retry");
    db.failTransactionsFor = null;
    nowMs += 3 * 60_000;
    await syncTick({ force: true }, deps);
    assertEqual(state().retry, [], "retry succeeded and was dequeued");
    assertEqual(db.cases.get("TS-1")?.version, 2, "retried issue written");

    /* Manual sync: own 30s throttle and an audit row. */
    const manual = await runManualSync({ accountId: "agent-1", displayName: "Alice Agent" }, deps);
    assert(manual.ok && !manual.skipped, "manual sync runs");
    assertEqual(db.audit.length, 1, "manual sync audited");
    assertEqual((await runManualSync({ accountId: "agent-1", displayName: "Alice Agent" }, deps)).skipped, "throttled", "manual throttle");
  }

  /* -------------------------------------------------------- JQL shapes */
  {
    assert(backfillJql("TS-40").endsWith('AND key > TS-40 ORDER BY key ASC'), "backfill JQL continues after the cursor");
    assert(backfillJql(null).includes('cf[10165] = "Credentialing"'), "scope by pod value");
    assert(incrementalJql("2026-10-06T14:00:00.000Z", at("2026-10-06T14:10:00.000Z")).includes("updated >= -12m"), "cursor minus 2 minutes overlap");
  }

  /* ------------------------------------------------------- SLA engine */
  {
    const resolution = (statusChanges: Array<{ at: string; to: string; toName: string }>, opts: { goal?: number | null; now: string; resolutions?: Array<{ at: string; set: boolean }> }) =>
      computeResolutionClock(
        {
          createdAt: "2026-10-02T13:00:00.000Z" /* Fri 09:00 EDT */,
          currentStatus: { id: "3", name: "In Progress" },
          resolutionChanges: opts.resolutions ?? [],
          resolvedAt: null,
          statusChanges: statusChanges.map((c) => ({ at: c.at, fromId: "1", fromName: "Open", toId: c.to, toName: c.toName })),
        },
        opts.goal === undefined ? 45 * HOUR : opts.goal,
        at(opts.now),
        CAL,
      );

    /* Fri 09:00 -> Mon 12:00 EDT across a weekend: 9h Friday + 3h Monday. */
    const weekend = resolution([], { now: "2026-10-05T16:00:00.000Z" });
    assertEqual(weekend.elapsedBusinessMs, 12 * HOUR, "weekend not counted");
    assertEqual(weekend.state, "running", "running");
    assertEqual(weekend.remainingMs, 33 * HOUR, "remaining");

    /* Pause in WfP from Fri 12:00 to Mon 10:00 EDT: 3h + (Mon 10-12) 2h. */
    const paused = resolution(
      [
        { at: "2026-10-02T16:00:00.000Z", to: "10633", toName: "Waiting for product" },
        { at: "2026-10-05T14:00:00.000Z", to: "3", toName: "In Progress" },
      ],
      { now: "2026-10-05T16:00:00.000Z" },
    );
    assertEqual(paused.elapsedBusinessMs, 5 * HOUR, "WfP pause excluded");
    const waitingCustomer = resolution([{ at: "2026-10-02T16:00:00.000Z", to: "10900", toName: "Waiting for customer" }], { now: "2026-10-05T16:00:00.000Z" });
    assertEqual([waitingCustomer.state, waitingCustomer.elapsedBusinessMs], ["paused", 3 * HOUR], "waiting for customer pauses (by name)");
    assert(isPauseStatus("10633", "anything") && isPauseStatus("x", "Waiting for client") && !isPauseStatus("x", "Waiting for support"), "pause statuses");

    /* Breach: goal 4h from Fri 09:00 -> breached at Fri 13:00 EDT. */
    const breached = resolution([], { goal: 4 * HOUR, now: "2026-10-05T16:00:00.000Z" });
    assertEqual([breached.state, breached.breachedAt, breached.remainingMs], ["breached", "2026-10-02T17:00:00.000Z", -8 * HOUR], "breach instant");
    const exactly = resolution([], { goal: 4 * HOUR, now: "2026-10-02T17:00:00.000Z" });
    assertEqual(exactly.state, "running", "exactly at goal is not breached");

    /* Resolved Fri 15:00 -> met; reopened Mon 09:00 -> new cycle from zero. */
    const met = resolution([], { now: "2026-10-05T16:00:00.000Z", resolutions: [{ at: "2026-10-02T19:00:00.000Z", set: true }] });
    assertEqual([met.state, met.elapsedBusinessMs, met.stoppedAt], ["met", 6 * HOUR, "2026-10-02T19:00:00.000Z"], "stops at resolution");
    const reopened = resolution([], {
      now: "2026-10-05T16:00:00.000Z",
      resolutions: [
        { at: "2026-10-02T19:00:00.000Z", set: true },
        { at: "2026-10-05T13:00:00.000Z", set: false },
      ],
    });
    assertEqual([reopened.state, reopened.elapsedBusinessMs, reopened.stoppedAt], ["running", 3 * HOUR, null], "reopen starts a new cycle");
    assertEqual(resolution([], { goal: null, now: "2026-10-05T16:00:00.000Z" }).state, "none", "no Jira goal -> none");

    /* DST: fall back (2026-11-01) and spring forward (2027-03-14) - local 09-18 holds. */
    const fall = runClock({ calendar: CAL, events: [], goalMs: null, initiallyPaused: false, nowMs: at("2026-11-02T10:00:00-05:00"), startMs: at("2026-10-30T17:00:00-04:00") });
    assertEqual(fall.elapsedBusinessMs, 2 * HOUR, "fall-back weekend: Fri 17-18 EDT + Mon 09-10 EST");
    const spring = runClock({ calendar: CAL, events: [], goalMs: null, initiallyPaused: false, nowMs: at("2027-03-15T10:00:00-04:00"), startMs: at("2027-03-12T17:00:00-05:00") });
    assertEqual(spring.elapsedBusinessMs, 2 * HOUR, "spring-forward weekend: Fri 17-18 EST + Mon 09-10 EDT");
    const holiday = runClock({ calendar: CAL, events: [], goalMs: null, initiallyPaused: false, nowMs: at("2026-10-13T10:00:00-04:00"), startMs: at("2026-10-09T17:00:00-04:00") });
    assertEqual(holiday.elapsedBusinessMs, 2 * HOUR, "holiday Monday (Indigenous Peoples Day) skipped");

    /* First response: the first PUBLIC comment by an agent who isn't the reporter. */
    const firstAt = firstAgentResponseAt(
      [
        { authorAccountId: "cust-1", authorType: "customer", createdAt: "2026-10-02T13:10:00.000Z", visibility: "public" },
        { authorAccountId: "agent-1", authorType: "atlassian", createdAt: "2026-10-02T13:20:00.000Z", visibility: "internal" },
        { authorAccountId: "bot", authorType: "app", createdAt: "2026-10-02T13:25:00.000Z", visibility: "public" },
        { authorAccountId: "agent-1", authorType: "atlassian", createdAt: "2026-10-02T14:30:00.000Z", visibility: "public" },
      ],
      "cust-1",
    );
    assertEqual(firstAt, "2026-10-02T14:30:00.000Z", "first public agent comment");
    const frt = computeFirstResponseClock({ createdAt: "2026-10-02T13:00:00.000Z", firstResponseAt: firstAt }, 4 * HOUR, at("2026-10-05T16:00:00.000Z"), CAL);
    assertEqual([frt.state, frt.elapsedBusinessMs], ["met", 1.5 * HOUR], "first response met");
    const frtLate = computeFirstResponseClock({ createdAt: "2026-10-02T21:00:00.000Z", firstResponseAt: null }, 4 * HOUR, at("2026-10-05T18:00:00.000Z"), CAL);
    assertEqual([frtLate.state, frtLate.breachedAt], ["breached", "2026-10-05T16:00:00.000Z"], "after-hours ticket breaches Monday 12:00 EDT");

    /* Parity. */
    const clock = (over: Partial<SlaClock>): SlaClock => ({
      breachedAt: null,
      computedAt: "2026-10-05T16:00:00.000Z",
      elapsedBusinessMs: HOUR,
      goalMs: 4 * HOUR,
      jira: { breached: false, goalMs: 4 * HOUR, remainingMs: 3 * HOUR, state: "running" },
      metric: "resolution",
      remainingMs: 3 * HOUR,
      state: "running",
      stoppedAt: null,
      ...over,
    });
    assertEqual(parityMismatch(clock({}), clock({}).jira), null, "agree");
    assertEqual(parityMismatch(clock({ remainingMs: 3 * HOUR + 4 * 60_000 }), clock({}).jira), null, "within tolerance");
    assert(parityMismatch(clock({ remainingMs: 2 * HOUR }), clock({}).jira)?.startsWith("remaining time differs") === true, "remaining mismatch");
    assert(parityMismatch(clock({ state: "paused" }), clock({}).jira)?.includes("paused") === true, "paused vs running");
    assert(parityMismatch(clock({ state: "met", stoppedAt: "2026-10-02T19:00:00.000Z" }), clock({}).jira) !== null, "cycle open vs stopped");
    assertEqual(
      parityMismatch(clock({ state: "met", stoppedAt: "x" }), { breached: false, goalMs: 4 * HOUR, remainingMs: null, state: "completed_only" }),
      null,
      "both completed",
    );
    assert(parityMismatch(clock({ state: "breached" }), clock({}).jira)?.includes("breached") === true, "breach disagreement");
    const parity = summarizeParity([
      { clock: clock({}), jiraKey: "TS-1" },
      { clock: clock({ remainingMs: HOUR }), jiraKey: "TS-2" },
    ]);
    assertEqual([parity.compared, parity.matched, parity.mismatched, parity.examples[0]?.jiraKey], [2, 1, 1, "TS-2"], "parity summary");

    /* A full bundle carries both clocks with Jira's readings. */
    const bundle = buildCaseBundle({ comments: [], histories: [], issue: issue("TS-1"), nowMs: at("2026-10-05T16:00:00.000Z") });
    assertEqual(bundle.sla.map((s) => [s.metric, s.goalMs, s.jira.goalMs]), [["first_response", 4 * HOUR, 4 * HOUR], ["resolution", 45 * HOUR, 45 * HOUR]], "bundle clocks");
    assert(caseWriteStatements(bundle).map((s) => s.name).join(",").startsWith("accounts.upsert,contacts.upsert,cases.upsert"), "parents written before children");
  }

  /* ------------------------------------------------------- migrations */
  {
    validateMigrations(MIGRATIONS);
    const bad: Migration[] = [
      { name: "a", statements: ["SELECT 1"], version: 1 },
      { name: "c", statements: ["SELECT 1"], version: 3 },
    ];
    let threw = false;
    try {
      validateMigrations(bad);
    } catch {
      threw = true;
    }
    assert(threw, "a gap in versions is refused");

    const three: Migration[] = [1, 2, 3].map((version) => ({ name: `m${version}`, statements: [`SELECT ${version}`], version }));
    assertEqual(pendingMigrations(three, new Set([1])).map((m) => m.version), [2, 3], "pending in order");
    threw = false;
    try {
      pendingMigrations(three, new Set([4]));
    } catch {
      threw = true;
    }
    assert(threw, "database ahead of the build is refused");

    const tx = migrationTransaction(three[1] as Migration).map((s) => s.name);
    assertEqual(tx, ["migrations.lock", "migrations.v2.0", "migrations.record"], "lock first, record last");

    const db = new FakeDb();
    assertEqual(await runMigrations(db, three), [1, 2, 3], "applies all in order");
    assertEqual(await runMigrations(db, three), [], "second run is a no-op");
    const order = db.log.filter((name) => name.startsWith("migrations.v")).map((name) => name.split(".")[1]);
    assertEqual(order, ["v1", "v2", "v3"], "DDL ran in version order");

    /* Lost race: another instance records v2 between our read and our transaction. */
    const racy = new FakeDb();
    racy.migrations.add(1);
    const original = racy.transaction.bind(racy);
    racy.transaction = (statements: SqlStatement[]) => {
      if (statements.some((s) => s.name === "migrations.v2.0") && !racy.migrations.has(2)) racy.migrations.add(2);
      return original(statements);
    };
    assertEqual(await runMigrations(racy, three), [3], "a migration applied concurrently is skipped, not fatal");

    const memo = new FakeDb();
    await Promise.all([ensureMigrated(memo, three), ensureMigrated(memo, three)]);
    await ensureMigrated(memo, three);
    assertEqual(memo.log.filter((name) => name === "migrations.create_table").length, 1, "ensureMigrated runs once per executor");
    assert(MIGRATIONS[0]?.statements.every((s) => !s.includes("--")) === true, "no line comments in bundled SQL");
  }

  /* ------------------------------------------------------- redaction */
  assertEqual(
    redactDbError(new Error("connect failed postgres://u:hunter22@ep-x.neon.tech/db"), { DATABASE_URL: "postgres://u:hunter22@ep-x.neon.tech/db" }),
    "connect failed postgres://[redacted]",
    "connection string redacted",
  );

  console.log("test-cases: all assertions passed");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
