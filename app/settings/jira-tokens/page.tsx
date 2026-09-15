import Link from "next/link";

import { Icon } from "@/components/Icon";
import { JiraTokenSettings } from "@/components/JiraTokenSettings";
import { listRegisteredJiraUsers } from "@/lib/userJiraTokens";

export const dynamic = "force-dynamic";

export default async function JiraTokenSettingsPage(): Promise<React.ReactElement> {
  const users = await listRegisteredJiraUsers();

  return (
    <>
      <Link className="back-link" href="/">
        <Icon name="chevron-left" size={14} />
        Back to dashboard
      </Link>

      <div className="page-header-row">
        <div className="page-title-group">
          <h1 className="page-title">Jira Tokens</h1>
          <p className="page-subtitle">
            Register your own Jira API token so follow-ups on tickets assigned to you post under your own
            Jira identity instead of the shared account. Routing is by ticket assignee, not by who clicks
            Send - once registered, any follow-up sent to one of your tickets from anywhere in this
            dashboard uses your token automatically. Tickets belonging to anyone who hasn't registered
            still use the shared account, exactly as before.
          </p>
          <p className="page-subtitle">
            To create a token: log in to{" "}
            <a
              href="https://id.atlassian.com/manage-profile/security/api-tokens"
              rel="noreferrer"
              target="_blank"
            >
              id.atlassian.com/manage-profile/security/api-tokens
            </a>{" "}
            → "Create API token with scopes" → give it a name and an expiration (1-365 days) → select
            Jira as the app → grant scopes covering: reading and writing issues/comments (this app posts
            follow-up comments and transitions tickets to Done), and reading your own Jira profile (used
            once, at registration, to verify the token and look up your account - Atlassian's token
            creation screen will show the exact current scope names, e.g. something like{" "}
            <code>read:jira-work</code>, <code>write:jira-work</code>) → Create → Copy to clipboard, then
            paste it below. Your token is encrypted before it's stored and is never shown again after
            registration.
          </p>
        </div>
      </div>

      <JiraTokenSettings users={users} />
    </>
  );
}
