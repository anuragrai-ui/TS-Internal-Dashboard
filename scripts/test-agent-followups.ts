import { ALL_FOLLOW_UP_KINDS, trimAndExpireAuditLog } from "@/lib/followupAudit";
import type { FollowUpAuditEntry } from "@/lib/followupAudit";
import { checkExternalMessageSafety } from "@/lib/messageSafety";
import { extractLatestMentionFromComments } from "@/lib/jiraClient";
import type { FormattedIssue } from "@/lib/jiraClient";
import { determineCpCandidate } from "@/lib/cpEscalation";
import type { CpMentionTarget } from "@/lib/cpEscalation";
import { determineProductWaitCandidate, draftProductWaitMessage } from "@/lib/productWaitFollowup";
import { VALID_KINDS } from "../app/api/tickets/[key]/followup/send/route";

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

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function makeIssue(overrides: Partial<FormattedIssue> = {}): FormattedIssue {
  return {
    action_date: daysAgoIso(0),
    assignee: "Anurag Rai",
    attachment_count: 0,
    attachments: [],
    comment_count: 0,
    components: [],
    key: "CP-9001",
    labels: [],
    latest_comment_created: "",
    priority: "High",
    priority_sort: 2,
    project: "CP",
    reporter: "Some Reporter",
    reporter_is_external: false,
    status: "Backlog",
    status_category: "new",
    subtask_count: 0,
    summary: "Test issue",
    updated: daysAgoIso(0),
    url: "https://certifyos.atlassian.net/browse/CP-9001",
    ...overrides,
  };
}

function makeAuditEntry(overrides: Partial<FollowUpAuditEntry> = {}): FollowUpAuditEntry {
  return {
    id: "audit-1",
    jira_comment_id: "comment-1",
    kind: "cp_escalation",
    posted_at: daysAgoIso(0),
    posted_text: "test",
    status: "sent",
    ...overrides,
  };
}

function mockAuditEntries(entries: FollowUpAuditEntry[]): (issueKey: string) => Promise<FollowUpAuditEntry[]> {
  return () => Promise.resolve(entries);
}

async function withMockEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) {
    saved[key] = process.env[key];
    process.env[key] = env[key];
  }
  const originalFetch = globalThis.fetch;

  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  }
}

// --- Mention extraction (src/lib/jiraClient.ts) ---

/* Exact real ADF structure captured live from CP-31631: one comment tagging
   two people in a single paragraph, confirming the walker must handle
   multiple mention nodes per comment, not just one. */
const REAL_MULTI_MENTION_COMMENT = {
  author: { displayName: "Anurag Rai" },
  body: {
    content: [
      {
        content: [
          { text: "Hi ", type: "text" },
          {
            attrs: {
              accessLevel: "",
              id: "712020:9b9fe07e-e8b1-49d6-b926-4ce6f7b19197",
              localId: "ace1e869-c916-4245-9667-d364267084ac",
              text: "@Richard Cai",
            },
            type: "mention",
          },
          { text: " ", type: "text" },
          {
            attrs: {
              accessLevel: "",
              id: "712020:e555b3ee-038e-4a25-9440-0ae673c88e99",
              localId: "8e127faf-4c53-48ff-b5c0-62524757bbaa",
              text: "@Ammar Jagirdar",
            },
            type: "mention",
          },
          { text: " The CP for the State Licence Web Crawler Issue. ", type: "text" },
        ],
        type: "paragraph",
      },
    ],
    type: "doc",
    version: 1,
  },
  created: "2026-05-18T09:36:24.042-0700",
};

const PLAIN_COMMENT_NO_MENTION = {
  author: { displayName: "Someone" },
  body: { content: [{ content: [{ text: "Just a plain comment.", type: "text" }], type: "paragraph" }], type: "doc", version: 1 },
  created: "2026-05-19T09:00:00.000-0700",
};

function testMentionExtractionMultiMention(): void {
  console.log("\n--- Test: extractLatestMentionFromComments extracts every mention from the most recent mention-bearing comment ---");

  const mentions = extractLatestMentionFromComments([REAL_MULTI_MENTION_COMMENT]);

  assertEqual(mentions.length, 2, "should extract both people mentioned in the one comment");
  assertEqual(mentions[0]?.accountId, "712020:9b9fe07e-e8b1-49d6-b926-4ce6f7b19197", "first mention's accountId");
  assertEqual(mentions[0]?.displayName, "Richard Cai", "first mention's display name, @ stripped");
  assertEqual(mentions[1]?.displayName, "Ammar Jagirdar", "second mention's display name");

  console.log("PASS: both real mention nodes extracted with correct accountId/displayName.");
}

function testMentionExtractionWalksBackwardsPastPlainComments(): void {
  console.log("\n--- Test: a plain comment after the mention-bearing one doesn't hide it ---");

  // getIssueComments orders oldest-first (orderBy: "created"); this array
  // reflects that - the mention-bearing comment is NOT the last one.
  const mentions = extractLatestMentionFromComments([REAL_MULTI_MENTION_COMMENT, PLAIN_COMMENT_NO_MENTION]);

  assertEqual(mentions.length, 2, "should walk backwards past the plain comment to find the mention");

  console.log("PASS: walks backwards through comments to find the most recent one with any mention.");
}

function testMentionExtractionNoMentionsAnywhere(): void {
  console.log("\n--- Test: no comment ever mentions anyone -> empty result, not a crash ---");

  const mentions = extractLatestMentionFromComments([PLAIN_COMMENT_NO_MENTION]);

  assertEqual(mentions, [], "should return an empty array, not throw");

  console.log("PASS: no mentions anywhere resolves to an empty array.");
}

// --- checkExternalMessageSafety (src/lib/messageSafety.ts) ---

function testSafetyCatchesBareTicketKey(): void {
  console.log("\n--- Test: checkExternalMessageSafety catches a bare internal ticket key ---");

  const result = checkExternalMessageSafety("We're tracking this via CP-38127 internally.", "TS-100");
  assert(!result.safe, "should be flagged unsafe");
  assert(result.violations.some((v) => v.includes("CP-38127")), "violation should name the leaked key");

  console.log("PASS: a bare CP key is caught.");
}

function testSafetyCatchesAnyProjectKeyNotJustCp(): void {
  console.log("\n--- Test: the key pattern is generic, not hardcoded to CP - agentic tool-calling can surface any project ---");

  const result = checkExternalMessageSafety("Related to ENG-456 on our side.", "TS-100");
  assert(!result.safe, "a non-CP internal key should also be caught");

  console.log("PASS: generic key pattern catches non-CP project keys too.");
}

function testSafetyCatchesWikiLink(): void {
  console.log("\n--- Test: checkExternalMessageSafety catches a Confluence/wiki link ---");

  const result = checkExternalMessageSafety(
    "See our internal runbook: https://certifyos.atlassian.net/wiki/spaces/ENG/pages/123",
    "TS-100",
  );
  assert(!result.safe, "should be flagged unsafe");
  assert(result.violations.some((v) => v.toLowerCase().includes("wiki")), "violation should mention the wiki link");

  console.log("PASS: a Confluence/wiki link is caught.");
}

function testSafetyAllowsOwnKeyAndCleanText(): void {
  console.log("\n--- Test: the ticket's own key is exempt, and clean text passes ---");

  const ownKeyResult = checkExternalMessageSafety("Following up on TS-100 for you.", "TS-100");
  assert(ownKeyResult.safe, "the draft's own ticket key should never itself be a violation");

  const cleanResult = checkExternalMessageSafety("We're working on a fix and will share an ETA soon.", "TS-100");
  assert(cleanResult.safe, "clean text should pass");

  console.log("PASS: own ticket key exempt, clean text passes.");
}

// --- CP cadence (src/lib/cpEscalation.ts) ---

const highPriorityMentionTarget: CpMentionTarget = {
  accountId: "acc-1",
  displayName: "Test Assignee",
  source: "assignee",
};
const resolveMentionTargetOk = (): Promise<CpMentionTarget | null> => Promise.resolve(highPriorityMentionTarget);
const resolveMentionTargetNone = (): Promise<CpMentionTarget | null> => Promise.resolve(null);

async function testCpCadenceHighPriority(): Promise<void> {
  console.log("\n--- Test: High/Critical CP cadence is 3 days ---");

  const tooSoon = await determineCpCandidate(
    makeIssue({ priority: "High", updated: daysAgoIso(1) }),
    "TS-1",
    mockAuditEntries([]),
    resolveMentionTargetOk,
  );
  assertEqual(tooSoon, null, "1 day idle should not yet be due for a High-priority CP");

  const due = await determineCpCandidate(
    makeIssue({ priority: "Critical", updated: daysAgoIso(3) }),
    "TS-1",
    mockAuditEntries([]),
    resolveMentionTargetOk,
  );
  assert(due !== null, "3 days idle should be due for a Critical-priority CP");

  console.log("PASS: High/Critical CPs use the 3-day cadence.");
}

async function testCpCadenceMediumPriority(): Promise<void> {
  console.log("\n--- Test: Medium CP cadence is 7 days, measured from the last nudge if one exists ---");

  const tooSoon = await determineCpCandidate(
    makeIssue({ priority: "Medium" }),
    "TS-1",
    mockAuditEntries([makeAuditEntry({ posted_at: daysAgoIso(5) })]),
    resolveMentionTargetOk,
  );
  assertEqual(tooSoon, null, "5 days since the last nudge should not yet be due for Medium (needs 7)");

  const due = await determineCpCandidate(
    makeIssue({ priority: "Medium" }),
    "TS-1",
    mockAuditEntries([makeAuditEntry({ posted_at: daysAgoIso(8) })]),
    resolveMentionTargetOk,
  );
  assert(due !== null, "8 days since the last nudge should be due for Medium");

  console.log("PASS: Medium CPs use the 7-day cadence, measured from the last cp_escalation entry.");
}

async function testCpLowPriorityAndDoneExcluded(): Promise<void> {
  console.log("\n--- Test: Low-priority and already-Done CPs are out of scope ---");

  const low = await determineCpCandidate(
    makeIssue({ priority: "Low", updated: daysAgoIso(30) }),
    "TS-1",
    mockAuditEntries([]),
    resolveMentionTargetOk,
  );
  assertEqual(low, null, "Low priority is not in the user's requested scope");

  const done = await determineCpCandidate(
    makeIssue({ priority: "Critical", status_category: "done", updated: daysAgoIso(30) }),
    "TS-1",
    mockAuditEntries([]),
    resolveMentionTargetOk,
  );
  assertEqual(done, null, "an already-Done CP should never be a candidate");

  console.log("PASS: Low priority and Done status are both correctly excluded.");
}

async function testCpNoMentionTargetExcludesCandidate(): Promise<void> {
  console.log("\n--- Test: no resolvable mention target (no assignee, no mention, no reporter accountId) excludes the candidate ---");

  const result = await determineCpCandidate(
    makeIssue({ priority: "High", updated: daysAgoIso(5) }),
    "TS-1",
    mockAuditEntries([]),
    resolveMentionTargetNone,
  );
  assertEqual(result, null, "with truly nobody to tag, this should not surface as a candidate at all");

  console.log("PASS: a CP with no possible mention target is excluded rather than surfaced with a broken action.");
}

// --- TS product-wait cadence + ordinal (src/lib/productWaitFollowup.ts) ---

function makeTsIssue(overrides: Partial<FormattedIssue> = {}): FormattedIssue {
  return makeIssue({
    key: "TS-9001",
    priority: "Medium",
    project: "TS",
    reporter: "Some Client",
    reporter_is_external: true,
    status: "Waiting for Product",
    url: "https://certifyos.atlassian.net/browse/TS-9001",
    ...overrides,
  });
}

async function testProductWaitCadenceAndOrdinal(): Promise<void> {
  console.log("\n--- Test: TS product-wait cadence is 3 days, and ordinal counts prior product_wait entries ---");

  const tooSoon = await determineProductWaitCandidate(makeTsIssue({ updated: daysAgoIso(2) }), mockAuditEntries([]));
  assertEqual(tooSoon, null, "2 days idle should not yet be due");

  const firstDue = await determineProductWaitCandidate(makeTsIssue({ updated: daysAgoIso(4) }), mockAuditEntries([]));
  assert(firstDue !== null, "4 days idle should be due");
  assertEqual(firstDue?.followUpOrdinal, 1, "first-ever follow-up should be ordinal 1");

  const thirdDue = await determineProductWaitCandidate(
    makeTsIssue(),
    mockAuditEntries([
      makeAuditEntry({ kind: "product_wait", posted_at: daysAgoIso(10) }),
      makeAuditEntry({ kind: "product_wait", posted_at: daysAgoIso(4) }),
    ]),
  );
  assert(thirdDue !== null, "4 days since the last of 2 prior follow-ups should be due");
  assertEqual(thirdDue?.followUpOrdinal, 3, "should be the 3rd follow-up given 2 prior entries");

  const notDueAfterRecent = await determineProductWaitCandidate(
    makeTsIssue(),
    mockAuditEntries([makeAuditEntry({ kind: "product_wait", posted_at: daysAgoIso(1) })]),
  );
  assertEqual(notDueAfterRecent, null, "1 day since the last follow-up should not yet be due");

  console.log("PASS: 3-day cadence and follow-up ordinal both computed correctly.");
}

// --- Fallback template ordinal variation (src/lib/productWaitFollowup.ts) ---

async function testExternalFallbackVariesByOrdinal(): Promise<void> {
  console.log("\n--- Test: the external fallback template genuinely varies by follow-up ordinal ---");

  // AI disabled -> draftViaChain returns the template immediately, no network call.
  await withMockEnv({ OPENROUTER_ESCALATION_ENABLED: "false" }, async () => {
    const first = await draftProductWaitMessage({ followUpOrdinal: 1, issue: makeTsIssue() }, []);
    const second = await draftProductWaitMessage({ followUpOrdinal: 2, issue: makeTsIssue() }, []);
    const third = await draftProductWaitMessage({ followUpOrdinal: 3, issue: makeTsIssue() }, []);
    const fifth = await draftProductWaitMessage({ followUpOrdinal: 5, issue: makeTsIssue() }, []);

    assert(first.text !== second.text, "1st and 2nd fallback text should differ");
    assert(second.text !== third.text, "2nd and 3rd fallback text should differ");
    assertEqual(third.text, fifth.text, "3rd-and-beyond share the same 'ongoing thread' variant by design");

    console.log("PASS: fallback template text genuinely differs across the first few ordinals.");
  });
}

async function testExternalDraftRejectsLeakAndFallsBackSafely(): Promise<void> {
  console.log("\n--- Test: an AI response that leaks an internal key is rejected, not surfaced to the reviewer ---");

  await withMockEnv(
    { DRAFT_PROVIDER: "openrouter", OPENROUTER_API_KEY: "fake-key", OPENROUTER_ESCALATION_ENABLED: "true" },
    async () => {
      globalThis.fetch = () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [{ message: { content: "We're tracking this via CP-38127, should be done soon." } }],
            }),
            { status: 200 },
          ),
        );

      const result = await draftProductWaitMessage({ followUpOrdinal: 1, issue: makeTsIssue() }, []);

      assert(!result.text.includes("CP-38127"), "the leaking AI response must never reach the caller");
      assert(result.text.includes("check in"), "should have fallen through to the safe ordinal-1 template");

      console.log("PASS: a leaking AI draft is rejected and replaced with the safe fallback, never surfaced.");
    },
  );
}

// --- trimAndExpireAuditLog (src/lib/followupAudit.ts) ---

async function testAuditLogTrimAndExpire(): Promise<void> {
  console.log("\n--- Test: trimAndExpireAuditLog trims to the cap and refreshes the key's TTL ---");

  const calls: { args: unknown[]; name: string }[] = [];
  const fakeRedis = {
    expire: (...args: unknown[]) => {
      calls.push({ args, name: "expire" });
      return Promise.resolve(1);
    },
    zremrangebyrank: (...args: unknown[]) => {
      calls.push({ args, name: "zremrangebyrank" });
      return Promise.resolve(0);
    },
  };

  await trimAndExpireAuditLog(fakeRedis as unknown as Parameters<typeof trimAndExpireAuditLog>[0], "TS-9001");

  const trimCall = calls.find((call) => call.name === "zremrangebyrank");
  const expireCall = calls.find((call) => call.name === "expire");

  assert(Boolean(trimCall), "should call zremrangebyrank to trim old entries");
  assertEqual(trimCall?.args[0], "followup:log:TS-9001", "should trim the correct issue's audit log key");
  assertEqual(trimCall?.args[1], 0, "should trim starting from rank 0 (the oldest entries)");
  assert(
    typeof trimCall?.args[2] === "number" && trimCall.args[2] < 0,
    "should trim up to a negative rank, keeping only the most recent N entries",
  );

  assert(Boolean(expireCall), "should refresh the key's TTL after trimming");
  assertEqual(expireCall?.args[0], "followup:log:TS-9001", "should refresh the TTL on the same key");
  assert(typeof expireCall?.args[1] === "number" && expireCall.args[1] > 0, "should set a positive TTL");

  console.log("PASS: the audit log is both trimmed to a cap and given a refreshed TTL, not left to grow forever.");
}

async function testAuditLogTrimSurvivesRedisFailure(): Promise<void> {
  console.log("\n--- Test: a Redis failure while trimming doesn't throw (the send already succeeded) ---");

  const failingRedis = {
    expire: () => Promise.reject(new Error("simulated Redis failure")),
    zremrangebyrank: () => Promise.reject(new Error("simulated Redis failure")),
  };

  await trimAndExpireAuditLog(failingRedis as unknown as Parameters<typeof trimAndExpireAuditLog>[0], "TS-9001");

  console.log("PASS: a trim/expire failure is swallowed (logged, not thrown) since the actual send already completed.");
}

// --- FollowUpKind / VALID_KINDS sync (app/api/tickets/[key]/followup/send/route.ts) ---

function testValidKindsStaysInSync(): void {
  console.log("\n--- Test: every FollowUpKind is present in the send route's VALID_KINDS ---");

  for (const kind of ALL_FOLLOW_UP_KINDS) {
    assert(VALID_KINDS.includes(kind), `FollowUpKind "${kind}" is missing from VALID_KINDS - it would silently coerce to "manual" on send`);
  }

  console.log(`PASS: all ${ALL_FOLLOW_UP_KINDS.length} FollowUpKind values are present in VALID_KINDS.`);
}

async function main(): Promise<void> {
  try {
    testMentionExtractionMultiMention();
    testMentionExtractionWalksBackwardsPastPlainComments();
    testMentionExtractionNoMentionsAnywhere();
    testSafetyCatchesBareTicketKey();
    testSafetyCatchesAnyProjectKeyNotJustCp();
    testSafetyCatchesWikiLink();
    testSafetyAllowsOwnKeyAndCleanText();
    await testCpCadenceHighPriority();
    await testCpCadenceMediumPriority();
    await testCpLowPriorityAndDoneExcluded();
    await testCpNoMentionTargetExcludesCandidate();
    await testProductWaitCadenceAndOrdinal();
    await testExternalFallbackVariesByOrdinal();
    await testExternalDraftRejectsLeakAndFallsBackSafely();
    await testAuditLogTrimAndExpire();
    await testAuditLogTrimSurvivesRedisFailure();
    testValidKindsStaysInSync();
    console.log("\nAll agent-followups tests passed.");
    process.exit(0);
  } catch (error) {
    console.error("\nAgent-followups test failed:", error);
    process.exit(1);
  }
}

main();
