# Optimize-existing signals + the Write surface (rankloop S3a)

## Status

Accepted (August 2026) — first half of step S3 of `../../docs/PLAN.md`.
Depends on S1 (GSC memory) + S2 (content inventory). S3b (spec 0013)
adds the WordPress update adapter, execution, and receipts.

## Goal

The first proposals: deterministic signals computed from the project's
OWN stored data (gsc_performance × content_pages), scored with logged
factors, surfaced in a new **Write** nav group on an **Articles** screen
(Proposed tab) with approve/decline. Nothing executes yet — the queue
must first look right and score right on real data.

## Non-goals

Execution/adapters/receipts (S3b) · net-new WRITE_NEW proposals, MERGE,
PRUNE (S6) · net-new writer (S7) · email digest (S9).

## Signals (pure functions in signals.logic.ts, unit-tested; all

thresholds named constants with WHY-comments)

Inputs per project: 28d window of gsc_performance (daily grain, sentinel
rows excluded), content_pages (kind='post'|'page'), project brand tokens
(name + domain stem — brand queries excluded from every signal).
Positions are impressions-weighted everywhere (Σ(pos×impr)/Σimpr).

1. **RETITLE (CTR deficit, relative)** — per (page, query) with
   `impr28 >= 100`: expectedCtr from the fixed band curve (p1 .28, p2
   .15, p3 .10, p4 .07, p5 .05, p6–10 .03, p11–20 .015; below p20 no
   signal). Fire when `actualCtr <= 0.55 × expectedCtr`. One proposal
   per page (the highest-impression qualifying query is the headline
   evidence; others listed). Score = `impr28 × deficit` (recovered-
   clicks units). Suppressed when the same page had a retitle proposal
   decided < 60 days ago.
2. **PUSH (striking distance)** — per (page, query) with `5 <= wPos <=
20` and `impr28 >= 30`: score = engine base (volume imputed from
   impr28, NULL KD) × inverted-U proximity (peak ~pos 11: 1.5×, decaying
   both directions). Evidence: pos, impr, the page. One proposal per
   (page, query).
3. **REFRESH (decay, guarded)** — requires ≥ 8 weeks of stored memory,
   page age ≥ 6 months (publishedAt), peak week ≥ 10 clicks; fire when
   trailing-28d clicks ≤ 0.7 × prior-28d AND impressions also declined
   (demand loss, not CTR loss). Will produce zero until memory ages —
   ship the code + tests anyway.

## Proposal lifecycle (service + repository, house layering)

- computeProposals(projectId): expire active proposals past their 10-day
  TTL (status → 'expired'); evaluate signals; INSERT with the S0
  partial-unique guard (failed insert = already active, skip silently);
  factorsJson (name/value/note per factor) + evidenceJson (chips) always
  populated — every score must be explainable.
- Triggers: (a) a new final step in GscSyncWorkflow after a successful
  sync (compute rides the fresh data); (b) server fn
  `refreshRankloopProposals` (manual); (c) weekly scheduled block is NOT
  added (sync-chained compute covers cadence).
- Decisions: `decideRankloopProposal({ projectId, proposalId, decision:
'approved'|'declined' })` — valid only from 'proposed'; posthog
  events; approved proposals just sit (S3b executes them).
- Reads: `getRankloopProposals({ projectId, status? })` ordered score
  desc.

## Surface

- **Nav**: new group **Write** (between Overview and Research) in
  navigation/items.ts — items: Articles (icon FileText). (Plan and
  Receipts arrive in later steps; one item now.)
- **Route**: `src/routes/_project/p/$projectId/articles/` layout +
  index. h1 "Articles" (Title Case nav identity), subtitle sentence:
  "Proposals from your own search data. Nothing changes your site
  without a yes."
- **Tabs** (tabs-border): "Proposed (N)" · "Approved" · "Declined" —
  counts live. Approved/Declined show the same table filtered;
  empty states in house voice ("Nothing approved yet." /
  "No proposals yet — they appear after your search memory syncs.").
- **Table** (table table-sm, AppDataTable if it fits naturally): type as
  tag-chip (retitle=sky, push=violet, refresh=amber), proposal title +
  mono target sub-line, evidence tag-chips, score (tabular-nums,
  expandable factor-breakdown row via the "More details" ghost idiom),
  Approve `btn btn-primary btn-sm` + Decline `btn btn-ghost btn-sm`
  (optimistic, toast past-tense "Approved" / "Declined", invalidate).
  Stamp: "computed after each search memory sync · proposals expire
  after 10 days".
- Progress spine: the muted "Competitors · arrives with the next
  update" row stays; no spine changes in S3a.

## Files

- `src/server/features/rankloop/proposals/{signals.logic.ts,
services,repositories}` + colocated tests (curve/deficit/banding/
  decay-guards/TTL/dedupe-suppression edge cases)
- GscSyncWorkflow: append compute step (pgStep, retries 2, failure of
  compute must NOT fail the sync run — wrap and record)
- `src/serverFunctions/rankloopProposals.ts` + zod schemas
- navigation/items.ts Write group · routes + feature dir
  `src/client/features/rankloop-articles/…`
- engine already linked — score via @rankloop/engine

## Acceptance

1. `pnpm ci:check && pnpm test:ci && pnpm vite build` green; dev boots.
2. Signal unit tests cover: weighted position, band edges (p20/p21),
   deficit boundary, brand exclusion, floors, retitle 60-day
   suppression, decay guards (young page / thin data / clicks-only
   decline all suppress), TTL expiry, duplicate-insert skip.
3. Dev proof: with seeded gsc_performance + content_pages fixtures (a
   seed script or test route is fine), the Articles screen lists
   proposals with evidence and factor breakdowns; approve/decline
   round-trips; second compute run does not duplicate.
4. Upstream surfaces untouched except items.ts (one group added).
