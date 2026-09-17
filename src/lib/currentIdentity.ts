import { cookies } from "next/headers";

import { getRegisteredJiraUser } from "@/lib/userJiraTokens";

import type { RegisteredJiraUser } from "@/lib/userJiraTokens";

/**
 * The only "who is browsing" concept in this app - there is no real
 * login/session system. Registering a personal Jira token (see
 * userJiraTokens.ts) proves you control that account, so the registration
 * response also sets this cookie; from then on this browser is treated as
 * that person everywhere identity matters (the header badge, which tickets
 * the Operations tabs show, and whose token a Send uses).
 */
export const IDENTITY_COOKIE = "ts_identity_account_id";

/**
 * Resolves the cookie against the live registry rather than trusting its
 * value alone, so a removed or re-registered account can't stay "identified"
 * with stale data - a cookie pointing at a since-removed account (or set
 * before Redis/encryption were configured) is treated the same as no cookie
 * at all: not identified.
 */
export async function getCurrentIdentity(): Promise<RegisteredJiraUser | null> {
  const store = await cookies();
  const accountId = store.get(IDENTITY_COOKIE)?.value;
  return getRegisteredJiraUser(accountId);
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
