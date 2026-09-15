"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import type { RegisteredJiraUser } from "@/lib/userJiraTokens";

interface JiraTokenSettingsProps {
  users: RegisteredJiraUser[];
}

interface RegisterResponseBody {
  error?: string;
  user?: RegisteredJiraUser;
}

export function JiraTokenSettings({ users }: JiraTokenSettingsProps): React.ReactElement {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [apiToken, setApiToken] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [successMessage, setSuccessMessage] = useState("");
  const [removingId, setRemovingId] = useState<string | null>(null);

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

  const handleRemove = async (accountId: string): Promise<void> => {
    setRemovingId(accountId);

    try {
      await fetch(`/api/settings/jira-tokens/${accountId}`, { method: "DELETE" });
      router.refresh();
    } finally {
      setRemovingId(null);
    }
  };

  return (
    <>
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
              {users.map((user) => (
                <tr key={user.accountId}>
                  <td>{user.displayName}</td>
                  <td className="cell-muted">{user.email}</td>
                  <td className="cell-muted">{new Date(user.registeredAt).toLocaleDateString()}</td>
                  <td>
                    <button
                      className="followup-button"
                      disabled={removingId === user.accountId}
                      onClick={() => void handleRemove(user.accountId)}
                      type="button"
                    >
                      {removingId === user.accountId ? "Removing…" : "Remove"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
