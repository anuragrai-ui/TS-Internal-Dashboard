# Graph Report - .  (2026-07-02)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 225 nodes · 376 edges · 17 communities (15 shown, 2 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 7 edges (avg confidence: 0.54)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `d9d84c57`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- [[_COMMUNITY_compilerOptions|compilerOptions]]
- [[_COMMUNITY_jiraClient.ts|jiraClient.ts]]
- [[_COMMUNITY_package.json|package.json]]
- [[_COMMUNITY_page.tsx|page.tsx]]
- [[_COMMUNITY_cache.ts|cache.ts]]
- [[_COMMUNITY_scripts|scripts]]
- [[_COMMUNITY_layout.tsx|layout.tsx]]
- [[_COMMUNITY_next.config.ts|next.config.ts]]
- [[_COMMUNITY_TS Jira Dashboard|TS Jira Dashboard]]
- [[_COMMUNITY_geminiEscalation.ts|geminiEscalation.ts]]
- [[_COMMUNITY_test-theme.ts|test-theme.ts]]
- [[_COMMUNITY_test-escalation.ts|test-escalation.ts]]

## God Nodes (most connected - your core abstractions)
1. `compilerOptions` - 20 edges
2. `TS Jira Dashboard` - 15 edges
3. `callGemini()` - 12 edges
4. `analyzeEscalationRisk()` - 12 edges
5. `FormattedIssue` - 9 edges
6. `scripts` - 8 edges
7. `testHeuristics()` - 8 edges
8. `testDisabledGemini()` - 8 edges
9. `testGeminiSuccess()` - 8 edges
10. `runScheduledJiraRefresh()` - 8 edges

## Surprising Connections (you probably didn't know these)
- `CategoryPage()` --calls--> `analyzeEscalationRisk()`  [EXTRACTED]
  app/category/[categoryKey]/page.tsx → src/lib/geminiEscalation.ts
- `DashboardPage()` --calls--> `getJiraSnapshotSummary()`  [EXTRACTED]
  app/page.tsx → src/lib/jiraSnapshotStore.ts
- `GET()` --calls--> `clearCache()`  [EXTRACTED]
  app/refresh/route.ts → src/lib/cache.ts
- `register()` --calls--> `startJiraRefreshScheduler()`  [INFERRED]
  instrumentation.ts → src/lib/jiraRefreshScheduler.ts
- `testHeuristics()` --calls--> `getLocalHeuristicAnalysis()`  [EXTRACTED]
  scripts/test-escalation.ts → src/lib/escalationHeuristics.ts

## Import Cycles
- None detected.

## Communities (17 total, 2 thin omitted)

### Community 0 - "compilerOptions"
Cohesion: 0.08
Nodes (23): compilerOptions, allowJs, allowSyntheticDefaultImports, baseUrl, esModuleInterop, forceConsistentCasingInFileNames, incremental, isolatedModules (+15 more)

### Community 1 - "jiraClient.ts"
Cohesion: 0.11
Nodes (26): CATEGORIES, CategoryCacheMeta, CurrentUser, DashboardTile, formatArrayField(), formatIssue(), getActionableItems(), getIssueComments() (+18 more)

### Community 2 - "package.json"
Cohesion: 0.07
Nodes (26): dependencies, next, react, react-dom, devDependencies, eslint, @eslint/js, @types/node (+18 more)

### Community 3 - "page.tsx"
Cohesion: 0.14
Nodes (18): CategoryPage(), CategoryPageProps, categoryIcons, DashboardPage(), RefreshCountdown(), RefreshCountdownProps, getSystemTheme(), getSystemThemeSnapshot() (+10 more)

### Community 4 - "cache.ts"
Cohesion: 0.38
Nodes (5): GET(), cache, CacheEntry, clearCache(), getCache()

### Community 5 - "scripts"
Cohesion: 0.15
Nodes (24): formatDate(), HistoryPage(), register(), Category, refreshAllCategories(), isSunday(), runScheduledJiraRefresh(), startJiraRefreshScheduler() (+16 more)

### Community 12 - "TS Jira Dashboard"
Cohesion: 0.12
Nodes (15): AI Escalation Triage, Environment, Graphify Project Graph, Install, Jira Snapshot History, Project Structure, Requirements, Routes (+7 more)

### Community 13 - "geminiEscalation.ts"
Cohesion: 0.12
Nodes (30): getRiskLabel(), TicketCard(), TicketCardProps, getLocalHeuristicAnalysis(), analysisCache, analyzeEscalationRisk(), buildCacheKey(), buildPrompt() (+22 more)

### Community 15 - "test-theme.ts"
Cohesion: 0.15
Nodes (10): css, cssPath, darkBlock, darkThumb, hero, lightOverride, prefersDark, reducedMotion (+2 more)

### Community 16 - "test-escalation.ts"
Cohesion: 0.53
Nodes (11): assert(), assertEqual(), main(), makeComments(), makeIssues(), makeMockGetComments(), requireThree(), testDisabledGemini() (+3 more)

## Knowledge Gaps
- **96 isolated node(s):** `CategoryPageProps`, `openSans`, `metadata`, `categoryIcons`, `nextConfig` (+91 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **2 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `FormattedIssue` connect `geminiEscalation.ts` to `test-escalation.ts`, `jiraClient.ts`, `scripts`?**
  _High betweenness centrality (0.019) - this node is a cross-community bridge._
- **Why does `analyzeEscalationRisk()` connect `geminiEscalation.ts` to `test-escalation.ts`, `page.tsx`?**
  _High betweenness centrality (0.011) - this node is a cross-community bridge._
- **What connects `CategoryPageProps`, `openSans`, `metadata` to the rest of the system?**
  _96 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `compilerOptions` be split into smaller, more focused modules?**
  _Cohesion score 0.08333333333333333 - nodes in this community are weakly interconnected._
- **Should `jiraClient.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.11396011396011396 - nodes in this community are weakly interconnected._
- **Should `package.json` be split into smaller, more focused modules?**
  _Cohesion score 0.07407407407407407 - nodes in this community are weakly interconnected._
- **Should `page.tsx` be split into smaller, more focused modules?**
  _Cohesion score 0.13768115942028986 - nodes in this community are weakly interconnected._