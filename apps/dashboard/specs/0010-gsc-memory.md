# GSC memory (rankloop S1)

## Status

Accepted (August 2026) — step S1 of `../../docs/PLAN.md`. Depends on S0
(spec 0009). Upstream GSC stays live-per-request; this spec adds the
stored history every rankloop signal reads.

## Goal

A durable page×query×date memory of Search Console data per project:
90-day backfill on first sync, daily deltas that re-pull the trailing 3
days (GSC finalizes late), top-N capping with sentinel remainder rows,
all through the interned-id tables from S0. Plus the minimum surface to
run and see it: a "Sync now" action and a provenance stamp.

## Non-goals

Monthly rollups (deferred until data ages past 90d), signals/proposals
(S6 of the plan — here we only store), DO-alarm dispatch (S9), any new
nav. No upstream behavior changes: GSC Insights keeps its live queries.

## New table (dual-dialect + parity, house idioms)

- **gsc_sync_runs** — id (text UUID) · projectId (fk cascade) · mode
  ('backfill'|'daily') · status ('pending'|'running'|'done'|'error') ·
  rangeStart · rangeEnd (YYYY-MM-DD, PT) · rowsWritten int nullable ·
  error nullable · startedAt · finishedAt nullable.
  Partial unique(projectId) WHERE status IN ('pending','running') — the
  failed INSERT is the already-running signal (audit-runs idiom).
  Workflow instance id === run row id.

## GscSyncWorkflow (Cloudflare Workflow — works in dev/Docker/CF alike)

Params `{ runId, projectId, mode }`. Steps (every DB step via pgStep):

1. Resolve the project's gsc_connections row + tokens (existing
   GscService client). No connection → mark run error, stop.
2. Compute the date range in **Pacific Time** (GSC's calendar):
   backfill = 93 days ago → 4 days ago; daily = (last stored date − 2)
   → 4 days ago, capped at 14 days per run (catch-up beyond that = the
   next daily run continues; eager watermark, no retry storms).
3. Per date: query dimensions [page, query] with date filters, page
   through results (1000-row limit + startRow, their GSC_MAX_ROW_LIMIT
   idiom), cap at the top 2500 rows by impressions; aggregate the
   remainder into ONE row attributed to the per-project sentinel
   entries (url `__rankloop:other__` / query `__rankloop:other__`,
   interned once by the service).
4. Intern pages/queries via batched upserts (runBatch, ≤100 bound params
   per statement), then insert performance rows with
   onConflictDoUpdate on the 5-column unique (re-pulled trailing days
   overwrite — GSC data finalizes late, last write wins).
5. Update the run row (rowsWritten, status done) in the same step as the
   final batch. Retries: free idempotent steps retry 2 (GSC reads are
   unmetered); no metered steps exist here.

## Dispatch

- **Scheduled**: extend the single `scheduled` handler's body (the house
  cron, `*/15`): select projects with an active GSC connection whose
  latest stored date < 4 days ago AND no pending/running sync run;
  insert run row (partial-unique guard) + start workflow, ≤10 per tick.
  (Cron fires only on Cloudflare deploys; self-host uses the button until
  S9's DO-alarm.)
- **Manual**: server function `startRankloopGscSync` (project-scoped,
  zod `projectId: z.string().uuid()`, service→repository layering).
  Duplicate start returns the existing active run, not an error.
- **Status**: `getRankloopGscMemory` returns { lastRun, latestDate,
  dayCount, rowCount } for the stamp and for polling (3000ms while a
  run is active, their idiom).

## Surface (minimal, house voice)

On the GSC Insights page (search-performance), below the existing
controls: one quiet row — stamp text "rankloop memory · 84 days stored ·
synced 2h ago" (text-[11px] text-base-content/45) + a `btn btn-ghost
btn-sm` "Sync now" that flips to "Syncing…" with the standard small
spinner while a run is active. When no memory exists yet: "rankloop
memory · not synced yet" + the same button reading "Back-fill 90 days".
Errors surface as the standard toast via getStandardErrorMessage.

## Files (per GRAFT-CONVENTIONS)

- schema: add to rankloop-write pair (or a new small pair if line caps
  demand) + parity registration
- `src/server/workflows/GscSyncWorkflow.ts` + wrangler.jsonc workflows
  entry + re-export from src/server.ts
- `src/server/features/rankloop/gsc-sync/{services,repositories}/…`
  (`as const` object literals of free functions; no classes)
- `src/serverFunctions/rankloopGsc.ts` + `src/types/schemas/rankloopGsc.ts`
- scheduled-handler extension beside runScheduledRankChecks
- UI touch in the search-performance feature (smallest possible diff)
- vitest: service tests (mocked gsc client + repo): PT date math, paging,
  top-N + sentinel remainder, watermark/catch-up cap, duplicate-start;
  behavioral test for the partial-unique runs guard

## Acceptance

1. Dual-dialect migrations + parity green.
2. Service tests green; `pnpm ci:check && pnpm test:ci && pnpm vite
build` all green.
3. Manual proof in dev: with a connected GSC project, "Sync now"
   back-fills and the stamp reports days/rows; a second click during a
   run does not double-start (partial-unique proof).
4. Upstream GSC Insights behavior unchanged.
