# Competitor intelligence (rankloop S4a)

## Status

Accepted (August 2026) — first half of step S4 of `../../docs/PLAN.md`.
Depends on S2 (crawl extraction idioms). S4b (spec 0015) adds the
Outreach planner.

## Goal

Tracked competitors with a studied playbook: discovery (key-gated) +
manual adds (free), a CompetitorStudyWorkflow (metrics + top-earning
pages + the winners-vs-losers blog study, with the sitemap-only degraded
path), monthly refresh with decay detection across snapshots, and the
new **Plan** screen (Write group) with a functional Competitors tab and
a competitor detail drill-in.

## Non-goals

Outreach planner (S4b) · SERP co-occurrence discovery (S6, needs the
serp corpus) · keyword gap → backlog flow (S5 consumes what this stores)
· page-type planner (S6).

## Schema (dual-dialect + parity)

- competitors gains `studySummaryJson` nullable (aggregate playbook:
  cadence timeline, page-type mix, winners-vs-median feature deltas,
  medians) — one migration per dialect.
- New **competitor_study_runs**: id · projectId (fk cascade) ·
  competitorId (fk competitors cascade) · status ('pending'|'running'|
  'done'|'error') · coverage ('full'|'sitemap_only') nullable ·
  pagesStudied int nullable · error nullable · startedAt · finishedAt
  nullable. Partial unique(competitorId) WHERE status IN
  ('pending','running'). Workflow instance id === run id. staleRunProbe
  applies.

## Discovery + tracking

- `discoverCompetitors` (service): Labs competitors_domain through the
  house metered DataForSEO client (R2-cached per the `domain:*` 12h TTL
  idiom); upserts status='suggested' rows (never downgrades 'tracked').
  Key-gated: no key → AppError the surface renders as the setup pitch.
- Manual add: domain input → validated bare domain (tldts, upstream
  dep) → status='tracked' immediately + study kicked.
- "Track" on a suggested row → 'tracked' + study kicked. "Skip" →
  'skipped'. Cost sentence in the UI: "studying a competitor costs
  ~$0.15 and refreshes monthly" (their ~-idiom).

## CompetitorStudyWorkflow

Params { runId, projectId, competitorId }. Steps (pgStep, free steps
retry 2, metered steps retry 0):

1. **Metrics** (key-gated, non-fatal if keyless — record nulls):
   domain rank / organic keywords / est traffic via the existing domain
   feature's service.
2. **Top-earning pages** (key-gated, non-fatal): labs relevantPages
   (the already-wrapped fetchRelevantPages), filtered to path prefixes
   that look like content (heuristic shared with S2's kind logic),
   top 100 by etv → competitor_pages upserts (etv, keywordCount).
3. **Sitemap study** (free, always runs): fetch robots.txt → sitemap(s)
   (reuse upstream discovery.ts parsing), build: cadence timeline from
   lastmod (24-month monthly buckets), URL-shape page-type mix (the S2
   path heuristics), total content-page count. HTML fetch of the blog
   index NOT required.
4. **Winners crawl** (free, only when HTML is fetchable): crawl top-30
   earning pages + a 15-page median sample (25 fetches/step, 2MiB body
   cap, robots-respecting — reuse the audit fetch helpers), extract
   structural features (dataTable, faqBlock, media count, byline,
   dateModified present, wordCount — reuse/extend S2 extraction into a
   shared pure function). First blocked/403'd batch → set
   coverage='sitemap_only' and skip remaining crawling gracefully.
5. **Summarize**: winners-vs-median feature deltas + medians →
   competitors.studySummaryJson; competitor_pages statuses: on a
   REFRESH run, pages present in the prior snapshot but now absent
   from sitemap/relevantPages → 'removed'; pages whose etv dropped
   ≥60% from the prior snapshot → 'decayed' (pure diff function,
   tested; first run leaves all 'active'). lastStudiedAt + run done.

Scheduled block: monthly refresh (tracked, lastStudiedAt > 30d, ≤3
starts/tick, after the receipts block).

## Surfaces

- **Nav**: Write group gains **Plan** (icon Map) ABOVE Articles —
  final Write shape: Plan · Articles · Receipts.
- **Route** `plan/` layout: h1 "Plan", subtitle "Who you're up against,
  what demand exists, and which pages are worth building." tabs-border:
  "Competitors (N tracked)" functional · "Keywords" · "Page types" ·
  "Outreach" as muted tabs rendering house empty states ("Arrives with
  the next update." one-liner each).
- **Competitors tab**: Add-competitor row (input input-sm + "Add"
  btn-sm, tldts-validated, error toast on junk). Suggested section
  (when discovery has run): compact table domain · overlap keywords ·
  Track btn-primary btn-sm / Skip btn-ghost btn-sm + the cost sentence
  as the section stamp. No key → the setup-pitch state for discovery
  only (manual add always visible above it). Tracked table
  (table table-sm): domain (link to detail) · domain rank (— when
  keyless) · est traffic · pages studied · coverage tag-chip
  (full=emerald "studied" / sitemap_only=amber "sitemap only") · last
  studied stamp · study status (spinner while running, their polling
  idiom).
- **Detail route** `plan/competitors/$competitorId` (drill-in, no nav
  entry): PageHeader = domain, subtitle "Studied {date} · refreshes
  monthly". Cards: **Authority** (Stats: domain rank, organic
  keywords, est traffic; keyless → setup pitch); **Top earning pages**
  (table: path · etv tabular-nums · keywords · type tag-chip; stamp
  "DataForSEO Labs · top 100 by traffic value"); **Blog playbook**
  (cadence 24-month mini-bar reusing the S2 div-bar idiom · page-type
  mix as tag-chips with counts · winners-vs-median deltas as a small
  table: feature · winners % · median % — only when coverage='full',
  else the sitemap-only note "studied from sitemap only — their pages
  block crawling"); **Decayed & removed** (table of
  status!='active' pages with status tag-chips rose/slate; empty
  state: "Appears after the first monthly refresh." — the
  what-not-to-build panel).
- Progress spine: the "Competitors" row goes live — "Competitors · N
  tracked, M studied" linking to /plan; keep "Page plan · after
  competitors" muted.

## Files

- schema deltas + parity · `src/server/workflows/CompetitorStudyWorkflow.ts` +
  wrangler + server.ts ·
  `src/server/features/rankloop/competitors/{discovery services, study services, repositories, study.logic.ts}`
  (pure: page-type mix, cadence buckets, feature extraction reuse,
  winners-vs-median, snapshot diff) · serverFunctions/
  rankloopCompetitors.ts + zod schemas · scheduled monthly block ·
  `src/client/features/rankloop-plan/…` + routes + items.ts (one item) + spine
  row update
- vitest: study.logic (mix/cadence/diff/deltas edge cases), services
  (keyless degradation per step, blocked-HTML → sitemap_only, refresh
  diff transitions, stale-run heal), discovery upsert semantics
  (suggested never downgrades tracked), WP-style mocked fetch for
  sitemap/robots parsing

## Acceptance

1. Parity + migrations green;
   `pnpm ci:check && pnpm test:ci && pnpm vite build` green; dev boots.
2. Keyless dev proof (seeded): manually add a competitor (seeded
   sitemap fixtures via mocked target or seeded DB rows) → tracked row
   renders with coverage chip; detail renders playbook from seeded
   studySummaryJson; discovery section shows the setup pitch; spine row
   live.
3. Metered paths proven against mocked client in tests (no live key).
4. All three keyless degradations honest in UI: no error states where
   a setup/degraded state belongs.
