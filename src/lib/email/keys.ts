/**
 * The key an email case is known by in the action pipeline, the audit log
 * and the URL. Client-safe and pure.
 *
 * A case linked to a TS ticket simply uses the Jira key. One that isn't
 * gets "EM-" plus the first 10 hex digits of its uuid, upper-cased
 * (EM-1A2B3C4D5E): stable for the case's life, short enough to read out,
 * and shaped so it can never be mistaken for a Jira key (the leak check's
 * key pattern needs digits only after the dash). 10 hex digits is 40 bits -
 * a collision among a support inbox's cases is not a practical concern, and
 * the reply path still checks the uuid itself.
 */

export const EMAIL_KEY_PREFIX = "EM-";

/** The action key for a case: its Jira key when linked, else EM-<10 hex>. Pure. */
export function emailCaseKey(caseId: string, jiraKey: string | null): string {
  return jiraKey ?? `${EMAIL_KEY_PREFIX}${caseId.replace(/-/g, "").slice(0, 10).toUpperCase()}`;
}

/** Whether a key is an unlinked email case's key. Pure. */
export function isEmailCaseKey(key: string): boolean {
  return /^EM-[0-9A-F]{10}$/.test(key);
}
