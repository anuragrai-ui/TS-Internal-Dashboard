import { NextResponse } from "next/server";

import { rejectCrossOrigin } from "@/lib/actions/sameOrigin";
import { executeAction, listTicketActions } from "@/lib/actions/service";
import { TICKET_KEY_PATTERN } from "@/lib/actions/validate";
import { requireIdentity } from "@/lib/currentIdentity";

import type { ExecuteActionRequest, ExecuteActionResponse, TicketActionsResponse } from "@/lib/workspace/types";

export const dynamic = "force-dynamic";
/* A transition is two Jira calls after the version check; a Slack post is a membership check, the post and a permalink. */
export const maxDuration = 120;

const NO_STORE = { "Cache-Control": "no-store" };

/* GET /api/actions?ticket=TS-123 -> TicketActionsResponse: the ticket's proposals (pending first) and its last 20 actions. */
export async function GET(request: Request): Promise<NextResponse> {
  const auth = await requireIdentity();
  if (auth.response) {
    return auth.response;
  }

  const ticketKey = (new URL(request.url).searchParams.get("ticket") ?? "").trim().toUpperCase();
  if (!TICKET_KEY_PATTERN.test(ticketKey)) {
    return NextResponse.json({ error: "Expected ?ticket=TS-123." }, { headers: NO_STORE, status: 400 });
  }

  const response: TicketActionsResponse = await listTicketActions(ticketKey);
  return NextResponse.json(response, { headers: NO_STORE });
}

/* POST ExecuteActionRequest -> ExecuteActionResponse. The person's own click is the approval; the outcome
   (succeeded / failed / uncertain / conflict / duplicate) is in execution.status with a 200. */
export async function POST(request: Request): Promise<NextResponse> {
  const auth = await requireIdentity();
  if (auth.response) {
    return auth.response;
  }
  const crossOrigin = rejectCrossOrigin(request);
  if (crossOrigin) {
    return crossOrigin;
  }

  let body: Partial<ExecuteActionRequest> | null;
  try {
    body = (await request.json()) as Partial<ExecuteActionRequest> | null;
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { headers: NO_STORE, status: 400 });
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Expected { ticketKey, args, idempotencyKey, expectedVersion?, force? }." }, { headers: NO_STORE, status: 400 });
  }

  /* Only the request's own fields: a browser can't attach a proposalId and pass its click off as an approval. */
  const result = await executeAction(
    {
      args: body.args as ExecuteActionRequest["args"],
      expectedVersion: body.expectedVersion,
      force: body.force === true,
      idempotencyKey: body.idempotencyKey as string,
      ticketKey: body.ticketKey as string,
    },
    { accountId: auth.identity.accountId, displayName: auth.identity.displayName },
  );
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { headers: NO_STORE, status: result.status });
  }

  const response: ExecuteActionResponse = { execution: result.execution };
  return NextResponse.json(response, { headers: NO_STORE });
}
