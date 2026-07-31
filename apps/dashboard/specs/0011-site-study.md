# Site study + Dashboard cards (rankloop S2)

## Status

Accepted (August 2026) — step S2 of `../../docs/PLAN.md`. Depends on S0
(spec 0009) and S1 (spec 0010).

## Goal

Turn a project's crawled site into the maintained **content inventory**
(`content_pages` — the corpus manifest every later phase reads: internal
link candidates, duplicate checks, laws context), and give the Dashboard
its first rankloop surfaces: the Content inventory card, the Authority
card, and the **progress spine** — the one primary-tinted checklist card
narrating the pipeline.

## Non-goals

Competitor study (S4), signals/proposals (S6), page-type classification
beyond the coarse kind heuristic (S6 refines via page_types), monthly GSC
rollups. No new nav.

## Approach: extend the audit, don't fork the crawler

Upstream's SiteAuditWorkflow already owns robots handling, frontier
batching, body caps, and batched writes; `audit_pages` already stores
title, wordCount, isIndexable, inSitemap, contentHash, crawlDepth.

1. **Additive columns on audit_pages** (upstream pair, both dialects,
   migrations + parity): `publishedAt` nullable (first hit of JSON-LD
   datePublished → `article:published_time` meta → `<time datetime>` →
   sitemap lastmod), `modifiedAt` nullable (dateModified /
   article:modified_time / sitemap lastmod), `outlinkPathsJson` nullable
   (same-origin outlink PATHS discovered on the page, deduped, capped at
   50 — the crawler already parses these links for its frontier; we
   persist the capped list instead of discarding it).
   Extraction lives in the existing crawl step with dense WHY-comments;
   extraction failures degrade to null, never fail a page.
2. **SiteStudyWorkflow** (new, Cloudflare Workflow): params { runId,
   projectId }. Steps: (a) ensure a completed audit run ≤7 days old,
   else start one via the existing AuditService and poll its status with
   step sleeps (30s interval, give up after 30 min → run error);
   (b) derive: promote the latest completed run's audit_pages into
   `content_pages` (upsert on (projectId, url); source='crawl'):
   - kind heuristic (pure function in a .logic.ts, unit-tested):
     'post' when publishedAt present OR path matches common blog shapes
     (/blog/, /posts/, /articles/, dated paths); 'hub' when the page's
     outlinks contain ≥8 distinct 'post' paths and wordCount < 500;
     'page' otherwise; 'other' for non-indexable/utility paths.
   - inlinkCount computed by inverting the outlinkPathsJson graph across
     the run (pure function, tested).
   - stale content_pages rows (source='crawl', url absent from this run)
     are deleted; source='publish' rows are never touched by derive.
     (c) finish run row.
3. **rankloop_study_runs is NOT a new table** — reuse `gsc_sync_runs`?
   No: different domain. Add **site_study_runs** (dual-dialect + parity):
   id · projectId (fk cascade) · status ('pending'|'running'|'done'|
   'error') · auditRunId nullable · pagesDerived int nullable · error
   nullable · startedAt · finishedAt nullable. Partial
   unique(projectId) WHERE status IN ('pending','running').
   **Both this service and S1's GscSyncService get the house stale-run
   self-heal**: on start, when an active run exists, probe the workflow
   instance status (60s startup grace, audit-service idiom); missing or
   terminally-failed instance → flip the row to error and proceed. This
   also closes S1's known gap — apply the same probe to
   GscSyncService.startSync in this step.

## Dispatch

- Manual: server functions `startRankloopSiteStudy` /
  `getRankloopSiteStudy` (project-scoped, layered, zod projectId uuid).
- Scheduled: extend the cron body — weekly re-study per project (latest
  done study > 7 days), ≤5 starts/tick, after the GSC dispatch block.

## Dashboard surfaces (house DNA to the letter)

All inside the existing project Dashboard grid (half-width cards, lg
span rules preserved). Sentence case, provenance stamps, no new colors.

1. **Progress spine** — the ONE primary-tinted card (their accented-card
   idiom), full-width like the onboarding checklist, placed directly
   under it (or replacing it when all upstream checklist items are done).
   Rows with live counts, each deep-linking:
   "Site studied · 214 pages, 34 posts" (→ nothing yet; plain text) ·
   "Search memory · 84 days stored" (→ GSC Insights) ·
   "Competitors · arrives with the next update" (muted, no link) ·
   "Page plan · after competitors" (muted).
   States: pending rows show the small spinner + gerund ("Studying your
   site · 134/214 pages" from the audit run's progress, their polling
   idiom); errored rows show the standard error text quietly.
2. **Content inventory** CardShell — Stats row: posts · pages · median
   words · last published (em dash when unknown). A 12-month cadence
   mini-bar (plain divs, h-8, bg-primary/20 with bg-primary for the
   max month — no chart lib for a card this small), and a one-line
   detected-kinds summary as tag-chips (slate). Empty state (no study
   yet): "Study your site to see what you've published." + `btn
btn-primary btn-sm` "Study my site". Stamp: "crawled 214 pages · 4h
   ago".
3. **Authority** CardShell — reuses the existing backlinks feature's
   service/cache for the project domain: backlinks · referring domains ·
   domain rank · new/lost 30d as Stats (success/error tones on
   new/lost). Without a DataForSEO key: the house setup-pitch state
   (benefit sentence + "Open setup guide" link), never an error. Stamp:
   "DataForSEO · snapshot Jul 31".

## Files

- upstream audit schema pair (+3 columns) + crawl-step extraction
- site_study_runs in the rankloop-write pair (+ parity)
- `src/server/workflows/SiteStudyWorkflow.ts` + wrangler + server.ts
- `src/server/features/rankloop/site-study/{services,repositories}/…`
  (+ `derive.logic.ts` pure functions: kind heuristic, inlink inversion)
- stale-run probe shared helper + applied in gsc-sync and site-study
  services
- `src/serverFunctions/rankloopSiteStudy.ts` + zod schemas
- scheduled-handler extension (weekly study block)
- `src/client/features/dashboard/` additions: RankloopProgressSpine,
  ContentInventoryCard, AuthorityCard (+ registration in DashboardPage)
- vitest: derive.logic tests (kind/inlink edge cases), service tests
  (poll-timeout, stale-run self-heal both services, derive delete-scope),
  crawl extraction tests if the house tests cover crawlPage similarly

## Acceptance

1. Migrations both dialects + parity green.
2. `pnpm ci:check && pnpm test:ci && pnpm vite build` green; dev boots.
3. Dev proof without any API key: "Study my site" runs an audit +
   derive on a local/demo target, Content inventory populates, the
   spine narrates states; Authority card shows the setup pitch.
4. Upstream audit behavior unchanged for existing surfaces (its tests
   stay green; new columns are additive).
