import { renderAcknowledged } from "@/lib/escalation/messages";
import { loadRecord, setAckIfFirst } from "@/lib/escalation/runnerStore";
import { rememberPostedSlackMessage } from "@/lib/notifications/slackThreads";
import { postSlackMessageDetailed } from "@/lib/slackApi";
import { neutralizeMentions } from "@/lib/slackTestMode";

import type { PostedSlackMessage } from "@/lib/notifications/slackThreads";
import type { AppNotification } from "@/lib/notifications/types";

/**
 * Acknowledging an escalation = a ✅ reaction on its parent message in Slack
 * (Vercel Connect forwards reaction_added; it doesn't forward button clicks
 * yet). The first ✅ per episode counts and gets a short reply in the thread.
 *
 * Shadow mode accepts anyone's ✅ - nobody's Slack id is verified yet, so
 * there is no owner list to check against. Live mode must restrict it to the
 * pod's owners and the CP assignee (RoutingRow.extraAckers).
 *
 * Written to its own key (esc:ack:*) rather than into the record, so it can
 * never race a runner that is mid-way through updating the same record; the
 * next run folds it in.
 */

const ACK_REACTIONS = new Set(["ballot_box_with_check", "heavy_check_mark", "white_check_mark"]);

export function isAckReaction(reaction: string | undefined): boolean {
  return ACK_REACTIONS.has((reaction ?? "").split("::")[0] ?? "");
}

export async function acknowledgeFromReaction(args: {
  actorAccountIds: ReadonlySet<string>;
  actorName: string;
  channel: string;
  messageTs: string;
  posted: PostedSlackMessage;
  reaction: string | undefined;
  slackUserId: string;
}): Promise<AppNotification | null> {
  const { posted } = args;

  /* Only a ✅ on the parent itself - a reaction on a thread reply isn't an acknowledgement. */
  if (posted.kind !== "escalation" || !posted.cpKey || posted.threadTs !== args.messageTs || !isAckReaction(args.reaction)) {
    return null;
  }

  const record = await loadRecord(posted.cpKey);
  if (!record || record.threadTs !== args.messageTs || record.state !== "open") {
    return null;
  }

  const ackedAt = new Date().toISOString();
  if (!(await setAckIfFirst(record.cpKey, record.episode, { ackedAt, name: args.actorName, slackUserId: args.slackUserId }))) {
    return null;
  }

  const baseUrl = (process.env.JIRA_BASE_URL ?? "").replace(/\/+$/, "");
  const cpRef = { key: record.cpKey, statusName: record.cpStatusName ?? "", url: `${baseUrl}/browse/${record.cpKey}` };
  const reply = await postSlackMessageDetailed(record.channelId ?? args.channel, neutralizeMentions(renderAcknowledged(cpRef, args.actorName)), {
    threadTs: record.threadTs,
  });
  if (reply) {
    await rememberPostedSlackMessage(reply.channel, reply.ts, { ...posted, threadTs: record.threadTs ?? args.messageTs });
  }

  const audience = posted.audience.filter((id) => !args.actorAccountIds.has(id));
  return {
    actor: args.actorName,
    at: ackedAt,
    audience,
    cpKey: record.cpKey,
    id: `esc:${record.cpKey}:e${record.episode}:ack`,
    important: true,
    kind: "escalation_ack",
    source: "escalation",
    ticketKey: posted.ticketKeys[0],
    title: `${args.actorName} acknowledged the escalation for ${record.cpKey}`,
    url: record.permalink,
  };
}
