import { verifyVercelOidcToken } from "@vercel/oidc";

import { verifySlackSignature } from "@/lib/slackSignature";

/**
 * Decides whether an inbound request to /api/slack/events really came from
 * Slack. Two legitimate shapes:
 *
 * 1. Forwarded by a Vercel Connect trigger. Connect already verified Slack's
 *    own signature at its intake, then forwards the event with a Vercel OIDC
 *    bearer token instead. We verify that token: issued by
 *    https://oidc.vercel.com, for THIS project and THIS environment (the
 *    @vercel/oidc defaults read VERCEL_PROJECT_ID and VERCEL_TARGET_ENV /
 *    VERCEL_ENV and fail closed if they're missing).
 * 2. Sent by Slack directly (a classic Slack app pointed at this URL): the
 *    x-slack-signature HMAC with SLACK_SIGNING_SECRET.
 *
 * Anything else is rejected. A request that carries a bearer token is only
 * ever judged on that token - it can't fall back to the signature path.
 */
export type SlackRequestAuthResult =
  | { ok: true; via: "slack_signature" | "vercel_connect" }
  | { ok: false; reason: string; status: 401 | 503 };

export interface SlackRequestAuthInput {
  authorization: string | null;
  rawBody: string;
  signature: string | null;
  timestamp: string | null;
}

export interface SlackRequestAuthDeps {
  signingSecret?: string;
  verifyOidcToken?: (token: string) => Promise<unknown>;
}

const BEARER = /^Bearer\s+(\S+)$/i;

export async function authenticateSlackRequest(
  input: SlackRequestAuthInput,
  deps: SlackRequestAuthDeps = { signingSecret: process.env.SLACK_SIGNING_SECRET },
): Promise<SlackRequestAuthResult> {
  const verifyOidcToken = deps.verifyOidcToken ?? ((token: string) => verifyVercelOidcToken(token));
  const authorization = input.authorization?.trim() ?? "";

  if (authorization) {
    const token = BEARER.exec(authorization)?.[1];
    if (!token) {
      return { ok: false, reason: "Malformed Authorization header.", status: 401 };
    }
    try {
      await verifyOidcToken(token);
      return { ok: true, via: "vercel_connect" };
    } catch (error) {
      console.warn("Rejected a Slack request with an invalid Vercel OIDC token.", error instanceof Error ? error.message : error);
      return { ok: false, reason: "Invalid Vercel Connect token.", status: 401 };
    }
  }

  if (!deps.signingSecret) {
    return { ok: false, reason: "Direct Slack requests are not configured on this server (no signing secret).", status: 503 };
  }

  const verified = verifySlackSignature({
    rawBody: input.rawBody,
    signature: input.signature ?? "",
    signingSecret: deps.signingSecret,
    timestamp: input.timestamp ?? "",
  });

  return verified ? { ok: true, via: "slack_signature" } : { ok: false, reason: "Invalid Slack signature.", status: 401 };
}
