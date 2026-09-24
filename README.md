# TS Jira Dashboard

A Next.js TypeScript dashboard for Jira tickets assigned to the current user. It shows high-level category tiles on the home page and a dense, filterable, sortable issue table per category - actionable, waiting-for-product, waiting-for-client, and waiting-for-operations - including CP (client-raised) tickets alongside TS tickets. Clicking a row opens a detail drawer where you can draft and send an AI-assisted follow-up comment directly to Jira, and see when a ticket is being discussed in a public Slack channel.

The UI is a Kibana/Jira-inspired enterprise operations console: a fixed left sidebar, a compact top header with breadcrumb and ticket-key search, a Jira-style sortable/filterable issues table with a right-side detail drawer, and Kibana-style KPI strips and breakdown bars - dense, bordered panels rather than large rounded cards or gradients. It also displays more Jira fields from `all_filed.json` (severity, support category, task type, urgency, source, team, due date, pending reason, comments, attachments, subtasks, and labels) - the table shows the scannable subset, the drawer shows everything.

## Tech Stack

- Next.js app router, deployed on Vercel (serverless)
- React
- TypeScript
- Jira Cloud REST API (read + comment-write)
- OpenRouter (default), Mistral, or NVIDIA NIM - server-side escalation triage (see [AI Escalation Triage](#ai-escalation-triage)); Mistral also powers attachment OCR (see [Attachment OCR](#attachment-ocr))
- Claude (Anthropic, default) - follow-up/closure draft generation, an independent provider axis from escalation triage above (see [AI Escalation Triage](#ai-escalation-triage))
- Upstash Redis (REST client) - cache, snapshot history, analysis cache, follow-up cooldown/audit log, Slack mention storage
- Vercel Cron - scheduled Jira refresh
- Slack Events API - real-time ticket-mention notifications
- Inter (via `next/font/google`)
- CSS custom properties for light/dark theming
- Graphify Labs project graph

## Requirements

- Node.js 20+
- Jira Cloud API token (with permission to add comments, for the follow-up feature)
- An API key for whichever provider is active in `ESCALATION_PROVIDER` (OpenRouter by default, or NVIDIA/Mistral) - this is escalation-risk triage only
- An `ANTHROPIC_API_KEY` for follow-up/closure draft generation (`DRAFT_PROVIDER`, Anthropic/Claude by default) - a separate, independent axis from the above; leaving it unset just means drafts fall back to the hardcoded templates
- An Upstash Redis instance (e.g. via the Vercel Marketplace) - required for caching, snapshots, the follow-up cooldown/audit log, and Slack mentions. The app still runs and degrades gracefully without one (every Redis-backed feature is skipped rather than erroring), but nothing persists across requests/deploys until it's configured.
- A Vercel deployment with `CRON_SECRET` set, to run the scheduled refresh
- Optionally, a Slack app (Event Subscriptions + Signing Secret) for the Slack-mention feature - see [Slack Mentions](#slack-mentions)

## Quick Setup

Everything below is a one-time setup step done outside this codebase, then pasted into `.env` (local) or your Vercel project's environment variables (deployed). Nothing here requires touching code. Ordered by what actually blocks the app from working at all, down to what's purely optional.

**1. Jira (required - nothing works without this)**
Already covered if you're reading this after cloning: `JIRA_BASE_URL`, `JIRA_EMAIL`, and a classic Jira API token (`id.atlassian.com/manage-profile/security/api-tokens` → Create API token → paste into `JIRA_API_TOKEN`). This is the one shared service-account identity every Jira read, and every write nobody's personally registered a token for (see step 5), uses.

**2. Redis - Upstash (strongly recommended; the app runs without it, but nothing persists)**
Without Redis, every cache/audit-log/cooldown feature silently no-ops - category pages re-fetch from Jira on every load, follow-up cooldowns don't block repeat sends, and the per-user Jira token feature (step 5) refuses to work at all.
1. In your Vercel project dashboard → Storage → Create Database → Upstash → Redis (this is the easiest path - it wires the env vars in for you automatically). Or create one directly at upstash.com and copy its REST URL/token by hand.
2. That's it if you used the Vercel Marketplace route - it sets `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` for you. If you created it manually, copy those two values from the Upstash console into `.env`/your Vercel env vars yourself.

**3. Slack - two independent setups, only build what you need**

*(a) Inbound - "Mentioned in Slack" ticket badges (`/api/slack/events`):*
1. [api.slack.com/apps](https://api.slack.com/apps) → Create New App → From scratch → pick your workspace.
2. Event Subscriptions → turn on → Request URL: `https://<your-deployment>/api/slack/events` (must already be deployed and reachable - Slack verifies this URL live before accepting it) → subscribe to the `message.channels` bot event.
3. OAuth & Permissions → add bot scopes `channels:history` and `channels:read` → Install App to Workspace.
4. Basic Information → Signing Secret → copy into `SLACK_SIGNING_SECRET`.
5. Invite the bot to every channel you want watched (`/invite @YourAppName` in each channel) - Slack only sends events for channels the bot has actually joined.

*(b) Outbound - the daily Agent Follow-Ups Slack summary (`app/api/cron/agent-followups`):*
1. Same Slack app as above (or a new one) → OAuth & Permissions → add the bot scope `chat:write` → reinstall the app if you added this scope after the initial install.
2. OAuth & Permissions → copy the "Bot User OAuth Token" (starts `xoxb-`) into `SLACK_BOT_TOKEN`.
3. Invite the bot to the channel you want the daily summary posted to (`/invite @YourAppName`), then set `SLACK_AGENT_FOLLOWUP_CHANNEL` to that channel's name (e.g. `#follow-ups`) or ID.
4. Leaving `SLACK_BOT_TOKEN` unset is safe - the cron still runs and prepares drafts, it just skips the Slack post (a warning is logged, nothing fails).

**4. `CRON_SECRET` (required for the two scheduled jobs to run in production)**
Any random string works - Vercel Cron attaches it as a header automatically once it's set as a project env var; without it, both `/api/cron/refresh` and `/api/cron/agent-followups` return 401 on every scheduled run. Generate one with `openssl rand -base64 24` or similar.

**5. `TOKEN_ENCRYPTION_KEY` (only if you want per-team-member Jira tokens - see [Per-Team-Member Jira Tokens](#per-team-member-jira-tokens))**
`openssl rand -base64 32`, paste the output in directly. Requires Redis (step 2) to actually persist anything. Skipping this just means `/settings/jira-tokens` refuses registrations with a clear error, and every follow-up keeps using the shared Jira account from step 1 - no partial/broken state either way.

**6. `ANTHROPIC_API_KEY` (only if you want AI-drafted follow-ups instead of fixed templates)**
Get one at [console.anthropic.com](https://console.anthropic.com). Also set `OPENROUTER_ESCALATION_ENABLED=true` - this one flag gates both AI drafting *and* escalation-risk triage. Skipping this means every draft uses the (still perfectly usable, just less tailored) hardcoded fallback templates - the app doesn't break.

**7. `OPENROUTER_API_KEY` (only if you also want escalation-risk triage - immediate/watch/low scoring on category pages)**
A separate, independent feature from step 6's drafting - see [AI Escalation Triage](#ai-escalation-triage) for why OpenRouter is the default over Mistral/NVIDIA here specifically.

## Environment

Create a local `.env` file:

```bash
JIRA_BASE_URL=https://certifyos.atlassian.net
JIRA_EMAIL=your.email@example.com
JIRA_API_TOKEN=your-jira-api-token
JIRA_PROJECT_KEY=TS

UPSTASH_REDIS_REST_URL=your-upstash-redis-rest-url
UPSTASH_REDIS_REST_TOKEN=your-upstash-redis-rest-token

CRON_SECRET=your-cron-secret

# Active escalation-RISK-TRIAGE provider (immediate/watch/low scoring only): openrouter | nvidia | mistral | anthropic
ESCALATION_PROVIDER=openrouter
OPENROUTER_ESCALATION_ENABLED=false

# OpenRouter (default triage provider) - qwen/qwen3.7-flash confirmed live
# against OpenRouter's /api/v1/models catalog: cheap, fast "flash"-tier
# reasoning model.
OPENROUTER_API_KEY=your-openrouter-api-key
OPENROUTER_MODEL=qwen/qwen3.7-flash
OPENROUTER_FALLBACK_MODEL=qwen/qwen3.7-flash
OPENROUTER_REASONING_ENABLED=true
# Optional tuning for OpenRouter's own retry/backoff (unrelated to the NVIDIA chain below)
OPENROUTER_MAX_RETRIES=4
OPENROUTER_REQUEST_TIMEOUT_MS=45000
OPENROUTER_BASE_DELAY_MS=500

# Active follow-up/closure DRAFT-generation provider - independent from
# ESCALATION_PROVIDER above: openrouter | nvidia | mistral | anthropic
DRAFT_PROVIDER=anthropic

# Anthropic (default draft provider) - Claude Haiku 4.5. Every draft's
# instruction preamble is sent as a cached system prompt (prompt caching),
# so the many similar drafts one cron batch generates reuse the cached
# prefix instead of paying full input price on each one.
ANTHROPIC_API_KEY=your-anthropic-api-key
ANTHROPIC_MODEL=claude-haiku-4-5-20251001
ANTHROPIC_FALLBACK_MODEL=

# Mistral (alternative provider) - also powers attachment OCR (see below)
# regardless of which provider is active. Was the default here previously;
# demoted after mistral-small-2603 started returning 429 (rate limited) on
# every attempt under normal use.
MISTRAL_API_KEY=your-mistral-api-key
MISTRAL_MODEL=mistral-small-2603
MISTRAL_FALLBACK_MODEL=
MISTRAL_OCR_MODEL=mistral-ocr-2512

# NVIDIA NIM (alternative provider) - ordered model chain, one fast attempt each.
# Not the default: the free tier's queue latency made this unreliable for a
# page-load-blocking call in testing - see AI Escalation Triage below.
NVIDIA_API_KEY=your-nvidia-api-key
NVIDIA_MODELS=
NVIDIA_CHAIN_TIMEOUT_MS=15000
NVIDIA_CHAIN_MAX_RETRIES=1

# Max tickets per category analyzed for escalation risk (default 25)
ESCALATION_ANALYSIS_LIMIT=25

# Concurrency cap for per-ticket Jira comment lookups (default 8)
JIRA_FETCH_CONCURRENCY=8

# Hours to block a repeat follow-up send on the same ticket (default 24)
FOLLOWUP_COOLDOWN_HOURS=24

# Slack Events API webhook signature verification
SLACK_SIGNING_SECRET=your-slack-app-signing-secret
```

`.env` is ignored by git. Do not commit Jira, provider, Redis, or Slack credentials.

## Install

```bash
npm install
```

## Run Locally

```bash
npm run dev
```

The app runs at:

```text
http://127.0.0.1:8000
```

## Useful Scripts

```bash
npm run typecheck
npm run lint
npm run build
npm start
npm run test:escalation
npm run test:theme
npm run test:slack
npm run test:jira-comment-adf
```

## Routes

- `/` - dashboard tiles
- `/category/[categoryKey]` - ticket list for one category
- `/history` - previous refresh data retained for the last 24 hours
- `/sla-followups` - TS tickets due for an SLA follow-up (see [SLA Follow-Ups](#sla-follow-ups))
- `/refresh` - clears the cache and redirects to the dashboard
- `/health` - health check
- `/api/health` - API health check
- `/api/cron/refresh` - Vercel Cron target (hourly); requires a matching `CRON_SECRET` bearer token
- `/api/tickets/[key]/followup/draft` - POST, drafts an AI follow-up message for review
- `/api/tickets/[key]/followup/send` - POST, posts the (optionally edited) draft as a Jira comment (also accepts `kind`/`mentionAccountId` for SLA follow-ups, see below)
- `/api/sla-followups` - GET, lists tickets currently due for an SLA follow-up
- `/api/sla-followups/[key]/draft` - POST, drafts a stage-aware SLA follow-up message
- `/api/slack/events` - POST, Slack Events API webhook (signature-verified)

## Project Structure

```text
app/
  page.tsx                       Dashboard page (KPI strip + category breakdown + list)
  category/[categoryKey]/page.tsx Category detail page - KPI strip + issue workspace
  history/page.tsx               Previous refresh data page
  sla-followups/page.tsx         SLA follow-up review queue (dense table)
  refresh/route.ts               Cache refresh route
  health/route.ts                Health route
  api/health/route.ts            API health route
  api/cron/refresh/route.ts      Vercel Cron target - scheduled snapshot/cache refresh
  api/tickets/[key]/followup/draft/route.ts  Draft an AI follow-up message
  api/tickets/[key]/followup/send/route.ts   Post a follow-up as a Jira comment
  api/sla-followups/route.ts               List SLA follow-up candidates
  api/sla-followups/[key]/draft/route.ts   Draft a stage-aware SLA follow-up message
  api/slack/events/route.ts      Slack Events API webhook
  globals.css                    Global design tokens & enterprise console components
  layout.tsx                     Root layout - Inter font, theme init script, AppShell

src/
  components/AppShell.tsx        Server wrapper - resolves current user + Jira base URL
  components/AppShellClient.tsx  Sidebar/header shell controller (collapse + mobile state)
  components/Sidebar.tsx         Fixed left navigation (collapsible, active-route aware)
  components/TopHeader.tsx       Breadcrumb, ticket-key jump search, theme/refresh/user
  components/IssueWorkspace.tsx  Filter/sort/drawer state for one category's issue table
  components/IssueTable.tsx      Dense sortable issues table
  components/IssueDrawer.tsx     Right-side issue detail panel (Escape/overlay to close)
  components/FilterDropdown.tsx  Reusable multi-select filter dropdown
  components/StatusBadge.tsx, PriorityIndicator.tsx, RiskBadge.tsx  Table/drawer badges
  components/KpiStrip.tsx, BreakdownBars.tsx  Compact KPI row + real-data breakdown bars
  components/RefreshCountdown.tsx Client-side refresh countdown
  components/ThemeToggle.tsx     Light/dark theme toggle (system-aware + persisted)
  components/FollowUpAction.tsx  Draft/review/send follow-up UI (lives in the drawer)
  components/SlaFollowUpAction.tsx Draft/review/send-and-close UI for SLA follow-ups
  lib/issueRow.ts                IssueRow shape + age/date formatting + breakdown helpers
  lib/slaFollowup.ts             SLA follow-up candidate detection
  lib/followupAudit.ts           Shared follow-up audit log (manual + SLA)
  lib/redis.ts                   Shared Upstash Redis client
  lib/cache.ts                   Redis-backed category cache
  lib/openrouterEscalation.ts   Server-side escalation triage (OpenRouter/Mistral/NVIDIA)
  lib/llmClient.ts               Shared LLM chat-completion HTTP client + model-chain fallback
  lib/followupDraft.ts           AI follow-up message drafting
  lib/mistralOcr.ts              Mistral OCR client for image/PDF attachments
  lib/attachmentOcr.ts           Attachment OCR caching + background enrichment
  lib/escalationHeuristics.ts    Local keyword-based risk heuristic (final fallback)
  lib/mlEscalationModel.ts       ONNX anomaly-model fallback (opt-in)
  lib/jiraClient.ts              Jira API, ticket category logic, comment writes/mentions, transitions, attachment download
  lib/jiraSnapshotStore.ts       24-hour snapshot persistence (Redis-backed)
  lib/jiraRefreshScheduler.ts    Scheduled refresh logic, invoked by /api/cron/refresh
  lib/slackSignature.ts          Slack webhook request-signature verification

scripts/
  test-escalation.ts            Escalation/heuristic unit tests
  test-theme.ts                 Theme CSS token tests
  test-jira-comment-adf.ts      Jira comment ADF (mention) construction tests
  test-slack-signature.ts       Slack signature verification unit tests
  test-llm-client.ts            Anthropic/OpenAI-compatible request+response translation, draft/triage provider independence, pickVariant tests
  test-user-jira-tokens.ts      Token encryption round-trip/tamper detection, per-user registration/lookup/list/remove tests
  test-google-sheets-writer.ts  Apps Script webhook append/batch-append, graceful failure (HTTP error, non-JSON, ok:false) tests
```

## AI Escalation Triage

Category pages can run a server-side AI analysis over each ticket and its recent comments to score escalation risk (immediate/watch/low). Set `OPENROUTER_ESCALATION_ENABLED=true` to enable it (this flag is the master switch for both this and draft generation below, regardless of which provider is active for either). `ESCALATION_PROVIDER` selects *this* feature's provider: `openrouter` (default), `nvidia`, `mistral`, or `anthropic`.

Follow-up/closure message drafting (see [Follow-Up Comments](#follow-up-comments) below) is a **separate feature with its own, independent provider axis** - `DRAFT_PROVIDER` (Anthropic/Claude by default), not `ESCALATION_PROVIDER`. The two used to share one pipeline; they were split apart so switching one doesn't silently change the other's already-tuned behavior. See [Follow-Up Draft Generation](#follow-up-draft-generation) for that provider's own docs.

**OpenRouter is the default provider**, model `qwen/qwen3.7-flash` - confirmed live against OpenRouter's `/api/v1/models` catalog and a real chat-completion call (~11s for a full analysis prompt, valid ticket-specific JSON output). It's a *reasoning* model: part of `maxTokens` is spent on hidden chain-of-thought before the visible answer (700-1800+ reasoning tokens observed for prompts this size), which is why both call sites budget generously (`maxTokens: 4096`) rather than the smaller budget a non-reasoning model would need for the same output - a tight budget can silently starve the visible content to empty even though the call itself succeeds. Mistral and OpenRouter both use a simple primary+fallback pair (`MISTRAL_MODEL`/`MISTRAL_FALLBACK_MODEL`, `OPENROUTER_MODEL`/`OPENROUTER_FALLBACK_MODEL`), each retried up to `OPENROUTER_MAX_RETRIES` times with exponential backoff and jitter on retryable errors (429/500/502/503/504).

**Mistral is available but not the default.** It was the default previously - measured at under 1 second for a trivial request and ~20-30 seconds for a full 25-ticket category analysis, with genuinely ticket-specific reasoning in its output. Demoted after `mistral-small-2603` was observed returning 429 (rate limited) on every attempt in the retry budget under normal use - not a one-off blip. Revisit as default if you're on a higher Mistral rate-limit tier.

**NVIDIA is available but not the default.** It uses a model chain rather than a single model: `NVIDIA_MODELS` is an ordered list (defaults to `nvidia/nemotron-3.5-lightning-30b-a3b`, `deepseek-ai/deepseek-v4-flash-0731`, `openai/gpt-oss-120b`, `nvidia/nemotron-3-ultra-550b-a55b`, `moonshotai/kimi-k3` when unset), each model getting exactly one attempt (`NVIDIA_CHAIN_MAX_RETRIES=1`, no backoff) within `NVIDIA_CHAIN_TIMEOUT_MS` (default 15s) before moving to the next - breadth over depth, so one slow model can't stall the whole request by itself. In practice this hasn't been enough: NVIDIA's shared free-tier NIM endpoint has been measured taking anywhere from ~25 seconds to 3+ minutes for the *same* model and key (a queue-depth property of their infrastructure, not something tunable here), and in one live test **all 5 chained models timed out**, making a single category page take 89 seconds. Set `ESCALATION_PROVIDER=nvidia` if you have a paid/dedicated key or want to try it again once the free tier is less congested - this retry/backoff behavior is independent of and unaffected by the Mistral/OpenRouter primary+fallback pair above.

If every model in the active provider's chain fails, the app silently falls back to a local heuristic analysis so the category page still renders without throwing unhandled errors. Up to `ESCALATION_ANALYSIS_LIMIT` tickets (default 25) per category are analyzed; the rest are shown unassessed.

Reasoning/thinking tokens are enabled by default (`OPENROUTER_REASONING_ENABLED=true`) for OpenRouter models that support them; this flag doesn't apply to NVIDIA or Mistral.

The analysis prompt includes each ticket's `pending_reason` and `severity` alongside its status/priority/comments - `pending_reason` is treated as context for *why* a ticket is stalled, not as a risk signal on its own.

The browser never receives any provider API key, the Jira API token, or the model prompt. It receives only the sanitized result for each assessed ticket:

- risk level
- risk score
- reason
- next action

Analysis results are cached in Redis for 30 minutes per ticket-set; if Redis isn't configured, analysis simply runs on every request instead of erroring.

## Attachment OCR

Tickets with image or PDF attachments (up to 15MB each) get those attachments OCR'd via Mistral (`MISTRAL_OCR_MODEL`, default `mistral-ocr-2512`) and the extracted text is included as `attachment_text` context in both the escalation-analysis prompt and follow-up drafts - useful for tickets where the actual problem is only described in a screenshot.

This is deliberately **never in the request path**: viewing a category page or drafting a follow-up triggers OCR for any not-yet-cached attachments in the background (`next/server`'s `after()`, same pattern as the Jira snapshot write), and the *next* view picks up the cached result (`ocr:attachment:{id}` in Redis, 30-day TTL - attachment content never changes, so this effectively never needs to be recomputed). A ticket's first view after a new attachment appears won't have OCR context yet; by the next analysis cycle (30-minute cache TTL) it will. Requires Redis; silently skipped otherwise. Uses `MISTRAL_API_KEY` regardless of which provider is active in `ESCALATION_PROVIDER`.

## Jira Snapshot History

Every new Jira category refresh appends the fetched rows to a single Redis key, guarded by a short-lived lock so concurrent writes (normal on serverless) don't race each other. The stored structure is:

- `last_cleared_at`
- `retention_hours`
- `rows`

Each row includes the formatted ticket fields plus:

- `category_key`
- `category_title`
- `fetched_at`

Only the last 24 hours of rows are retained. `/api/cron/refresh` is triggered hourly by Vercel Cron (see `vercel.json`) and requires a matching `Authorization: Bearer $CRON_SECRET` header. When 24 hours have passed since the last clear, it clears the snapshot, clears the cache, and refreshes all Jira categories again. The scheduled clear/refresh is skipped on Sundays. If Redis isn't configured, snapshot history and caching are simply skipped rather than erroring - the dashboard still works, just without persistence between requests.

## Follow-Up Comments

Each issue's detail drawer has a "Draft follow-up" button (draft-then-confirm, never automatic):

1. Clicking it calls `POST /api/tickets/[key]/followup/draft`, which asks the active **draft** provider (Claude/Anthropic by default - see [Follow-Up Draft Generation](#follow-up-draft-generation)) to draft a short, professional follow-up addressed to the right team (based on the ticket's status, `pending_reason`, and any OCR'd attachment text), falling back to a plain template message if AI drafting is disabled, unavailable, or fails.
2. The draft appears in an editable text box. Nothing is sent until you click "Send."
3. Sending calls `POST /api/tickets/[key]/followup/send`, which posts the (possibly edited) text as a real Jira comment via `addFollowUpComment()`, then records an audit entry and starts a cooldown (`FOLLOWUP_COOLDOWN_HOURS`, default 24h) that blocks another send on the same ticket, enforced server-side regardless of what the UI shows. It also logs the same send to the "Follow-Up Log" Google Sheet tab if configured - see [Follow-Up Log (Google Sheet)](#follow-up-log-google-sheet).

**This app still has no real login/session system.** Jira access defaults to one shared service-account token, so anyone who can reach a deployed URL could trigger a real Jira comment - see [Per-Team-Member Jira Tokens](#per-team-member-jira-tokens) for the lightweight, cookie-based identity built on top of that registry instead of real auth. Enable [Vercel Deployment Protection](https://vercel.com/docs/deployment-protection) (password or SSO) before deploying this feature anywhere reachable beyond your own machine.

## Per-Team-Member Jira Tokens

`/settings/jira-tokens` lets each team member register their own Jira API token. Registering does two things at once:

1. **Identifies this browser as you.** `src/lib/currentIdentity.ts` stores the registered `accountId` in an httpOnly cookie (`ts_identity_account_id`), re-validated against the live registry on every read (a removed or stale account is treated as "not identified," not trusted from the cookie value alone). The five Operations tabs - Agent Follow-Ups, Sheet AI Follow-Ups, SLA Follow-Ups, Closure Candidates, History - each read this identity server-side and only show items assigned to that account, rendering an "enter your Jira API key" prompt (`src/components/IdentityRequired.tsx`) instead of any data until someone has identified themselves. The header badge (`AppShell.tsx`/`TopHeader.tsx`) reflects the same identity (or a neutral icon when nobody has identified themselves) - previously it always called the shared service account's `/myself`, so it always showed the same person regardless of who was actually browsing. **There is deliberately no one-click "identify as someone else."** An earlier version of this feature let a browser switch to any already-registered account by accountId alone (`POST /api/settings/identity`) - a one-click impersonation hole, since it required no proof the person clicking it actually owned that account, and a Send would then post real Jira comments under a specific named teammate's identity without their knowledge. That endpoint is gone; becoming identified as someone always goes through `POST /api/settings/jira-tokens`, which requires the exact email+API token pair Jira's own `/myself` accepts for that account. On a shared machine, switching users means that person pastes their own token. "Not you? Forget this identity" (`DELETE /api/settings/identity`) only clears the cookie - safe, since it can't set it to anyone. Removing a registered token (`DELETE /api/settings/jira-tokens/[accountId]`) is likewise restricted server-side to the currently-identified owner of that exact account, closing a related gap where anyone could otherwise delete a teammate's registration.
2. **Routes Send under your own Jira identity.** When a follow-up is sent, the send route (`app/api/tickets/[key]/followup/send/route.ts`) prefers the browsing identity's token over the ticket's own `assignee_account_id` (falling back to the assignee for a caller with no identity cookie, like the cron job) - in practice these agree, since the tabs only ever show a person their own tickets, but this matters for Sheet-sourced tickets (Sheet AI Follow-Ups, History), which never carry an `assignee_account_id` at all. A ticket/account with no registered token keeps using the shared service account, exactly as before this feature existed.

Three of the five tabs (Agent Follow-Ups, SLA Follow-Ups, Closure Candidates) filter on Jira's own `assignee_account_id`, an exact match. The other two (**Sheet AI Follow-Ups, History**) are sourced from the Google Sheet backlog, which has no Jira account id at all - only a plain "Assignee" text cell - so filtering there falls back to a case-insensitive match against your Jira display name (`assigneeMatchesIdentity()` in `currentIdentity.ts`). A sheet cell that's a nickname, typo, or otherwise doesn't match your Jira display name exactly just won't match; not fixable without changing what the sheet stores.

**Registration** (`registerUserJiraToken()`) never trusts a pasted token blindly: it calls Jira's own `/myself` with the *exact* email+token pair being registered, and only stores it if Jira accepts it - the stored account id, display name, and email all come back from Jira itself, not from the form. **Tokens are encrypted at rest** (`src/lib/tokenCrypto.ts`, AES-256-GCM, keyed by `TOKEN_ENCRYPTION_KEY` - generate with `openssl rand -base64 32`) before being written to Redis; the plaintext token is never stored and is not shown again after registration. If a stored token later turns out to be expired or revoked (a 401/403 from Jira when actually posting), the send route logs a warning, falls back to the shared service account for that one request, and reports `usedFallbackAccount: true` in its response rather than failing the send outright.

**To create a token**: log in to [id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens) → "Create API token with scopes" → name it, set an expiration (1-365 days), select Jira, grant scopes covering reading/writing issues and comments plus reading your own profile → Create → copy it → paste it into `/settings/jira-tokens`. A token that expires simply stops working at that date; re-registering with a fresh token is the only way to renew it - there's no expiry-tracking or renewal-reminder mechanism yet.

## Follow-Up Log (Google Sheet)

Every follow-up send (`POST /api/tickets/[key]/followup/send`, any kind - manual, SLA, CP escalation, product-wait, closure) appends a row to a "Follow-Up Log" tab in the same Google Sheet the [Team Sheet Backlog](#project-structure) reads from - a durable, human-readable record independent of Redis, since the Redis-backed audit log (`src/lib/followupAudit.ts`) is deliberately capped (50 entries) and TTL'd (180 days) to stay within a memory-limited free Redis tier. The Sheet is never the operational source of truth for cadence/cooldown logic (that stays in Redis, which is fine to clear or let entries age out of) - it exists purely so that record is never actually lost.

**This is a separate, write-capable path from `src/lib/googleSheetBacklog.ts`**, which only reads the sheet via its public CSV export URL and has no authentication at all. Writing here uses a **Google Apps Script Web App** bound to the spreadsheet (`GOOGLE_SHEET_WEBHOOK_URL`) rather than a Google Cloud service account - deliberately, since a service account needs IAM Admin access to create, and this doesn't need any Google Cloud Console access at all. Anyone who can already edit the sheet can set it up directly from the Sheets UI (Extensions -> Apps Script -> paste a ~10-line `doPost` handler -> Deploy as a Web App with "Execute as: Me" / "Who has access: Anyone" -> copy the resulting `/exec` URL) - see the exact snippet and steps in `.env.example`. `src/lib/googleSheetsWriter.ts` is then just one plain `fetch()` POST to that URL - no OAuth, no signing, no API client library.

Logging is best-effort and never blocks or fails a send: `appendFollowUpLogRow`/`appendFollowUpLogRows` return `false` (never throw) on missing config, an HTTP failure, or a non-JSON response (Apps Script redirects to a Google sign-in page instead of running the script if the deployment's access level isn't actually "Anyone" - checked explicitly, since that would otherwise look like an empty success). Calls are `await`ed (not fire-and-forget) specifically because a serverless function's background promises aren't guaranteed to finish once the response is sent - a "durable" log that can silently lose writes on every cold response would defeat its own purpose.

## Follow-Up Draft Generation

Every follow-up/closure message (manual follow-ups, SLA follow-ups, closure candidates, CP escalations, TS product-wait follow-ups) is drafted through the same `draftViaChain()` in `src/lib/followupDraft.ts`, on its own provider axis (`DRAFT_PROVIDER`, independent from `ESCALATION_PROVIDER` - see [AI Escalation Triage](#ai-escalation-triage)).

**Claude (Anthropic) is the default draft provider**, model `claude-haiku-4-5-20251001` (`ANTHROPIC_API_KEY`/`ANTHROPIC_MODEL`). `src/lib/llmClient.ts` translates the same internal `ChatMessage`/`ToolCall` currency every other provider uses into Anthropic's Messages API shape (`x-api-key`/`anthropic-version` headers, a top-level `system` field, `tool_use`/`tool_result` content blocks) and back, so every caller above `callChatCompletionRaw()` - including the tool-calling loop - stays provider-agnostic.

**Prompt caching:** each draft's instruction preamble (role, formatting rules, audience/intent framing) is built as a separate, per-ticket-interpolation-free `systemPrompt` string and sent as an Anthropic cached content block (`cache_control: { type: "ephemeral" }`); only the small per-ticket JSON payload (key, summary, reporter, comments, ...) is a plain user message priced at full input rate. Since one cron run drafts dozens of CP escalations or dozens of external product-wait follow-ups that share the same (kind, audience, intent) combination, most of a batch's calls hit Anthropic's ~5-minute prompt cache instead of paying full input price - see the "Live-verified count" note in `src/lib/cpEscalation.ts` for the real batch sizes this run into.

**Draft variety:** every system prompt ends with an explicit "write like a real person, not a template" instruction, and drafts sample at `temperature: 0.7` (up from a near-deterministic `0.1` default) - both aimed at the same problem, that near-zero-temperature, template-shaped prompts produced messages reading as interchangeable across different tickets. The **fallback templates** (used when AI drafting is disabled, unavailable, or fails) are pooled into 2-3 phrasing variants per message kind and picked deterministically per ticket via `pickVariant()` in `src/lib/textVariety.ts` (a hash of the issue key), so a batch of fallback messages doesn't all read as the exact same string either - `productWaitFollowup.ts`'s external path additionally varies by follow-up ordinal (1st/2nd/3rd+) on top of that, since a client on their 3rd follow-up should never see the same message a 1st-time recipient sees.

`checkExternalMessageSafety()` (`src/lib/messageSafety.ts`) is unaffected by any of the above - it's a deterministic regex backstop checked after generation regardless of provider, temperature, or which variant was drafted.

## SLA Follow-Ups

`/sla-followups` surfaces TS tickets in **"Waiting for Client" or "Waiting for Operations"** that have gone 3+ days without progress, for two independent reasons that can each trigger a follow-up:

- **No response from reporter** - the ticket hasn't been updated in 3+ days.
- **Linked CP ticket not worked** - the TS ticket links to a CP (Prod team) ticket (any Jira issue-link type; in practice almost always "Action item") that isn't resolved and is either unassigned, still in `Backlog`/`Selected For Sprint`, or hasn't been updated in 3+ days itself.

Like the manual follow-up feature, **every step requires a human to click "Send"** - the scan only surfaces candidates and drafts messages; nothing is posted or closed unattended. There are two stages, tracked via the same Redis audit log the manual follow-up button writes to (`src/lib/followupAudit.ts`, entries tagged `sla_stage_1`/`sla_stage_2`):

1. **Stage 1** - a polite first check-in, drafted with awareness of *why* it's stalled (waiting on the reporter vs. still being worked internally via the linked CP ticket).
2. **Stage 2** - surfaces once a stage-1 follow-up is itself 3+ days old with the ticket still not Done. The draft is a **closure** message if the linked CP has since resolved, or a **final notice** otherwise - either way, clicking "Send & mark Done" posts the comment *and* transitions the ticket to Jira's "Done" status in one confirmed action (`transitionIssueToDone()` looks up the issue's actual available transitions rather than assuming a fixed transition id, since these differ by issue type/workflow; if no exact "Done"-named transition is found, or Jira rejects it, the comment still posts and the response reports the failure back to the UI rather than silently doing nothing).

**Addressing** is driven by Jira's own `reporter.accountType` field - `"customer"` (external) gets addressed by name in the drafted prose; anything else (internal/employee) gets a real Jira `mention` ADF node (not literal `@name` text, which wouldn't notify anyone) via a `{{MENTION}}` placeholder the LLM is instructed to use, substituted at send time (falls back to addressing by name if an internal reporter is somehow missing an accountId - see `scripts/test-jira-comment-adf.ts`).

**Known approximations, not precise tracking:** "no response from reporter" is approximated as "the ticket hasn't been updated at all" rather than precisely attributing comment authorship - a support agent's own comment would also reset this clock. "No activity" on the linked CP ticket is the same approximation. Review the candidate list before drafting rather than trusting the reason label blindly. This also means the "no reporter response" label reads a little loosely for a Waiting-for-Operations ticket - the silence there could just as easily be internal (ops hasn't picked it up), not the client - but the underlying "nothing has happened on this ticket in N days" signal is equally meaningful either way.

## POD-Based Routing (CP Escalations & SLA-Breach Alerts)

`src/lib/podRouting.ts` is a static table (sourced directly from the team's org chart) mapping each Jira `pod` custom-field value to its Engineering Manager, Product Manager, PM Manager, and Slack channel. A POD not in the table (or an issue with no `pod` set) falls back to the Technical Support Slack channel with nobody to tag - a real gap, not a guess. Two features build on it:

**CP Escalations** (`app/agent-followups`, `src/lib/cpEscalation.ts`): an unassigned CP ticket's nudge now tags its owning POD's EM + PM together (`resolveCpMentionTarget()`), rather than falling straight to an unconfirmed guess at the reporter. On a repeat nudge (already sent once, cadence elapsed again with no resolution), the PM Manager is added on top - broadening visibility, not replacing the original two. An already-assigned CP is untouched; the real assignee still takes priority. Names are resolved to Jira accountIds via `findJiraUserByName()` (`src/lib/jiraClient.ts`, Jira's own `/user/search`, cached 7 days) - an ambiguous or missing match is dropped, not guessed, so the nudge still posts with whoever *did* resolve.

**SLA-Breach Slack Alert** (`/sla-followups`, "Alert POD (Slack)" button, `src/lib/slaBreachAlert.ts`): appears only when a candidate has both `missedSla: true` (we're now late even by our own SLA-breach buffer, not just the client being silent) and `reason: "cp_not_worked"` - a client's own silence has no Product-side fix, so the button doesn't appear for that reason. Routes to the **linked CP's own POD** (not the TS ticket's), since that's the blocking party, tagging that POD's PM and posting to its Slack channel (Technical Support as fallback). Same draft-then-confirm contract as every other action here - drafting never posts anything; a human reviews the text and clicks Send. A 24h Redis cooldown (separate from the Jira follow-up cooldown - this is a different channel/action entirely) stops an accidental double-post.

Tagging a real person on Slack needs their Slack user ID, which the org chart doesn't have - `findSlackUserIdByName()` (`src/lib/slackApi.ts`) guesses a `firstname.lastname@certifyos.com` address (confirmed pattern, but not guaranteed for every name) and resolves it via Slack's `users.lookupByEmail` (needs the `users:read.email` scope on `SLACK_BOT_TOKEN`, in addition to `chat:write`). A failed guess or missing scope isn't a hard failure - the alert still posts, just with a plain-text `@Name` instead of a real `<@U...>` ping.

## Closure Candidates

`/closure-candidates` (`src/lib/closureCandidates.ts`) surfaces open TS tickets ready to close, via three independent signals: a linked CP ticket resolving, an AI similarity pass finding a near-identical past ticket that was already fixed, or the reporter going unresponsive even after a second follow-up (reason `client_unresponsive`). Same draft-then-confirm contract as everywhere else - a candidate is a suggestion, nothing closes without a human clicking Send.

**`client_unresponsive` reuses the SLA Follow-Ups cadence, it doesn't duplicate it.** A ticket that already has an `sla_stage_2` or `sla_stage_3` audit entry (see [SLA Follow-Ups](#sla-follow-ups) above - a second follow-up already sent, still no reply) and is still open now surfaces here too, not just on the SLA tab - exactly "unresponsive even after 2 follow-ups" as requested. It's excluded, though, when the real blocker turns out to be a not-yet-worked linked CP (`isCpNotWorkedOn()`) rather than genuine reporter silence - that's Product's problem to fix (CP Escalations / the SLA-breach Slack alert own it), not a reason to suggest closing. A ticket already at stage 1 alone (only a first check-in sent) does NOT qualify - it takes an actual second follow-up.

**`client_unresponsive` also comes from the ticket's own Jira comments** (`src/lib/replyTracking.ts`), not only the SLA audit trail: 2+ follow-up rounds from us since the reporter last commented, the latest 4+ days old (`UNRESPONSIVE_MIN_FOLLOW_UPS` / `UNRESPONSIVE_MIN_DAYS` in `closureCandidates.ts`). This covers every open status, "Waiting for Product" included, and counts follow-ups posted directly in Jira, not just ones sent through this dashboard. Comments within 24h of each other count as one round (a message plus a quick correction is one follow-up, not two), and Jira automation (`app` accounts) never counts. An open linked CP doesn't hide the candidate (nearly every Waiting-for-Product ticket has one); instead the explanation names it ("CP-X (Backlog) is still open - worth a quick check before closing") and it shows as the Reference. That reviewer note never reaches the drafted closing message.

### Product-Wait Follow-Up Tracking

The TS Product-Wait table on `/agent-followups` reads the same comment history: **Follow-Up #** is the next follow-up round since the reporter's last reply (it used to count only dashboard-sent follow-ups in Redis, so it sat at 1 for anything followed up directly in Jira), plus **Last Follow-Up** and **Reporter Replied** (days ago), and a "Ready to close" flag using the exact same thresholds as Closure Candidates.

### Weekly Closures

`/weekly-closures` (`src/lib/weeklyClosures.ts`) shows the identified user's TS tickets that moved to a Done-category status this week and over the last 6 weeks (Monday start), and how many of those had been "Waiting for Product" during that window, plus whole-TS-project totals for context. "Closed" is Jira's `statusCategoryChangedDate`, so Done/Closed/Resolved all count. Week boundaries use `WEEKLY_REPORT_TIMEZONE` (default `America/Los_Angeles`, the Jira service account's timezone, which is how Jira reads JQL date literals). Cached 15 minutes per user.

**Multi-CP-aware, Story-negated:** a TS ticket can have more than one linked CP ticket (any Jira issue-link type - Action item, Problem/Incident, etc. are all treated the same). `classifyIssue()` requires **every** linked CP to be resolved before treating the ticket as closable - one of several linked CPs resolving is not enough, since the others may still represent open work. **Story-type linked CPs are excluded from this check entirely** (neither required to be resolved, nor able to block on their own), since a Story tracks planned work rather than a blocking bug/task; if every linked CP on a ticket happens to be a Story, this signal contributes nothing and the ticket falls through to the AI similarity check instead, same as having no linked CP at all. See `scripts/test-closure-logic.ts` for the exact boundary cases (partial resolution, full resolution, Story-only).

## Slack Mentions

`/api/slack/events` is a Slack Events API webhook: when a message in a public channel mentions a ticket key (`TS-1234`, `CP-1234`), the app records the mention in Redis and a "Mentioned in Slack" badge appears in that ticket's detail drawer, linking back to the channel.

Setup (outside this codebase):

1. Create a Slack app in your workspace with Event Subscriptions enabled, Request URL set to `https://<your-deployment>/api/slack/events`, subscribed to the `message.channels` bot event, and scopes `channels:history` + `channels:read`.
2. Copy the app's Signing Secret into `SLACK_SIGNING_SECRET`.
3. Invite the bot to each channel you want watched - Slack only delivers `message.channels` events for channels the bot has joined; this app does not auto-join channels.

Every request is signature-verified (HMAC-SHA256 over the raw body, using the timestamp + signing secret, rejecting anything older than 5 minutes) before any processing happens - see `src/lib/slackSignature.ts` and `npm run test:slack`. This requires the app to already be deployed at a public HTTPS URL; it cannot be exercised end-to-end locally.

## UI Design & Theming

The interface is a Kibana/Jira-inspired enterprise operations console, not a marketing-style admin template:

- Fixed left sidebar (collapsible) grouping Dashboard / Issues (the four categories) / Operations (SLA Follow-Ups, History), active-route aware
- Compact top header: breadcrumb, a ticket-key jump search (`TS-12345`/`CP-12345` opens the ticket in Jira directly), refresh/theme/user
- Dense, sortable, filterable issues table per category (`IssueTable`/`IssueWorkspace`) instead of large cards - click a row to open a right-side detail drawer (`IssueDrawer`) rather than navigating away
- Compact KPI strips (`KpiStrip`) and real-data breakdown bars (`BreakdownBars`) for status/priority/category distribution - no fabricated metrics or charts backed by data the app doesn't actually have
- Bordered, low-radius panels instead of large rounded cards or gradients; shadows reserved for the drawer and dropdown menus
- Accessible focus-visible states, skip link, and Escape-to-close on the drawer

Light and dark modes are supported through CSS `color-scheme` and a persisted manual toggle. The selected theme is applied before first paint via an inline script in `app/layout.tsx`, so there is no flash of unstyled content. The toggle also reacts to system preference changes when the user has not made an explicit choice.

## Ticket Fields Displayed

`src/lib/jiraClient.ts` fetches a wide set of Jira fields from `all_filed.json`. The table (`IssueTable`) shows the scannable subset needed to triage at a glance:

- Ticket key + project, summary, category, POD/team
- Priority, status (+ pending reason), AI risk
- Assignee, reporter (+ external/internal), created date, age, last updated
- Linked CP issue + its status

Clicking a row opens the detail drawer (`IssueDrawer`) with everything else:

- Severity, urgency, source, task type, due date, major incident, affected services
- Components and labels
- Comment, attachment, and subtask counts
- Full description
- AI escalation insight (when the active provider is enabled)
- The draft/send follow-up action and Slack mention badge, if any

## Graphify Project Graph

This repo includes a Graphify Labs graph generated from the TypeScript/Next.js codebase.

Generated artifacts:

- [`graphify-out/GRAPH_REPORT.md`](graphify-out/GRAPH_REPORT.md)
- [`graphify-out/graph.json`](graphify-out/graph.json)
- [`graphify-out/graph.html`](graphify-out/graph.html)

Current graph summary (built from commit `cb7faead`):

- 235 nodes
- 402 edges
- 17 communities
- 98% EXTRACTED / 2% INFERRED
- No import cycles detected

Main Graphify findings:

- `DashboardPage()` calls `getDashboardTiles()`, `getCurrentUser()`, `getCategoryCacheMeta()`, and `getJiraSnapshotSummary()`.
- `CategoryPage()` calls `getCategoryIssues()`, `getCategoryCacheMeta()`, and `analyzeEscalationRisk()`.
- `getCategoryIssues()` uses `getCache()` and `setCache()` to cache Jira category results.
- ~~`register()` in `instrumentation.ts` starts `startJiraRefreshScheduler()`~~ - superseded: the scheduler is now triggered by Vercel Cron hitting `/api/cron/refresh`, and `instrumentation.ts` no longer exists. Run `graphify update .` to refresh this section.
- Core graph hubs are `callOpenRouter()` (15 edges), `analyzeEscalationRisk()` (14 edges), and `FormattedIssue` (9 edges) — escalation triage is the most connected subsystem. (Pre-dates the `llmClient.ts` extraction; re-run graphify to update.)
- `FormattedIssue` is the main cross-community bridge (betweenness 0.023), linking `jiraClient.ts`, `openrouterEscalation.ts`, `TicketCard.tsx`, and the test scripts.

To refresh the graph after code changes:

```bash
graphify update .
graphify cluster-only .
```

If `graphify` is not on your shell path, use the installed binary directly:

```bash
/Users/anurag.rai/.local/bin/graphify update .
/Users/anurag.rai/.local/bin/graphify cluster-only .
```

## Verification

Run the full verification pipeline after any changes:

```bash
npm run typecheck
npm run lint
npm run test:escalation
npm run test:theme
npm run build
npm start
```
