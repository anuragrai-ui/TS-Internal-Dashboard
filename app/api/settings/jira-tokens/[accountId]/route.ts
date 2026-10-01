import { NextResponse } from "next/server";

import { endIdentitySession, getCurrentIdentity } from "@/lib/currentIdentity";
import { removeUserJiraToken } from "@/lib/userJiraTokens";

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ accountId: string }> },
): Promise<NextResponse> {
  const { accountId } = await params;

  // Self-service only: without this, anyone at the shared dashboard could
  // remove a teammate's registration they have no ownership of. Being
  // identified as `accountId` is itself proof of ownership - that identity
  // comes only from a server-issued session started right after Jira's own
  // /myself verified this account's email + API token (see
  // src/lib/identitySession.ts), not from anything settable client-side.
  const identity = await getCurrentIdentity();

  if (identity?.accountId !== accountId) {
    return NextResponse.json(
      { error: "You can only remove your own registered Jira token." },
      { status: 403 },
    );
  }

  // Removing the token also ends every other browser's session for this
  // account: getCurrentIdentity() re-checks the registry each time, and a
  // later re-registration gets a new registeredAt that no older session
  // matches (see resolveSessionIdentity in src/lib/identitySession.ts).
  await removeUserJiraToken(accountId);
  await endIdentitySession();

  return NextResponse.json({ removed: true });
}
