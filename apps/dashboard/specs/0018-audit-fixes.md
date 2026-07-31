# Audit fixes — S0–S3b defects (rankloop F1)

## Status

Accepted (August 2026). Not a feature step: this is the fix contract for
the seven distinct defects confirmed by the five-lens adversarial audit
of the S0–S3b code (28 candidate findings → 9 confirmed after
independent refutation → 7 distinct after dedupe). Each fix below is the
*verified* minimal shape, which in three cases differs from what the
original reporter proposed.

Ordering is deliberate: the three HIGH defects each silently disable a
product guarantee, so they land first and each carries a regression test
that fails before the fix.

---

## F1.1 — HIGH · receipts starvation (platform-wide)

`receipts/repositories/ReceiptsRepository.ts` (`getDueReceipts`)

**Defect.** The due query is global, oldest-first, capped at 50, and two
of `runMeasurementPass`'s outcomes (`wait_for_data`, pruned-page skip)
never change a receipt's status — so an un-advanceable receipt matches
again on every 15-minute tick forever. Archived projects make this
reachable by design: `archiveProject` is a soft delete, the GSC sync
due-query deliberately excludes archived projects, so their watermark
freezes permanently and every open receipt they own becomes immortal.
Once 50 accumulate, **no project on the instance ever measures a receipt
again** — the product's proof mechanism, dead, with only a repeating
"50 waiting on data" log line as the symptom.

**Fix (both parts, in this order).**

1. **Deferral cursor (load-bearing).** Add nullable `nextCheckAt` (text)
   to `receipts` in both dialects + migration + parity. Stamp it to
   tomorrow in the `wait_for_data` and pruned-page branches; add
   `(next_check_at IS NULL OR next_check_at <= :today)` to the due
   query. This is the `rank_tracking_configs.nextCheckAt` idiom already
   in the repo — an un-advanceable row yields its slot for a day
   instead of holding it 96 times.
2. **Watermark + archived pre-filter.** Left-join the per-project
   `max(date) where grain='day'` subquery (the
   `GscSyncRepository.getProjectsDueForSync` pattern) and require
   `latest_date >= windowEnd` on the closed-window arm; inner-join
   `projects` on `isNull(archivedAt)`. The baseline-flip arm stays
   unconditional.

Keep the `lagged` observability by counting separately (cheap
`count(*)`), not by returning rows that cannot transition.

**Regression test.** 60 receipts across two projects where project A's
watermark is frozen behind `windowEnd`: assert project B's receipt is
returned by `getDueReceipts` and that A's stamped rows are excluded on
the same day.

---

## F1.2 — HIGH · PUSH re-proposal loop destroys its own receipts

`proposals/signals.logic.ts` + `proposals/repositories/ProposalsRepository.ts`

**Defect.** Only RETITLE consults recent decisions. An executed PUSH
flips to `done`, leaves the partial-unique index, and the next
sync-chained compute re-emits an identical candidate (GSC cannot reflect
link work for ~2 weeks). If the user acts on the duplicate,
`isContaminated` sees a second execution inside the window and closes
the original receipt as contaminated — **rankloop invalidating its own
measurement**. Ignored duplicates churn forever via the 10-day TTL.

**Fix.** Generalize the suppression the retitle path already has, with
two corrections the verification surfaced:

- anchor on `coalesce(executedAt, decidedAt)`, not `decidedAt` — a
  push approved on the 1st but executed on the 20th has a receipt window
  running past a decidedAt-anchored cutoff, which is exactly the window
  we must not re-propose inside;
- widen the repository predicate to `(decidedAt >= cutoff OR executedAt
  >= cutoff)` and return both columns — the current `gte(decidedAt,…)`
  would drop such rows entirely;
- cover **declines** too, not just executions (a declined push has no
  `executedAt` and no receipt, and is otherwise re-proposed on the very
  next sync).

Apply to push and refresh; keep retitle's existing 60-day semantics.
Suppression window = the receipt evaluation window (42 days) for
executed rows, the existing decision window for declined ones.

**Regression test.** Execute a push → run compute twice → assert no
second proposal exists for the same (page, query), and that a declined
push is likewise not re-proposed.

---

## F1.3 — HIGH · a degraded crawl wipes the content manifest

`site-study/services/SiteStudyService.ts` (`deriveFromAudit`)

**Defect.** The stale-row delete runs unconditionally after the upsert.
A completed-but-degraded audit (WAF challenge day, site-wide 5xx: pages
crawled, none loadable) derives zero eligible pages and therefore
deletes **every** crawl-sourced `content_pages` row — taking with it the
category/keyword/pageTypeId columns the upsert deliberately preserves,
and starving every downstream signal that reads the manifest.

**Fix (smaller than first proposed — no size heuristic needed).** In
`deriveFromAudit`, between upsert and delete: if the eligible set is
empty while the audit crawled pages, throw with a message naming the
audit id and both counts. The run lands in `error`, the manifest
survives, the next weekly study repairs it. WHY-comment states the
distinction: *no loadable pages is a degraded crawl, not an emptied
site*.

**Regression test.** Audit with N crawled pages, zero eligible →
`deriveFromAudit` throws and `content_pages` still holds the prior rows.

---

## F1.4 — MEDIUM · a stranded run row removes a project from cron forever

`gsc-sync`, `site-study`, `competitors` repositories (the `activeRuns`
subqueries)

**Defect.** Due-queries exclude projects with a pending/running run, but
`getStaleRunReason` is only reachable from a *user-triggered* start. A
run row that outlives its workflow instance (deploy mid-run, instance
lost) therefore removes that project from the scheduled flywheel
permanently — and self-host, where nobody clicks the manual button,
never recovers.

**Fix.** Age-bound the exclusion rather than adding a reaper to each
block: in each `activeRuns` subquery, only *young* active runs suppress
the project (`startedAt > wedgeCutoff`, one shared constant). An older
active run re-enters the tick and the existing blocked-INSERT probe
settles it — a live instance returns already-running, a dead one is
flipped to error and the work proceeds. One predicate, three call sites.

**Regression test.** A pending run older than the cutoff → the project
appears in the due query; a young one → it does not.

---

## F1.5 — LOW · lost CAS still writes an orphan receipt

`proposals/repositories/ExecutionRepository.ts` (`markDoneWithReceipt`)

**Defect.** The proposal flip is a CAS on `status='approved'` but the
receipt insert is unconditional in the same batch, so a losing
concurrent execute writes a receipt with no transition behind it. The
code's comment claims contamination detection catches this; it cannot
(`isContaminated` reads *proposals*, and the loser stamped no
`executedAt`).

**Fix.** Gate the insert on the CAS outcome *inside the batch*:
`INSERT INTO receipts (…) SELECT … WHERE EXISTS (SELECT 1 FROM proposals
WHERE id=:proposalId AND project_id=:projectId AND executed_at=:executedAt)`.
The winner inserts, the loser inserts zero rows; identical on D1 and pg;
no migration. **Also correct the false comment** — that is mandatory
regardless of whether the insert guard lands.

---

## F1.6 — LOW · stale GSC rows double-count against the sentinel

`gsc-sync/repositories/GscSyncRepository.ts` (`upsertPerformanceRows`)

**Defect.** Re-pulling a date only inserts/updates. A (page, query) pair
present in an earlier pull but absent from a later one keeps its stale
row, which is then counted *in addition to* the sentinel remainder row
that now represents it — inflating that day's totals.

**Fix.** The marker + stale-delete idiom the repo already uses (see
`SiteStudyRepository.deleteStaleCrawlPages`, whose comment explains why
a `NOT IN` list blows D1's ~100-param cap): add a `syncMark` column to
`gsc_performance` (both dialects + migration + parity), have `syncDay`
pass one stable per-(run, date) mark onto every row it writes including
the sentinel, then after all batches land delete rows for that
(project, date, grain) whose mark differs.

---

## F1.7 — LOW · provenance stamp misreads D1 timestamps

`client/features/search-performance/SearchPerformanceMemoryStamp.tsx`

**Defect.** `formatRelative` parses with a bare `new Date(iso)`,
dropping the SQLite `current_timestamp` normalization that both
`cardParts.formatDay` and `ContentInventoryCard`'s own copy carry — so
the stamp reports a wrong age on D1 deployments (the default self-host
path).

**Fix.** Hoist the guarded `formatRelative` into `cardParts.tsx`
(which already owns `formatDay`'s identical normalization) and import it
in both call sites, deleting the local copy. One implementation owns the
dialect difference.

---

---

## F1.8 — MEDIUM · outreach targets freeze silently when they leave the gap

`rankloop/outreach/…` (recompute path, found by S4b's own verifier)

**Defect.** The recompute upsert skips human-owned targets (status moved
or a note written) entirely, so a target that no longer qualifies keeps
its old `competitorCount`/`evidenceJson` forever — the UI presents stale
computed numbers as current.

**Fix.** On recompute, targets that are human-owned but absent from the
fresh gap get their computed columns marked stale rather than skipped:
add nullable `staleAsOf` (text) to `outreach_targets` (both dialects +
migration + parity); set it when a human-owned target falls out, clear
it when it returns. The table renders a slate "no longer in the gap"
tag-chip and dims the computed cells; human columns are still never
touched. Non-human-owned rows that fall out are deleted as today.

## F1.9 — LOW · `contactUrl` has no writer (dormant column)

Both schemas comment it as "discovered from the crawl" and the message
modal renders a Contact-page block, but nothing in S4b populates it.
It degrades correctly (the block only renders when present), so this is
a gap, not a bug.

**Fix.** Populate it cheaply inside the existing competitor study crawl:
when fetching a target domain is already happening, record the first
same-origin link whose path matches `/contact|/about|/write-for-us/`
(a named constant, WHY-commented). No new fetches, no email extraction
— page URLs only, per the product law. If that crawl does not cover
outreach targets, leave the column unwritten and **remove the modal
block** instead; a permanently empty UI affordance is worse than none.

---

## Ratified: `specs/` is exempt from prettier

S4b added `specs/` to `.prettierignore` because the markdown printer
changes spec *meaning* (a line opening `>= cutoff)` becomes a
blockquote). That call is correct and stands: prose contracts are not
machine-formatted. Specs stay hand-wrapped at ~72 columns.

## Acceptance

1. Each HIGH fix ships with a regression test that **fails against the
   pre-fix code** (state this explicitly in the report).
2. Dual-dialect migrations + `schema-parity.test.ts` green (F1.1 and
   F1.6 add columns).
3. `pnpm ci:check && pnpm test:ci && pnpm vite build` green; dev boots.
4. No behavior change beyond the seven defects — this is a fix pass, not
   a refactor.
