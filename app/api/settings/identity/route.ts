import { NextResponse } from "next/server";

import { endIdentitySession } from "@/lib/currentIdentity";

/**
 * Deliberately clear-only ("Not you? Forget this identity"). This route used
 * to also accept POST { accountId } to switch a browser's identity to any
 * registered account with no proof of ownership - removed. The only way to
 * become identified as someone is POST /api/settings/jira-tokens, which
 * requires the exact email + API token pair Jira's own /myself accepts for
 * that account. Ending the session also revokes it server-side, so a copied
 * cookie stops working too.
 */
export async function DELETE(): Promise<NextResponse> {
  await endIdentitySession();
  return NextResponse.json({ cleared: true });
}
