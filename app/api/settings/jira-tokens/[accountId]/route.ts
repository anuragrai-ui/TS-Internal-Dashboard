import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { IDENTITY_COOKIE } from "@/lib/currentIdentity";
import { removeUserJiraToken } from "@/lib/userJiraTokens";

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ accountId: string }> },
): Promise<NextResponse> {
  const { accountId } = await params;

  await removeUserJiraToken(accountId);

  // A removed account can't stay "browsing as" itself - without this, the
  // cookie would keep pointing at a deleted record until getCurrentIdentity's
  // registry lookup fails it anyway, but clearing it now avoids a stale
  // cookie lingering client-side for no reason.
  const store = await cookies();
  if (store.get(IDENTITY_COOKIE)?.value === accountId) {
    store.delete(IDENTITY_COOKIE);
  }

  return NextResponse.json({ removed: true });
}
