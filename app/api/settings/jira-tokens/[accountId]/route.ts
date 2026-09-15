import { NextResponse } from "next/server";

import { removeUserJiraToken } from "@/lib/userJiraTokens";

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ accountId: string }> },
): Promise<NextResponse> {
  const { accountId } = await params;

  await removeUserJiraToken(accountId);

  return NextResponse.json({ removed: true });
}
