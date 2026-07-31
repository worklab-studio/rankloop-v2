# Write-side rails (rankloop S0)

## Status

Accepted (August 2026) — implementation step S0 of the rankloop master
plan (`../../docs/PLAN.md`). This spec covers only the rails: schema,
migrations, and the `@rankloop/engine` dependency. Screens, workflows and
server functions arrive in S1+ under their own spec sections.

## Goal

Give the Write side (site study → competitors → keyword universe → page
plan → articles → receipts) durable, dual-dialect storage that passes
`schema-parity.test.ts`, plus a consumable build of the pure-TS rankloop
engine (laws, scoring, briefs, quota — zero LLM calls) that bundles in
this app's vite/workerd toolchain.

## Non-goals

No UI, no server functions, no workflows, no nav changes, no data
backfill. Nothing user-visible ships in S0.

## Tables

Conventions follow the house rules: text UUID PKs minted with
`crypto.randomUUID()` in services, text timestamps (`current_timestamp` /
`isoNow` defaults per dialect), `projectId` FKs → `projects.id` with
cascade, partial unique indexes for one-in-flight guards, JSON as text
columns with `_json` suffix. New files (do NOT edit upstream schema
files): `rankloop-data.schema.ts` + `rankloop-write.schema.ts`, each with
a `pg/` twin, registered wherever the existing schema files are
aggregated. Keep every file under the 400-line oxlint cap.

### rankloop-data (facts in)

- **gsc_pages** — id · projectId · url. unique(projectId, url).
  Interned page URLs (single-D1 size reality: raw text in the fact table
  would 5–10x row+index size).
- **gsc_queries** — id · projectId · query. unique(projectId, query).
- **gsc_performance** — id · projectId · pageId(fk gsc_pages) ·
  queryId(fk gsc_queries) · date (YYYY-MM-DD; first-of-month when
  grain='month') · grain ('day'|'month', default 'day') · clicks int ·
  impressions int · ctr real · position real.
  unique(projectId, pageId, queryId, date, grain).
  90d daily grain + monthly rollups; top-N/day cap with an aggregated
  remainder row (pageId/queryId nullable is NOT allowed — the remainder
  row uses dedicated interned sentinel rows created by the sync service).
- **content_pages** — id · projectId · url · path · kind
  ('post'|'page'|'hub'|'other') · title · description · publishedAt ·
  modifiedAt · wordCount int · category · keyword · pageTypeId (nullable,
  fk page_types, set null) · inlinkCount int · outlinkPathsJson ·
  contentHash · source ('crawl'|'publish') · lastCrawledAt.
  unique(projectId, url). The maintained corpus manifest (site study
  derives it from audit runs; publishes append to it).
- **serp_snapshots** — id · projectId · keyword · purpose
  ('plan'|'grounding') · organicJson · paaJson · featuresJson (AIO /
  snippet / heavy-ads flags) · fetchedAt. index(projectId, keyword,
  fetchedAt). History table — no unique; refreshes append.
- **indexation_checks** — id · projectId · url · verdict · coverageState ·
  checkedAt. index(projectId, url, checkedAt). Persists URL Inspection
  results (upstream fetches but never stores them).

### rankloop-write (decisions out)

- **competitors** — id · projectId · domain · status
  ('suggested'|'tracked'|'skipped') · discoveredVia · domainRank int ·
  organicKeywords int · estTraffic real · backlinks int ·
  referringDomains int · coverage ('full'|'sitemap_only') nullable ·
  lastStudiedAt. unique(projectId, domain).
- **competitor_pages** — id · competitorId (fk cascade) · url · title ·
  pageType · etv real · keywordCount int · wordCount int ·
  structuralFeaturesJson · status ('active'|'decayed'|'removed') ·
  firstSeenAt · lastSeenAt. unique(competitorId, url). Monthly snapshots
  update in place; decayed/removed statuses are the what-not-to-build
  signal.
- **keyword_backlog** — id · projectId · keyword · source
  ('gsc'|'gap'|'expansion'|'autocomplete'|'harvest'|'manual') · seed ·
  category · format · pageTypeId nullable (set null) · searchVolume int
  nullable · keywordDifficulty int nullable · intent · score real ·
  status ('discovered'|'planned'|'proposed'|'queued'|'published'|
  'skipped'|'needs_human') · clusterKey · notesJson · createdAt ·
  updatedAt. unique(projectId, keyword). NULL volume/KD admitted by
  doctrine (the min_volume=0 law).
- **page_types** — id · projectId · name · kind ('pseo'|'blog'|'hub') ·
  status ('proposed'|'approved'|'declined') · urlPattern ·
  keywordPattern · templateContractJson · dataSourceJson (mode:
  'dataset'|'compiled'|null + config) · hubContentPageId nullable ·
  evidenceJson · serpCheckJson · demand int · instanceCount int ·
  createdAt · decidedAt. unique(projectId, name).
- **page_type_data** — id · pageTypeId (fk cascade) · entity · rowJson ·
  provenanceJson (per-cell sourceUrl + fetchedAt) · confidence real ·
  needsReview int (0/1) · updatedAt. unique(pageTypeId, entity).
  The "no data row, no page" backbone.
- **proposals** — id · projectId · type ('write_new'|'retitle'|'refresh'|
  'push'|'merge'|'prune') · track ('optimize'|'net_new') · status
  ('proposed'|'approved'|'declined'|'executing'|'done'|'measured'|
  'expired') · target (keyword or path) · title · pageTypeId nullable ·
  keywordBacklogId nullable · contentPageId nullable · score real ·
  factorsJson · evidenceJson · createdAt · expiresAt · decidedAt ·
  executedAt. Partial unique(projectId, type, target) WHERE status IN
  ('proposed','approved','executing') — a failed INSERT is the
  already-active signal, per house idiom.
- **articles** — id · projectId · proposalId (fk) · pageTypeId nullable ·
  keyword · slug · title · description · status ('briefing'|'writing'|
  'gate'|'fixing'|'review'|'approved'|'publishing'|'published'|'failed')
  · attempts int · writerMode ('agent'|'api') · model · briefMd ·
  content · lawReportJson · adapter · adapterRef · publishedUrl ·
  publishedAt · costUsd real · createdAt · updatedAt.
  Partial unique(proposalId) WHERE status NOT IN ('published','failed')
  — one in-flight article per proposal.
- **receipts** — id · projectId · actionType · articleId nullable ·
  contentPageId nullable · targetQuery · status ('baseline'|'measuring'|
  'measured'|'contaminated') · baselineJson (window + metrics) ·
  resultJson · windowStart · windowEnd · measuredAt · createdAt.
  index(projectId, status).
- **llm_spend** — id · projectId · operation · provider · model ·
  inputTokens int · outputTokens int · costUsd real · articleId nullable
  · occurredAt. index(projectId, occurredAt). Self-host cost ledger
  (hosted metering stays Autumn's).

## Engine dependency

`@rankloop/engine` (monorepo `packages/engine`) gains a bundled build
(tsup → `dist/index.js` + `dist/index.d.ts`, exports map updated; source
`.ts`-extension imports stay — tsup handles them) and this app depends on
it via `link:../../packages/engine`. Acceptance: a colocated vitest test
imports `{ score, validate }` from `@rankloop/engine` and asserts a known
parity value, and `pnpm vite build` bundles it (pure TS, no node APIs —
workerd-safe by construction).

## Acceptance (all must pass)

1. `pnpm db:generate` produces migrations for BOTH dialects; `pnpm
db:migrate:local` applies cleanly.
2. `schema-parity.test.ts` green (structural equality of the new tables
   across dialects).
3. Engine smoke test green under the app's vitest.
4. `pnpm ci:check && pnpm test:ci && pnpm vite build` all green (knip
   included — if new schema exports trip knip, configure it the same way
   existing schema files are handled, smallest diff possible).
