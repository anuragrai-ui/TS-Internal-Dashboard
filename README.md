# TS Jira Dashboard

A Next.js TypeScript dashboard for Jira tickets assigned to the current user. It shows high-level ticket tiles on the home page and category-specific ticket lists for actionable, waiting-for-product, waiting-for-client, and waiting-for-operations work.

## Tech Stack

- Next.js app router
- React
- TypeScript
- Jira Cloud REST API
- In-memory server cache
- Graphify Labs project graph

## Requirements

- Node.js 20+
- Jira Cloud API token

## Environment

Create a local `.env` file:

```bash
JIRA_BASE_URL=https://certifyos.atlassian.net
JIRA_EMAIL=your.email@example.com
JIRA_API_TOKEN=your-jira-api-token
JIRA_PROJECT_KEY=TS
```

`.env` is ignored by git. Do not commit Jira credentials.

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
```

## Routes

- `/` - dashboard tiles
- `/category/[categoryKey]` - ticket list for one category
- `/refresh` - clears the in-memory cache and redirects to the dashboard
- `/health` - health check
- `/api/health` - API health check

## Project Structure

```text
app/
  page.tsx                       Dashboard page
  category/[categoryKey]/page.tsx Category detail page
  refresh/route.ts               Cache refresh route
  health/route.ts                Health route
  api/health/route.ts            API health route
  globals.css                    Global styles

src/
  components/RefreshCountdown.tsx Client-side refresh countdown
  lib/cache.ts                   In-memory cache
  lib/jiraClient.ts              Jira API and ticket category logic
```

## Graphify Project Graph

This repo includes a Graphify Labs graph generated from the TypeScript/Next.js codebase.

Generated artifacts:

- [`graphify-out/GRAPH_REPORT.md`](graphify-out/GRAPH_REPORT.md)
- [`graphify-out/graph.json`](graphify-out/graph.json)
- [`graphify-out/graph.html`](graphify-out/graph.html)

Current graph summary:

- 14 code files
- 106 nodes
- 130 edges
- 12 communities
- No import cycles detected

Main Graphify findings:

- `DashboardPage()` calls `getDashboardTiles()`, `getCurrentUser()`, and `getCategoryCacheMeta()`.
- `CategoryPage()` calls `getCategoryIssues()` and `getCategoryCacheMeta()`.
- `getCategoryIssues()` uses `getCache()` and `setCache()` to cache Jira category results.
- Core graph hubs include `getCategoryCacheMeta()`, `getCategoryIssues()`, `searchIssues()`, `getActionableItems()`, `DashboardPage()`, and `RefreshCountdown()`.

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

The current Next.js conversion was verified with:

```bash
npm run typecheck
npm run lint
npm run build
curl http://127.0.0.1:8000/health
```
