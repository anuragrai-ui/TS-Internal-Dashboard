/* Vercel Connect's default trigger path for the Slack connector. Same
   handler (and the same Vercel-OIDC / Slack-signature checks) as
   /api/slack/events, so events arrive whichever path the connector's
   trigger destination is set to. */
export { POST } from "../../api/slack/events/route";
