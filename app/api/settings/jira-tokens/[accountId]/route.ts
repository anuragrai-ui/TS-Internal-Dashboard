import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { getCurrentIdentity, IDENTITY_COOKIE } from "@/lib/currentIdentity";
import { removeUserJiraToken } from "@/lib/userJiraTokens";

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ accountId: string }> },
): Promise<NextResponse> {
  const { accountId } = await params;

  // Self-service only: without this, anyone at the shared dashboard could
  // remove a teammate's registration they have no ownership of (a griefing/
  // denial vector - not impersonation, but still an unauthenticated write on
  // someone else's identity). Being identified as `accountId` is itself
  // proof of ownership, since that identity can only be reached by having
  // that exact account's real Jira email+token pair verified against Jira's
  // own /myself (see POST /api/settings/jira-tokens) - not by anything
  // forgeable client-side.
  const identity = await getCurrentIdentity();

  if (identity?.accountId !== accountId) {
    return NextResponse.json(
      { error: "You can only remove your own registered Jira token." },
      { status: 403 },
    );
  }

  await removeUserJiraToken(accountId);

  const store = await cookies();
  store.delete(IDENTITY_COOKIE);

  return NextResponse.json({ removed: true });
}
