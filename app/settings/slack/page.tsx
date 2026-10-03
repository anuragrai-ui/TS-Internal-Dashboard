import Link from "next/link";

import { Icon } from "@/components/Icon";
import { IdentityRequired } from "@/components/IdentityRequired";
import { SlackHistoryProbe } from "@/components/SlackHistoryProbe";
import { SlackTestPanel } from "@/components/SlackTestPanel";
import { getCurrentIdentity } from "@/lib/currentIdentity";
import { checkSlackConnection } from "@/lib/slackConnect";
import { getRecentInboundSlackEvents } from "@/lib/slackInboundLog";
import { getSlackTestChannel } from "@/lib/slackTestMode";
import { getSlackBackfillStatus } from "@/lib/tracker/slackBackfill";

import type { SlackBackfillChannelState } from "@/lib/tracker/slackBackfill";

export const dynamic = "force-dynamic";

/* The permissions the dashboard actually relies on, and what each is for. */
const NEEDED_SCOPES: Array<{ scope: string; why: string }> = [
  { scope: "chat:write", why: "post alerts and escalation threads" },
  { scope: "chat:write.public", why: "post in public pod channels without an invite" },
  { scope: "channels:read", why: "check public channel access; list the channels the tracker reads" },
  { scope: "channels:history", why: "recover threads after a failure; show ticket conversations in the tracker (public)" },
  { scope: "groups:history", why: "recover threads after a failure; show ticket conversations in the tracker (private)" },
  { scope: "reactions:read", why: "acknowledge escalations with a ✅ reaction" },
  { scope: "users:read", why: "look up people for @-mentions" },
  { scope: "users:read.email", why: "match people by email (optional)" },
  { scope: "groups:read", why: "check private channel access (optional)" },
];

function formatTime(iso: string): string {
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed)
    ? iso
    : new Date(parsed).toLocaleString("en-US", { day: "numeric", hour: "numeric", minute: "2-digit", month: "short", timeZone: "America/New_York" }) + " ET";
}

function backfillProgress(channel: SlackBackfillChannelState): React.ReactElement {
  if (channel.error && channel.done) {
    return <span className="status-badge tone-danger">Skipped ({channel.error})</span>;
  }
  if (channel.done) {
    return <span className="status-badge tone-success">Caught up</span>;
  }
  if (channel.error) {
    return <span className="status-badge tone-warning">Retrying ({channel.error})</span>;
  }
  return <span className="status-badge tone-accent">{channel.cursor ? "In progress" : "Queued"}</span>;
}

export default async function SlackSettingsPage(): Promise<React.ReactElement> {
  const identity = await getCurrentIdentity();
  const testChannel = getSlackTestChannel();
  const [report, events, backfill] = identity
    ? await Promise.all([checkSlackConnection(), getRecentInboundSlackEvents(), getSlackBackfillStatus()])
    : [null, [], null];
  const granted = new Set(report?.scopes ?? []);

  return (
    <>
      <Link className="back-link" href="/">
        <Icon name="chevron-left" size={14} />
        Back to dashboard
      </Link>

      <div className="page-header-row">
        <div className="page-title-group">
          <h1 className="page-title">Slack</h1>
          <p className="page-subtitle">
            The dashboard posts to Slack through the Vercel Connect connector <code>{report?.connector ?? "slack/ts-internal-dashboard"}</code>{" "}
            - no Slack secret is stored here. Everything on this page is read-only except the test button, which can only post to the test
            channel.
          </p>
        </div>
      </div>

      {!identity ? (
        <IdentityRequired itemsLabel="Slack connection status" />
      ) : (
        <>
          <div className="followup-panel">
            {testChannel ? (
              <span className="page-subtitle" style={{ color: "var(--warning)", fontWeight: 600 }}>
                Test mode is ON: every Slack message the app sends goes to the test channel ({testChannel}) with @-mentions suppressed. Remove
                SLACK_TEST_CHANNEL in Vercel and redeploy to post to real pod channels.
              </span>
            ) : (
              <span className="page-subtitle" style={{ fontWeight: 600 }}>
                Test mode is OFF: messages go to the real pod channels. Set SLACK_TEST_CHANNEL in Vercel to test safely.
              </span>
            )}
          </div>

          <div className="page-title-group">
            <h2 className="page-title" style={{ fontSize: "1.05rem" }}>
              Connection
            </h2>
          </div>
          {report?.ok ? (
            <div className="followup-panel">
              <span className="page-subtitle">
                <span className="status-badge tone-success">Connected</span> as <strong>{report.botRealName || report.appName || report.user}</strong>{" "}
                in the <strong>{report.team}</strong> workspace. To add it to a channel, type <code>/invite @{report.botRealName || report.appName}</code> there.
              </span>
            </div>
          ) : (
            <div className="empty-state">
              <span className="status-badge tone-danger">Not connected</span> {report?.error}
            </div>
          )}

          <div className="table-scroll">
            <table className="data-table">
              <caption className="visually-hidden">Slack permissions</caption>
              <thead>
                <tr>
                  <th scope="col">Permission</th>
                  <th scope="col">Used for</th>
                  <th scope="col">Granted</th>
                </tr>
              </thead>
              <tbody>
                {NEEDED_SCOPES.map(({ scope, why }) => (
                  <tr key={scope}>
                    <td>
                      <code>{scope}</code>
                    </td>
                    <td className="cell-muted">{why}</td>
                    <td>
                      {granted.has(scope) ? (
                        <span className="status-badge tone-success">Yes</span>
                      ) : (
                        <span className="status-badge tone-warning">No</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="page-title-group">
            <h2 className="page-title" style={{ fontSize: "1.05rem" }}>
              Channels
            </h2>
          </div>
          <div className="table-scroll">
            <table className="data-table">
              <caption className="visually-hidden">Slack channels the dashboard posts to</caption>
              <thead>
                <tr>
                  <th scope="col">Channel</th>
                  <th scope="col">Used by</th>
                  <th scope="col">Bot access</th>
                </tr>
              </thead>
              <tbody>
                {(report?.channels ?? []).map((channel) => (
                  <tr key={channel.channelId}>
                    <td>
                      {channel.name ? `#${channel.name}` : channel.channelId}
                      <span className="cell-sub"> {channel.isPrivate ? "private" : channel.name ? "public" : ""}</span>
                    </td>
                    <td className="cell-muted">{channel.usedBy.join(", ")}</td>
                    <td>
                      {channel.error === "missing_scope" ? (
                        <span className="status-badge tone-accent">Can&apos;t check (private) - invite the bot, then try the test button</span>
                      ) : channel.error ? (
                        <span className="status-badge tone-danger">No access ({channel.error}) - invite the bot</span>
                      ) : channel.isMember ? (
                        <span className="status-badge tone-success">Member</span>
                      ) : (
                        <span className="status-badge tone-warning">Can post, not a member (invite to receive reactions)</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="page-title-group">
            <h2 className="page-title" style={{ fontSize: "1.05rem" }}>
              Test
            </h2>
            <p className="page-subtitle">
              Sends one message to the test channel. React to it in Slack, then refresh to see the reaction arrive below - the same path the
              escalation pilot uses for ✅ acknowledgements.
            </p>
          </div>
          <SlackTestPanel testChannel={testChannel} />

          <div className="page-title-group">
            <h2 className="page-title" style={{ fontSize: "1.05rem" }}>
              Ticket conversations (escalation tracker)
            </h2>
            <p className="page-subtitle">
              The tracker links Slack threads to tickets from live messages and from a slow walk of the last 30 days of history in every
              channel the bot is in - one page about every 70 seconds, pausing whenever Slack asks it to. Only pointers and counts are kept;
              a thread&apos;s messages are read live when someone opens it. The walk finds threads whose first message names a ticket; one that only names it in a reply shows up once someone replies, or when its link is pasted into a Jira comment or the tracker.
              {backfill?.backoffUntil && Date.parse(backfill.backoffUntil) > Date.now() ? ` Slack asked to slow down until ${formatTime(backfill.backoffUntil)}.` : ""}
              {backfill?.lastTickAt ? ` Last step ${formatTime(backfill.lastTickAt)}.` : ""}
            </p>
          </div>
          <SlackHistoryProbe />
          {!backfill || backfill.channels.length === 0 ? (
            <div className="empty-state">No history walked yet - it starts with the tracker&apos;s next refresh.</div>
          ) : (
            <div className="table-scroll">
              <table className="data-table">
                <caption className="visually-hidden">Slack history backfill progress per channel</caption>
                <thead>
                  <tr>
                    <th scope="col">Channel</th>
                    <th scope="col">Progress</th>
                    <th scope="col">Messages read</th>
                    <th scope="col">Conversations linked</th>
                    <th scope="col">Last page</th>
                    <th scope="col">Last read</th>
                  </tr>
                </thead>
                <tbody>
                  {backfill.channels.map((channel) => (
                    <tr key={channel.channel}>
                      <td>
                        {channel.name ? `#${channel.name}` : channel.channel}
                        {channel.passes > 0 ? <span className="cell-sub"> {channel.passes} pass{channel.passes === 1 ? "" : "es"}</span> : null}
                      </td>
                      <td>{backfillProgress(channel)}</td>
                      <td className="cell-muted">{channel.messagesScanned}</td>
                      <td className="cell-muted">{channel.conversationsLinked}</td>
                      <td className="cell-muted">{channel.lastPageSize ?? "—"}</td>
                      <td className="cell-muted">{channel.lastScannedAt ? formatTime(channel.lastScannedAt) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="page-title-group">
            <h2 className="page-title" style={{ fontSize: "1.05rem" }}>
              Recent events received
            </h2>
          </div>
          {events.length === 0 ? (
            <div className="empty-state">Nothing received yet. Invite the bot to a channel and add a reaction to one of its messages.</div>
          ) : (
            <div className="table-scroll">
              <table className="data-table">
                <caption className="visually-hidden">Recent inbound Slack events</caption>
                <thead>
                  <tr>
                    <th scope="col">When</th>
                    <th scope="col">Event</th>
                    <th scope="col">Channel</th>
                    <th scope="col">Verified via</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((event, index) => (
                    <tr key={`${event.at}-${index}`}>
                      <td className="cell-muted">{formatTime(event.at)}</td>
                      <td>
                        {event.eventType ?? event.payloadType}
                        {event.reaction ? <span className="cell-sub"> :{event.reaction}:</span> : null}
                      </td>
                      <td className="cell-muted">{event.channel ?? "—"}</td>
                      <td className="cell-muted">{event.via === "vercel_connect" ? "Vercel Connect" : "Slack signature"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </>
  );
}
