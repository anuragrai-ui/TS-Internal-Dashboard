import { NextResponse } from "next/server";

import { getCachedTsCandidates } from "@/lib/agentFollowupCache";
import { getProductWaitCandidates } from "@/lib/productWaitFollowup";

export interface ProductWaitListItem {
  followUpOrdinal: number;
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
}

export async function GET(): Promise<NextResponse> {
  const candidates = (await getCachedTsCandidates()) ?? (await getProductWaitCandidates());

  const items: ProductWaitListItem[] = candidates.map((candidate) => ({
    followUpOrdinal: candidate.followUpOrdinal,
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
  }));

  return NextResponse.json({ items });
}
