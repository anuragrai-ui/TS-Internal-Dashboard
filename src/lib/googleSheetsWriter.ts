/**
 * Write access to the "Follow-Up Log" Google Sheet tab - a separate,
 * write-capable counterpart to googleSheetBacklog.ts's read-only public-CSV
 * approach (which has no auth at all and can't write).
 *
 * Deliberately NOT a Google Cloud service account: that requires IAM Admin
 * access to create, which isn't available here. Instead this posts to a
 * Google Apps Script Web App bound to the spreadsheet - something anyone
 * who can already edit the sheet can set up themselves from the Sheets UI
 * (Extensions -> Apps Script -> Deploy as Web App), no Google Cloud Console
 * or service account needed at all. See the "Follow-Up Log (Google Sheet)"
 * README section for the exact Apps Script snippet and deployment steps.
 *
 * Purpose: a durable, human-readable audit trail independent of Redis. The
 * Redis-backed follow-up audit log (src/lib/followupAudit.ts) is capped and
 * TTL'd for memory reasons on a size-limited free tier - it's the
 * operational source of truth for cadence/cooldown logic, but it's expected
 * to age out. Every row logged here survives that.
 */
export interface FollowUpLogRow {
  issueKey: string;
  jiraCommentId: string;
  kind: string;
  postedAt: string;
  postedText: string;
  status: string;
}

export function isGoogleSheetsWriteConfigured(): boolean {
  return Boolean(process.env.GOOGLE_SHEET_WEBHOOK_URL);
}

function toRow(row: FollowUpLogRow): string[] {
  return [row.postedAt, row.issueKey, row.kind, row.status, row.jiraCommentId, row.postedText];
}

/**
 * Appends one or more rows via the Apps Script Web App in one call. Returns
 * false (never throws) on any failure - missing config, a paused/un-
 * redeployed script, a network error - since this is always a secondary,
 * best-effort record next to the Jira comment that already posted
 * successfully; a logging failure must never fail or roll back the actual
 * follow-up send.
 */
export async function appendFollowUpLogRows(rows: FollowUpLogRow[]): Promise<boolean> {
  const webhookUrl = process.env.GOOGLE_SHEET_WEBHOOK_URL;

  if (!webhookUrl || rows.length === 0) {
    return false;
  }

  try {
    const response = await fetch(webhookUrl, {
      body: JSON.stringify({ values: rows.map(toRow) }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
      // Apps Script web apps issue a 302 redirect to the actual execution
      // URL on every call - fetch follows redirects by default, but be
      // explicit since a script deployed with the wrong access level
      // redirects to a Google sign-in page instead, which this would
      // otherwise (wrongly) treat as a successful, empty 200.
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      const body = await response.text();
      console.warn(`Google Sheet webhook append failed (${response.status}): ${body.slice(0, 500)}`);
      return false;
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      // A non-JSON 200 (e.g. Google's own sign-in/consent HTML page) means
      // the deployment access level is wrong, not a real success.
      console.warn("Google Sheet webhook returned a non-JSON response - check the Apps Script deployment's access level (must be \"Anyone\").");
      return false;
    }

    const data = (await response.json()) as { ok?: boolean };
    if (!data.ok) {
      console.warn("Google Sheet webhook responded without ok:true - treating as a failure.", data);
      return false;
    }

    return true;
  } catch (error) {
    console.warn("Failed to log follow-up(s) to the Google Sheet.", error);
    return false;
  }
}

export async function appendFollowUpLogRow(row: FollowUpLogRow): Promise<boolean> {
  return appendFollowUpLogRows([row]);
}
