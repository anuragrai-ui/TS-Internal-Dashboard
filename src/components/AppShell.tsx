import { AppShellClient } from "@/components/AppShellClient";
import { getCurrentIdentity } from "@/lib/currentIdentity";

interface AppShellProps {
  children: React.ReactNode;
}

export async function AppShell({ children }: AppShellProps): Promise<React.ReactElement> {
  // Previously this always called the shared-service-account getCurrentUser()
  // here, so the header badge showed the same person (whoever owns the
  // shared Jira token) to every visitor regardless of who was actually
  // browsing. Now it reflects this browser's own identified account (see
  // src/lib/currentIdentity.ts), or null if nobody has identified themselves
  // yet - TopHeader renders a neutral "not identified" state for null rather
  // than falling back to any one person's name.
  const identity = await getCurrentIdentity();
  const userDisplayName = identity?.displayName ?? null;
  const jiraBaseUrl = (process.env.JIRA_BASE_URL ?? "").replace(/\/+$/, "");

  return (
    <AppShellClient jiraBaseUrl={jiraBaseUrl} userDisplayName={userDisplayName}>
      {children}
    </AppShellClient>
  );
}
