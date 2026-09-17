import Link from "next/link";

import { getCurrentIdentity } from "@/lib/currentIdentity";
import { Icon } from "@/components/Icon";
import { JiraTokenSettings } from "@/components/JiraTokenSettings";
import { listRegisteredJiraUsers } from "@/lib/userJiraTokens";

export const dynamic = "force-dynamic";

export default async function JiraTokenSettingsPage(): Promise<React.ReactElement> {
  const [users, currentIdentity] = await Promise.all([listRegisteredJiraUsers(), getCurrentIdentity()]);

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
            Registering your own Jira API token identifies this browser as you: the Agent Follow-Ups,
            Sheet AI Follow-Ups, SLA Follow-Ups, Closure Candidates, and History tabs then show only
            tickets assigned to you, and anything you send from them posts under your own Jira account
            instead of the shared one. Nobody sees another person's tickets on those tabs. If you've
            already registered, use "Identify as" below to switch which of you a shared browser is
            currently identified as.
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

      <JiraTokenSettings currentIdentity={currentIdentity} users={users} />
    </>
  );
}
