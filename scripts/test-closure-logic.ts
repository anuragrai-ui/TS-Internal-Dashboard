import { determineCandidate } from "@/lib/slaFollowup";
import { classifyIssue, parseSimilarityMatches } from "@/lib/closureCandidates";
import type { FollowUpAuditEntry } from "@/lib/followupAudit";
import type { FormattedIssue } from "@/lib/jiraClient";

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
    key: "TS-9001",
    labels: [],
    latest_comment_created: "",
    priority: "Medium",
    priority_sort: 3,
    project: "TS",
    reporter: "Some Client",
    reporter_is_external: true,
    severity: "Minor",
    status: "Waiting for Client",
    status_category: "indeterminate",
    subtask_count: 0,
    summary: "Test ticket",
    updated: daysAgoIso(0),
    url: "https://certifyos.atlassian.net/browse/TS-9001",
    ...overrides,
  };
}

function makeAuditEntry(overrides: Partial<FollowUpAuditEntry> = {}): FollowUpAuditEntry {
  return {
    id: "audit-1",
    jira_comment_id: "comment-1",
    kind: "sla_stage_1",
    posted_at: daysAgoIso(0),
    posted_text: "test",
    status: "sent",
    ...overrides,
  };
}

function mockAuditEntries(entries: FollowUpAuditEntry[]): (issueKey: string) => Promise<FollowUpAuditEntry[]> {
  return () => Promise.resolve(entries);
}

// --- determineCandidate (src/lib/slaFollowup.ts) ---

async function testStage3FiresOnFailedTransition(): Promise<void> {
  console.log("\n--- Test: stage 3 fires when sla_stage_2 was sent but the ticket isn't actually Done ---");

  const issue = makeIssue({ status_category: "indeterminate" });
  const auditEntries = [makeAuditEntry({ kind: "sla_stage_2", posted_at: daysAgoIso(1) })];

  const candidate = await determineCandidate(issue, mockAuditEntries(auditEntries));

  assert(candidate !== null, "should return a candidate");
  assertEqual(candidate?.stage, 3, "should be stage 3");
  assertEqual(candidate?.missedSla, false, "stage 3 candidates are never flagged as missedSla");

  console.log("PASS: a sent-but-not-Done stage-2 attempt surfaces as stage 3.");
}

async function testStage3DoesNotFireOnceDone(): Promise<void> {
  console.log("\n--- Test: stage 3 does NOT fire once the ticket is actually Done ---");

  const issue = makeIssue({ status_category: "done" });
  const auditEntries = [makeAuditEntry({ kind: "sla_stage_2", posted_at: daysAgoIso(1) })];

  const candidate = await determineCandidate(issue, mockAuditEntries(auditEntries));

  assertEqual(candidate, null, "a successfully-closed ticket should not be a candidate at all");

  console.log("PASS: once status_category is done, the ticket drops out entirely.");
}

async function testStage1MissedSlaBoundary(): Promise<void> {
  console.log("\n--- Test: stage 1 missedSla flips at SLA_DAYS + MISSED_SLA_BUFFER_DAYS ---");

  const justEligible = makeIssue({ updated: daysAgoIso(3) });
  const notYetMissed = await determineCandidate(justEligible, mockAuditEntries([]));
  assert(notYetMissed !== null, "3 days idle should already be a stage-1 candidate");
  assertEqual(notYetMissed?.missedSla, false, "3 days idle should not yet be flagged as missed");

  const overdue = makeIssue({ updated: daysAgoIso(5) });
  const missed = await determineCandidate(overdue, mockAuditEntries([]));
  assertEqual(missed?.missedSla, true, "5 days idle (3 + 2 buffer) should be flagged as missed");

  console.log("PASS: stage-1 missedSla is false right at eligibility, true once the buffer elapses.");
}

async function testStage2MissedSlaBoundary(): Promise<void> {
  console.log("\n--- Test: stage 2 missedSla flips at SLA_DAYS + MISSED_SLA_BUFFER_DAYS since stage 1 ---");

  const stage1Entry = makeAuditEntry({ kind: "sla_stage_1", posted_at: daysAgoIso(3) });
  const notYetMissed = await determineCandidate(makeIssue(), mockAuditEntries([stage1Entry]));
  assert(notYetMissed !== null, "3 days since stage 1 should already be a stage-2 candidate");
  assertEqual(notYetMissed?.stage, 2, "should be stage 2");
  assertEqual(notYetMissed?.missedSla, false, "3 days since stage 1 should not yet be flagged as missed");

  const overdueStage1 = makeAuditEntry({ kind: "sla_stage_1", posted_at: daysAgoIso(5) });
  const missed = await determineCandidate(makeIssue(), mockAuditEntries([overdueStage1]));
  assertEqual(missed?.missedSla, true, "5 days since stage 1 (3 + 2 buffer) should be flagged as missed");

  console.log("PASS: stage-2 missedSla tracks days since the stage-1 send, not the ticket's own idle time.");
}

// --- classifyIssue (src/lib/closureCandidates.ts) ---

async function testClosureRetryFiresWhenNotDone(): Promise<void> {
  console.log("\n--- Test: a closure_candidate attempt that didn't close surfaces as retry_close ---");

  const issue = makeIssue({ status_category: "indeterminate" });
  const result = await classifyIssue(issue, mockAuditEntries([makeAuditEntry({ kind: "closure_candidate" })]));

  assertEqual(result.kind, "candidate", "should classify as a candidate");
  assert(result.kind === "candidate" && result.candidate.reason === "retry_close", "reason should be retry_close");

  console.log("PASS: an unresolved closure_candidate attempt surfaces as a retry.");
}

async function testClosureAttemptDoneIsSkipped(): Promise<void> {
  console.log("\n--- Test: a closure_candidate attempt that succeeded is fully handled ---");

  const issue = makeIssue({ status_category: "done" });
  const result = await classifyIssue(issue, mockAuditEntries([makeAuditEntry({ kind: "closure_candidate" })]));

  assertEqual(result.kind, "skip", "a successfully closed ticket should be skipped");

  console.log("PASS: once Done, a closure_candidate ticket is excluded entirely.");
}

async function testStage1AloneDoesNotTriggerUnresponsiveCandidate(): Promise<void> {
  console.log("\n--- Test: a mere stage-1 check-in does not surface as a closure candidate here ---");

  const stage1Issue = makeIssue({ linked_cp_issues: [{ isDone: true, key: "CP-2", status: "Done" }] });
  const stage1Result = await classifyIssue(stage1Issue, mockAuditEntries([makeAuditEntry({ kind: "sla_stage_1" })]));
  assertEqual(
    stage1Result.kind,
    "candidate",
    "a mere stage-1 check-in should NOT block it - the CP resolving is still worth surfacing on its own signal",
  );
  assert(
    stage1Result.kind === "candidate" && stage1Result.candidate.reason === "linked_cp_resolved",
    "with only a stage-1 entry, the resolved-linked-CP signal should still be the one that fires",
  );

  console.log("PASS: only an actual second follow-up (stage 2/3) triggers the unresponsive-reporter check - stage 1 alone does not.");
}

async function testStage2NoResponseSurfacesAsClientUnresponsive(): Promise<void> {
  console.log("\n--- Test: stage 2 sent, ticket still open, reporter never replied -> client_unresponsive candidate ---");

  const issue = makeIssue({ status_category: "indeterminate" });
  const result = await classifyIssue(issue, mockAuditEntries([makeAuditEntry({ kind: "sla_stage_2" })]));

  assertEqual(result.kind, "candidate", "should surface as a candidate, not silently deferred to the SLA tab");
  assert(
    result.kind === "candidate" && result.candidate.reason === "client_unresponsive",
    "reason should be client_unresponsive - a second follow-up already went out with no reply",
  );

  console.log("PASS: a stage-2 send with no reply surfaces here as \"client unresponsive\", exactly what was requested.");
}

async function testStage3AlsoSurfacesAsClientUnresponsive(): Promise<void> {
  console.log("\n--- Test: stage 3 (retry after a failed close attempt) also qualifies ---");

  const issue = makeIssue({ status_category: "indeterminate" });
  const result = await classifyIssue(issue, mockAuditEntries([makeAuditEntry({ kind: "sla_stage_3" })]));

  assert(
    result.kind === "candidate" && result.candidate.reason === "client_unresponsive",
    "a stage-3 entry should also qualify, same as stage 2",
  );

  console.log("PASS: stage 3 entries are treated the same as stage 2 for this signal.");
}

async function testStillDoneTicketIsSkippedEvenWithStage2(): Promise<void> {
  console.log("\n--- Test: a stage-2 send that actually succeeded (ticket now Done) is skipped, not re-surfaced ---");

  const issue = makeIssue({ status_category: "done" });
  const result = await classifyIssue(issue, mockAuditEntries([makeAuditEntry({ kind: "sla_stage_2" })]));

  assertEqual(result.kind, "skip", "an already-Done ticket should never surface as a candidate, regardless of history");

  console.log("PASS: a successfully-closed ticket is excluded even if it has a stage-2 entry in its history.");
}

async function testCpNotWorkedTicketIsNotMisclassifiedAsUnresponsive(): Promise<void> {
  console.log("\n--- Test: if the real blocker is a not-yet-worked linked CP, this is NOT surfaced as \"client unresponsive\" ---");

  // status "Backlog" is the isCpNotWorkedOn fast-path (no live Jira lookup needed for this case).
  const issue = makeIssue({
    linked_cp_issue: { isDone: false, key: "CP-9", status: "Backlog" },
    status_category: "indeterminate",
  });
  const result = await classifyIssue(issue, mockAuditEntries([makeAuditEntry({ kind: "sla_stage_2" })]));

  assertEqual(
    result.kind,
    "skip",
    "the reporter isn't actually the problem here - an unworked linked CP is Product's problem, not a reason to suggest closing",
  );

  console.log("PASS: a stage-2 ticket whose real blocker is an unworked CP is left to CP escalations, not misfiled as unresponsive.");
}

async function testLinkedCpResolvedIsFreeCandidate(): Promise<void> {
  console.log("\n--- Test: a resolved linked CP is an immediate candidate, no AI needed ---");

  const issue = makeIssue({ linked_cp_issues: [{ isDone: true, key: "CP-42", status: "Done" }] });
  const result = await classifyIssue(issue, mockAuditEntries([]));

  assertEqual(result.kind, "candidate", "should classify as a candidate");
  assert(
    result.kind === "candidate" &&
      result.candidate.reason === "linked_cp_resolved" &&
      result.candidate.referenceKey === "CP-42",
    "should reference the resolved CP ticket",
  );

  console.log("PASS: a single resolved linked CP is enough to surface a candidate, no similarity check needed.");
}

async function testMultipleLinkedCpsRequireAllResolved(): Promise<void> {
  console.log("\n--- Test: with 2+ linked CPs, one resolved is NOT enough - all must be resolved ---");

  const issue = makeIssue({
    linked_cp_issues: [
      { isDone: true, key: "CP-1", status: "Done" },
      { isDone: false, key: "CP-2", status: "In Progress" },
    ],
  });
  const result = await classifyIssue(issue, mockAuditEntries([]));

  assertEqual(
    result.kind,
    "needs-similarity",
    "one resolved CP out of two should NOT auto-qualify - it must fall through, not be treated as closable",
  );

  console.log("PASS: a partially-resolved multi-CP link does not surface as a free candidate.");
}

async function testMultipleLinkedCpsAllResolvedIsCandidate(): Promise<void> {
  console.log("\n--- Test: with 2+ linked CPs, ALL resolved is a free candidate mentioning every one ---");

  const issue = makeIssue({
    linked_cp_issues: [
      { isDone: true, key: "CP-1", status: "Done" },
      { isDone: true, key: "CP-2", status: "Done" },
    ],
  });
  const result = await classifyIssue(issue, mockAuditEntries([]));

  assertEqual(result.kind, "candidate", "should classify as a candidate once every linked CP is resolved");
  assert(
    result.kind === "candidate" &&
      result.candidate.reason === "linked_cp_resolved" &&
      result.candidate.explanation.includes("CP-1") &&
      result.candidate.explanation.includes("CP-2"),
    "the explanation should name every resolved linked CP, not just one",
  );

  console.log("PASS: every linked CP resolved surfaces as a candidate, naming all of them.");
}

async function testStoryTypeCpIsIgnoredForClosure(): Promise<void> {
  console.log("\n--- Test: a Story-type linked CP never blocks or contributes to closure - it's negated entirely ---");

  const issue = makeIssue({
    linked_cp_issues: [
      { isDone: false, issueType: "Story", key: "CP-1", status: "Backlog" },
      { isDone: true, issueType: "Task", key: "CP-2", status: "Done" },
    ],
  });
  const result = await classifyIssue(issue, mockAuditEntries([]));

  assertEqual(
    result.kind,
    "candidate",
    "an unresolved Story-type CP alongside a resolved Task CP should still qualify - Story doesn't block",
  );
  assert(
    result.kind === "candidate" && result.candidate.referenceKey === "CP-2",
    "should reference the real (non-Story) resolved CP, not the ignored Story one",
  );

  console.log("PASS: Story-type linked CPs are excluded from the closure check entirely, in either direction.");
}

async function testAllStoryTypeCpsGiveNoSignal(): Promise<void> {
  console.log("\n--- Test: if every linked CP is Story-type, there's no closure signal here at all ---");

  const issue = makeIssue({
    linked_cp_issues: [
      { isDone: true, issueType: "Story", key: "CP-1", status: "Done" },
      { isDone: true, issueType: "Story", key: "CP-2", status: "Done" },
    ],
  });
  const result = await classifyIssue(issue, mockAuditEntries([]));

  assertEqual(
    result.kind,
    "needs-similarity",
    "with nothing but Story-type links (negated), this should defer to the similarity check like having no linked CP at all",
  );

  console.log("PASS: an all-Story linked-CP set contributes no closure signal, same as no linked CP.");
}

async function testNoSignalNeedsSimilarityCheck(): Promise<void> {
  console.log("\n--- Test: no audit entry and no resolved linked CP defers to the AI similarity check ---");

  const issue = makeIssue();
  const result = await classifyIssue(issue, mockAuditEntries([]));

  assertEqual(result.kind, "needs-similarity", "should defer to the bounded AI similarity check");

  console.log("PASS: a ticket with no free signal is queued for the similarity check rather than skipped or auto-flagged.");
}

// --- parseSimilarityMatches (src/lib/closureCandidates.ts) ---

function testParsesGenuineMatches(): void {
  console.log("\n--- Test: parseSimilarityMatches extracts well-formed matches ---");

  const text = JSON.stringify([
    { key: "TS-1", matched_key: "TS-100", reason: "Same root cause." },
    { key: "TS-2", matched_key: "TS-200", reason: "Duplicate report." },
  ]);

  const matches = parseSimilarityMatches(text);
  assertEqual(matches.length, 2, "should extract both matches");
  assertEqual(matches[0]?.matched_key, "TS-100", "first match should reference TS-100");

  console.log("PASS: well-formed matches are extracted correctly.");
}

function testIgnoresMalformedEntries(): void {
  console.log("\n--- Test: parseSimilarityMatches drops malformed entries instead of throwing ---");

  const text = JSON.stringify([
    { key: "TS-1", matched_key: "TS-100", reason: "Valid entry." },
    { key: "TS-2" }, // missing matched_key/reason
    "not an object",
  ]);

  const matches = parseSimilarityMatches(text);
  assertEqual(matches.length, 1, "only the well-formed entry should survive");

  console.log("PASS: malformed entries are filtered out rather than crashing the scan.");
}

function testEmptyOrUnparseableInput(): void {
  console.log("\n--- Test: parseSimilarityMatches handles no-match and unparseable responses gracefully ---");

  assertEqual(parseSimilarityMatches("[]"), [], "an empty array should produce no matches");
  assertEqual(parseSimilarityMatches("not json at all"), [], "unparseable text should produce no matches, not throw");

  console.log("PASS: no genuine matches and malformed model output both resolve to an empty list.");
}

async function main(): Promise<void> {
  try {
    await testStage3FiresOnFailedTransition();
    await testStage3DoesNotFireOnceDone();
    await testStage1MissedSlaBoundary();
    await testStage2MissedSlaBoundary();
    await testClosureRetryFiresWhenNotDone();
    await testClosureAttemptDoneIsSkipped();
    await testStage1AloneDoesNotTriggerUnresponsiveCandidate();
    await testStage2NoResponseSurfacesAsClientUnresponsive();
    await testStage3AlsoSurfacesAsClientUnresponsive();
    await testStillDoneTicketIsSkippedEvenWithStage2();
    await testCpNotWorkedTicketIsNotMisclassifiedAsUnresponsive();
    await testLinkedCpResolvedIsFreeCandidate();
    await testMultipleLinkedCpsRequireAllResolved();
    await testMultipleLinkedCpsAllResolvedIsCandidate();
    await testStoryTypeCpIsIgnoredForClosure();
    await testAllStoryTypeCpsGiveNoSignal();
    await testNoSignalNeedsSimilarityCheck();
    testParsesGenuineMatches();
    testIgnoresMalformedEntries();
    testEmptyOrUnparseableInput();
    console.log("\nAll closure-logic tests passed.");
    process.exit(0);
  } catch (error) {
    console.error("\nClosure-logic test failed:", error);
    process.exit(1);
  }
}

main();
