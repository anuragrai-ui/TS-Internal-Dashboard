"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import type { RegisteredJiraUser } from "@/lib/userJiraTokens";

interface JiraTokenSettingsProps {
  currentIdentity: RegisteredJiraUser | null;
  users: RegisteredJiraUser[];
}

interface RegisterResponseBody {
  error?: string;
  user?: RegisteredJiraUser;
}

export function JiraTokenSettings({ currentIdentity, users }: JiraTokenSettingsProps): React.ReactElement {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [apiToken, setApiToken] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [successMessage, setSuccessMessage] = useState("");
  const [removing, setRemoving] = useState(false);
  const [clearing, setClearing] = useState(false);

  const handleSubmit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    setSuccessMessage("");

    try {
      const response = await fetch("/api/settings/jira-tokens", {
        body: JSON.stringify({ apiToken, email }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const body = (await response.json()) as RegisterResponseBody;

      if (!response.ok || !body.user) {
        setError(body.error ?? "Failed to register this token.");
        return;
      }

      setSuccessMessage(`Registered as ${body.user.displayName}. Follow-ups on their tickets will now post under this identity.`);
      setEmail("");
      setApiToken("");
      router.refresh();
    } catch {
      setError("Failed to register this token.");
    } finally {
      setSubmitting(false);
    }
  };

  // Removal is server-enforced to your own registered account (see
  // app/api/settings/jira-tokens/[accountId]/route.ts) - the button is only
  // rendered for that one row (isCurrent below) so this never even attempts
  // a call the server would reject.
  const handleRemove = async (accountId: string): Promise<void> => {
    setRemoving(true);

    try {
      await fetch(`/api/settings/jira-tokens/${accountId}`, { method: "DELETE" });
      router.refresh();
    } finally {
      setRemoving(false);
    }
  };

  const handleForgetIdentity = async (): Promise<void> => {
    setClearing(true);

    try {
      await fetch("/api/settings/identity", { method: "DELETE" });
      router.refresh();
    } finally {
      setClearing(false);
    }
  };

  return (
    <>
      {currentIdentity ? (
        <div className="followup-panel">
          <span className="page-subtitle">
            This browser is identified as <strong>{currentIdentity.displayName}</strong>. The Operations
            tabs show only their tickets, and Send posts under their Jira account.
          </span>
          <div className="followup-panel-actions">
            <button
              className="followup-button"
              disabled={clearing}
              onClick={() => void handleForgetIdentity()}
              type="button"
            >
              {clearing ? "Clearing…" : "Not you? Forget this identity"}
            </button>
          </div>
        </div>
      ) : (
        <div className="empty-state">
          This browser isn't identified as anyone yet - register your own token below to identify it as
          you.
        </div>
      )}

      <form className="followup-panel" onSubmit={(event) => void handleSubmit(event)}>
        <label className="page-subtitle" htmlFor="jira-token-email">
          Jira account email
        </label>
        <input
          className="followup-textarea"
          disabled={submitting}
          id="jira-token-email"
          onChange={(event) => setEmail(event.target.value)}
          placeholder="you@certifyos.com"
          required
          style={{ minHeight: "auto" }}
          type="email"
          value={email}
        />
        <label className="page-subtitle" htmlFor="jira-token-value">
          API token (with scopes)
        </label>
        <input
          className="followup-textarea"
          disabled={submitting}
          id="jira-token-value"
          onChange={(event) => setApiToken(event.target.value)}
          placeholder="Paste the token here - it's encrypted before storage"
          required
          style={{ minHeight: "auto" }}
          type="password"
          value={apiToken}
        />
        <div className="followup-panel-actions">
          <button className="followup-button followup-button-primary" disabled={submitting} type="submit">
            {submitting ? "Verifying…" : "Register my token"}
          </button>
        </div>
        {error ? <span className="followup-status followup-status-error">{error}</span> : null}
        {successMessage ? <span className="followup-status followup-status-success">{successMessage}</span> : null}
      </form>

      {users.length === 0 ? (
        <div className="empty-state">No team members have registered a personal Jira token yet.</div>
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <caption className="visually-hidden">Registered Jira tokens</caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Email</th>
                <th scope="col">Registered</th>
                <th scope="col">Action</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => {
                const isCurrent = currentIdentity?.accountId === user.accountId;
                return (
                  <tr key={user.accountId}>
                    <td>
                      {user.displayName}
                      {isCurrent ? <span className="cell-sub"> (you)</span> : null}
                    </td>
                    <td className="cell-muted">{user.email}</td>
                    <td className="cell-muted">{new Date(user.registeredAt).toLocaleDateString()}</td>
                    <td>
                      {isCurrent ? (
                        <button
                          className="followup-button"
                          disabled={removing}
                          onClick={() => void handleRemove(user.accountId)}
                          type="button"
                        >
                          {removing ? "Removing…" : "Remove"}
                        </button>
                      ) : (
                        <span className="cell-muted">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
