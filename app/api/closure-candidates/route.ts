import { NextResponse } from "next/server";

import { getClosureCandidates } from "@/lib/closureCandidates";
import type { ClosureReason } from "@/lib/closureCandidates";

export interface ClosureCandidateListItem {
  explanation: string;
  issue: {
    key: string;
    reporter: string;
    reporterIsExternal: boolean;
    status?: string;
    summary?: string;
    url: string;
  };
  reason: ClosureReason;
  referenceKey?: string;
}

export async function GET(): Promise<NextResponse> {
  const candidates = await getClosureCandidates();

  const items: ClosureCandidateListItem[] = candidates.map((candidate) => ({
    explanation: candidate.explanation,
    issue: {
      key: candidate.issue.key,
      reporter: candidate.issue.reporter,
      reporterIsExternal: candidate.issue.reporter_is_external,
      status: candidate.issue.status,
      summary: candidate.issue.summary,
      url: candidate.issue.url,
    },
    reason: candidate.reason,
    referenceKey: candidate.referenceKey,
  }));

  return NextResponse.json({ items });
}
