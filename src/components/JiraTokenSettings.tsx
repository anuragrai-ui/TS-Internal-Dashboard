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

interface IdentityResponseBody {
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
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [switchError, setSwitchError] = useState("");

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

  const handleIdentifyAs = async (accountId: string): Promise<void> => {
    setSwitchingId(accountId);
    setSwitchError("");

    try {
      const response = await fetch("/api/settings/identity", {
        body: JSON.stringify({ accountId }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const body = (await response.json()) as IdentityResponseBody;

      if (!response.ok || !body.user) {
        setSwitchError(body.error ?? "Failed to switch identity.");
        return;
      }

      router.refresh();
    } catch {
      setSwitchError("Failed to switch identity.");
    } finally {
      setSwitchingId(null);
    }
  };

  const handleForgetIdentity = async (): Promise<void> => {
    setSwitchingId("__clear__");

    try {
      await fetch("/api/settings/identity", { method: "DELETE" });
      router.refresh();
    } finally {
      setSwitchingId(null);
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
              disabled={switchingId === "__clear__"}
              onClick={() => void handleForgetIdentity()}
              type="button"
            >
              {switchingId === "__clear__" ? "Clearing…" : "Not you? Forget this identity"}
            </button>
          </div>
        </div>
      ) : (
        <div className="empty-state">
          This browser isn't identified as anyone yet - register your token below, or pick yourself from
          the list if you've already registered.
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

      {switchError ? <span className="followup-status followup-status-error">{switchError}</span> : null}

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
                    <td style={{ display: "flex", gap: "var(--space-2)" }}>
                      {!isCurrent ? (
                        <button
                          className="followup-button"
                          disabled={switchingId === user.accountId}
                          onClick={() => void handleIdentifyAs(user.accountId)}
                          type="button"
                        >
                          {switchingId === user.accountId ? "Switching…" : "Identify as"}
                        </button>
                      ) : null}
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
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
