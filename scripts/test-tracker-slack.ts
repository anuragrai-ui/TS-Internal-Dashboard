import { audienceForKeys, keysNeedingOwnerLookup, oneMentionPerPerson, planMessageNotifications } from "@/lib/notifications/slack";
import {
  backfillChannelList,
  emptyBackfillState,
  historyMessageToUpdate,
  pickBackfillChannel,
  probeVerdict,
  runBackfillTick,
  USER_HISTORY_READ_KEY,
} from "@/lib/tracker/slackBackfill";
import { linkConversationWith, recordSlackActivityWith } from "@/lib/tracker/slackIndex";
import {
  buildSlackPermalink,
  detectEscalationHint,
  effectiveMessage,
  excludedChannels,
  extractMessageTicketKeys,
  extractSlackPermalinks,
  extractTicketKeysFromText,
  isIndexableMessage,
  isTrackableChannel,
  slackOriginFromPermalink,
  toThreadMessages,
} from "@/lib/tracker/slackParse";
import { mergeConversation, readConversationsForTickets, upsertConversation } from "@/lib/tracker/slackStore";

import type { SlackInboundEvent, SlackNotificationContext } from "@/lib/notifications/slack";
import type { PostedSlackMessage } from "@/lib/notifications/slackThreads";
import type { BackfillDeps, SlackBackfillState, SlackHistoryPage } from "@/lib/tracker/slackBackfill";
import type { SlackIndexDeps } from "@/lib/tracker/slackIndex";
import type { SlackIndexRedis, StoredConversation } from "@/lib/tracker/slackStore";
import type { SlackConversationRef } from "@/lib/tracker/types";

/**
 * Tests for the escalation tracker's Slack index: key and permalink parsing,
 * escalation hints, the conversation store, the history drip and the
 * notification de-duplication. Pure functions plus an in-memory Redis - no
 * Slack, Jira or real Redis is touched.
 *
 *   npx tsx scripts/test-tracker-slack.ts
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

/* ------------------------------------------------------------ in-memory Redis */

function memoryIndexRedis(): SlackIndexRedis & { raw: Map<string, unknown> } {
  const raw = new Map<string, unknown>();
  const zsets = new Map<string, Map<string, number>>();
  const sets = new Map<string, Set<string>>();
  const zset = (key: string): Map<string, number> => {
    const existing = zsets.get(key) ?? new Map<string, number>();
    zsets.set(key, existing);
    return existing;
  };
  const sorted = (key: string): string[] => [...zset(key).entries()].sort((a, b) => b[1] - a[1]).map(([member]) => member);

  return {
    expire: () => Promise.resolve(),
    get: <T>(key: string) => Promise.resolve(raw.has(key) ? (structuredClone(raw.get(key)) as T) : null),
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
    smembers: (key) => Promise.resolve([...(sets.get(key) ?? [])]),
    zadd: (key, entries) => {
      entries.forEach(({ member, score }) => zset(key).set(member, score));
      return Promise.resolve();
    },
    zrevrangeMany: (keys, count) => Promise.resolve(keys.map((key) => sorted(key).slice(0, count))),
    ztrim: (key, keep) => {
      sorted(key)
        .slice(keep)
        .forEach((member) => zset(key).delete(member));
      return Promise.resolve();
    },
  };
}

const CHANNEL = "C07U9C0EPEH";
const ROOT_TS = "1727881200.000100";
const JIRA = "https://certifyos.atlassian.net";

function deps(store: SlackIndexRedis, overrides: Partial<SlackIndexDeps> = {}): SlackIndexDeps {
  return { excluded: excludedChannels(""), now: new Date("2026-10-03T12:00:00.000Z"), store, ...overrides };
}

function message(overrides: Partial<SlackInboundEvent> = {}): SlackInboundEvent {
  return { channel: CHANNEL, text: "", ts: ROOT_TS, type: "message", user: "U01ALICE", ...overrides };
}

/* ------------------------------------------------------------------ parsing */

function testKeyExtraction(): void {
  console.log("\n--- Test: ticket keys from text, links, URL forms, glued keys, blocks, attachments, edits ---");
  assertEqual(
    extractTicketKeysFromText(`<${JIRA}/browse/TS-123|Roster upload fails for Acme> and CP-55 again, see TS-116432Jira`),
    ["TS-123", "CP-55", "TS-116432"],
    "mrkdwn link (key only in the URL), plain key, glued key",
  );
  assertEqual(
    extractTicketKeysFromText(
      [
        `${JIRA}/jira/servicedesk/projects/TS/issue/TS-201`,
        `${JIRA}/jira/servicedesk/projects/TS/queues/issue/TS-202`,
        `${JIRA}/servicedesk/customer/portal/53/TS-203`,
      ].join(" "),
    ),
    ["TS-201", "TS-202", "TS-203"],
    "service desk URL variants",
  );
  assertEqual(extractTicketKeysFromText("ABCTS-123 xCP-9 TS-1 TS-77 TS-77"), ["TS-77"], "no key inside a longer token, at least 2 digits, deduped");
  assertEqual(extractTicketKeysFromText("ts-123 lowercase"), [], "keys are upper-case only");
  assertEqual(extractTicketKeysFromText(Array.from({ length: 30 }, (_, i) => `TS-${100 + i}`).join(" ")).length, 20, "capped at 20");

  const withBlocks = message({
    blocks: [
      {
        elements: [
          {
            elements: [
              { text: "please look at ", type: "text" },
              { text: "the roster bug", type: "link", url: `${JIRA}/browse/TS-301` },
              { type: "user", user_id: "U01BOB" },
            ],
            type: "rich_text_section",
          },
        ],
        type: "rich_text",
      },
    ],
    text: "please look at the roster bug",
  });
  assertEqual(extractMessageTicketKeys(withBlocks), ["TS-301"], "rich_text link element URL");

  const withAttachment = message({
    attachments: [{ fallback: "[CP-88] Fix the sync", from_url: `${JIRA}/browse/TS-302`, title: "Sync broken", title_link: `${JIRA}/browse/CP-88` }],
    text: "fyi",
  });
  assertEqual(extractMessageTicketKeys(withAttachment), ["CP-88", "TS-302"], "attachment title_link, fallback and from_url");

  const edit: SlackInboundEvent = {
    channel: CHANNEL,
    message: { text: "now with TS-404", ts: "1727881300.000200", thread_ts: ROOT_TS, type: "message", user: "U01BOB" },
    subtype: "message_changed",
    ts: "1727881399.000900",
    type: "message",
  };
  const effective = effectiveMessage(edit);
  assert(effective?.isEdit === true, "message_changed is an edit");
  assertEqual(effective?.message.ts, "1727881300.000200", "the edited message, not the edit event, is what counts");
  assertEqual(extractMessageTicketKeys(effective?.message ?? {}), ["TS-404"], "keys come from the edited message");
  console.log("PASS");
}

function testPermalinks(): void {
  console.log("\n--- Test: Slack permalinks in plain text, mrkdwn and with thread_ts ---");
  const plain = extractSlackPermalinks("See https://certifyos.slack.com/archives/C07U9C0EPEH/p1727881200000100 for context.");
  assertEqual(plain, [{ channel: CHANNEL, threadTs: undefined, ts: ROOT_TS, url: "https://certifyos.slack.com/archives/C07U9C0EPEH/p1727881200000100" }], "plain link");

  const reply = extractSlackPermalinks(
    "<https://certifyos.slack.com/archives/C07U9C0EPEH/p1727881300000200?thread_ts=1727881200.000100&amp;cid=C07U9C0EPEH|thread> and again https://certifyos.slack.com/archives/C07U9C0EPEH/p1727881300000200?thread_ts=1727881200.000100&cid=C07U9C0EPEH",
  );
  assertEqual(reply.length, 1, "the same link twice is one link");
  assertEqual(reply[0]?.ts, "1727881300.000200", "the reply's own ts");
  assertEqual(reply[0]?.threadTs, ROOT_TS, "thread_ts read from the query (&amp; decoded)");
  assertEqual(reply[0]?.url, `https://certifyos.slack.com/archives/${CHANNEL}/p1727881300000200?thread_ts=${ROOT_TS}&cid=${CHANNEL}`, "canonical url");

  assertEqual(extractSlackPermalinks("https://certifyos.slack.com/archives/G0PRIVATE1/p1727881200000100")[0]?.channel, "G0PRIVATE1", "private channel ids");
  assertEqual(extractSlackPermalinks("https://example.com/archives/C07U9C0EPEH/p1727881200000100 https://certifyos.slack.com/archives/C1/p12"), [], "not Slack, or not a message link");
  assertEqual(buildSlackPermalink("https://certifyos.slack.com", CHANNEL, ROOT_TS), "https://certifyos.slack.com/archives/C07U9C0EPEH/p1727881200000100", "local permalink build");
  assertEqual(slackOriginFromPermalink("https://certifyos.slack.com/archives/C1/p1"), "https://certifyos.slack.com", "origin learned from a permalink");
  console.log("PASS");
}

function testEscalationHints(): void {
  console.log("\n--- Test: escalation hints - group mentions, priority words, an engineer tagged with a CP ---");
  const hint = (text: string, extra: Partial<SlackInboundEvent> = {}): boolean => {
    const msg = message({ text, ...extra });
    return detectEscalationHint(msg, extractMessageTicketKeys(msg));
  };
  assert(hint("<!subteam^S08V9D2KXPU> can someone look at TS-123"), "TS group mention");
  assert(hint("<!subteam^S0OTHER01|@eng-oncall> TS-123"), "any group mention");
  assert(hint("Need this ASAP for TS-123"), "ASAP");
  assert(hint("this is a blocker for go-live"), "blocker");
  assert(hint("escalating TS-123 to eng"), "escalat*");
  assert(hint("please prioritise TS-1234"), "prioritise");
  assert(hint("can we get it by EOD"), "by EOD");
  assert(hint("high priority client"), "high priority");
  assert(hint("<@U02ENG> can you check CP-55?"), "engineer tagged with a CP key");
  assert(!hint("<@U02ENG> can you check TS-123?"), "a person tagged with only a TS key is just a question");
  assert(!hint("thanks, closing TS-123"), "ordinary chatter");
  assert(!hint("fyi", { attachments: [{ text: "Priority: Critical", title: "TS-123 Roster" }] }), "a Jira unfurl's priority is not the person's words");
  console.log("PASS");
}

function testMessageFilters(): void {
  console.log("\n--- Test: which messages are indexed ---");
  assert(isIndexableMessage(message()), "plain message");
  assert(isIndexableMessage(message({ subtype: "thread_broadcast", thread_ts: ROOT_TS, ts: "1727881300.000200" })), "thread broadcast");
  assert(isIndexableMessage(message({ subtype: "file_share" })), "file share");
  assert(!isIndexableMessage(message({ bot_id: "B01" })), "bot post");
  assert(!isIndexableMessage(message({ subtype: "bot_message" })), "bot_message subtype");
  assert(!isIndexableMessage(message({ subtype: "channel_join" })), "join");
  assert(excludedChannels("C1, C2").has("C091ENAGV1S") && excludedChannels("C1, C2").has("C2"), "digest channel plus env list");
  console.log("PASS");
}

/* -------------------------------------------------------------------- store */

async function testLiveIndexing(): Promise<void> {
  console.log("\n--- Test: live events - root keys, replies counted once, CP from a reply attaches to the root, edits not counted ---");
  const store = memoryIndexRedis();
  const d = deps(store);

  const root = await recordSlackActivityWith(message({ text: `<${JIRA}/browse/TS-123|Roster upload fails> ASAP please` }), d);
  assertEqual(root.newlyLinkedKeys, ["TS-123"], "the root links its key");
  assertEqual(root.replyInLinkedConversation, false, "a root is not a reply");
  assertEqual(root.conversation?.id, `${CHANNEL}:${ROOT_TS}`, "conversation id is channel:rootTs");
  assertEqual(root.conversation?.snippet, "Roster upload fails ASAP please", "snippet from the root's plain text");
  assertEqual(root.conversation?.replyCount, 0, "no replies yet");
  assert(root.conversation?.escalationHint === true, "ASAP flags the conversation");
  assertEqual(root.conversation?.source, "event", "found live");
  assertEqual(root.conversation?.firstSeenAt, "2024-10-02T15:00:00.000Z", "started when the root was posted");

  const reply = message({ text: "looking now", thread_ts: ROOT_TS, ts: "1727881300.000200", user: "U01BOB" });
  const first = await recordSlackActivityWith(reply, d);
  assertEqual(first.replyInLinkedConversation, true, "a key-less reply in a linked conversation still counts as activity there");
  assertEqual(first.newlyLinkedKeys, [], "no new keys");
  assertEqual(first.conversation?.replyCount, 1, "one reply");
  assertEqual(first.conversation?.participants, 2, "two people");
  assertEqual(first.conversation?.snippet, "Roster upload fails ASAP please", "a reply never replaces the root snippet");
  assertEqual(first.conversation?.lastActivityAt, "2024-10-02T15:01:40.000Z", "activity moves to the reply");

  const again = await recordSlackActivityWith(reply, d);
  assertEqual(again.conversation?.replyCount, 1, "a redelivered event is not counted twice");

  const cpReply = await recordSlackActivityWith(message({ text: "Filed <https://certifyos.atlassian.net/browse/CP-55|CP-55>", thread_ts: ROOT_TS, ts: "1727881400.000300", user: "U02ENG" }), d);
  assertEqual(cpReply.newlyLinkedKeys, ["CP-55"], "the CP from a reply is newly linked");
  assertEqual(cpReply.conversation?.id, `${CHANNEL}:${ROOT_TS}`, "to the ROOT conversation");
  assertEqual(cpReply.conversation?.ticketKeys, ["TS-123", "CP-55"], "keys accumulate");
  assertEqual(cpReply.conversation?.replyCount, 2, "two replies");

  const edit = await recordSlackActivityWith(
    {
      channel: CHANNEL,
      message: { text: "looking now - also TS-124", thread_ts: ROOT_TS, ts: "1727881300.000200", type: "message", user: "U01BOB" },
      subtype: "message_changed",
      ts: "1727881500.000400",
      type: "message",
    },
    d,
  );
  assertEqual(edit.newlyLinkedKeys, ["TS-124"], "an edit that adds a key links it");
  assertEqual(edit.conversation?.replyCount, 2, "an edit is never a reply");
  assertEqual(edit.replyInLinkedConversation, false, "and never notifies as one");

  const forTickets = await readConversationsForTickets(store, ["TS-123", "CP-55", "TS-124", "TS-999"]);
  assertEqual([...forTickets.keys()], ["TS-123", "CP-55", "TS-124"], "every linked key finds the conversation; unknown keys are left out");
  console.log("PASS");
}

async function testSkippedEvents(): Promise<void> {
  console.log("\n--- Test: bots, excluded channels and unlinked chatter are not indexed ---");
  const store = memoryIndexRedis();
  const d = deps(store, { excluded: excludedChannels("C0EXCLUDE1") });

  assertEqual((await recordSlackActivityWith(message({ bot_id: "B01", text: "TS-123 created" }), d)).conversation, null, "bot post skipped");
  assertEqual((await recordSlackActivityWith(message({ subtype: "bot_message", text: "TS-123" }), d)).conversation, null, "bot_message skipped");
  assertEqual((await recordSlackActivityWith(message({ channel: "C091ENAGV1S", text: "TS-123" }), d)).conversation, null, "digest channel skipped");
  assertEqual((await recordSlackActivityWith(message({ channel: "C0EXCLUDE1", text: "TS-123" }), d)).conversation, null, "env-excluded channel skipped");
  assertEqual((await recordSlackActivityWith(message({ text: "lunch?" }), d)).conversation, null, "no key, no conversation");
  assertEqual(
    (await recordSlackActivityWith(message({ text: "agreed", thread_ts: "1727880000.000001", ts: "1727881300.000200" }), d)).replyInLinkedConversation,
    false,
    "a reply in an unlinked thread is nothing",
  );
  assertEqual(store.raw.size, 0, "nothing was written for any of them");

  const fromReply = await recordSlackActivityWith(message({ text: "this is CP-77", thread_ts: "1727880000.000001", ts: "1727881300.000200" }), d);
  assertEqual(fromReply.conversation?.id, `${CHANNEL}:1727880000.000001`, "a key in a reply of an unseen thread creates the root conversation");
  assertEqual(fromReply.conversation?.replyCount, 1, "counting that reply");
  assertEqual(fromReply.conversation?.snippet, undefined, "with no snippet (the root wasn't seen)");
  assertEqual(fromReply.replyInLinkedConversation, false, "it wasn't linked before - the mention path handles it");
  console.log("PASS");
}

async function testExcludedChannelsAndDms(): Promise<void> {
  console.log("\n--- Test: excluded channels and DMs can't be linked by hand, from Jira or from events ---");
  assert(isTrackableChannel(CHANNEL, excludedChannels("")), "an ordinary channel is trackable");
  assert(!isTrackableChannel("C091ENAGV1S", excludedChannels("")), "the digest channel is not");
  assert(!isTrackableChannel("C0EXCLUDE1", excludedChannels("C0EXCLUDE1")), "an env-excluded channel is not");
  assert(!isTrackableChannel("D07DIRECT01", excludedChannels("")), "a DM is not");
  assert(!isTrackableChannel("nope", excludedChannels("")), "a non-id is not");

  const store = memoryIndexRedis();
  const d = deps(store, { excluded: excludedChannels("C0EXCLUDE1") });
  for (const source of ["manual", "jira_link", "bot", "backfill"] as const) {
    assertEqual(await linkConversationWith({ channel: "C091ENAGV1S", rootTs: ROOT_TS, source, ticketKeys: ["TS-500"] }, d), null, `digest channel refused for ${source}`);
    assertEqual(await linkConversationWith({ channel: "C0EXCLUDE1", rootTs: ROOT_TS, source, ticketKeys: ["TS-500"] }, d), null, `env-excluded channel refused for ${source}`);
    assertEqual(await linkConversationWith({ channel: "D07DIRECT01", rootTs: ROOT_TS, source, ticketKeys: ["TS-500"] }, d), null, `DM refused for ${source}`);
  }
  assertEqual((await recordSlackActivityWith(message({ channel: "D07DIRECT01", text: "TS-500 please" }), d)).conversation, null, "a DM event is not indexed");
  assertEqual(store.raw.size, 0, "nothing was written for any of them");

  const ok = await linkConversationWith({ channel: CHANNEL, rootTs: ROOT_TS, source: "manual", ticketKeys: ["TS-500"] }, d);
  assertEqual(ok?.id, `${CHANNEL}:${ROOT_TS}`, "an ordinary channel still links");
  console.log("PASS");
}

async function testLinkIdempotencyAndCounts(): Promise<void> {
  console.log("\n--- Test: linkConversation is idempotent, never lowers counts, and the bot's own thread names the source ---");
  const store = memoryIndexRedis();
  const d = deps(store);

  const once = await linkConversationWith({ channel: CHANNEL, rootTs: ROOT_TS, source: "manual", ticketKeys: ["TS-500"] }, d);
  const twice = await linkConversationWith({ channel: CHANNEL, rootTs: ROOT_TS, source: "manual", ticketKeys: ["TS-500"] }, d);
  assertEqual(twice, once, "linking twice changes nothing");
  assertEqual(once?.lastActivityAt, "2024-10-02T15:00:00.000Z", "a hand link to an old thread doesn't make it look active");
  assertEqual(await linkConversationWith({ channel: "not-a-channel", rootTs: ROOT_TS, source: "manual", ticketKeys: ["TS-500"] }, d), null, "bad ids rejected");

  /* The drip saw 7 replies; then a live reply arrives; then the drip re-reads a stale page saying 7. */
  await upsertConversation(store, { channel: CHANNEL, participants: 4, replyCount: 7, rootTs: ROOT_TS, source: "backfill", ticketKeys: ["TS-500"] });
  await recordSlackActivityWith(message({ text: "+1", thread_ts: ROOT_TS, ts: "1727890000.000001", user: "U09NEW" }), d);
  const stale = await upsertConversation(store, { channel: CHANNEL, participants: 4, replyCount: 7, rootTs: ROOT_TS, source: "backfill", ticketKeys: ["TS-500"] });
  assertEqual(stale?.record.replyCount, 8, "counts never go down");
  assertEqual(stale?.record.participants, 4, "participants keep the larger known total");
  assertEqual(stale?.record.source, "manual", "a hand link outranks the drip");

  const bot = await linkConversationWith({ channel: CHANNEL, rootTs: ROOT_TS, source: "bot", ticketKeys: ["CP-9"] }, d);
  assertEqual(bot?.source, "bot", "the bot's own thread outranks everything");
  assertEqual(bot?.ticketKeys, ["TS-500", "CP-9"], "and adds its keys");

  const merged = mergeConversation(null, { channel: CHANNEL, rootTs: ROOT_TS, source: "event", ticketKeys: ["TS-1", "TS-1"] }, new Date());
  assertEqual(merged.newlyLinkedKeys, ["TS-1"], "duplicate keys in one update count once");
  console.log("PASS");
}

async function testReadOrdering(): Promise<void> {
  console.log("\n--- Test: conversations per ticket are most recent first; expired ones are skipped ---");
  const store = memoryIndexRedis();
  const at = (minute: number): string => new Date(Date.UTC(2026, 9, 3, 10, minute)).toISOString();
  await upsertConversation(store, { at: at(1), channel: CHANNEL, rootTs: "1759485600.000001", source: "event", ticketKeys: ["TS-1"] });
  await upsertConversation(store, { at: at(30), channel: CHANNEL, rootTs: "1759485600.000002", source: "event", ticketKeys: ["TS-1", "TS-2"] });
  await upsertConversation(store, { at: at(10), channel: "C0OTHER001", rootTs: "1759485600.000003", source: "event", ticketKeys: ["TS-1"] });

  const read = await readConversationsForTickets(store, ["TS-1", "TS-2"]);
  assertEqual(
    read.get("TS-1")?.map((item) => item.rootTs),
    ["1759485600.000002", "1759485600.000003", "1759485600.000001"],
    "most recent activity first",
  );
  assertEqual(read.get("TS-2")?.length, 1, "per-key lists");

  /* ~400 tickets are read on every rebuild and only a few have a thread: only those may cost a sorted-set read. */
  const asked: string[] = [];
  const spy: SlackIndexRedis = {
    ...store,
    zrevrangeMany: (keys, count) => {
      asked.push(...keys);
      return store.zrevrangeMany(keys, count);
    },
  };
  const wide = await readConversationsForTickets(spy, ["TS-1", "TS-2", "TS-3", "TS-4", "CP-5"]);
  assertEqual([...wide.keys()], ["TS-1", "TS-2"], "tickets without a conversation are left out");
  assertEqual(asked, ["slack:convos_for:TS-1", "slack:convos_for:TS-2"], "and never read");
  assertEqual((await readConversationsForTickets(spy, ["TS-3", "TS-4"])).size, 0, "a read with no linked ticket at all");
  assertEqual(asked.length, 2, "makes no sorted-set read");

  store.raw.delete(`slack:convo:C0OTHER001:1759485600.000003`);
  assertEqual((await readConversationsForTickets(store, ["TS-1"])).get("TS-1")?.length, 2, "an expired conversation is skipped");
  console.log("PASS");
}

/* --------------------------------------------------------------- backfill */

function historyPage(messages: SlackInboundEvent[], nextCursor?: string): SlackHistoryPage {
  return { has_more: Boolean(nextCursor), messages, ok: true, response_metadata: nextCursor ? { next_cursor: nextCursor } : undefined };
}

async function testBackfill(): Promise<void> {
  console.log("\n--- Test: history drip - lock, pages, cursor, done, rate-limit backoff, user reads first ---");
  assertEqual(
    historyMessageToUpdate(CHANNEL, "technical-support", {
      reply_count: 5,
      reply_users: ["U01BOB", "U01ALICE"],
      reply_users_count: 2,
      latest_reply: "1727890000.000001",
      text: `<${JIRA}/browse/TS-123|Roster> urgent`,
      ts: ROOT_TS,
      type: "message",
      user: "U01ALICE",
    })?.participants,
    2,
    "root author already among the repliers isn't counted twice",
  );
  assertEqual(historyMessageToUpdate(CHANNEL, undefined, { bot_id: "B1", text: "TS-123", ts: ROOT_TS, user: "U1" }), null, "bot posts skipped");
  assertEqual(historyMessageToUpdate(CHANNEL, undefined, { text: "TS-123", thread_ts: "1727880000.000001", ts: ROOT_TS, user: "U1" }), null, "broadcast replies skipped");
  assertEqual(historyMessageToUpdate(CHANNEL, undefined, { text: "no ticket", ts: ROOT_TS, user: "U1" }), null, "no key, nothing");

  const channels = backfillChannelList([{ id: "C0BBBBBBB", name: "b" }, { id: "C091ENAGV1S", name: "digest" }], ["C0AAAAAAA", "D0DIRECT01"], excludedChannels(""));
  assertEqual(channels.map((channel) => channel.id), ["C0AAAAAAA", "C0BBBBBBB"], "bot channels + seen channels, minus digest and DMs");
  const state: SlackBackfillState = { ...emptyBackfillState(), nextIndex: 1 };
  assertEqual(pickBackfillChannel(state, channels, Date.now())?.channel.id, "C0BBBBBBB", "round robin resumes where it stopped");

  const store = memoryIndexRedis();
  let now = new Date("2026-10-03T12:00:00.000Z");
  const calls: Array<{ channel: string; cursor?: string; oldest: string }> = [];
  const responses: Array<Awaited<ReturnType<BackfillDeps["history"]>>> = [
    { data: null, error: "ratelimited", ok: false, rateLimited: true, retryAfterSeconds: 120 },
    { data: historyPage([{ reply_count: 3, text: "TS-700 is down", ts: "1759485000.000001", type: "message", user: "U1" }, { text: "hi", ts: "1759484000.000001", type: "message", user: "U2" }], "next-1"), ok: true, rateLimited: false },
    { data: historyPage([{ text: "and CP-701", ts: "1759480000.000001", type: "message", user: "U1" }]), ok: true, rateLimited: false },
  ];
  const linked: string[] = [];
  const backfillDeps: BackfillDeps = {
    botChannels: () => Promise.resolve([{ id: CHANNEL, name: "technical-support" }]),
    history: (channel, params) => {
      calls.push({ channel, ...params });
      return Promise.resolve(responses.shift() ?? { data: null, error: "exhausted", ok: false, rateLimited: false });
    },
    link: async (update) => {
      linked.push(...update.ticketKeys);
      return (await upsertConversation(store, update)) !== null;
    },
    now: () => now,
    store,
  };
  const tick = async (advanceSeconds: number): Promise<void> => {
    now = new Date(now.getTime() + advanceSeconds * 1000);
    store.raw.delete("slack:backfill:lock");
    await runBackfillTick(backfillDeps);
  };
  const stateNow = (): SlackBackfillState => store.raw.get("slack:backfill:state") as SlackBackfillState;

  await runBackfillTick(backfillDeps);
  assertEqual(calls.length, 1, "first tick reads one page");
  assert(Boolean(stateNow().backoffUntil), "rate limited: a backoff is stored");
  await runBackfillTick(backfillDeps);
  assertEqual(calls.length, 1, "the lock holds off a second tick within 70s");

  await tick(60);
  assertEqual(calls.length, 1, "still inside Slack's Retry-After");

  await tick(90);
  assertEqual(calls.length, 2, "after the backoff the same channel is read again");
  assertEqual(calls[1]?.oldest, calls[0]?.oldest, "with the same 30-day window");
  assertEqual(calls[1]?.cursor, undefined, "from the newest page");
  assertEqual(stateNow().channels[CHANNEL]?.cursor, "next-1", "the cursor is kept");
  assertEqual(linked, ["TS-700"], "only messages naming a ticket are linked");
  const fromDrip = (await readConversationsForTickets(store, ["TS-700"])).get("TS-700")?.[0] as StoredConversation;
  assertEqual(fromDrip.replyCount, 3, "counts come from the page (no replies fan-out)");
  assertEqual(fromDrip.channelName, "technical-support", "and the channel name from users.conversations");

  store.raw.set(USER_HISTORY_READ_KEY, "1");
  await tick(80);
  assertEqual(calls.length, 2, "a person's thread read just now takes the budget");
  store.raw.delete(USER_HISTORY_READ_KEY);

  await tick(80);
  assertEqual(calls[2]?.cursor, "next-1", "the next page continues from the cursor");
  const done = stateNow().channels[CHANNEL];
  assert(done?.done === true && done.passes === 1, "the last page finishes the pass");
  assertEqual(done?.messagesScanned, 3, "progress counts every message read");
  assertEqual(done?.conversationsLinked, 2, "and every conversation linked");

  await tick(80);
  assertEqual(calls.length, 3, "a caught-up channel waits for its rescan");
  await tick(7 * 3600);
  assertEqual(calls.length, 4, "hours later it is walked again");
  assert(Number(calls[3]?.oldest) > Number(calls[0]?.oldest), "but only since the previous pass");

  assertEqual(probeVerdict(15, true, false), "clamped", "15 and more -> clamped");
  assertEqual(probeVerdict(200, true, true), "clamped", "second call refused -> clamped");
  assertEqual(probeVerdict(200, true, false), "full", "a full page -> full");
  assertEqual(probeVerdict(4, false, false), "unknown", "a tiny channel can't tell");
  console.log("PASS");
}

async function testBackfillFailures(): Promise<void> {
  console.log("\n--- Test: history drip - a dead cursor restarts the pass, repeated failures park the channel ---");
  const store = memoryIndexRedis();
  let now = new Date("2026-10-03T12:00:00.000Z");
  const calls: Array<{ cursor?: string }> = [];
  let error = "invalid_cursor";
  const backfillDeps: BackfillDeps = {
    botChannels: () => Promise.resolve([{ id: CHANNEL, name: "technical-support" }]),
    history: (_channel, params) => {
      calls.push({ cursor: params.cursor });
      return Promise.resolve({ data: null, error, ok: false, rateLimited: false });
    },
    link: () => Promise.resolve(true),
    now: () => now,
    store,
  };
  const tick = async (): Promise<void> => {
    now = new Date(now.getTime() + 80_000);
    store.raw.delete("slack:backfill:lock");
    await runBackfillTick(backfillDeps);
  };
  const channelNow = (): SlackBackfillState["channels"][string] | undefined => (store.raw.get("slack:backfill:state") as SlackBackfillState).channels[CHANNEL];

  store.raw.set("slack:backfill:state", {
    channels: { [CHANNEL]: { channel: CHANNEL, conversationsLinked: 0, cursor: "dead-cursor", done: false, messagesScanned: 30, oldest: "1759000000.000000", passStartedAt: "2026-10-03T11:00:00.000Z", passes: 0 } },
    nextIndex: 0,
  } satisfies SlackBackfillState);

  await tick();
  assertEqual(calls[0]?.cursor, "dead-cursor", "the stored cursor is tried first");
  assertEqual(channelNow()?.cursor, undefined, "a dead cursor is dropped, so the pass restarts from its first page");
  assertEqual(channelNow()?.oldest, "1759000000.000000", "keeping the pass window");
  assertEqual(channelNow()?.failures, 1, "and the failure is counted");

  error = "internal_error";
  await tick();
  assertEqual(calls[1]?.cursor, undefined, "the next try starts from the first page");
  await tick();
  await tick();
  assertEqual(channelNow()?.done, false, "four failures in a row: still trying");
  await tick();
  assert(channelNow()?.done === true && Boolean(channelNow()?.completedAt), "the fifth parks the channel until its next scheduled pass");
  assertEqual(channelNow()?.failures, undefined, "with the counter reset");
  const before = calls.length;
  await tick();
  assertEqual(calls.length, before, "a parked channel spends no more history calls");

  /* Slack not being connected is nobody's fault: the whole drip waits, no channel is marked failing. */
  const offline = memoryIndexRedis();
  const offlineCalls: number[] = [];
  let offlineNow = new Date("2026-10-03T12:00:00.000Z");
  const offlineDeps: BackfillDeps = {
    ...backfillDeps,
    history: () => {
      offlineCalls.push(1);
      return Promise.resolve({ data: null, error: "no_token", ok: false, rateLimited: false });
    },
    now: () => offlineNow,
    store: offline,
  };
  await runBackfillTick(offlineDeps);
  offlineNow = new Date(offlineNow.getTime() + 80_000);
  offline.raw.delete("slack:backfill:lock");
  await runBackfillTick(offlineDeps);
  assertEqual(offlineCalls.length, 1, "no token: one call, then the drip sits out five minutes");
  const offlineState = offline.raw.get("slack:backfill:state") as SlackBackfillState;
  assertEqual(offlineState.channels[CHANNEL]?.failures, undefined, "without counting a failure against the channel");
  assertEqual(offlineState.lastError, "no_token", "but saying why");
  console.log("PASS");
}

/* ---------------------------------------------------------- notifications */

const ALICE = "acc-alice";
const BOB = "acc-bob";
const CAROL = "acc-carol";

function conversation(overrides: Partial<SlackConversationRef> = {}): SlackConversationRef {
  return {
    channel: CHANNEL,
    channelName: "technical-support",
    escalationHint: false,
    firstSeenAt: "2026-10-03T10:00:00.000Z",
    id: `${CHANNEL}:${ROOT_TS}`,
    lastActivityAt: "2026-10-03T10:00:00.000Z",
    participants: 2,
    replyCount: 1,
    rootTs: ROOT_TS,
    source: "event",
    ticketKeys: ["TS-100", "CP-55"],
    ...overrides,
  };
}

const ctx: SlackNotificationContext = {
  actorAccountIds: new Set([BOB]),
  actorName: "Bob B",
  channelName: "technical-support",
  permalink: "https://certifyos.slack.com/archives/C07U9C0EPEH/p1727881300000200",
  snippet: "on it",
};
const replyEvent: SlackInboundEvent = { channel: CHANNEL, thread_ts: ROOT_TS, ts: "1727881300.000200", type: "message", user: "U01BOB" };

function testNotificationPlanning(): void {
  console.log("\n--- Test: one notification per person per message - conversation replies, bot threads, mentions ---");
  const audience = new Map([
    ["TS-100", [ALICE, BOB]],
    ["CP-55", [ALICE, CAROL]],
    ["TS-200", [CAROL]],
  ]);
  assertEqual(audienceForKeys(["TS-100", "CP-55"], audience), [ALICE, BOB, CAROL], "audience union");
  assertEqual([...oneMentionPerPerson(["CP-55", "TS-200"], audience, new Set([ALICE]))], [["CP-55", [CAROL]]], "each person once, already-told skipped");

  const reply = planMessageNotifications({ audienceByKey: audience, conversation: conversation(), ctx, event: replyEvent, mentionedKeys: [], posted: null });
  assertEqual(reply.length, 1, "one reply notification");
  assertEqual(reply[0]?.title, "Bob B replied in #technical-support about TS-100", "reply title names channel and TS key");
  assertEqual(reply[0]?.audience, [ALICE, CAROL], "every ticket's audience, minus the replier");
  assertEqual(reply[0]?.id, `slack:${CHANNEL}:1727881300.000200`, "id is the message");
  assert(reply[0]?.kind === "slack_reply" && reply[0]?.important === true, "important slack_reply");
  assertEqual(reply[0]?.cpKey, "CP-55", "carries the CP");

  const withMentions = planMessageNotifications({
    audienceByKey: audience,
    conversation: conversation(),
    ctx,
    event: replyEvent,
    mentionedKeys: ["CP-55", "TS-200"],
    posted: null,
  });
  assertEqual(withMentions.map((item) => item.id), [`slack:${CHANNEL}:1727881300.000200`], "everyone was already told by the reply");

  const mentionsOnly = planMessageNotifications({
    audienceByKey: new Map([["TS-300", [ALICE]], ["CP-301", [ALICE, CAROL]]]),
    conversation: null,
    ctx: { ...ctx, channelName: undefined },
    event: { channel: CHANNEL, ts: "1727881300.000200", type: "message", user: "U01BOB" },
    mentionedKeys: ["TS-300", "CP-301"],
    posted: null,
  });
  assertEqual(mentionsOnly.map((item) => [item.id, item.audience]), [[`slack:${CHANNEL}:1727881300.000200:m:TS-300`, [ALICE]], [`slack:${CHANNEL}:1727881300.000200:m:CP-301`, [CAROL]]], "two keys, Alice told once");
  assertEqual(mentionsOnly[0]?.title, "Bob B mentioned TS-300 in Slack", "channel unknown -> 'in Slack'");

  const posted: PostedSlackMessage = {
    audience: [ALICE],
    cpKey: "CP-55",
    kind: "escalation",
    label: "the escalation thread for CP-55",
    postedAt: "2026-10-03T10:00:00.000Z",
    threadTs: ROOT_TS,
    ticketKeys: ["TS-100"],
  };
  const botThread = planMessageNotifications({ audienceByKey: audience, conversation: conversation({ source: "bot" }), ctx, event: replyEvent, mentionedKeys: ["TS-200"], posted });
  assertEqual(botThread.length, 1, "a bot-thread reply stays one notification");
  assertEqual(botThread[0]?.title, "Bob B replied to the escalation thread for CP-55", "the bot thread's own title");
  assertEqual(botThread[0]?.audience, [ALICE, CAROL], "its audience plus the tickets' followers");

  const ownTest = planMessageNotifications({
    audienceByKey: new Map(),
    conversation: null,
    ctx,
    event: replyEvent,
    mentionedKeys: [],
    posted: { ...posted, audience: [BOB], kind: "test", label: "your Slack test message", ticketKeys: [] },
  });
  assertEqual(ownTest[0]?.audience, [BOB], "replying to your own Settings test message still notifies you");
  console.log("PASS");
}

function testOwnerLookupKeys(): void {
  console.log("\n--- Test: which keys still need a Jira owner lookup (CPs, uncovered TS keys, the conversation's own keys) ---");
  const covered = new Map([["TS-1", ["acc-a"]], ["CP-9", ["acc-follower"]]]);
  assertEqual(keysNeedingOwnerLookup(["TS-1"], [], covered), [], "a covered TS key needs nothing");
  assertEqual(keysNeedingOwnerLookup(["TS-1", "TS-2"], [], covered), ["TS-2"], "an uncovered TS key does");
  assertEqual(keysNeedingOwnerLookup([], ["CP-9"], covered), ["CP-9"], "a CP always does - the snapshot only knows TS assignees, even when a follower covers it");
  assertEqual(keysNeedingOwnerLookup(["TS-2"], ["TS-2", "CP-7"], covered), ["TS-2", "CP-7"], "mentioned and conversation keys are merged without repeats");
  const many = Array.from({ length: 30 }, (_unused, index) => `CP-${100 + index}`);
  assertEqual(keysNeedingOwnerLookup(many, [], new Map()).length, 12, "capped, so a message full of keys can't fan out into Jira");
  console.log("PASS");
}

function testThreadMessages(): void {
  console.log("\n--- Test: thread reads become plain, named, clipped messages ---");
  const out = toThreadMessages(
    [
      { text: "<@U01BOB> please check <https://x.atlassian.net/browse/TS-1|the ticket>", ts: ROOT_TS, user: "U01ALICE" },
      { bot_id: "B1", bot_profile: { name: "Jira Cloud" }, subtype: "bot_message", text: "x".repeat(1500), ts: "1727881300.000200" },
      { subtype: "channel_join", text: "joined", ts: "1727881400.000300", user: "U03" },
    ],
    new Map([["U01ALICE", "Alice A"], ["U01BOB", "Bob B"]]),
  );
  assertEqual(out.length, 2, "joins dropped");
  assertEqual(out[0], { at: "2024-10-02T15:00:00.000Z", isBot: false, text: "@Bob B please check the ticket", ts: ROOT_TS, userName: "Alice A" }, "person message");
  assert(out[1]?.isBot === true && out[1]?.userName === "Jira Cloud", "bot flagged and named");
  assertEqual(out[1]?.text.length, 1000, "clipped to ~1000 chars");
  console.log("PASS");
}

async function main(): Promise<void> {
  testKeyExtraction();
  testPermalinks();
  testEscalationHints();
  testMessageFilters();
  await testLiveIndexing();
  await testSkippedEvents();
  await testExcludedChannelsAndDms();
  await testLinkIdempotencyAndCounts();
  await testReadOrdering();
  await testBackfill();
  await testBackfillFailures();
  testNotificationPlanning();
  testOwnerLookupKeys();
  testThreadMessages();
}

main()
  .then(() => {
    console.log("\nAll tracker Slack tests passed.");
    process.exit(0);
  })
  .catch((error: unknown) => {
    console.error("\nTracker Slack test failed:", error);
    process.exit(1);
  });
