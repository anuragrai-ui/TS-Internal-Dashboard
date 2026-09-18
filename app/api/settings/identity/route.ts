import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { IDENTITY_COOKIE } from "@/lib/currentIdentity";

/**
 * Deliberately clear-only. This route used to also accept POST { accountId }
 * to switch a browser's identity to any already-registered account with no
 * proof of ownership - a one-click impersonation hole (anyone at the shared
 * dashboard could "Identify as" a named teammate and have Sends post under
 * that person's real Jira account). Removed. The only way to become
 * identified as someone is still POST /api/settings/jira-tokens, which
 * requires the exact email+API token pair Jira's own /myself endpoint
 * accepts for that account - proof of ownership, not a name picked from a
 * list.
 */
export async function DELETE(): Promise<NextResponse> {
  const store = await cookies();
  store.delete(IDENTITY_COOKIE);
  return NextResponse.json({ cleared: true });
}
