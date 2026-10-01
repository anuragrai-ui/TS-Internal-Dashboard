import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import {
  createIdentitySession,
  LEGACY_IDENTITY_COOKIE,
  resolveSessionIdentity,
  revokeIdentitySession,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
} from "@/lib/identitySession";
import { getRegisteredJiraUser } from "@/lib/userJiraTokens";

import type { RegisteredJiraUser } from "@/lib/userJiraTokens";

/**
 * The only "who is browsing" concept in this app - there is no real
 * login/session system beyond this. Registering a personal Jira token (see
 * userJiraTokens.ts) proves you control that account, so the registration
 * response starts a server-side session for it (src/lib/identitySession.ts)
 * and sets its random id as a cookie; from then on this browser is treated
 * as that person everywhere identity matters (the header badge, which
 * tickets the Operations tabs show, and whose token a Send uses).
 *
 * The cookie is an unguessable session id, never the accountId itself - see
 * identitySession.ts for why the old raw-accountId cookie was forgeable.
 */
export async function getCurrentIdentity(): Promise<RegisteredJiraUser | null> {
  const store = await cookies();

  // Re-checked against the live registry every time, and the session must
  // belong to the account's current registration - see
  // resolveSessionIdentity for how removal and re-registration end every
  // other browser's session, not just this one.
  return resolveSessionIdentity(store.get(SESSION_COOKIE)?.value, getRegisteredJiraUser);
}

/**
 * For route handlers that act on someone's behalf or reveal ticket data
 * (sends, drafts, candidate lists): returns the identity, or a ready-made
 * 401 response to return as-is. The pages already show these tabs only to
 * an identified browser - this closes the same door on the API routes
 * behind them, which used to accept anyone.
 */
export async function requireIdentity(): Promise<
  { identity: RegisteredJiraUser; response?: undefined } | { identity?: undefined; response: NextResponse }
> {
  const identity = await getCurrentIdentity();

  if (!identity) {
    return {
      response: NextResponse.json(
        { error: "Identify yourself first: register your own Jira API token on the Jira Tokens page." },
        { status: 401 },
      ),
    };
  }

  return { identity };
}

/** Starts a session for an account whose Jira token was just verified, and sets the cookie on `response`. */
export async function startIdentitySession(response: NextResponse, user: RegisteredJiraUser): Promise<boolean> {
  const sessionId = await createIdentitySession(user);

  if (!sessionId) {
    return false;
  }

  response.cookies.set(SESSION_COOKIE, sessionId, {
    httpOnly: true,
    maxAge: SESSION_TTL_SECONDS,
    path: "/",
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });
  response.cookies.delete(LEGACY_IDENTITY_COOKIE);
  return true;
}

/** Revokes this browser's session server-side and clears its cookies (route handlers only). */
export async function endIdentitySession(): Promise<void> {
  const store = await cookies();
  await revokeIdentitySession(store.get(SESSION_COOKIE)?.value);
  store.delete(SESSION_COOKIE);
  store.delete(LEGACY_IDENTITY_COOKIE);
}

/**
 * Sheet-sourced data (Sheet AI Follow-Ups, History - see googleSheetBacklog.ts)
 * has no Jira accountId at all, just a plain "Assignee" string typed into the
 * sheet, so it can't be filtered by accountId like the other three
 * Operations tabs. This falls back to a case-insensitive match against the
 * identified person's Jira display name - a known soft spot (a sheet
 * assignee cell that's a nickname, typo, or otherwise doesn't match the
 * Jira display name exactly just won't match), not fixable without changing
 * what the sheet stores.
 */
export function assigneeMatchesIdentity(assignee: string, identity: RegisteredJiraUser): boolean {
  return assignee.trim().toLowerCase() === identity.displayName.trim().toLowerCase();
}
