# Graph Report - /Users/anurag.rai/Documents/TS-Dashbord  (2026-07-02)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 106 nodes · 130 edges · 12 communities (10 shown, 2 thin omitted)
- Extraction: 97% EXTRACTED · 3% INFERRED · 0% AMBIGUOUS · INFERRED: 4 edges (avg confidence: 0.5)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `87d8f21c`
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

## God Nodes (most connected - your core abstractions)
1. `compilerOptions` - 20 edges
2. `getCategoryCacheMeta()` - 7 edges
3. `scripts` - 6 edges
4. `getCategoryIssues()` - 6 edges
5. `searchIssues()` - 5 edges
6. `getActionableItems()` - 5 edges
7. `DashboardPage()` - 4 edges
8. `getDashboardTiles()` - 4 edges
9. `CategoryPage()` - 3 edges
10. `RefreshCountdown()` - 3 edges

## Surprising Connections (you probably didn't know these)
- `CategoryPage()` --calls--> `getCategoryCacheMeta()`  [EXTRACTED]
  app/category/[categoryKey]/page.tsx → src/lib/jiraClient.ts
- `CategoryPage()` --calls--> `getCategoryIssues()`  [EXTRACTED]
  app/category/[categoryKey]/page.tsx → src/lib/jiraClient.ts
- `DashboardPage()` --calls--> `getCategoryCacheMeta()`  [EXTRACTED]
  app/page.tsx → src/lib/jiraClient.ts
- `DashboardPage()` --calls--> `getCurrentUser()`  [EXTRACTED]
  app/page.tsx → src/lib/jiraClient.ts
- `DashboardPage()` --calls--> `getDashboardTiles()`  [EXTRACTED]
  app/page.tsx → src/lib/jiraClient.ts

## Import Cycles
- None detected.

## Communities (12 total, 2 thin omitted)

### Community 0 - "compilerOptions"
Cohesion: 0.08
Nodes (23): compilerOptions, allowJs, allowSyntheticDefaultImports, baseUrl, esModuleInterop, forceConsistentCasingInFileNames, incremental, isolatedModules (+15 more)

### Community 1 - "jiraClient.ts"
Cohesion: 0.13
Nodes (22): CATEGORIES, Category, CategoryCacheMeta, CurrentUser, DashboardTile, formatIssue(), FormattedIssue, getActionableItems() (+14 more)

### Community 2 - "package.json"
Cohesion: 0.11
Nodes (18): dependencies, next, react, react-dom, devDependencies, eslint, @eslint/js, @types/node (+10 more)

### Community 3 - "page.tsx"
Cohesion: 0.24
Nodes (10): CategoryPage(), CategoryPageProps, DashboardPage(), RefreshCountdown(), RefreshCountdownProps, formatDateTime(), getCategoryCacheMeta(), getCategoryIssues() (+2 more)

### Community 4 - "cache.ts"
Cohesion: 0.28
Nodes (7): GET(), cache, CacheEntry, clearCache(), getCache(), getCacheMeta(), setCache()

### Community 5 - "scripts"
Cohesion: 0.33
Nodes (6): scripts, build, dev, lint, start, typecheck

## Knowledge Gaps
- **58 isolated node(s):** `CategoryPageProps`, `metadata`, `nextConfig`, `name`, `version` (+53 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **2 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `scripts` connect `scripts` to `package.json`?**
  _High betweenness centrality (0.019) - this node is a cross-community bridge._
- **What connects `CategoryPageProps`, `metadata`, `nextConfig` to the rest of the system?**
  _58 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `compilerOptions` be split into smaller, more focused modules?**
  _Cohesion score 0.08333333333333333 - nodes in this community are weakly interconnected._
- **Should `jiraClient.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.12648221343873517 - nodes in this community are weakly interconnected._
- **Should `package.json` be split into smaller, more focused modules?**
  _Cohesion score 0.10526315789473684 - nodes in this community are weakly interconnected._