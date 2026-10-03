import type { GooglePurpose } from "@/lib/workspace/types";

/**
 * What the Google sign-in can say to a person, keyed by short codes. The
 * callback redirects back with `?google_error=<code>` rather than a sentence,
 * so nothing personal (an email address, Google's own error text) ever sits
 * in a URL, a browser history entry or a Referer header. Client-safe.
 */

export type GoogleConnectErrorCode =
  | "access_denied"
  | "bad_id_token"
  | "bad_purpose"
  | "bad_state"
  | "expired_state"
  | "missing_scopes"
  | "no_refresh_token"
  | "storage"
  | "token_exchange"
  | "unconfigured"
  | "unverified_email"
  | "wrong_domain"
  | "wrong_mailbox"
  | "wrong_user";

export const GOOGLE_CONNECT_ERRORS: Record<GoogleConnectErrorCode, string> = {
  access_denied: "Google sign-in was cancelled - nothing was connected.",
  bad_id_token: "Google's answer couldn't be verified - nothing was connected. Try again.",
  bad_purpose: "Unknown connection type - use the Connect button on the page.",
  bad_state: "That sign-in link was already used or isn't from this dashboard - start again with the Connect button.",
  expired_state: "The sign-in took longer than 10 minutes - start again with the Connect button.",
  missing_scopes: "Some permissions were left unticked on Google's consent screen - connect again and allow all of them.",
  no_refresh_token: "Google didn't hand out a long-lived sign-in - connect again (the consent screen must be shown).",
  storage: "The sign-in worked but couldn't be saved (Redis or TOKEN_ENCRYPTION_KEY) - check the server configuration and try again.",
  token_exchange: "Google refused to finish the sign-in - try again in a moment.",
  unconfigured: "Google sign-in isn't set up on the server yet (GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET).",
  unverified_email: "That Google account's email isn't verified - use a certifyos.com Workspace account.",
  wrong_domain: "Only certifyos.com Google Workspace accounts can be connected.",
  wrong_mailbox: "Sign in as the support mailbox itself (SUPPORT_MAILBOX_ADDRESS), not your own account.",
  wrong_user: "The sign-in was started by a different dashboard user - start again from this browser.",
};

/** The page each connection is managed from (and the callback returns to). Pure. */
export function googleReturnPath(purpose: GooglePurpose): string {
  return purpose === "calendar" ? "/oncall" : "/inbox";
}

/** The sentence for a `?google_error=` code, or null for anything unknown. Pure. */
export function googleConnectErrorMessage(code: string | null | undefined): string | null {
  return code && Object.hasOwn(GOOGLE_CONNECT_ERRORS, code) ? GOOGLE_CONNECT_ERRORS[code as GoogleConnectErrorCode] : null;
}

/** What to do when a purpose isn't connected - the text the calendar and the inbox show. Pure. */
export function connectHint(purpose: GooglePurpose): string {
  return purpose === "calendar" ? "Connect Google Calendar on /oncall." : "Connect the support mailbox on /inbox.";
}
