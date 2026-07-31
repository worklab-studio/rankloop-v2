# The graft plan — Write-side into the OpenSEO fork, one step at a time

Companion docs (generated from deep study of the vendored code, read them
before writing any code): DESIGN-DNA.md · DESIGN-VOICE.md ·
DASHBOARD-ARCHITECTURE.md · DASHBOARD-JOBS.md · DASHBOARD-GSC-DATA.md ·
GRAFT-CONVENTIONS.md.

## Ground rules (non-negotiable)

1. **Indistinguishable from upstream.** Every screen follows DESIGN-DNA +
   DESIGN-VOICE to the letter: CardShell anatomy, AppDataTable, tag-chips,
   text-opacity ladder, provenance stamps, sentence-case copy, cost
   transparency, layout-cloning skeletons. The 12 anti-AI rules in
   DESIGN-DNA are review criteria, not suggestions.
2. **Their architecture law**: server fn → service → repository →
   provider-aware schema; dual-dialect tables + parity test; nav only via
   items.ts; oxlint limits; `pnpm ci:check && pnpm test:ci && pnpm vite
   build` green before every step ships. A numbered spec (specs/0009-…)
   opens the work.
3. **The grader is never the author** — laws run in @rankloop/engine,
   zero LLM.

## What the study changed (discoveries → decisions)

- **GSC stores nothing upstream** (live API per request). rankloop's first
  real contribution is *memory*: a `gsc_performance` page×query×date table.
  Bonus: their `searchPerformanceReport.ts` already ships tested
  impressions-weighted position AND striking-distance (5–20 band) — our
  page-2 signal skeleton exists as upstream code.
- **Cloudflare Workflows work in every environment** (miniflare persists
  state locally and in Docker) → minutes-long article writing is safe
  self-hosted. But **cron triggers never fire locally/self-host** — daily
  routines get a DO-alarm scheduler (the agents package ships one, unused)
  plus the existing cron body for Cloudflare deploys.
- **Everything runs in workerd, even Docker** → no child processes, no fs
  writes: the git publish adapter is GitHub-API-based (contents/PR
  endpoints), not a local git binary. WordPress REST + webhook are pure
  fetch. (The Python CLI remains the local-filesystem path.)
- **LLM plumbing already exists** (OPENROUTER key threading, cost capture,
  Autumn metering hosted-side) → the writer reuses it; BYO Anthropic/OpenAI
  keys ride the same interface. Self-host spend lands in our ledger tables.

## The steps (each one PR-sized, CI-green, usable on its own)

**W0 — Spec + rails.**
`specs/0009-write-side.md` in their format. Dual-dialect tables:
`gsc_performance`, `proposals`, `articles`, `receipts`,
`indexation_checks`, `serp_snapshots`, `llm_spend` — parity test green,
migrations generated. Make `@rankloop/engine` consumable from the app
(tsc build → dist, `file:` dep). No UI yet.

**W1 — GSC memory (the fuel).**
`GscSyncWorkflow`: 90-day backfill at connect, daily delta re-pulling the
trailing 3 days (GSC finalizes late), PT dates, 1000-row paging. Dispatch:
cron body (Cloudflare) + DO-alarm (local/self-host) + a "Sync now" button
in their setup-card idiom. GSC Insights keeps its live view; signals read
the table.

**W2 — Signals + the Opportunities screen (read-only first).**
Signal service: page-2 (generalizing their striking-distance code),
CTR-deficit (relative, position-banded), unserved demand (clustered,
brand-excluded), gap (their keyword_metrics + Labs), scored by
@rankloop/engine with factor logging. New nav group **Write** →
Opportunities: AppDataTable, evidence tag-chips, score with expandable
factor breakdown ("More details"), provenance stamp ("computed nightly ·
GSC 28d · last sync 2h ago"). It must look right and score right on real
data before any button exists.

**W3 — Approve/decline + trust rail.**
Proposal lifecycle (proposed → approved/declined, 10-day TTL, batch
approve), their confirm-modal voice, PostHog events, settings card for the
trust dial with their cost-transparency idiom ("~$0.25 per article with
your key · you approve every title").

**W4 — The writer.** *(dogfooding starts the day this works)*
`ArticleWriteWorkflow`: brief (engine + their DataForSEO client + R2 SERP
cache, persisted to serp_snapshots) → draft (their LLM plumbing, BYO key)
→ **laws gate (engine)** → fix loop ≤3 → review/failed. One-in-flight via
their partial-unique-index idiom; metered steps retries=0. Articles
screen: pipeline list + detail (law-report checklist, minimal editor that
re-runs the gate on save).

**W5 — Publish + receipts.**
Adapters: WordPress REST, webhook, GitHub API (commit/PR). IndexNow ping.
Receipts: baseline recorded in the same transaction as publish-success;
evaluation window days 14–42, diff-in-diff vs site trend; Receipts screen
in their chart DNA (fixed-width recharts, no animation, trend vars).

**W6 — Intelligence deepening.**
serp_snapshots → SERP-overlap cannibalization gate + weakness scoring;
URL-Inspection results persisted → indexation rate → **quota throttle**;
decay + PRUNE proposals once gsc_performance has enough weeks.

**W7 — Autopilot + routine.**
Catch-up quota (engine), daily routine dispatch, in-app digest (email via
their Loops path hosted-side later), autopilot gated on the 90-day receipt
cohort per action type.

## Sequencing logic

Fuel (W1) before intelligence (W2) before actions (W3) before generation
(W4) before shipping (W5): every step produces something real to look at,
and nothing writes a word until the queue has proven its judgment on the
operator's own data.
