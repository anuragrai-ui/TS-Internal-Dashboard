# TS Jira Dashboard

A Next.js TypeScript dashboard for Jira tickets assigned to the current user. It shows high-level ticket tiles on the home page and category-specific ticket lists for actionable, waiting-for-product, waiting-for-client, and waiting-for-operations work.

The UI is inspired by the [Argon Dashboard](https://github.com/creativetimofficial/argon-dashboard-tailwind) design: a sticky top navigation, gradient hero banner, rounded stat cards, and soft shadows. It also displays more Jira fields from `all_filed.json` on ticket cards (severity, support category, task type, urgency, source, team, due date, comments, attachments, subtasks, and labels).

## Tech Stack

- Next.js app router
- React
- TypeScript
- Jira Cloud REST API
- OpenRouter API server-side escalation triage (default model `openai/gpt-oss-120b:free`)
- In-memory server cache
- Open Sans (via `next/font/google`)
- CSS custom properties for light/dark theming
- Graphify Labs project graph

## Requirements

- Node.js 20+
- Jira Cloud API token
- OpenRouter API key

## Environment

Create a local `.env` file:

```bash
JIRA_BASE_URL=https://certifyos.atlassian.net
JIRA_EMAIL=your.email@example.com
JIRA_API_TOKEN=your-jira-api-token
JIRA_PROJECT_KEY=TS
OPENROUTER_API_KEY=your-openrouter-api-key
OPENROUTER_ESCALATION_ENABLED=false
OPENROUTER_MODEL=openai/gpt-oss-120b:free
OPENROUTER_FALLBACK_MODEL=openai/gpt-oss-120b:free
OPENROUTER_REASONING_ENABLED=true
# Optional tuning for OpenRouter retries/timeouts
OPENROUTER_MAX_RETRIES=4
OPENROUTER_REQUEST_TIMEOUT_MS=45000
OPENROUTER_BASE_DELAY_MS=500
```

`.env` is ignored by git. Do not commit Jira or OpenRouter credentials.

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
```

## Routes

- `/` - dashboard tiles
- `/category/[categoryKey]` - ticket list for one category
- `/history` - previous refresh data retained for the last 24 hours
- `/refresh` - clears the in-memory cache and redirects to the dashboard
- `/health` - health check
- `/api/health` - API health check

## Project Structure

```text
app/
  page.tsx                       Dashboard page (Argon-style hero + stats + tiles)
  category/[categoryKey]/page.tsx Category detail page with risk summary stats
  history/page.tsx               Previous refresh data page
  refresh/route.ts               Cache refresh route
  health/route.ts                Health route
  api/health/route.ts            API health route
  globals.css                    Global design tokens & Argon-style components
  layout.tsx                     Root layout with theme init script

src/
  components/RefreshCountdown.tsx Client-side refresh countdown
  components/ThemeToggle.tsx     Light/dark theme toggle (system-aware + persisted)
  components/TicketCard.tsx      Interactive ticket card with extra Jira fields
  lib/cache.ts                   In-memory cache
  lib/openrouterEscalation.ts   Server-side OpenRouter escalation triage
  lib/jiraClient.ts              Jira API and ticket category logic
  lib/jiraSnapshotStore.ts       24-hour JSON snapshot persistence
  lib/jiraRefreshScheduler.ts    Scheduled snapshot rotation

scripts/
  test-escalation.ts            Escalation/heuristic unit tests
  test-theme.ts                 Theme CSS token tests
```

## AI Escalation Triage

Category pages can run a server-side OpenRouter analysis over the ticket and recent comments. Set `OPENROUTER_ESCALATION_ENABLED=true` to enable this external analysis. The default model is `openai/gpt-oss-120b:free`; if that request fails, the app falls back to `OPENROUTER_FALLBACK_MODEL` (defaults to the same model).

If OpenRouter returns a retryable error (such as 429 rate-limiting or 503) or times out, the request is retried with exponential backoff and jitter. If both models fail, the app silently falls back to a local heuristic analysis so the category page still renders without throwing unhandled errors. Tune retry behavior with `OPENROUTER_MAX_RETRIES`, `OPENROUTER_REQUEST_TIMEOUT_MS`, and `OPENROUTER_BASE_DELAY_MS`.

Reasoning/thinking tokens are enabled by default (`OPENROUTER_REASONING_ENABLED=true`) for models that support them.

The browser never receives the OpenRouter API key, Jira API token, or model prompt. It receives only the sanitized result for each assessed ticket:

- risk level
- risk score
- reason
- next action

## Jira Snapshot History

Every new Jira category refresh writes the fetched rows to:

```text
data/jira-refresh-history.json
```

The file is a JSON table-style structure with:

- `last_cleared_at`
- `retention_hours`
- `rows`

Each row includes the formatted ticket fields plus:

- `category_key`
- `category_title`
- `fetched_at`

Only the last 24 hours of rows are retained. A server-side scheduler starts with the Next.js process and checks hourly. When 24 hours have passed since the last clear, it clears the JSON snapshot, clears the in-memory cache, and refreshes all Jira categories again. The scheduled clear/refresh is skipped on Sundays.

`data/` is ignored by git because it contains live Jira ticket data.

## UI Design & Theming

The interface follows the [Argon Dashboard](https://github.com/creativetimofficial/argon-dashboard-tailwind) visual language:

- Sticky top navigation bar with a branded mark
- Gradient hero banner on every page
- Rounded stat cards with colored icons
- Soft-shadow cards and tables
- Accessible focus-visible states
- Skip link for keyboard users

Light and dark modes are supported through CSS `color-scheme` and a persisted manual toggle. The selected theme is applied before first paint via an inline script in `app/layout.tsx`, so there is no flash of unstyled content. The toggle also reacts to system preference changes when the user has not made an explicit choice.

## Ticket Fields Displayed

`src/lib/jiraClient.ts` now fetches a wider set of Jira fields from `all_filed.json`. `TicketCard` displays the most useful ones:

- Project, issue type, status, priority, severity
- Support category, client support task type, urgency
- Source, team, due date
- Comment, attachment, and subtask counts
- Labels and components
- Truncated description
- AI escalation insight (when OpenRouter is enabled)

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
- `register()` in `instrumentation.ts` starts `startJiraRefreshScheduler()`.
- Core graph hubs are `callOpenRouter()` (15 edges), `analyzeEscalationRisk()` (14 edges), and `FormattedIssue` (9 edges) — escalation triage is the most connected subsystem.
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
