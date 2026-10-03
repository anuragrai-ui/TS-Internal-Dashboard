import Link from "next/link";

import { EscalationControls } from "@/components/EscalationControls";
import { Icon } from "@/components/Icon";
import { IdentityRequired } from "@/components/IdentityRequired";
import { getCurrentIdentity } from "@/lib/currentIdentity";
import { DEFAULT_ESCALATION_POLICY, POD_OPTIONS, PILOT_POD_OPTION_ID } from "@/lib/escalation/policy";
import { getLastRun, getRunnerConfig, getShadowChannel, loadRecords } from "@/lib/escalation/runnerStore";
import { isLiveState } from "@/lib/escalation/stateMachine";

import type { EscalationRecord } from "@/lib/escalation/runnerStore";
import type { Priority } from "@/lib/escalation/types";

export const dynamic = "force-dynamic";

const PRIORITIES: Priority[] = ["Critical", "High", "Medium", "Low"];

const STATE_LABEL: Record<EscalationRecord["state"], { label: string; tone: string }> = {
  acked: { label: "Acknowledged", tone: "tone-success" },
  fix_ready: { label: "Fix ready", tone: "tone-success" },
  frozen_pod_changed: { label: "Moved pods", tone: "" },
  handed_back: { label: "Handed back", tone: "" },
  open: { label: "Waiting on engineering", tone: "tone-warning" },
  resolved: { label: "Resolved", tone: "" },
  suppressed: { label: "Wrong pod", tone: "" },
};

function formatTime(iso: string | undefined): string {
  const parsed = iso ? Date.parse(iso) : Number.NaN;
  return Number.isNaN(parsed)
    ? "—"
    : `${new Date(parsed).toLocaleString("en-US", { day: "numeric", hour: "numeric", minute: "2-digit", month: "short", timeZone: "America/New_York" })} ET`;
}

function hours(value: number | undefined): string {
  return value === undefined ? "—" : `${Math.floor(value * 10) / 10}h`;
}

export default async function EscalationsPage(): Promise<React.ReactElement> {
  const identity = await getCurrentIdentity();
  const [config, lastRun, records] = identity
    ? await Promise.all([getRunnerConfig(), getLastRun(), loadRecords()])
    : [null, null, new Map<string, EscalationRecord>()];
  const shadowChannel = getShadowChannel();
  const pilotPod = POD_OPTIONS.find((pod) => pod.id === PILOT_POD_OPTION_ID)?.name ?? "pilot";
  const jiraBaseUrl = (process.env.JIRA_BASE_URL ?? "").replace(/\/+$/, "");
  const rows = [...records.values()].sort(
    (a, b) => Number(isLiveState(b.state)) - Number(isLiveState(a.state)) || (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""),
  );
  const policy = DEFAULT_ESCALATION_POLICY;

  return (
    <>
      <Link className="back-link" href="/">
        <Icon name="chevron-left" size={14} />
        Back to dashboard
      </Link>

      <div className="page-header-row">
        <div className="page-title-group">
          <h1 className="page-title">Escalation bot</h1>
          <p className="page-subtitle">
            Settings and shadow run for the bot that opens one Slack thread per CP that TS tickets are waiting on, escalated by SLA - piloting
            with the {pilotPod} pod. Jira is only ever read.
          </p>
          <p className="page-subtitle">
            Looking for every High/Critical ticket, manual escalations and their Slack conversations? They live in the{" "}
            <Link href="/tracker">Escalation tracker</Link>.
          </p>
        </div>
        <div className="page-actions">
          <Link className="btn" href="/tracker">
            <Icon name="inbox" size={14} />
            Open the tracker
          </Link>
        </div>
      </div>

      {!identity || !config ? (
        <IdentityRequired itemsLabel="escalations" />
      ) : (
        <>
          <div className="page-title-group">
            <h2 className="page-title" style={{ fontSize: "1.05rem" }}>
              How it works
            </h2>
          </div>
          <ol className="escalation-steps">
            <li>
              <strong>Trigger.</strong> A TS Support Ticket enters <em>Waiting for product</em> with an open CP linked. All TS tickets on the same
              CP share one escalation, routed by the CP&apos;s own Pod.
            </li>
            <li>
              <strong>Thread.</strong> The first run that sees it posts one parent message for the CP: its status and assignee, every waiting TS
              ticket, how long they&apos;ve waited, and what happens next. Everything after that is a reply in that thread.
            </li>
            <li>
              <strong>SLA ladder.</strong> Jira&apos;s Time to Resolution is paused in Waiting for product, so the ladder counts its own business
              hours (Mon–Fri 9:00–18:00 ET, Jira calendar 30) from the moment the ticket started waiting. L1 is a wait warning, L2 a breach and
              L3 goes to the top owner, each tagging one more person. Priority steps up one level when 3+ tickets wait on the CP, a TTR is breached
              or nearly breached, or there&apos;s a major incident.
            </li>
            <li>
              <strong>Acknowledge.</strong> Engineering reacts ✅ on the parent message; the thread confirms it.
            </li>
            <li>
              <strong>Updates.</strong> Tickets joining or leaving, <em>Ready for Release</em> (ladder pauses), Released or Closed (resolves after a{" "}
              {policy.resolveGraceMinutes}-minute grace period), rejected, handed back, or a pod change: each is posted once in the thread.
            </li>
            <li>
              <strong>Notifications.</strong> Every new thread, level, ✅ and reply shows up in the bell for the owners of the waiting tickets, live.
            </li>
          </ol>

          <div className="table-scroll">
            <table className="data-table">
              <caption className="visually-hidden">Escalation ladder, business hours since the ticket started waiting</caption>
              <thead>
                <tr>
                  <th scope="col">Priority</th>
                  <th scope="col">L1 wait warning</th>
                  <th scope="col">L2 wait breach</th>
                  <th scope="col">L3 top owner</th>
                  <th scope="col">Acknowledge within</th>
                </tr>
              </thead>
              <tbody>
                {PRIORITIES.map((priority) => (
                  <tr key={priority}>
                    <td>{priority}</td>
                    <td>{policy.ladder[priority].l1Bh} bh</td>
                    <td>{policy.ladder[priority].l2Bh} bh</td>
                    <td>{policy.ladder[priority].l3Bh} bh</td>
                    <td>{policy.ackDueBh[priority]} bh</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="page-subtitle">
            bh = business hours. These thresholds are the pilot&apos;s proposal from discovery, to be calibrated in the shadow run. At most{" "}
            {policy.maxNewParentsPerRun} new threads open per run and {policy.maxNewParentsPerDay} per day, most urgent first.
          </p>

          <div className="page-title-group">
            <h2 className="page-title" style={{ fontSize: "1.05rem" }}>
              Shadow run
            </h2>
            <p className="page-subtitle">
              {config.mode === "shadow" ? (
                <>
                  <span className="status-badge tone-success">On</span> since {formatTime(config.enabledAt)}
                  {config.enabledByName ? ` (started by ${config.enabledByName})` : ""}. Threads go to the test channel
                  {shadowChannel ? ` ${shadowChannel}` : ""} only, with nobody @-mentioned. It runs every 10 minutes while the dashboard is open
                  somewhere.
                </>
              ) : (
                <>
                  <span className="status-badge">Off</span> Nothing is posted. Starting it posts real threads, but only to the test channel
                  {shadowChannel ? ` (${shadowChannel})` : ""}, never to a pod channel, and nobody is @-mentioned. CPs already waiting when it
                  first starts are timed from that moment.
                </>
              )}
            </p>
          </div>
          <EscalationControls mode={config.mode} shadowChannel={shadowChannel} />

          {lastRun ? (
            <p className="page-subtitle">
              Last run {formatTime(lastRun.at)} ({lastRun.trigger === "manual" ? "Run now" : "automatic"}):{" "}
              {lastRun.skipped
                ? `skipped (${lastRun.skipped.replace(/_/g, " ")})`
                : lastRun.error
                  ? `failed - ${lastRun.error}`
                  : `${lastRun.posted.length} posted, ${lastRun.heldBackByCaps.length} waiting for the caps, ${lastRun.trackedLive} open${lastRun.exceptions ? `, ${lastRun.exceptions.actionable} routing problems to fix` : ""}.`}
            </p>
          ) : null}

          <div className="page-title-group">
            <h2 className="page-title" style={{ fontSize: "1.05rem" }}>
              Bot escalations
            </h2>
          </div>
          {rows.length === 0 ? (
            <div className="empty-state">No escalations yet. Start the shadow run, then press Run now.</div>
          ) : (
            <div className="table-scroll">
              <table className="data-table">
                <caption className="visually-hidden">Escalations tracked by the shadow run</caption>
                <thead>
                  <tr>
                    <th scope="col">CP</th>
                    <th scope="col">State</th>
                    <th scope="col">Priority</th>
                    <th scope="col">Level</th>
                    <th scope="col">Engineering wait</th>
                    <th scope="col">Waiting TS</th>
                    <th scope="col">Thread</th>
                    <th scope="col">Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((record) => {
                    const state = STATE_LABEL[record.state];
                    const waiting = record.qualifyingTsKeys ?? [];
                    const plan = record.lastPlan;
                    return (
                      <tr key={record.cpKey}>
                        <td>
                          <a href={`${jiraBaseUrl}/browse/${record.cpKey}`} rel="noreferrer" target="_blank">
                            {record.cpKey}
                          </a>
                          <span className="cell-sub"> {record.cpStatusName}</span>
                        </td>
                        <td>
                          <span className={`status-badge ${state.tone}`}>{state.label}</span>
                          {record.episode > 1 ? <span className="cell-sub"> episode {record.episode}</span> : null}
                        </td>
                        <td>{plan?.effectivePriority ?? "—"}</td>
                        <td>
                          {record.levelSent > 0 ? `L${record.levelSent} sent` : "—"}
                          {plan?.nextLevel ? <span className="cell-sub"> L{plan.nextLevel.level} in {hours(plan.nextLevel.dueInBh)}</span> : null}
                        </td>
                        <td>{hours(plan?.engineeringWaitBh)}</td>
                        <td className="cell-muted">
                          {waiting.length === 0 ? "—" : `${waiting.slice(0, 3).join(", ")}${waiting.length > 3 ? ` +${waiting.length - 3}` : ""}`}
                        </td>
                        <td>
                          {record.permalink ? (
                            <a href={record.permalink} rel="noreferrer" target="_blank">
                              Open in Slack
                            </a>
                          ) : (
                            <span className="cell-muted">{isLiveState(record.state) ? "not posted yet" : "—"}</span>
                          )}
                        </td>
                        <td className="cell-muted">{formatTime(record.updatedAt)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </>
  );
}
