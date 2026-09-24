import { NextResponse } from "next/server";

import { getSlaFollowUpCandidates } from "@/lib/slaFollowup";
import type { SlaFollowUpReason } from "@/lib/slaFollowup";

export interface SlaFollowUpListItem {
  daysSinceLastActivity: number;
  isResolved: boolean;
  issue: {
    key: string;
    linkedCpKey?: string;
    linkedCpStatus?: string;
    reporter: string;
    reporterIsExternal: boolean;
    status?: string;
    summary?: string;
    url: string;
  };
  missedSla: boolean;
  reason: SlaFollowUpReason;
  stage: 1 | 2 | 3;
}

export async function GET(): Promise<NextResponse> {
  const candidates = await getSlaFollowUpCandidates();

  const items: SlaFollowUpListItem[] = candidates.map((candidate) => ({
    daysSinceLastActivity: Math.round(candidate.daysSinceLastActivity * 10) / 10,
    isResolved: candidate.isResolved,
    issue: {
      key: candidate.issue.key,
      linkedCpKey: candidate.issue.linked_cp_issue?.key,
      linkedCpStatus: candidate.issue.linked_cp_issue?.status,
      reporter: candidate.issue.reporter,
      reporterIsExternal: candidate.issue.reporter_is_external,
      status: candidate.issue.status,
      summary: candidate.issue.summary,
      url: candidate.issue.url,
    },
    missedSla: candidate.missedSla,
    reason: candidate.reason,
    stage: candidate.stage,
  }));

  return NextResponse.json({ items });
}
