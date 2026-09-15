import assert from "node:assert/strict";
import { stdout } from "node:process";

import {
  countTicketsNeedingFollowup,
  parseCsv,
  parseSheetBacklogCsv,
  parseSheetFollowupsCsv,
} from "../src/lib/googleSheetBacklog.ts";

const parsed = parseCsv('Key,Comment\r\nTS-1,"Line one\nLine two, with comma and ""quote"""\r\n');
assert.deepEqual(parsed, [
  ["Key", "Comment"],
  ["TS-1", 'Line one\nLine two, with comma and "quote"'],
]);

const backlog = parseSheetBacklogCsv(
  [
    "Issue Type,Key,Summary,Assignee,Reporter,Priority,Customer(s),Status,Resolution,Created,Resolved,[CHART] Date of First Response,Reopen Date,Comment,Linked Issues,Linked Issues.id,Linked Issues.issueId",
    'Support Ticket,TS-1,"A multiline ticket",Alex,client@example.com,High,Client A,Waiting for product,,9/1/2026 10:00:00,,9/2/2026 10:00:00,,"First line\nSecond line",CP-10,1,10',
    'Support Ticket,TS-1,"A multiline ticket",Alex,client@example.com,High,Client A,Waiting for product,,9/1/2026 10:00:00,,9/2/2026 10:00:00,,"First line\nSecond line",CP-11,2,11',
  ].join("\n"),
);

assert.equal(backlog.length, 1);
assert.deepEqual(backlog[0]?.linkedIssues, ["CP-10", "CP-11"]);
assert.equal(backlog[0]?.issue.latest_comment_created, "2026-09-02T04:30:00.000Z");
assert.equal(backlog[0]?.issue.assignee, "Alex");
assert.equal(
  countTicketsNeedingFollowup(backlog, new Date("2026-09-06T04:30:00.000Z")),
  1,
);

const followups = parseSheetFollowupsCsv(
  [
    "Ticket Type,Ticket Key,Linked Ticket,Summary,Assignee,Status,Last Activity,Age (Days),Priority,AI Insight,Recommended Action,Follow-up Draft,Follow-up State,Generated At,Source Link",
    "TS,TS-1,CP-10,Summary,Alex,Waiting for product,9/2/2026 10:00:00,4,High,Insight,Review,Draft,Ready,9/6/2026 10:00:00,https://example.test/TS-1",
  ].join("\n"),
);

assert.equal(followups.length, 1);
assert.equal(followups[0]?.key, "TS-1");
assert.equal(followups[0]?.generatedAt, "2026-09-06T04:30:00.000Z");
assert.equal(followups[0]?.followupDraft, "Draft");

stdout.write("Google Sheet backlog parser tests passed.\n");
