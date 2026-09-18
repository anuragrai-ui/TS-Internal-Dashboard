import { NextResponse } from "next/server";

import { getIssueByKey } from "@/lib/jiraClient";
import { buildSlaBreachAlert } from "@/lib/slaBreachAlert";
import { determineCandidate } from "@/lib/slaFollowup";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ key: string }> },
): Promise<NextResponse> {
  const { key } = await params;

  const issue = await getIssueByKey(key);

  if (!issue) {
    return NextResponse.json({ error: `Ticket ${key} not found.` }, { status: 404 });
  }

  // Re-run the real cadence/eligibility logic (not a synthetic candidate)
  // so missedSla reflects reality - it's the actual gate for whether this
  // alert applies at all (see isEligibleForSlaBreachAlert in
  // slaBreachAlert.ts).
  const candidate = await determineCandidate(issue);

  if (!candidate) {
    return NextResponse.json({ error: `${key} no longer qualifies for an SLA follow-up.` }, { status: 409 });
  }

  const draft = await buildSlaBreachAlert(candidate);

  if (!draft) {
    return NextResponse.json(
      { error: `${key} isn't eligible for an SLA-breach Slack alert (needs a missed SLA and an unworked linked CP).` },
      { status: 409 },
    );
  }

  return NextResponse.json({
    channel: draft.channel,
    pmDisplayName: draft.pmDisplayName,
    podName: draft.podName,
    text: draft.text,
  });
}
