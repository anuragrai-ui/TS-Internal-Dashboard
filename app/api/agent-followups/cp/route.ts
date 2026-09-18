import { NextResponse } from "next/server";

import { getCachedCpCandidates } from "@/lib/agentFollowupCache";
import { getCpEscalationCandidates } from "@/lib/cpEscalation";

export interface CpEscalationListItem {
  cp: {
    issueType?: string;
    key: string;
    priority: string;
    status?: string;
    summary?: string;
    url: string;
  };
  daysSinceLastNudge: number;
  linkedTsKey: string;
  mentionTarget: {
    people: Array<{ accountId: string; displayName: string }>;
    source: string;
  };
}

export async function GET(): Promise<NextResponse> {
  const candidates = (await getCachedCpCandidates()) ?? (await getCpEscalationCandidates());

  const items: CpEscalationListItem[] = candidates.map((candidate) => ({
    cp: {
      issueType: candidate.cp.issue_type,
      key: candidate.cp.key,
      priority: candidate.cp.priority,
      status: candidate.cp.status,
      summary: candidate.cp.summary,
      url: candidate.cp.url,
    },
    daysSinceLastNudge: Math.round(candidate.daysSinceLastNudge * 10) / 10,
    linkedTsKey: candidate.linkedTsKey,
    mentionTarget: candidate.mentionTarget,
  }));

  return NextResponse.json({ items });
}
