# Dashboard data layer — what the intelligence layer can compute on day one

Lens: GSC + stored SEO data in `apps/dashboard` (the vendored OpenSEO app).
Everything below is read from the code as of this writing; file paths are
relative to `apps/dashboard/` unless noted. The last section maps each
rankloop signal (docs/PLAN.md L1) to the exact tables/columns it can be
computed from today, and names what is missing.

---

## 1. Database shape

- Drizzle over **SQLite (D1) by default, Postgres opt-in** via
  `DATABASE_PROVIDER=postgres`. `src/db/index.ts` exports one `db` handle
  typed as the D1 client; `src/db/schema-parity.test.ts` guarantees the pg
  schema (`src/db/pg`) is structurally identical.
- All timestamps are **text** columns defaulting to
  `` sql`(current_timestamp)` `` (SQLite `YYYY-MM-DD HH:MM:SS` format —
  see `rankTrackingTimestamps.ts` / `toSqliteTimestamp`).
- D1 caps **100 bound parameters per statement**; every repository chunks
  accordingly (`QUERY_CHUNK_SIZE = 80`, `DELETE_CHUNK_SIZE = 90`,
  `CHUNK_SIZE = 90` in `snapshotQueries.ts`, upsert batches of 100 in
  `refresh-metrics.ts`). New tables must follow the same discipline.
- Atomic multi-statement writes go through `runBatch`
  (`src/db/runBatch.ts`), never `db.batch` (pg driver has no `.batch`).
- Schema files: `app.schema.ts` (projects, keywords, rank tracking,
  activation, backlink snapshots), `gsc.schema.ts`, `audit.schema.ts`,
  `sam.schema.ts` (agent sessions + memory), `billing.schema.ts`,
  `better-auth-schema.ts` (user/org/**account** — OAuth token storage),
  `telemetry.schema.ts`, `reddit-attribution.schema.ts`.

Scoping model: everything hangs off `projects`
(`organizationId`, `name`, `domain`, `locationCode` default 2840,
`languageCode` default "en", `archivedAt` soft delete). The project's
location/language pair is "set during onboarding and reused by every
project-scoped data call."

---

## 2. Google Search Console

### 2.1 What is stored (almost nothing — by design)

`src/db/gsc.schema.ts` — the **only** GSC table:

```ts
export const gscConnections = sqliteTable(
  "gsc_connections",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull()...,
    organizationId: text("organization_id").notNull()...,
    // Stored verbatim from sites.list — "sc-domain:example.com" or
    // "https://example.com/". Never normalize; GSC matches it byte-for-byte.
    siteUrl: text("site_url").notNull(),
    // Whose google-search-console grant getAccessToken should use.
    connectedByUserId: text("connected_by_user_id").notNull(),
    gscAccountId: text("gsc_account_id"),
    connectedAccountEmail: text("connected_account_email"),
    ...
  },
  (table) => [
    // One selected property per project in v1; switching replaces the row.
    uniqueIndex("gsc_connections_project_idx").on(table.projectId),
    ...
  ],
);
```

OAuth tokens live in the better-auth `account` table under
`providerId = "google-search-console"` (`GSC_OAUTH_PROVIDER_ID` in
`src/shared/gsc.ts`), encrypted at rest, auto-refreshed by Better Auth
(`getAuth().api.getAccessToken` in `src/server/lib/gscClient.ts`).

**There is no GSC performance storage.** From
`specs/0003-google-search-console-integration.md`:

> One property per project (re-selecting replaces it); **no history or
> caching — every query hits Google live.**

Every consequence for rankloop flows from this line (see §7).

### 2.2 The client (`src/server/lib/gscClient.ts`)

Raw REST, no SDK. Free — the header comment is explicit: "Unlike the
DataForSEO client it does NOT meter credits — GSC is first-party data with
no per-call cost." Three endpoints:

- `listSites()` — Webmasters v3 `sites.list` (verified properties +
  `permissionLevel`; `siteUnverifiedUser` rows are not selectable).
- `querySearchAnalytics(siteUrl, body)` — `searchAnalytics.query`,
  returns `{ keys?, clicks, impressions, ctr, position }[]`.
- `inspectUrl(siteUrl, url, languageCode?)` — URL Inspection API
  (`searchconsole.googleapis.com/v1/urlInspection/index:inspect`),
  returning `indexStatusResult` (`verdict`, `coverageState`,
  `robotsTxtState`, `indexingState`, `lastCrawlTime`, `pageFetchState`,
  `googleCanonical`, `userCanonical`, `crawledAs`, `sitemap[]`,
  `referringUrls[]`), plus mobile/rich-results verdicts.

Error taxonomy: `GscTokenError` (grant revoked/expired — reconnect prompt),
`GscApiError` with `.status` (401/403 = expected grant failure; 429/5xx =
real fault). `isExpectedGrantFailure` in `GscService.ts` is the shared
classifier.

### 2.3 Dimensions, ranges, limits (`src/server/features/gsc/searchAnalytics.ts`)

```ts
export const GSC_DIMENSIONS = ["query","page","country","device","date","searchAppearance"] as const;
export const GSC_FILTER_OPERATORS = ["equals","notEquals","contains","notContains"] as const;
export const GSC_SEARCH_TYPES = ["web","image","video","news","googleNews","discover"] as const;
export const GSC_DATE_RANGES = ["last_7_days","last_28_days","last_3_months",
  "last_6_months","last_12_months","last_16_months"] as const;

export const GSC_DEFAULT_ROW_LIMIT = 1000;
// v1 caps rows-per-call at 1000 to protect the MCP context window. The GSC API
// supports up to 25000, but we keep fetched == returned so counts stay honest;
// the agent paginates with `startRow` for more.
export const GSC_MAX_ROW_LIMIT = 1000;
// GSC data trails by ~2-3 days; default the end of convenience ranges before it.
const GSC_DATA_LAG_DAYS = 3;
```

Hard facts a sync job must respect:

- **16-month floor**: `resolveDateRange` clamps any start date to
  `sixteenMonthFloor(today)` — Google keeps nothing older.
- **~3-day lag**: convenience ranges end `today − 3d`; `dataState: "all"`
  (the default everywhere) includes fresh/incomplete recent rows,
  `"final"` excludes them.
- **Multi-dimension queries work live**: the MCP tool allows up to 4
  dimensions per call, so `["query","page"]`, `["page","date"]`, or
  `["query","page","date"]` fan-outs are one call each. `searchAppearance`
  must be the only dimension when used (guarded in
  `search-console-tools.ts`).
- Filters are AND-combined and must be wrapped in
  `dimensionFilterGroups` — "GSC silently ignores a top-level `filters`
  field" (`buildSearchAnalyticsRequest` comment).
- Pagination: `startRow` offset; no total count from Google — callers
  fetch `pageSize + 1` to detect a next page
  (`getSearchPerformanceTable`).
- Dates are **Pacific Time** (stated in the MCP tool descriptions).

### 2.4 Consumers today

`src/serverFunctions/searchPerformance.ts` (the Search Performance page,
route `/p/$projectId/search-performance`) fires 4 live calls per page
load: daily series current + previous period (`DAILY_ROW_LIMIT = 200`),
`["query","page"]` at `STRIKING_DISTANCE_FETCH_LIMIT = 1000`, and a
country breakdown (`COUNTRY_ROW_LIMIT = 25`). Export pulls one dimension
at `EXPORT_ROW_LIMIT = 1000`.

`src/server/features/gsc/searchPerformanceReport.ts` holds the pure
shaping code the graft should reuse verbatim:

- `sumSearchTotals` — **impressions-weighted position**
  (`weightedPosition += row.position * row.impressions`, divided by total
  impressions). This is exactly PLAN.md's aggregation law, already in
  tree.
- `buildStrikingDistanceRows` — collapses `["query","page"]` fan-out to
  each query's **best page** (lowest position, ties by impressions), keeps
  the query only when that best page sits in the 5..20 band:

  ```ts
  // "Striking distance" = already ranking, not yet in the top spots: the queries
  // where a content improvement most plausibly moves real traffic.
  const STRIKING_DISTANCE_MIN_POSITION = 5;
  const STRIKING_DISTANCE_MAX_POSITION = 20;
  const STRIKING_DISTANCE_ROW_LIMIT = 100;
  ```

  This IS the page-2 signal's skeleton, minus floors and SERP-overlap
  routing.
- `previousPeriod` — same-length window immediately before
  `[start, end]`, for period-over-period deltas.

`GscService.getPerformance` (`services/GscService.ts`) is the single
entry: resolves the project's connection, throws `GscNotConnectedError`
when absent, builds the request, calls the connector's grant.
`GscService.inspectUrls` resolves the connection once and inspects 1–N
URLs sequentially with per-URL error capture (token errors abort the
batch). Nothing persists the inspection results.

MCP tools (`src/server/mcp/tools/search-console-tools.ts`):
`get_search_console_performance` (free, read-only, `hasMore` +
`nextStartRow` paging) and `inspect_urls` (1–10 URLs per call). Their
descriptions are the house voice for GSC copy — e.g. "First-party data —
use it for what already ranks, near-ranking queries, and pages with real
demand. ctr is a 0-1 fraction; position is a 1-based average; dates are
Pacific Time; the last ~3 days may be incomplete. Read-only; uses no
credits."

Self-hosted deployments need `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
`BETTER_AUTH_SECRET` (`oauth-config.ts` / `selfHostedOAuth.ts`;
docs/SELF_HOSTING_GOOGLE_SEARCH_CONSOLE.md). In Google "Testing" OAuth
mode grants expire ~weekly (spec 0003 consequence), so grant-failure
handling is a first-class state, not an edge case.

---

## 3. Keywords: saved list + latest-metrics cache

`src/db/app.schema.ts`:

- **`saved_keywords`** — the canonical user-saved list. Unique on
  `(projectId, keyword, locationCode, languageCode)`; insert is
  `onConflictDoNothing`. No metrics on the row itself.
- **`keyword_metrics`** — "Latest cached metrics for a keyword within a
  project." Columns: `searchVolume`, `cpc`, `competition` (0–1 ratio),
  `keywordDifficulty`, `intent`
  (informational/commercial/transactional/navigational/unknown),
  `monthlySearches` (JSON string of `{year, month, searchVolume}` —
  DataForSEO ships ~12 months of trend, so this is the only demand
  *history* stored), `fetchedAt`. Unique on the same 4-tuple;
  `upsertKeywordMetric` (`KeywordResearchRepository.ts`) is
  `onConflictDoUpdate` — **overwrite, latest-only, no metric history
  rows**.
- **`saved_keyword_tags`** / **`saved_keyword_tag_assignments`** —
  per-project tags (normalized-name unique), N:M assignments. The natural
  home for cluster labels if the graft reuses instead of adding a
  clusters table.

Write paths into `keyword_metrics` (all fire-and-forget or explicit, no
cron):

1. `research()` (`services/research/research.ts`) persists every fetched
   row via `persistRows` (void promise, error-logged).
2. Saving keywords from the research UI.
3. `refreshSavedKeywordMetrics` (`research/refresh-metrics.ts`) — explicit
   refresh: groups saved keywords by (location, language), one
   `fetchKeywordMetricsForList` per group, upserts in batches of 100.
4. Rank-tracking metric refresh (`rank_tracking_keywords` carries its own
   denormalized `searchVolume`/`keywordDifficulty`/`cpc` +
   `metricsFetchedAt`).

The saved-keywords list query (`listSavedKeywordsByProject`) left-joins
metrics on the 4-tuple and filters/sorts on volume, CPC, difficulty, tags,
include/exclude terms — the Opportunities queue can lift this pattern
wholesale.

---

## 4. Rank tracking (the only owned time-series today)

Tables (`app.schema.ts`):

- **`rank_tracking_configs`** — per project+domain+location:
  `devices` ("both"/"desktop"/"mobile"), `serpDepth` (10–100, multiple of
  10 — zod schema `src/types/schemas/rank-tracking.ts`),
  `scheduleInterval` ("daily"/"weekly"/"monthly"/"manual"),
  `locationName` (null = national; set = local config — partial unique
  indexes keep national and local configs distinct), `isActive`,
  `lastCheckedAt`, `nextCheckAt`, `lastSkipReason`.
- **`rank_tracking_keywords`** — unique `(configId, keyword)`; caps:
  `MAX_KEYWORDS_PER_CONFIG = 1000`, `MAX_CONFIGS_PER_PROJECT = 500`
  (`src/shared/rank-tracking.ts`).
- **`rank_check_runs`** — one row per execution; partial unique index
  `ON (config_id) WHERE status IN ('pending','running')` is the
  duplicate-trigger guard ("INSERT of a second pending run … fails with a
  unique-constraint violation"). `isSubsetRun` marks partial manual
  re-checks so trend queries can exclude them.
- **`rank_snapshots`** — one row per keyword × device × run. Unique
  `(runId, trackingKeywordId, device)`.
  `position` **null = checked but not found within serpDepth** ("a real
  event, not a missing check"), `url` = the ranking URL,
  `serpFeatures` = JSON array of feature type strings. Deliberately **no
  FK** to `rank_tracking_keywords`: "Historical snapshots are preserved
  after a keyword is removed."

Cadence and triggers:

- Worker cron `"*/15 * * * *"` (`wrangler.jsonc`) → `scheduled` handler
  (`src/server.ts`) → `runScheduledRankChecks` — scans
  `isActive = true AND nextCheckAt <= now`, skips orgs without a paid plan
  in hosted mode, advances `nextCheckAt` *before* starting the workflow
  ("to prevent retry storms"), then starts `RankCheckWorkflow`
  (Cloudflare Workflow).
- `computeNextCheckAt` anchors to the previous `nextCheckAt` so delayed
  runs don't drift; fresh configs get a random 04–09 UTC slot.
- Scheduled runs use DataForSEO's **task queue** (~30% of live price);
  manual runs use the live endpoint. Costs
  (`src/shared/rank-tracking.ts`): live $0.002 first page + $0.0015 per
  extra page; queued $0.0006 + $0.00045. Credits are pre-checked against
  the estimate before a run starts (`prepareRankCheckKeywords`).

Read queries already written (`repositories/snapshotQueries.ts`) — the
receipts/decay machinery can reuse these directly:

- `getKeywordHistory(configId, keywordId, sinceDays)` — flat per-keyword
  position series across completed runs.
- `getConfigTrend(configId, device, sinceDays)` — per-run distribution
  buckets (top3 / 4–10 / 11–20 / not-ranking), excluding subset runs.
- `getPositionMatrix` — last N runs × keywords matrix.
- `getSnapshotsForConfig` / `getSnapshotsBeforeDate` /
  `getEarliestSnapshotsForKeywords` — SQL GROUP BY + self-join picking one
  snapshot per keyword+device (latest, latest-before-date, or earliest)
  without loading all rows into JS.

**What rank tracking does NOT store:** the rest of the SERP. Only the own
domain's position/url/features survive; competitor URLs at other positions
are discarded at snapshot time.

---

## 5. Site audit (owned crawl corpus, run-scoped)

`src/db/audit.schema.ts` — all rows scoped to an `audits` run
(**manual trigger only**: `startAudit` server function →
`SiteAuditWorkflow`; config JSON `{ maxPages, lighthouseStrategy }`,
default 50 pages, plan-tiered ceiling):

- **`audit_pages`** — per crawled URL: `statusCode`, `redirectUrl`,
  `title`, `metaDescription`, `canonicalUrl`, `robotsMeta`, OG fields,
  h1–h6 counts + `headingOrderJson`, `wordCount`, image counts +
  `imagesMissingAlt`, `internalLinkCount`/`externalLinkCount`,
  `hasStructuredData`, `hreflangTagsJson`, **`isIndexable`**,
  `xRobotsTag`, `headerCanonicalUrl`, `crawlDepth` (null = sitemap-seeded,
  not link-reached), **`inSitemap`**, **`contentHash`** ("SHA-256 of the
  visible body text, for duplicate-content grouping"), `fetchClass`
  (ok/blocked/error), `responseTimeMs`.
- **`audit_links`** — internal link edges `(sourcePageId, targetUrl,
  anchor, isNofollow)`; external edges not yet stored but `isInternal`
  exists "so external-link checks can start writing rows without a
  migration".
- **`audit_issues`** — `(issueType, severity, pageUrl, detailsJson)`.
- **`audit_lighthouse_results`** — per page × strategy scores + CWV
  (`lcpMs`, `cls`, `inpMs`, `ttfbMs`), full payload in R2 via `r2Key`.

This is the closest thing to a **corpus manifest** in tree: latest audit
= page inventory with titles, word counts, indexability, in-sitemap flags
and the internal-link graph. It is run-scoped and manual, not a maintained
registry.

---

## 6. DataForSEO: endpoints, caching, metering

### 6.1 Client and metering (`src/server/lib/dataforseo/client.ts`, spec 0002)

All hosted access goes through `createDataforseoClient(customer)`; every
call is wrapped by `meter(...)`:

- **Self-host mode: no metering at all** (`if (!isHostedMode) return
  result.data`). Users bring their own DataForSEO key
  (docs/DATAFORSEO_API_KEY.md).
- Hosted: `assertUsageCreditsAvailable` preflight →
  execute → `trackUsageCreditSpend` with the **provider-reported** cost
  from the billing envelope (`envelope.ts`: every fetcher returns
  `{ data, billing: { path, costUsd } }`; `assertOk` is the single
  status/billing ladder; charged-but-failed tasks throw
  `DataforseoChargedTaskError` and still get metered).
- Credits: `AUTUMN_SEO_DATA_CREDITS_PER_USD = 1000`,
  `SEO_DATA_COST_MARKUP = 1.28` (`src/shared/billing.ts`). Autumn is the
  ledger; nothing spend-related is queryable in the app DB beyond
  `billing_customer_status`.
- Spend attribution: every call maps to a `CreditFeature`
  (`keyword_research`, `rank_tracking`, `local_seo`, …) with per-call
  override via `creditFeature` in the input — a grafted feature should
  pass its own feature name, exactly as onboarding does.
- The ~3 MB `dataforseo-client` SDK loads lazily behind
  `loadDataforseoSections()` — one dynamic import boundary. New endpoints
  go in `sections.ts` + a section module, then a `meter()` entry.

Endpoint surface (client namespaces): `keywords.related/suggestions/ideas`
+ Google-Ads `adsIdeas`/`adsSearchVolume`; `labs.keywordOverview`
(≤700 kw/batch, `KEYWORD_METRICS_BATCH_SIZE` in `keyword-metrics.ts`) and
`labs.serpCompetitors`; `domain.rankOverview/rankedKeywords/relevantPages`;
`serp.live/rankCheck/rankCheckTaskPost/local`; `backlinks.summary/rows/
referringDomains/domainPages/history`; `lighthouse.live`; `aiSearch.*`;
`business.*`.

### 6.2 Provider routing (spec 0004 — load-bearing for cost math)

`getKeywordDataProvider(locationCode)` (`src/shared/keyword-locations.ts`)
routes each country to exactly one provider — Labs (94 countries; the only
source of KD, intent, SERP context; $0.01/task + $0.0001/row) or Google
Ads endpoints ($0.075 flat, 217 countries, **no KD/intent** —
`keywordDifficulty: null`, `intent: "unknown"`). Clickstream-refined
volumes **double** the request cost and are opt-in per call (default off).
Google Ads live endpoints allow **12 requests/min per DataForSEO
account**. Local (sub-country) metrics merge Ads local volume with Labs
national KD/intent (`fetchKeywordMetricsForList`, spec 0008) and never
silently substitute national volume for local.

### 6.3 Caching (R2 JSON, soft TTL)

`src/server/lib/r2-cache.ts`: R2 objects under `dataforseo-cache/`,
SHA-256 key of sorted params, soft expiry via `customMetadata.expiresAt`,
Zod-validated on read ("schema drift between writes and reads is
otherwise silent"). Cache writes go through `waitUntil`, not
fire-and-forget ("workerd cancels unregistered pending I/O once the
response is sent").

| prefix | TTL | keyed by (notable) |
|---|---|---|
| `kw:research` | 24 h | org, project, keywords, loc, lang, limit, mode, clickstream, `CACHE_VERSION = 3` |
| `serp:analysis` | 12 h | keyword, loc, lang, org, project |
| `domain:overview` | 12 h | org, project, domain, subdomains, loc, lang |
| `domain:keyword-suggestions` / `keywords-page` / `pages-page` | 12 h | same pattern |
| `backlinks:overview` / tabs | 6 h | |
| `ai-search:brand-lookup` | 24 h | |
| `ai-search:prompt-response` | 7 d | |

Because `organizationId`/`projectId` are in the keys, cached vendor data is
**never shared across tenants**. Ahrefs free Domain Rating is cached in KV
for 24 h (`serverFunctions/ahrefs.ts` — free, keyless, not billed).

Non-vendor storage of vendor data: `backlink_snapshots` (append-only
point-in-time summaries, "written by the dashboard's visit-triggered
refresh"; domain stored per row "so a later project-domain change doesn't
rewrite history") and the denormalized metric columns on
`rank_tracking_keywords`.

---

## 7. Signal → data mapping (rankloop L1 vs what exists)

Shorthand: **LIVE** = computable now via live GSC pass-through (no
storage), **DB** = computable from owned tables, **MISSING** = needs new
storage or sync.

| Signal | Computable from, today | What is missing |
|---|---|---|
| **Unserved demand** (impressions, no owned page serving on purpose) | LIVE: `GscService.getPerformance({dimensions:["query","page"]})` gives query→page pairs with impressions and weighted position; 1000 rows/call with `startRow` paging. `buildStrikingDistanceRows` already computes best-page-per-query. | (a) **A corpus manifest** — "no owned page's primary topic matches the query" needs a registry of published pages with primary query/topic. Closest proxies: `audit_pages` (run-scoped, manual) and `gsc` page dimension (only pages with impressions). (b) **A stored `gsc_performance` (page × query × date) table** for stable 28-day windows, floors that scale with traffic, and "no backlog row covers it" joins — live-only reads recompute the world every time and die on properties larger than the row cap. (c) Backlog/opportunities table to dedupe against. |
| **Almost-ranking (page-2)** | LIVE + code: striking-distance band 5..20 with best-page collapse is implemented (`searchPerformanceReport.ts`), impressions-sorted, cap 100. | Floors (`page2Floor`), brand-query exclusion, and the **SERP-overlap router** — needs cached top-10 URL sets per query. `serp.live` fetches them ($0.002/kw, 12 h R2 cache keyed per org/project) but only organic items are kept and nothing persists beyond the cache TTL. A durable `serp_snapshots` store is new. |
| **CTR deficit → RETITLE** | LIVE: per-query/page `ctr` (0–1) and weighted position come straight off `searchAnalytics.query`; expected-CTR curve is a constant table. `previousPeriod` gives the comparison window. | Per-band site medians need stored history. Dampening on AI Overview/featured-snippet requires the SERP snapshot store (`serpFeatures` exists only for *tracked* keywords in `rank_snapshots`). The 60-day re-fire suppression needs a proposals/actions log. |
| **Keyword gap** | DB+vendor: `domain.rankedKeywords` (Labs) for any competitor domain — per-keyword volume/CPC/KD + `ranked_serp_element` position/URL/etv (`labs.ts`, Zod-schema'd because the SDK types it loosely; `totalCount` for paging). GSC is the we-rank-nowhere check (LIVE). `labs.serpCompetitors` discovers competitors from seed keywords. | A **tracked-competitors list** per project (no table exists; competitor step in `project_activation_state` is click-through only). Gap results are 12 h-cached but not persisted; a young site's "NULL KD passes" rule needs the backlog store to hold vendor rows with null metrics (schema already tolerates nulls everywhere — `keyword_metrics` columns are all nullable). |
| **KD ceiling (adaptive)** | DB: `keyword_metrics.keywordDifficulty` for saved keywords + LIVE GSC top-10 check; or `rank_tracking_keywords.keywordDifficulty` joined to latest `rank_snapshots.position <= 10`. | Brand-token exclusion config; a place to persist the current ceiling + its weekly movement (max +5/sync) — i.e. a per-project settings/state row. |
| **SERP weakness** | Vendor: `serp.live` items carry domain, type, `etv`, backlinks info per result. | Word-count/age of competitor pages (needs fetching competitor URLs — nothing in tree does this); durable SERP snapshots again. |
| **Cluster coverage** | Partial DB: `saved_keyword_tags` can carry cluster labels; `keyword_metrics` supplies volume/intent for scoring. | Cluster definitions with `plannedMin`, and published-count per cluster — both live in the missing corpus manifest / proposals tables. |
| **Decay → REFRESH** | LIVE only, and only within Google's window: 16-month lookback supports YoY 28d-vs-28d for 13+-month-old properties, recomputed on every read. | A stored daily series makes this cheap and stable; "page age ≥ 6 months" and "peak week ≥ 10 clicks" need per-page first-seen tracking (corpus manifest) and weekly aggregates. |
| **Cannibalization → MERGE** | LIVE: `["query","page","date"]` (3 dims, one call) exposes URL flip-flopping across days; both-pages-stuck-8–30 is a filter over the same rows. | Nothing structurally — but doing this live per-query is O(rows × days); the stored page×query×date table is what makes it a SQL window function instead of a re-crawl of Google's API. |
| **Indexation throttle** | LIVE: `GscService.inspectUrls` returns verdict/coverageState/lastCrawlTime per URL (free; MCP caps 10/call, service takes 1–N sequentially). `audit_pages.isIndexable`/`inSitemap` give the crawl-side view per audit run. | **Persistence**: inspection results are returned, never stored. The trailing-30d cohort rate needs an `indexation_checks` (url, checkedAt, verdict, coverageState) table + a daily sampling job. Note Google's own quota (~2000 inspections/day/property) — the sequential loop in `inspectUrls` is fine at cohort-sample size. |
| **Receipts (attribution)** | DB for tracked keywords: `rank_snapshots` history via `getKeywordHistory` / `getSnapshotsBeforeDate` gives before/after positions per device. LIVE GSC for clicks/impressions in fixed windows. | Per-article target-query registry (which queries belong to which published article — corpus manifest again), an actions log with execution timestamps to anchor windows, and stored GSC dailies for the diff-in-diff baseline of untouched queries. |

### The one-sentence conclusion

Day-one computability is high — weighted-position aggregation,
striking-distance banding, period comparison, ranked-keywords gap data,
rank-snapshot history and URL inspection all exist as working code — but
**every 28-day-windowed signal is recomputed against Google live on every
read**, because the app deliberately stores no GSC rows. The graft's first
schema additions are, in dependency order:

1. `gsc_performance` — page × query × date rows, daily sync re-pulling the
   trailing 3 days (`GSC_DATA_LAG_DAYS`), onboarding backfill bounded by
   the 16-month floor, upsert-on-(project, page, query, date) following
   the `keyword_metrics` conflict-target pattern. The existing `*/15` cron
   + Workflow + `pgStep` machinery (`RankCheckWorkflow.ts`,
   `scheduledRankChecks.ts`) is the template — including the
   advance-schedule-before-run and partial-unique-active-run idioms.
2. A corpus manifest (published pages: url, primary query, topic/cluster,
   first-seen, source article) — nothing comparable exists; `audit_pages`
   is the column-vocabulary reference.
3. `serp_snapshots` (query, capturedAt, top-10 URL set + features) —
   promote the existing 12 h R2 `serp:analysis` cache into durable rows at
   brief time.
4. `indexation_checks` — persist what `GscService.inspectUrls` already
   returns.
5. Proposals/opportunities + actions log — lifecycle, TTL, re-fire
   suppression, receipts anchoring.

Everything else (metering, caching, batching, D1 parameter limits,
location/language scoping, credit attribution, grant-failure UX) has an
established in-tree pattern to copy, and §2–§6 name the file to copy it
from.
