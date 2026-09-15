export interface LeakCheckResult {
  safe: boolean;
  violations: string[];
}

/* Generic Jira key pattern, not just CP-\d+: agentic tool-calling
   (src/lib/agentTools.ts's search_jira_issues) runs unscoped JQL across the
   whole Jira instance, so a model could surface a key from any project, not
   only CP. Matches the ticket-key extraction already used in
   app/api/slack/events/route.ts, generalized from TS|CP to any project. */
const JIRA_KEY_PATTERN = /\b[A-Z][A-Z0-9]{1,9}-\d{1,6}\b/g;
const WIKI_URL_PATTERN = /atlassian\.net\/wiki|\/wiki\//i;

/**
 * Checks a draft that's about to go to an external (client) reporter for
 * internal-only content that must never leak: any Jira ticket key other than
 * the ticket's own, and any Confluence/wiki link. Deliberately returns a
 * verdict rather than an edited string - see callers (draftViaChain,
 * app/api/tickets/[key]/followup/send/route.ts) for why: a violation is
 * treated exactly like an empty/failed model response (reject, fall through
 * to the next model or a template) rather than silently stripped, since a
 * scrubbed sentence can read as broken or misleading and nobody would know
 * to check it.
 */
export function checkExternalMessageSafety(text: string, ownIssueKey: string): LeakCheckResult {
  const violations: string[] = [];

  const keyMatches = text.match(JIRA_KEY_PATTERN) ?? [];
  const foreignKeys = [
    ...new Set(keyMatches.filter((key) => key.toUpperCase() !== ownIssueKey.toUpperCase())),
  ];

  if (foreignKeys.length > 0) {
    violations.push(`References other Jira ticket(s): ${foreignKeys.join(", ")}`);
  }

  if (WIKI_URL_PATTERN.test(text)) {
    violations.push("References an internal Confluence/wiki link");
  }

  return { safe: violations.length === 0, violations };
}
