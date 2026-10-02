import { adfToText, notificationsFromJiraChanges } from "@/lib/notifications/jiraChanges";
import {
  isHumanMessage,
  matchRegisteredUsers,
  mentionNotifications,
  reactionGlyph,
  reactionNotification,
  replyNotification,
  slackTextToPlain,
} from "@/lib/notifications/slack";
import { addNotifications, getFeedVersion, getUnreadCount, listNotifications, markNotificationsRead } from "@/lib/notifications/store";

import type { JiraChangeInput, WatchedIssue } from "@/lib/notifications/jiraChanges";
import type { SlackNotificationContext } from "@/lib/notifications/slack";
import type { PostedSlackMessage } from "@/lib/notifications/slackThreads";
import type { FeedRedis, ScoredMember } from "@/lib/notifications/store";
import type { AppNotification } from "@/lib/notifications/types";

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

/* ------------------------------------------------------------ in-memory Redis */

function memoryFeedRedis(): FeedRedis & { raw: Map<string, unknown> } {
  const raw = new Map<string, unknown>();
  const zsets = new Map<string, Map<string, number>>();
  const sets = new Map<string, Set<string>>();
  const zset = (key: string): Map<string, number> => {
    const existing = zsets.get(key) ?? new Map<string, number>();
    zsets.set(key, existing);
    return existing;
  };
  const sorted = (key: string): ScoredMember[] =>
    [...zset(key).entries()].map(([member, score]) => ({ member, score })).sort((a, b) => b.score - a.score || (a.member < b.member ? 1 : -1));

  return {
    del: (key) => {
      raw.delete(key);
      sets.delete(key);
      zsets.delete(key);
      return Promise.resolve();
    },
    expire: () => Promise.resolve(),
    get: <T>(key: string) => Promise.resolve(raw.has(key) ? (raw.get(key) as T) : null),
    incr: (key) => {
      const next = Number(raw.get(key) ?? 0) + 1;
      raw.set(key, next);
      return Promise.resolve(next);
    },
    mget: <T>(keys: string[]) => Promise.resolve(keys.map((key) => (raw.has(key) ? (structuredClone(raw.get(key)) as T) : null))),
    raw,
    sadd: (key, members) => {
      const set = sets.get(key) ?? new Set<string>();
      members.forEach((member) => set.add(member));
      sets.set(key, set);
      return Promise.resolve();
    },
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
    smismember: (key, members) => Promise.resolve(members.map((member) => sets.get(key)?.has(member) ?? false)),
    zadd: (key, entries) => {
      entries.forEach(({ member, score }) => zset(key).set(member, score));
      return Promise.resolve();
    },
    zrem: (key, members) => {
      members.forEach((member) => zset(key).delete(member));
      return Promise.resolve();
    },
    zrevrange: (key, { above, below, count }) =>
      Promise.resolve(
        sorted(key)
          .filter(({ score }) => (below === undefined || score < below) && (above === undefined || score > above))
          .slice(0, count),
      ),
    ztrim: (key, keep) => {
      sorted(key)
        .slice(keep)
        .forEach(({ member }) => zset(key).delete(member));
      return Promise.resolve();
    },
  };
}

function notification(id: string, audience: string[], at = "2026-10-02T15:00:00.000Z"): AppNotification {
  return { at, audience, id, important: false, kind: "jira_comment", source: "jira", ticketKey: "TS-1", title: `n ${id}` };
}

/* --------------------------------------------------------------------- store */

async function testFanOutAndDedupe(): Promise<void> {
  console.log("\n--- Test: items fan out to each reader and the team feed, once per id ---");
  const store = memoryFeedRedis();
  const now = new Date("2026-10-02T16:00:00.000Z");

  const added = await addNotifications([notification("a", ["alice", "bob"]), notification("b", ["alice"]), notification("nobody", [])], now, store);
  assertEqual(added.map((item) => item.id).sort(), ["a", "b"], "empty-audience item dropped");

  const again = await addNotifications([notification("a", ["alice", "bob"])], new Date(now.getTime() + 60_000), store);
  assertEqual(again.length, 0, "an id seen before is never added twice");

  const alice = await listNotifications("alice", {}, store);
  const bob = await listNotifications("bob", {}, store);
  const team = await listNotifications("carol", { scope: "team" }, store);
  assertEqual(alice.items.map((item) => item.id).sort(), ["a", "b"], "alice sees both");
  assertEqual(bob.items.map((item) => item.id), ["a"], "bob sees only his");
  assertEqual(team.items.length, 2, "team feed holds everything");
  assert(team.items.every((item) => item.read), "someone else's items carry no unread state for a team viewer");
  assert(!alice.items.some((item) => "audience" in item), "audience is never sent to the browser");
  console.log("PASS");
}

async function testUnreadAndMarkRead(): Promise<void> {
  console.log("\n--- Test: unread counts, mark one, mark all, late arrivals stay unread ---");
  const store = memoryFeedRedis();
  const t0 = new Date("2026-10-02T16:00:00.000Z");
  await addNotifications([notification("a", ["alice"]), notification("b", ["alice"]), notification("c", ["alice"])], t0, store);
  assertEqual(await getUnreadCount("alice", store), 3, "three new items unread");

  const v1 = await getFeedVersion("alice", "mine", store);
  assertEqual(await markNotificationsRead("alice", { ids: ["b"] }, store), 2, "marking one read leaves two");
  assert((await getFeedVersion("alice", "mine", store)) !== v1, "read changes bump the version");

  assertEqual(await markNotificationsRead("alice", { all: true }, store), 0, "mark all read clears the badge");

  /* Found by the sync after "Mark all read", although it happened before it: still news. */
  await addNotifications([notification("late", ["alice"], "2026-10-02T15:59:00.000Z")], new Date(t0.getTime() + 120_000), store);
  const page = await listNotifications("alice", {}, store);
  assertEqual(page.unreadCount, 1, "a late arrival is unread");
  assertEqual(page.items[0]?.id, "late", "and it is at the top of the feed");
  assert(page.items.slice(1).every((item) => item.read), "everything before the cursor stays read");
  console.log("PASS");
}

async function testPagingAndExpiry(): Promise<void> {
  console.log("\n--- Test: paging with `before`, expired items dropped from the feed ---");
  const store = memoryFeedRedis();
  const items = Array.from({ length: 5 }, (_, i) => notification(`n${i}`, ["alice"], `2026-10-02T15:0${i}:00.000Z`));
  await addNotifications(items, new Date("2026-10-02T16:00:00.000Z"), store);

  const first = await listNotifications("alice", { limit: 2 }, store);
  assertEqual(first.items.map((item) => item.id), ["n4", "n3"], "newest first within a batch");
  assert(first.hasMore, "more pages exist");
  const second = await listNotifications("alice", { before: first.items.at(-1)?.score, limit: 2 }, store);
  assertEqual(second.items.map((item) => item.id), ["n2", "n1"], "next page continues below the cursor");

  store.raw.delete("notif:item:n0");
  const last = await listNotifications("alice", { before: second.items.at(-1)?.score, limit: 2 }, store);
  assertEqual(last.items.length, 0, "an expired item is skipped");
  assertEqual((await listNotifications("alice", { limit: 10 }, store)).items.length, 4, "and removed from the feed");
  console.log("PASS");
}

/* ------------------------------------------------------------------- jira */

const BASE = "https://example.atlassian.net";
const SINCE = Date.parse("2026-10-02T15:00:00.000Z");
const ALICE = "acc-alice";
const BOB = "acc-bob";
const registered = new Set([ALICE, BOB]);

function ticket(overrides: Partial<WatchedIssue> = {}): WatchedIssue {
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
    content: [
      {
        content: [
          ...(mentionId ? [{ attrs: { id: mentionId, text: "@Alice A" }, type: "mention" }] : []),
          { text, type: "text" },
        ],
        type: "paragraph",
      },
    ],
    type: "doc",
    version: 1,
  };
}

function run(input: Partial<JiraChangeInput>): AppNotification[] {
  return notificationsFromJiraChanges({ baseUrl: BASE, cps: [], registeredAccountIds: registered, sinceMs: SINCE, tickets: [], ...input });
}

function testTicketComments(): void {
  console.log("\n--- Test: TS comments - customer replies, mentions, own/app/old comments skipped ---");
  const out = run({
    tickets: [
      ticket({
        comments: [
          { author: { accountId: "cust-1", accountType: "customer", displayName: "Pat Customer" }, body: adf("Still broken for us"), created: "2026-10-02T15:10:00.000Z", id: "1" },
          { author: { accountId: BOB, accountType: "atlassian", displayName: "Bob B" }, body: adf(" can you check?", ALICE), created: "2026-10-02T15:11:00.000Z", id: "2", jsdPublic: false },
          { author: { accountId: ALICE, accountType: "atlassian", displayName: "Alice A" }, body: adf("on it"), created: "2026-10-02T15:12:00.000Z", id: "3" },
          { author: { accountId: "app-1", accountType: "app", displayName: "Automation" }, body: adf("reminder"), created: "2026-10-02T15:13:00.000Z", id: "4" },
          { author: { accountId: BOB, accountType: "atlassian", displayName: "Bob B" }, body: adf("old"), created: "2026-10-02T14:00:00.000Z", id: "5" },
        ],
      }),
    ],
  });

  assertEqual(out.map((item) => item.id), ["jira:TS-100:c1", "jira:TS-100:c2"], "only the customer reply and Bob's mention");
  const [reply, mention] = out;
  assertEqual(reply?.kind, "jira_customer_reply", "customer comment is a customer reply");
  assert(reply?.important === true, "customer replies are important");
  assertEqual(reply?.title, "Pat Customer replied on TS-100", "reply title");
  assertEqual(reply?.url, `${BASE}/browse/TS-100?focusedCommentId=1`, "links to the comment");
  assertEqual(mention?.title, "Bob B mentioned you on TS-100", "mention title");
  assert(mention?.important === true, "a mention is important");
  assert(mention?.detail?.startsWith("Internal note: @Alice A can you check?") === true, `internal notes are labelled: ${mention?.detail}`);
  assertEqual(reply?.audience, [ALICE], "only the assignee hears about it");
  console.log("PASS");
}

function testTicketHistory(): void {
  console.log("\n--- Test: TS history - status, assignment, priority, links; own changes skipped ---");
  const out = run({
    tickets: [
      ticket({
        histories: [
          {
            author: { accountId: BOB, displayName: "Bob B" },
            created: "2026-10-02T15:20:00.000Z",
            id: "900",
            items: [
              { field: "status", fieldId: "status", fromString: "Waiting for Client", to: "3", toString: "In Progress" },
              { field: "assignee", fieldId: "assignee", from: BOB, to: ALICE, toString: "Alice A" },
              { field: "priority", fieldId: "priority", fromString: "Medium", toString: "Critical" },
              { field: "Link", fromString: null, toString: "This issue relates to CP-55" },
              { field: "labels", fieldId: "labels", toString: "noise" },
            ],
          },
          { author: { accountId: ALICE, displayName: "Alice A" }, created: "2026-10-02T15:25:00.000Z", id: "901", items: [{ fieldId: "status", toString: "Waiting for Client" }] },
          { author: { accountId: BOB, displayName: "Bob B" }, created: "2026-10-02T14:00:00.000Z", id: "899", items: [{ fieldId: "status", toString: "Open" }] },
        ],
      }),
    ],
  });

  assertEqual(out.map((item) => item.kind), ["jira_status", "jira_assigned", "jira_priority", "jira_link"], "four meaningful changes, labels ignored");
  assertEqual(out[0]?.detail, "Waiting for Client → In Progress", "status detail");
  assertEqual(out[1]?.title, "TS-100 was assigned to you", "assignment title");
  assert(out[1]?.important === true, "being assigned is important");
  assert(out[2]?.important === true, "raised to Critical is important");
  assertEqual(out[3]?.title, "CP-55 was linked to TS-100", "link title");
  assertEqual(out[3]?.cpKey, "CP-55", "link carries the CP");
  console.log("PASS");
}

function testAutomationEchoSuppressed(): void {
  console.log("\n--- Test: automation's status move right after a customer reply isn't a second notification ---");
  const out = run({
    tickets: [
      ticket({
        comments: [{ author: { accountId: "cust-1", accountType: "customer", displayName: "Pat" }, body: "thanks", created: "2026-10-02T15:10:00.000Z", id: "1" }],
        histories: [
          { author: { accountId: "app-1", accountType: "app", displayName: "Automation for Jira" }, created: "2026-10-02T15:10:20.000Z", id: "9", items: [{ fieldId: "status", fromString: "Waiting for client", toString: "In Progress" }] },
          { author: { accountId: "app-1", accountType: "app", displayName: "Automation for Jira" }, created: "2026-10-02T15:40:00.000Z", id: "10", items: [{ fieldId: "status", fromString: "In Progress", toString: "Resolved" }] },
        ],
      }),
    ],
  });
  assertEqual(out.map((item) => item.id), ["jira:TS-100:h10:status", "jira:TS-100:c1"], "the echo is dropped, a later automation move is kept");
  console.log("PASS");
}

function testUnregisteredOwnerIgnored(): void {
  console.log("\n--- Test: tickets owned by someone not using the dashboard produce nothing ---");
  const out = run({
    tickets: [
      ticket({
        assignee: { accountId: "acc-stranger" },
        comments: [{ author: { accountId: "cust-1", accountType: "customer" }, body: "hi", created: "2026-10-02T15:10:00.000Z", id: "1" }],
      }),
    ],
  });
  assertEqual(out.length, 0, "no audience, no notification");
  console.log("PASS");
}

function testCpChanges(): void {
  console.log("\n--- Test: CP updates reach the owners of linked TS tickets ---");
  const cp: WatchedIssue = {
    assignee: { accountId: "eng-1", displayName: "Eve Engineer" },
    comments: [
      { author: { accountId: "eng-1", accountType: "atlassian", displayName: "Eve Engineer" }, body: adf("Fix is merged"), created: "2026-10-02T15:30:00.000Z", id: "77" },
      { author: { accountId: BOB, accountType: "atlassian", displayName: "Bob B" }, body: adf("thanks"), created: "2026-10-02T15:31:00.000Z", id: "78" },
    ],
    histories: [
      { author: { accountId: "eng-1", displayName: "Eve Engineer" }, created: "2026-10-02T15:29:00.000Z", id: "500", items: [{ fieldId: "status", fromString: "In Review", to: "10131", toString: "Ready for Release" }] },
      { author: { accountId: "eng-2", displayName: "Max" }, created: "2026-10-02T15:05:00.000Z", id: "499", items: [{ fieldId: "status", fromString: "To Do", to: "3", toString: "In Progress" }] },
    ],
    key: "CP-55",
  };
  const out = run({
    cps: [
      {
        issue: cp,
        linkedTickets: [
          { assigneeAccountId: ALICE, key: "TS-100" },
          { assigneeAccountId: BOB, key: "TS-101" },
          { assigneeAccountId: "acc-stranger", key: "TS-102" },
        ],
      },
    ],
  });

  const ready = out.find((item) => item.id === "jira:CP-55:h500:status");
  assert(ready?.important === true, "Ready for Release is important");
  assertEqual(ready?.audience, [ALICE, BOB], "both registered owners, never the stranger");
  assert(ready?.detail?.includes("linked to TS-100, TS-101") === true, `detail names the linked tickets: ${ready?.detail}`);
  const inProgress = out.find((item) => item.id === "jira:CP-55:h499:status");
  assert(inProgress?.important === false, "an ordinary move is not important");
  const bobsComment = out.find((item) => item.id === "jira:CP-55:c78");
  assertEqual(bobsComment?.audience, [ALICE], "Bob isn't told about his own CP comment");
  assertEqual(out.find((item) => item.id === "jira:CP-55:c77")?.title, "Eve Engineer commented on CP-55", "engineer comment title");
  console.log("PASS");
}

function testAdfToText(): void {
  console.log("\n--- Test: comment bodies flatten to one clipped line ---");
  assertEqual(adfToText(adf("hello   world", ALICE), 100), "@Alice Ahello world", "mention + text, whitespace collapsed");
  assertEqual(adfToText("plain *wiki* text", 100), "plain *wiki* text", "legacy string bodies pass through");
  const long = adfToText(adf("x".repeat(500)), 20);
  assertEqual(long.length, 20, "clipped to the limit");
  assert(long.endsWith("…"), "with an ellipsis");
  console.log("PASS");
}

/* ------------------------------------------------------------------ slack */

const posted: PostedSlackMessage = {
  audience: [ALICE, BOB],
  cpKey: "CP-55",
  kind: "sla_alert",
  label: "the SLA-breach alert for TS-100",
  postedAt: "2026-10-02T15:00:00.000Z",
  threadTs: "1727881200.000100",
  ticketKeys: ["TS-100"],
};

const ctx: SlackNotificationContext = { actorAccountIds: new Set([BOB]), actorName: "Bob B", permalink: "https://certify.slack.com/archives/C1/p1", snippet: "on it" };

function testSlackEventFilters(): void {
  console.log("\n--- Test: only human messages count ---");
  const base = { channel: "C1", ts: "1.2", type: "message", user: "U1" };
  assert(isHumanMessage(base), "plain message");
  assert(isHumanMessage({ ...base, subtype: "thread_broadcast" }), "thread broadcast");
  assert(!isHumanMessage({ ...base, bot_id: "B1" }), "bot posts (including ours) are ignored");
  assert(!isHumanMessage({ ...base, subtype: "message_changed" }), "edits are ignored");
  assert(!isHumanMessage({ ...base, subtype: "channel_join" }), "joins are ignored");
  console.log("PASS");
}

function testSlackText(): void {
  console.log("\n--- Test: Slack mrkdwn flattens to readable text ---");
  const names = new Map([["U123", "Priya"]]);
  assertEqual(
    slackTextToPlain("<@U123> see <https://x.atlassian.net/browse/TS-1|TS-1> in <#C9|eng-pod> &amp; <!here> <@U999>", names),
    "@Priya see TS-1 in #eng-pod & @here @someone",
    "mentions, links, channels, entities",
  );
  assertEqual(reactionGlyph("+1::skin-tone-3"), "👍", "skin tones stripped");
  assertEqual(reactionGlyph("party_parrot"), ":party_parrot:", "unknown reactions stay as names");
  console.log("PASS");
}

function testSlackReplyReactionMention(): void {
  console.log("\n--- Test: replies, reactions and mentions become notifications for the right people ---");
  const reply = replyNotification({ channel: "C1", thread_ts: posted.threadTs, ts: "1727881300.000200", type: "message", user: "U1" }, posted, ctx);
  assertEqual(reply?.audience, [ALICE], "the replier (Bob) isn't notified of his own reply");
  assertEqual(reply?.id, "slack:C1:1727881300.000200", "id is the reply's own ts");
  assertEqual(reply?.title, "Bob B replied to the SLA-breach alert for TS-100", "reply title");
  assertEqual(reply?.at, new Date(1727881300_000 + 200 / 1000).toISOString(), "time comes from the Slack ts");
  assert(reply?.important === true, "replies are important");

  const reaction = reactionNotification({ item: { channel: "C1", ts: posted.threadTs, type: "message" }, reaction: "white_check_mark", type: "reaction_added", user: "U1" }, posted, ctx);
  assertEqual(reaction?.title, "Bob B reacted ✅ to the SLA-breach alert for TS-100", "reaction title");

  const onlyBob = replyNotification({ channel: "C1", thread_ts: posted.threadTs, ts: "9.9", type: "message", user: "U1" }, { ...posted, audience: [BOB] }, ctx);
  assertEqual(onlyBob, null, "nothing when the only listener is the replier");

  const mentions = mentionNotifications({ channel: "C1", ts: "5.5", type: "message", user: "U1" }, new Map([["TS-100", [ALICE]], ["CP-55", [ALICE, BOB]]]), ctx);
  assertEqual(mentions.map((item) => item.id), ["slack:C1:5.5:m:TS-100", "slack:C1:5.5:m:CP-55"], "one per mentioned key");
  assertEqual(mentions[1]?.audience, [ALICE], "the mentioner is skipped");
  assertEqual(mentions[1]?.cpKey, "CP-55", "CP mentions carry the CP");
  console.log("PASS");
}

function testNameMatching(): void {
  console.log("\n--- Test: Slack people map to dashboard users by exact name only ---");
  const users = [
    { accountId: ALICE, displayName: "Alice A", email: "a@x", registeredAt: "" },
    { accountId: BOB, displayName: "Bob B", email: "b@x", registeredAt: "" },
  ];
  assertEqual([...matchRegisteredUsers({ displayName: "bob", realName: "Bob B" }, users)], [BOB], "real name match");
  assertEqual([...matchRegisteredUsers({ displayName: "Al", realName: "Alicia A" }, users)], [], "no fuzzy matching");
  assertEqual([...matchRegisteredUsers(null, users)], [], "unknown person matches nobody");
  console.log("PASS");
}

async function main(): Promise<void> {
  await testFanOutAndDedupe();
  await testUnreadAndMarkRead();
  await testPagingAndExpiry();
  testTicketComments();
  testTicketHistory();
  testAutomationEchoSuppressed();
  testUnregisteredOwnerIgnored();
  testCpChanges();
  testAdfToText();
  testSlackEventFilters();
  testSlackText();
  testSlackReplyReactionMention();
  testNameMatching();
}

main()
  .then(() => {
    console.log("\nAll notification tests passed.");
    process.exit(0);
  })
  .catch((error: unknown) => {
    console.error("\nNotification test failed:", error);
    process.exit(1);
  });
