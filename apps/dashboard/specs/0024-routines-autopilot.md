# Routines, digest, and earned autopilot (rankloop S9)

## Status

Accepted (August 2026) — step S9 of `../../docs/PLAN.md`, the last
planned build step. Depends on every prior step; nothing new is
computed here, this is what makes the machine run itself and hand the
operator a single daily surface.

## Goal

Three things:

1. **Routines run everywhere**, including self-host and local, where
   Cloudflare cron never fires.
2. **One daily digest** — the surface a solo operator actually reads.
3. **Autopilot is earned, per action type, by the 90-day receipt
   cohort** — never a toggle someone flips on faith.

## 1. Dispatch that works in all three environments

The problem (documented in `../../docs/DASHBOARD-JOBS.md`): the
`*/15` cron only fires on Cloudflare deploys. In local dev and Docker
self-host — the default install — every scheduled block silently never
runs, and nothing in the app admits it.

Fix, using what the fork already ships: the `agents` package's
Durable-Object alarm scheduler (present, unused). A single
`RoutineSchedulerAgent` DO per project sets an alarm at the next due
time and, on wake, invokes the same block functions the cron body
calls. Both paths converge on one exported `runProjectRoutines(env,
projectId, now)` so a routine can never behave differently by
environment; the cron body becomes a loop over due projects calling it,
and the DO becomes a per-project alarm calling it once.

- Cloudflare deploys: cron drives it (DO alarms idle as a backstop).
- Docker / local: the DO alarm drives it. Alarms *do* fire in
  miniflare, which is why this is the mechanism.
- The DO is armed on project creation and re-armed at the end of every
  wake; a project whose alarm was lost is re-armed by the next
  user request through a cheap `ensureArmed` on read paths.
- **Honesty**: the Settings surface states which mechanism is driving
  this deployment and when the next run is due. No silent no-ops.

## 2. The daily digest

One `digest` per project per day, generated after the morning routine:
- proposals awaiting a decision (top 5 by score with their evidence),
- what shipped yesterday (articles + their URLs),
- receipts that became `measured` (the wins, and the honest nulls),
- anything blocked: throttle active, gate failures in review, adapter
  errors, spend near a ceiling.

Delivery: **in-app first** (a Digest card on the Dashboard listing the
last 7 digests, each expandable), with email as an opt-in that reuses
the fork's existing Loops transactional path when configured, and a
webhook for self-hosters who want it elsewhere. A digest with nothing
in it is not sent and not stored — silence is information.

`digests` table: id · projectId (fk cascade) · forDate · payloadJson ·
deliveredJson (channels + status) · createdAt. Unique(projectId,
forDate).

## 3. Autopilot, earned

`trustDial` already exists per project (`titles` | `drafts` |
`autopilot`) and is currently stored but not honored end to end. S9
makes it real, **per action type**:

`autopilotEligibility(actionType)` (pure, tested) over receipts whose
evaluation window closed ≥90 days ago for that action type:
- fewer than **5 measured receipts** → not eligible ("needs 5 measured
  results, has 2"),
- median trend-adjusted position delta must be an **improvement**, and
  at most **1 in 5** may be worse than baseline → eligible,
- otherwise not eligible, with the numbers stated.

Honoring it:
- `titles` — a human approves each proposal; a passing draft
  auto-approves (already S7b behavior).
- `drafts` — a human approves the draft before publishing.
- `autopilot` — for **eligible action types only**, the routine
  approves and executes without a human: retitle/push execute; net-new
  writes, gates, and publishes. Ineligible types fall back to `drafts`
  behavior and say why on screen. MERGE and PRUNE are **never**
  autopilot-eligible, regardless of receipts.
- Every autopilot action is recorded with `decidedBy='autopilot'` so
  the receipts view can separate machine decisions from human ones.

Kill switches, because this is the mode that publishes without asking:
the indexation throttle already caps volume; additionally autopilot
pauses itself on 3 consecutive failed gates or any adapter auth error,
and says so in the digest.

## Schema

- `digests` (new, both dialects + parity).
- `proposals.decidedBy` ('human'|'autopilot', nullable) + migration.

## Surfaces

- **Settings → Automation**: which dispatcher is active and the next
  run time; the trust dial with **per-action eligibility rendered
  honestly** — "retitle: eligible (7 measured, median +3.1
  positions)" / "net-new: needs 5 measured results, has 2"; the kill
  switch state when tripped.
- **Dashboard → Digest card**: last 7 digests, newest expanded.
- **Receipts**: a small chip distinguishing autopilot decisions from
  human ones.

## Files

- `RoutineSchedulerAgent` (DO) + wrangler binding + `runProjectRoutines`
  extracted so cron and alarm share one path
- `src/server/features/rankloop/routines/{digest.logic.ts,
  autopilot.logic.ts,services,repositories}` + tests
- `digests` + `decidedBy` schema, migration, parity
- serverFunctions + Settings/Dashboard/Receipts surfaces
- tests: dispatcher convergence (cron and alarm produce identical
  effects for the same clock), digest assembly incl. the empty case,
  eligibility branches (all four), autopilot honoring per type,
  MERGE/PRUNE never eligible, kill-switch trips, `decidedBy` recorded

## Acceptance

1. Parity + migrations green; `pnpm ci:check && pnpm test:ci && pnpm
   vite build` green; dev boots.
2. **Dispatch proof**: with cron disabled (local), a DO alarm fires the
   routine and the run rows appear; and `runProjectRoutines` invoked
   from both paths with the same clock produces the same DB effect.
3. **Digest proof**: a seeded day produces a digest with each section
   populated; a quiet day produces none at all (assert no row).
4. **Autopilot proof**: seed receipt histories for three action types —
   one eligible, one with too few, one with poor results — and assert
   the routine autopublishes only the eligible type, that the other two
   fall back with their stated reasons, and that MERGE/PRUNE never
   execute unattended.
5. **Kill-switch proof**: three consecutive gate failures pause
   autopilot and the pause appears in the digest.
