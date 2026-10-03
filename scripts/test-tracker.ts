import { notificationsFromJiraChanges } from "@/lib/notifications/jiraChanges";
import { followedTsKeysForQuery } from "@/lib/notifications/jiraSync";
import { changelogItems, commentItems, mergeTimeline, notificationItems } from "@/lib/tracker/detail";
import { getFollowedKeys, getFollowersByKey, getFollowersForAccounts, isTrackerKey, setFollowing } from "@/lib/tracker/follow";
import { deriveSignals, etDay, isEscalated, mergeAudience, slaNotifications, whoseMove } from "@/lib/tracker/signals";
import {
  CHUNK_SIZE,
  pickBotEscalation,
  readSnapshot,
  readSnapshotOwners,
  slackThreadsInComments,
  toTrackerTicket,
  writeSnapshot,
} from "@/lib/tracker/snapshot";

import type { JiraChangeInput, WatchedIssue } from "@/lib/notifications/jiraChanges";
import type { NotificationView } from "@/lib/notifications/types";
import type { FollowStore } from "@/lib/tracker/follow";
import type { SignalInput } from "@/lib/tracker/signals";
import type { RawTrackerIssue, SnapshotStore, TicketContext } from "@/lib/tracker/snapshot";
import type { SlackConversationRef, TrackerCp, TrackerSla, TrackerSnapshot, TrackerTicket } from "@/lib/tracker/types";

/* Run with: npx tsx scripts/test-tracker.ts - pure logic and in-memory stores only, nothing touches Redis, Jira or Slack. */

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

const BASE = "https://example.atlassian.net";
const ALICE = "acc-alice";
const BOB = "acc-bob";
const CAROL = "acc-carol";
const HOUR = 3_600_000;
const NOW = Date.parse("2026-10-03T15:00:00.000Z");

const NO_SLA: TrackerSla = { breached: false, goalMs: null, remainingMs: null, state: "none" };

function sla(overrides: Partial<TrackerSla>): TrackerSla {
  return { breached: false, goalMs: 72 * HOUR, remainingMs: 24 * HOUR, state: "running", ...overrides };
}

function cp(key: string, outcome: TrackerCp["outcome"]): TrackerCp {
  return { assigneeName: null, key, outcome, podName: "Credentialing", statusName: outcome, summary: null };
}

function conversation(overrides: Partial<SlackConversationRef> = {}): SlackConversationRef {
  return {
    channel: "C07U9C0EPEH",
    channelName: "technical-support",
    escalationHint: false,
    firstSeenAt: "2026-10-02T10:00:00.000Z",
    id: "C07U9C0EPEH:1727862000.000100",
    lastActivityAt: "2026-10-03T12:00:00.000Z",
    participants: 2,
    replyCount: 3,
    rootTs: "1727862000.000100",
    source: "event",
    ticketKeys: ["TS-1"],
    ...overrides,
  };
}

function ticket(overrides: Partial<TrackerTicket> = {}): TrackerTicket {
  return {
    account: "Acme",
    assignee: { accountId: ALICE, name: "Alice A" },
    botEscalation: null,
    cps: [],
    created: "2026-09-01T00:00:00.000Z",
    escalated: false,
    firstResponse: NO_SLA,
    key: "TS-1",
    lastActivityAt: "2026-10-03T10:00:00.000Z",
    pod: null,
    priority: "High",
    reporterName: null,
    resolvedAt: null,
    signals: [],
    slack: { activeConversations: 0, conversations: 0, lastActivityAt: null },
    statusCategory: "indeterminate",
    statusId: "3",
    statusName: "In Progress",
    summary: "Roster upload fails",
    ttr: sla({}),
    updated: "2026-10-03T10:00:00.000Z",
    whoseMove: "on_ts",
    ...overrides,
  };
}

/* ------------------------------------------------------------ whose move */

function testWhoseMove(): void {
  console.log("\n--- Test: whose move it is, from status and CPs ---");
  const table: Array<[string, TrackerTicket["statusCategory"], TrackerCp["outcome"][], string]> = [
    ["10633", "indeterminate", [], "on_engineering"],
    ["3", "indeterminate", ["open"], "on_engineering"],
    ["10045", "indeterminate", ["fix_ready"], "on_engineering"],
    ["10045", "indeterminate", ["shipped"], "on_customer"],
    ["10263", "indeterminate", [], "on_customer"],
    ["10634", "indeterminate", [], "on_operations"],
    ["1", "new", [], "new"],
    ["10173", "new", ["rejected"], "new"],
    ["3", "indeterminate", [], "on_ts"],
    ["4", "indeterminate", [], "on_ts"],
    ["12772", "indeterminate", [], "on_ts"],
    ["10262", "indeterminate", [], "on_ts"],
    ["11062", "indeterminate", [], "on_ts"],
    ["99999", "indeterminate", [], "on_ts"],
    ["10633", "done", ["open"], "closed"],
    ["6", "done", [], "closed"],
  ];
  for (const [statusId, category, outcomes, expected] of table) {
    assertEqual(whoseMove(statusId, category, outcomes), expected, `whoseMove(${statusId}, ${category}, [${outcomes.join(",")}])`);
  }
  console.log("PASS");
}

/* --------------------------------------------------------------- signals */

function signalInput(overrides: Partial<SignalInput> = {}): SignalInput {
  return {
    botEscalation: null,
    cps: [],
    escalationComment: false,
    firstResponse: NO_SLA,
    priorityRaised: false,
    sentiment: null,
    slackConversations: [],
    slackPermalink: false,
    statusId: "3",
    ttr: sla({}),
    ...overrides,
  };
}

function testSignals(): void {
  console.log("\n--- Test: signals, their tiers and the escalated flag ---");
  assertEqual(deriveSignals(signalInput()), [], "a quiet ticket has no signals");
  assert(!isEscalated(deriveSignals(signalInput({ sentiment: "Negative" }))), "tier 3 alone is not escalated");
  assert(!isEscalated(deriveSignals(signalInput({ firstResponse: sla({ breached: true, remainingMs: -HOUR }) }))), "first-response breach alone is context only");

  const everything = deriveSignals(
    signalInput({
      botEscalation: { cpKey: "CP-9", levelSent: 2, state: "open" },
      cps: [cp("CP-9", "open"), cp("CP-10", "fix_ready"), cp("CP-11", "shipped")],
      escalationComment: true,
      firstResponse: sla({ breached: true }),
      priorityRaised: true,
      sentiment: "Negative",
      slackConversations: [conversation(), conversation({ channelName: "customer-acme", id: "C2:1.1" })],
      slackPermalink: true,
      statusId: "10633",
      ttr: sla({ breached: true, remainingMs: -3 * HOUR }),
    }),
  );
  assertEqual(
    everything.map((item) => `${item.tier}:${item.kind}`),
    [
      "1:waiting_for_product",
      "1:open_cp",
      "1:bot_thread",
      "1:ttr_breached",
      "2:priority_raised",
      "2:escalation_comment",
      "2:slack_conversation",
      "2:slack_permalink",
      "3:first_response_breached",
      "3:negative_sentiment",
    ],
    "every signal, strongest first (a breached TTR is not also 'at risk')",
  );
  const byKind = new Map(everything.map((item) => [item.kind, item]));
  assertEqual(byKind.get("open_cp")?.label, "Open CP-9, CP-10", "open CP lists only pending keys");
  assertEqual(byKind.get("open_cp")?.detail, "Fix ready: CP-10", "fix-ready CPs are called out");
  assertEqual(byKind.get("bot_thread")?.label, "Bot escalation L2", "bot level");
  assertEqual(byKind.get("slack_conversation")?.label, "Discussed in #technical-support", "most recent conversation's channel");
  assertEqual(byKind.get("slack_conversation")?.detail, "2 Slack conversations", "conversation count");
  assertEqual(byKind.get("ttr_breached")?.detail, "3h over", "overrun shown");

  const atRisk = deriveSignals(signalInput({ ttr: sla({ remainingMs: 5 * HOUR + 30 * 60_000 }) }));
  assertEqual(atRisk.map((item) => item.kind), ["ttr_at_risk"], "under 8h while running is at risk");
  assertEqual(atRisk[0]?.label, "Resolution SLA due in 5h 30m", "at-risk label");
  assert(isEscalated(atRisk), "at risk is tier 2, so escalated");
  assertEqual(deriveSignals(signalInput({ ttr: sla({ remainingMs: 5 * HOUR, state: "paused" }) })), [], "a paused clock is never at risk");
  assertEqual(deriveSignals(signalInput({ ttr: sla({ remainingMs: 9 * HOUR }) })), [], "9h left is fine");
  assertEqual(deriveSignals(signalInput({ cps: [cp("CP-1", "shipped"), cp("CP-2", "rejected")] })), [], "only pending CPs signal");
  console.log("PASS");
}

function rawIssue(overrides: Partial<RawTrackerIssue["fields"]> = {}, key = "TS-1"): RawTrackerIssue {
  return {
    fields: {
      assignee: { accountId: ALICE, displayName: "Alice A" },
      created: "2026-09-01T00:00:00.000Z",
      customfield_10002: [],
      customfield_10165: { value: "Credentialing" },
      customfield_10251: { name: "Negative" },
      customfield_10650: { ongoingCycle: { breached: false, goalDuration: { millis: 72 * HOUR }, paused: false, remainingTime: { millis: 4 * HOUR } } },
      issuelinks: [{ outwardIssue: { key: "CP-9" } }, { inwardIssue: { key: "TS-5" } }, { inwardIssue: { key: "CP-9" } }],
      labels: ["acme-health"],
      priority: { name: "Critical" },
      reporter: { displayName: "Pat Customer" },
      resolutiondate: null,
      status: { id: "3", name: "In Progress", statusCategory: { key: "indeterminate" } },
      summary: `  ${"x".repeat(200)}  `,
      updated: "2026-10-03T10:00:00.000Z",
      ...overrides,
    },
    key,
  };
}

function testTicketMapping(): void {
  console.log("\n--- Test: a Jira issue maps to a tracker row ---");
  const ctx: TicketContext = {
    botRecords: new Map([["CP-9", { levelSent: 1, permalink: "https://slack/p1", state: "open" as const }]]),
    cps: new Map([["CP-9", cp("CP-9", "open")]]),
    escalationCommentKeys: new Set(),
    nowMs: NOW,
    priorityRaisedKeys: new Set(["TS-1"]),
    slackByKey: new Map([
      [
        "TS-1",
        [conversation({ lastActivityAt: "2026-10-03T14:00:00.000Z" }), conversation({ id: "C2:2.2", lastActivityAt: "2026-09-01T00:00:00.000Z" })],
      ],
    ]),
    slackLinkKeys: new Set(),
  };
  const row = toTrackerTicket(rawIssue(), ctx);
  assertEqual(row.account, "acme-health", "no Organization -> first label");
  assertEqual(toTrackerTicket(rawIssue({ customfield_10002: [{ name: "Acme Health" }] }), ctx).account, "Acme Health", "Organization wins");
  assertEqual(toTrackerTicket(rawIssue({ labels: [] }), ctx).account, null, "neither -> null");
  assertEqual(row.summary.length, 160, "summary clipped to 160");
  assertEqual(row.cps.map((item) => item.key), ["CP-9"], "CP links deduplicated, TS links ignored");
  assertEqual(row.whoseMove, "on_engineering", "an open CP puts it on engineering");
  assertEqual(row.botEscalation, { cpKey: "CP-9", levelSent: 1, permalink: "https://slack/p1", state: "open" }, "bot record via the linked CP");
  assertEqual(row.slack, { activeConversations: 1, conversations: 2, lastActivityAt: "2026-10-03T14:00:00.000Z" }, "slack summary");
  assertEqual(row.lastActivityAt, "2026-10-03T14:00:00.000Z", "Slack activity newer than Jira's updated");
  assertEqual(row.pod, "Credentialing", "pod");
  assertEqual(row.priority, "Critical", "priority");
  assertEqual(row.ttr.state, "running", "ttr parsed");
  assert(row.escalated, "escalated");
  assertEqual(
    row.signals.map((item) => item.kind),
    ["open_cp", "bot_thread", "priority_raised", "slack_conversation", "ttr_at_risk", "negative_sentiment"],
    "signals on the row",
  );
  assertEqual(toTrackerTicket(rawIssue({ priority: { name: "Highest" } }), ctx).priority, "Medium", "unknown priority reads as Medium");

  /* An open Epic is a container for planned work, not a fix someone is on: it must not read as "waiting on engineering". */
  const epicCtx: TicketContext = { ...ctx, botRecords: new Map(), cps: new Map([["CP-9", { ...cp("CP-9", "open"), isEpic: true }]]), priorityRaisedKeys: new Set(), slackByKey: new Map() };
  const epicRow = toTrackerTicket(rawIssue({ customfield_10650: null }), epicCtx);
  assertEqual(epicRow.whoseMove, "on_ts", "an open Epic CP leaves the move with TS");
  assert(!epicRow.signals.some((item) => item.kind === "open_cp"), "and raises no open-CP signal");
  assertEqual(epicRow.cps.map((item) => item.key), ["CP-9"], "but is still listed");

  assertEqual(
    pickBotEscalation(["CP-1", "CP-2", "CP-3"], new Map([
      ["CP-1", { levelSent: 3, state: "resolved" as const }],
      ["CP-2", { levelSent: 1, state: "acked" as const }],
      ["CP-3", { levelSent: 2, state: "open" as const }],
    ]))?.cpKey,
    "CP-3",
    "an ongoing escalation beats a finished one, then the highest level",
  );
  console.log("PASS");
}

function testSlackThreadsInComments(): void {
  console.log("\n--- Test: Slack threads found in Jira comment bodies (link marks included) ---");
  const body = {
    content: [
      {
        content: [
          { marks: [{ attrs: { href: "https://certifyos.slack.com/archives/C07U9C0EPEH/p1727862000000100?thread_ts=1727861000.000200&cid=C07U9C0EPEH" }, type: "link" }], text: "see thread", type: "text" },
          { attrs: { url: "https://certifyos.slack.com/archives/C0123ABCD/p1727863000000300" }, type: "inlineCard" },
        ],
        type: "paragraph",
      },
    ],
    type: "doc",
  };
  const threads = slackThreadsInComments([
    { body, created: "2026-10-02T10:00:00.000Z", id: "1" },
    { body: "again https://certifyos.slack.com/archives/C0123ABCD/p1727863000000300", created: "2026-10-02T11:00:00.000Z", id: "2" },
  ]);
  assertEqual(
    threads,
    [
      { at: "2026-10-02T10:00:00.000Z", channel: "C07U9C0EPEH", rootTs: "1727861000.000200" },
      { at: "2026-10-02T10:00:00.000Z", channel: "C0123ABCD", rootTs: "1727863000.000300" },
    ],
    "a reply link points at its thread root; repeats collapse",
  );
  console.log("PASS");
}

/* ------------------------------------------------------- SLA notifications */

function testSlaNotifications(): void {
  console.log("\n--- Test: SLA notifications - first snapshot silent, breach once, due-2h per day ---");
  const audienceByKey = new Map([["TS-1", [ALICE, BOB]]]);
  const fine = ticket({ ttr: sla({ remainingMs: 5 * HOUR }) });
  const soon = ticket({ ttr: sla({ remainingMs: 90 * 60_000 }) });
  const breached = ticket({ ttr: sla({ breached: true, remainingMs: -60_000 }) });

  assertEqual(slaNotifications({ audienceByKey, baseUrl: BASE, current: [breached], nowMs: NOW, previous: null }), [], "first snapshot says nothing");

  const due = slaNotifications({ audienceByKey, baseUrl: `${BASE}/`, current: [soon], nowMs: NOW, previous: [fine] });
  assertEqual(due.map((item) => item.id), [`tracker:TS-1:ttr_due_2h:${etDay(NOW)}`], "crossing under 2h warns");
  assertEqual(etDay(Date.parse("2026-10-03T02:00:00.000Z")), "2026-10-02", "the day is New York's");
  const [warning] = due;
  assertEqual(warning?.kind, "tracker_sla", "kind");
  assertEqual(warning?.source, "jira", "source");
  assert(warning?.important === true, "important");
  assertEqual(warning?.audience, [ALICE, BOB], "audience from the map");
  assertEqual(warning?.url, `${BASE}/browse/TS-1`, "links to the issue");
  assertEqual(warning?.title, "TS-1 resolution SLA due in 1h 30m", "title");
  assertEqual(slaNotifications({ audienceByKey, baseUrl: BASE, current: [soon], nowMs: NOW, previous: [soon] }), [], "still under 2h: no repeat");

  const breach = slaNotifications({ audienceByKey, baseUrl: BASE, current: [breached], nowMs: NOW, previous: [soon] });
  assertEqual(breach.map((item) => item.id), ["tracker:TS-1:ttr_breached"], "breach notifies, with a per-ticket id (once ever, via write-once ids)");
  assertEqual(slaNotifications({ audienceByKey, baseUrl: BASE, current: [breached], nowMs: NOW, previous: [breached] }), [], "still breached: nothing");
  assertEqual(
    slaNotifications({ audienceByKey, baseUrl: BASE, current: [breached], nowMs: NOW, previous: [fine] }).map((item) => item.id),
    ["tracker:TS-1:ttr_breached"],
    "a jump straight to breached is one breach, not a due warning too",
  );
  assertEqual(slaNotifications({ audienceByKey, baseUrl: BASE, current: [breached], nowMs: NOW, previous: [] }), [], "new to the scope: history, not news");
  assertEqual(
    slaNotifications({ audienceByKey, baseUrl: BASE, current: [ticket({ ttr: sla({ remainingMs: HOUR, state: "paused" }) })], nowMs: NOW, previous: [fine] }),
    [],
    "a paused clock doesn't warn",
  );
  assertEqual(
    slaNotifications({ audienceByKey, baseUrl: BASE, current: [{ ...breached, statusCategory: "done" }], nowMs: NOW, previous: [soon] }),
    [],
    "closed tickets are left alone",
  );
  const tomorrow = NOW + 24 * HOUR;
  assert(etDay(tomorrow) !== etDay(NOW), "a different ET day re-arms the warning id");
  console.log("PASS");
}

/* --------------------------------------------------------------- audience */

function memoryFollowStore(): FollowStore {
  const sets = new Map<string, Set<string>>();
  const set = (key: string): Set<string> => {
    const existing = sets.get(key) ?? new Set<string>();
    sets.set(key, existing);
    return existing;
  };
  return {
    expire: () => Promise.resolve(),
    sadd: (key, member) => {
      set(key).add(member);
      return Promise.resolve();
    },
    scard: (key) => Promise.resolve(set(key).size),
    smembers: (key) => Promise.resolve([...set(key)]),
    srem: (key, member) => {
      set(key).delete(member);
      return Promise.resolve();
    },
  };
}

async function testFollowAndAudience(): Promise<void> {
  console.log("\n--- Test: following, and the audience merge (assignee if registered + registered followers) ---");
  const store = memoryFollowStore();
  assert(isTrackerKey("TS-12") && isTrackerKey("CP-3") && !isTrackerKey("TS-12 OR 1=1") && !isTrackerKey("ts-12"), "key validation");
  assert(!(await setFollowing(ALICE, "TS-1) OR (1=1", true, store)), "a malformed key is refused");
  assert(await setFollowing(BOB, "TS-1", true, store), "bob follows TS-1");
  assert(await setFollowing(CAROL, "TS-1", true, store), "carol follows TS-1");
  assert(await setFollowing(CAROL, "TS-2", true, store), "carol follows TS-2");
  assert(await setFollowing(CAROL, "CP-7", true, store), "carol follows CP-7");
  assert(await setFollowing(CAROL, "TS-2", false, store), "carol unfollows TS-2");
  assertEqual(await getFollowedKeys(CAROL, store), ["CP-7", "TS-1"], "carol's list");
  assertEqual([...(await getFollowersByKey(["TS-1", "TS-2", "bad key"], store)).entries()], [["TS-1", [BOB, CAROL]]], "followers per key, unfollowed gone");
  assertEqual(
    [...(await getFollowersForAccounts([BOB, CAROL], store)).entries()].sort(),
    [["CP-7", [CAROL]], ["TS-1", [BOB, CAROL]]],
    "inverted from people's own lists",
  );

  const registered = new Set([ALICE, BOB]);
  const audience = mergeAudience({
    assigneeByKey: new Map<string, string | null>([["TS-1", ALICE], ["TS-2", "acc-stranger"], ["TS-3", null]]),
    followersByKey: new Map([["TS-1", [BOB, CAROL]], ["TS-2", [BOB]], ["TS-9", [ALICE, CAROL]]]),
    keys: ["TS-1", "TS-2", "TS-3", "TS-9", "TS-404"],
    registered,
  });
  assertEqual(audience.get("TS-1"), [ALICE, BOB], "registered assignee + registered follower; unregistered follower dropped");
  assertEqual(audience.get("TS-2"), [BOB], "unregistered assignee dropped, follower kept");
  assert(!audience.has("TS-3"), "nobody to tell -> absent");
  assertEqual(audience.get("TS-9"), [ALICE], "not in the snapshot -> followers only");
  assert(!audience.has("TS-404"), "unknown and unfollowed -> absent, so callers fall back");
  console.log("PASS");
}

/* --------------------------------------------------------------- snapshot */

function memorySnapshotStore(): SnapshotStore & { raw: Map<string, unknown> } {
  const raw = new Map<string, unknown>();
  return {
    del: (keys) => {
      keys.forEach((key) => raw.delete(key));
      return Promise.resolve();
    },
    get: <T>(key: string) => Promise.resolve(raw.has(key) ? (structuredClone(raw.get(key)) as T) : null),
    mget: <T>(keys: string[]) => Promise.resolve(keys.map((key) => (raw.has(key) ? (structuredClone(raw.get(key)) as T) : null))),
    raw,
    set: (key, value) => {
      raw.set(key, structuredClone(value));
      return Promise.resolve();
    },
    setIfAbsent: (key, value) => {
      if (raw.has(key)) {
        return Promise.resolve(false);
      }
      raw.set(key, structuredClone(value));
      return Promise.resolve(true);
    },
  };
}

function snapshotOf(count: number, builtAt: string): TrackerSnapshot {
  return {
    builtAt,
    errors: ["one search failed"],
    scopeJql: "project = TS",
    tickets: Array.from({ length: count }, (_unused, index) =>
      ticket({ assignee: index % 2 === 0 ? { accountId: ALICE, name: "Alice A" } : null, key: `TS-${index + 1}` }),
    ),
  };
}

async function testSnapshotGenerations(): Promise<void> {
  console.log("\n--- Test: snapshot chunks, generation switch, old generation cleanup, torn reads ---");
  const store = memorySnapshotStore();
  assertEqual(await readSnapshot(store), null, "nothing before the first build");

  const first = snapshotOf(CHUNK_SIZE * 2 + 10, "2026-10-03T14:00:00.000Z");
  await writeSnapshot(store, first, "g1");
  assertEqual([...store.raw.keys()].filter((key) => key.startsWith("tracker:snap:g1:")).length, 4, "3 chunks + the owner index");
  const read = await readSnapshot(store);
  assertEqual(read?.tickets.map((row) => row.key), first.tickets.map((row) => row.key), "round trip keeps order");
  assertEqual(read?.errors, ["one search failed"], "errors kept");
  assertEqual((await readSnapshotOwners(store))?.get("TS-1"), ALICE, "owner index");
  assertEqual((await readSnapshotOwners(store))?.get("TS-2"), null, "unassigned in the owner index");

  /* A reader that fetched g1's meta, then a writer switches to g2 before it reads the chunks. */
  const tornStore = memorySnapshotStore();
  await writeSnapshot(tornStore, first, "g1");
  const second = snapshotOf(5, "2026-10-03T14:05:00.000Z");
  let switched = false;
  const racing: SnapshotStore = {
    ...tornStore,
    mget: async <T>(keys: string[]) => {
      if (!switched) {
        switched = true;
        await writeSnapshot(tornStore, second, "g2");
      }
      return tornStore.mget<T>(keys);
    },
  };
  const afterRace = await readSnapshot(racing);
  assertEqual(afterRace?.builtAt, second.builtAt, "a torn read retries on the new generation, never mixes");
  assertEqual(afterRace?.tickets.length, 5, "all of the new one");
  assertEqual([...tornStore.raw.keys()].filter((key) => key.startsWith("tracker:snap:g1:")), [], "the old generation is deleted after the switch");

  /* Chunks expired but meta survived: reads as no snapshot rather than a partial list. */
  tornStore.raw.delete("tracker:snap:g2:0");
  assertEqual(await readSnapshot(tornStore), null, "a missing chunk is never served as a partial list");
  console.log("PASS");
}

/* ------------------------------------------------- follower-aware Jira sync */

const SINCE = Date.parse("2026-10-02T15:00:00.000Z");

function watched(overrides: Partial<WatchedIssue> = {}): WatchedIssue {
  return {
    assignee: { accountId: ALICE, accountType: "atlassian", displayName: "Alice A" },
    comments: [],
    histories: [],
    key: "TS-100",
    reporterAccountId: "cust-1",
    summary: "Roster upload fails",
    ...overrides,
  };
}

function adf(text: string, mentionId?: string): unknown {
  return {
    content: [{ content: [...(mentionId ? [{ attrs: { id: mentionId, text: "@someone" }, type: "mention" }] : []), { text, type: "text" }], type: "paragraph" }],
    type: "doc",
    version: 1,
  };
}

function runSync(input: Partial<JiraChangeInput>): ReturnType<typeof notificationsFromJiraChanges> {
  return notificationsFromJiraChanges({ baseUrl: BASE, cps: [], registeredAccountIds: new Set([ALICE, BOB, CAROL]), sinceMs: SINCE, tickets: [], ...input });
}

function testFollowerAwareJiraNotifications(): void {
  console.log("\n--- Test: Jira notifications reach followers too, never the actor ---");
  const followersByKey = new Map([["TS-100", [BOB, CAROL, "acc-unregistered"]], ["CP-55", [CAROL]]]);
  const out = runSync({
    followersByKey,
    tickets: [
      watched({
        comments: [
          { author: { accountId: "cust-1", accountType: "customer", displayName: "Pat" }, body: adf("still broken"), created: "2026-10-02T15:10:00.000Z", id: "1" },
          { author: { accountId: BOB, accountType: "atlassian", displayName: "Bob B" }, body: adf(" look", ALICE), created: "2026-10-02T15:11:00.000Z", id: "2" },
        ],
        histories: [
          {
            author: { accountId: BOB, displayName: "Bob B" },
            created: "2026-10-02T15:20:00.000Z",
            id: "900",
            items: [
              { fieldId: "status", fromString: "Waiting for Client", toString: "In Progress" },
              { fieldId: "assignee", from: BOB, to: ALICE, toString: "Alice A" },
            ],
          },
        ],
      }),
    ],
  });
  const byId = new Map(out.map((item) => [item.id, item]));
  assertEqual(byId.get("jira:TS-100:c1")?.audience, [ALICE, BOB, CAROL], "a customer reply reaches owner + registered followers");
  const mention = byId.get("jira:TS-100:c2");
  assertEqual(mention?.audience, [ALICE, CAROL], "Bob isn't told about his own comment");
  assertEqual(mention?.title, "Bob B commented on TS-100", "not 'mentioned you' when it isn't true for everyone");
  assert(mention?.important === true, "but still important: it mentions someone listening");
  assertEqual(byId.get("jira:TS-100:h900:status")?.audience, [ALICE, CAROL], "status move reaches everyone but its author");
  assertEqual(byId.get("jira:TS-100:h900:assignee")?.audience, [ALICE], "'assigned to you' stays the assignee's");
  assertEqual(byId.get("jira:TS-100:h900:assignee:followers")?.audience, [CAROL], "followers see who has it now");
  assertEqual(byId.get("jira:TS-100:h900:assignee:followers")?.title, "TS-100 was assigned to Alice A", "follower assignment title");

  const unowned = runSync({
    followersByKey,
    tickets: [
      watched({
        assignee: { accountId: "acc-stranger" },
        comments: [{ author: { accountId: "cust-1", accountType: "customer" }, body: "hi", created: "2026-10-02T15:10:00.000Z", id: "1" }],
      }),
    ],
  });
  assertEqual(unowned[0]?.audience, [BOB, CAROL], "a followed ticket with an unregistered assignee still notifies its followers");
  assertEqual(runSync({ tickets: [watched({ assignee: { accountId: "acc-stranger" }, comments: [{ author: { accountType: "customer" }, body: "hi", created: "2026-10-02T15:10:00.000Z", id: "1" }] })] }), [], "no followers, unregistered owner: nothing (unchanged)");

  const cpOut = runSync({
    cps: [
      {
        issue: {
          assignee: null,
          comments: [{ author: { accountId: "eng-1", accountType: "atlassian", displayName: "Eve" }, body: adf("fix merged"), created: "2026-10-02T15:30:00.000Z", id: "77" }],
          histories: [],
          key: "CP-55",
        },
        linkedTickets: [
          { assigneeAccountId: null, key: "TS-100" },
          { assigneeAccountId: "acc-stranger", key: "TS-101" },
        ],
      },
      {
        issue: { assignee: null, comments: [{ author: { accountId: "eng-1", displayName: "Eve" }, body: adf("hi"), created: "2026-10-02T15:31:00.000Z", id: "78" }], histories: [], key: "CP-56" },
        linkedTickets: [],
      },
    ],
    followersByKey: new Map([["TS-100", [BOB]], ["CP-56", [CAROL]]]),
  });
  const cpComment = cpOut.find((item) => item.id === "jira:CP-55:c77");
  assertEqual(cpComment?.audience, [BOB], "CP activity reaches followers of the linked TS ticket");
  assertEqual(cpComment?.ticketKey, "TS-100", "only the listened-to TS key is named");
  assert(cpComment?.detail?.endsWith("linked to TS-100") === true, `detail: ${cpComment?.detail}`);
  assertEqual(cpOut.find((item) => item.id === "jira:CP-56:c78")?.audience, [CAROL], "a followed CP notifies its own followers");

  assertEqual(
    followedTsKeysForQuery(new Map([["TS-5", [ALICE]], ["CP-7", [ALICE]], ["TS-100", [BOB]], ["TS-20", [BOB]]]), 2),
    ["TS-100", "TS-20"],
    "the sync's key list: TS keys only, newest first, capped",
  );
  console.log("PASS");
}

/* ----------------------------------------------------------------- detail */

function testDetailTimeline(): void {
  console.log("\n--- Test: detail timeline pieces merge oldest first ---");
  const comments = commentItems(
    [
      { author: { accountType: "customer", displayName: "Pat" }, body: adf("help"), created: "2026-10-02T10:00:00.000Z", id: "1", jsdPublic: true },
      { author: { displayName: "Alice A" }, body: adf("checking logs"), created: "2026-10-02T11:00:00.000Z", id: "2", jsdPublic: false },
      { author: { displayName: "No date" }, body: "x", id: "3" },
    ],
    { baseUrl: BASE, issueKey: "TS-1", on: "ts" },
  );
  assertEqual(comments.map((item) => [item.kind, item.internal, item.title]), [["jira_comment", false, "Pat replied"], ["jira_internal_note", true, "Alice A added an internal note"]], "comments and internal notes");
  const cpComments = commentItems([{ author: { displayName: "Eve" }, body: "merged", created: "2026-10-02T12:00:00.000Z", id: "9" }], { baseUrl: BASE, issueKey: "CP-9", on: "cp" });
  assertEqual(cpComments[0]?.thread, "CP-9", "CP items get their own tab");
  const history = changelogItems(
    [
      {
        author: { displayName: "Bob B" },
        created: "2026-10-02T09:00:00.000Z",
        id: "5",
        items: [
          { fieldId: "status", fromString: "To Do", toString: "Waiting for product" },
          { fieldId: "priority", fromString: "Medium", toString: "High" },
          { fieldId: "assignee", toString: "Alice A" },
          { field: "Link", toString: "This issue relates to CP-9" },
          { fieldId: "labels", toString: "noise" },
        ],
      },
    ],
    { baseUrl: BASE, issueKey: "TS-1", on: "ts" },
  );
  assertEqual(history.map((item) => item.kind), ["jira_status", "jira_priority", "jira_assignee", "jira_link"], "changelog kinds, noise skipped");
  const views: NotificationView[] = [
    { at: "2026-10-02T13:00:00.000Z", id: "slack:C1:1.1", important: false, kind: "slack_mention", read: true, receivedAt: "", score: 1, source: "slack", ticketKey: "TS-1", title: "mentioned" },
    { at: "2026-10-02T13:30:00.000Z", id: "jira:TS-1:c1", important: false, kind: "jira_comment", read: true, receivedAt: "", score: 2, source: "jira", ticketKey: "TS-1", title: "dup" },
    { at: "2026-10-02T14:00:00.000Z", id: "tracker:TS-1:ttr_breached", important: true, kind: "tracker_sla", read: true, receivedAt: "", score: 3, source: "jira", ticketKey: "TS-1", title: "breached" },
    { at: "2026-10-02T14:30:00.000Z", cpKey: "CP-9", id: "esc:1", important: false, kind: "escalation_update", read: true, receivedAt: "", score: 4, source: "escalation", title: "L1" },
    { at: "2026-10-02T15:00:00.000Z", id: "slack:C1:2.2", important: false, kind: "slack_mention", read: true, receivedAt: "", score: 5, source: "slack", ticketKey: "TS-2", title: "other" },
  ];
  const notes = notificationItems(views, new Set(["TS-1", "CP-9"]));
  assertEqual(notes.map((item) => [item.kind, item.id]), [["slack_message", "notif:slack:C1:1.1"], ["notification", "notif:tracker:TS-1:ttr_breached"], ["notification", "notif:esc:1"]], "jira duplicates and other tickets dropped");
  const merged = mergeTimeline([comments, cpComments, history, notes, comments]);
  assert(merged.every((item, index) => index === 0 || Date.parse(merged[index - 1]?.at ?? "") <= Date.parse(item.at)), "ascending");
  assertEqual(merged.length, comments.length + cpComments.length + history.length + notes.length, "duplicates collapse by id");
  console.log("PASS");
}

async function main(): Promise<void> {
  testWhoseMove();
  testSignals();
  testTicketMapping();
  testSlackThreadsInComments();
  testSlaNotifications();
  await testFollowAndAudience();
  await testSnapshotGenerations();
  testFollowerAwareJiraNotifications();
  testDetailTimeline();
}

main()
  .then(() => {
    console.log("\nAll tracker tests passed.");
    process.exit(0);
  })
  .catch((error: unknown) => {
    console.error("\nTracker test failed:", error);
    process.exit(1);
  });
