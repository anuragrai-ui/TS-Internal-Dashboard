import { AppShellClient } from "@/components/AppShellClient";
import { getCurrentUser } from "@/lib/jiraClient";

interface AppShellProps {
  children: React.ReactNode;
}

async function resolveUserDisplayName(): Promise<string> {
  try {
    const user = await getCurrentUser();
    return user.display_name ?? "Support Team";
  } catch (error) {
    console.warn("Failed to resolve the current Jira user for the app shell.", error);
    return "Support Team";
  }
}

export async function AppShell({ children }: AppShellProps): Promise<React.ReactElement> {
  const userDisplayName = await resolveUserDisplayName();
  const jiraBaseUrl = (process.env.JIRA_BASE_URL ?? "").replace(/\/+$/, "");

  return (
    <AppShellClient jiraBaseUrl={jiraBaseUrl} userDisplayName={userDisplayName}>
      {children}
    </AppShellClient>
  );
}
