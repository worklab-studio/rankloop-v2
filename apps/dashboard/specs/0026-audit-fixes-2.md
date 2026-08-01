# Audit fixes — S4a–S9b defects (rankloop F2)

## Status

Accepted (August 2026). Fix contract for the 16 defects confirmed by the
six-lens adversarial audit of S4a–S9b (29 candidates → 16 confirmed
after independent refutation; 13 refuted). Full verified analysis per
finding, including each verifier's reasoning, is at
`/private/tmp/claude-501/-Users-worklab-Rankloop/0de63739-055e-41ce-aeb6-5bed8d342c8e/scratchpad/audit2.json`
— **read it; the fixes below are summaries of verified analysis, and in
several cases the verifier's fix differs from the reporter's.**

Eight HIGH findings, folded into seven entries below (the money and
workflow-integrity lenses reported the same root cause independently).
Three of those cost real money or corrupt user data while nobody is
watching, so they lead.

## Shipped fixes that differ from the reporter's proposal

Recorded here per acceptance item 5, because in each case the reporter's
fix would have introduced a new defect:

- **F2.1** — the reporter folded every terminal failure into
  `consecutiveGateFailures`. That breaks the passing "does not blame the
  gate for a provider outage" test and would pause a whole project for
  one 502. Shipped: a **separate writer streak** with its own pause
  sentence, plus the per-proposal ceiling that stops the spend.
- **F2.2** — the reporter's `assertUsageCreditsAvailable` throws, and a
  throw inside the retries-0 metered step lands as `internal_error`,
  erasing the reason the user needs. Shipped: a balance check returning
  a named `insufficient_credits` failure, every branch gated on hosted
  mode so self-host BYO-key behavior is unchanged.
- **F2.3** — the reporter put the catch in `AutopilotRunService.publishPhase`,
  which can never observe it: `startPublish` returns as soon as the
  workflow instance is created, and AppError identity does not survive a
  step boundary. Shipped: recorded at the adapter seam inside the step.
- **F2.11** — shipped with a `windowSaturated` signal rather than the
  proposed inventory diff, so a page that merely fell out of the
  rank-limited window is never called `removed`.

---

## F2.1 — HIGH · unbounded metered respend (the money leak)

`routines/services/AutopilotService.ts:112` + `AutopilotRepository.ts:246`
(reported twice, by the money and workflow-integrity lenses)

An article landing `failed` for any reason other than `laws_unmet` —
truncation, unparseable frontmatter, internal error — is dropped by
`toGateOutcomes` (empty `laws` **and** a non-`laws_unmet` reason), so the
kill switch never counts it. But `failed` frees the proposal's in-flight
slot, so `writePhase` re-drafts the same proposal on the next wake.
**Steady state: 2 proposals × 96 wakes/day × ~$0.12 ≈ $23/day, forever**,
for keywords that will never succeed. `shared/rankloop-autopilot.ts`
literally promises "the kill switch trips three failed gates later" —
false for every non-gate failure.

**Fix (both halves):**
1. Bound retries per proposal on the **unattended path only**:
   `getWritableNetNewProposals` also selects each proposal's failed-article
   count; `writePhase` skips at `AUTOPILOT_PROPOSAL_FAIL_LIMIT` (2,
   declared in `shared/rankloop-autopilot.ts` beside the other caps) and
   **logs the refusal by name** ("2 drafts failed before reaching review
   — it needs a human"). Filter in the loop, not the WHERE clause: a
   silent skip violates this file's own every-refusal-says-why contract.
   The human path (`serverFunctions/rankloopWriter.ts`) is untouched, so
   "write again now that I fixed the page type" still works.
2. Give non-gate terminal landings their own counter and pause reason
   (`consecutiveWriterFailures` → "autopilot paused — 3 drafts in a row
   never reached the gate"), rather than folding them into
   `consecutiveGateFailures` and breaking the existing tested semantics.

**Regression test:** a fixture whose draft fails by *truncation* (not by
a graded report) must pause autopilot and must not re-spend. The current
kill-switch proof passes only because its fixture fails via
`laws_unmet`; this is the untested class.

## F2.2 — HIGH · the writer never bills

`writing/services/ArticleWriteService.ts:265`

OpenRouter calls — the most expensive operation in the product — write
only to the local `llm_spend` table. No `assertUsageCreditsAvailable`
preflight and no `trackUsageCreditSpend`, unlike every other paid path.
On a hosted deployment the writer is free to the tenant and costs the
operator; self-host is unaffected.

**Fix:** mirror the DataForSEO metering path exactly — preflight before
the call, track after it, hosted-mode-gated by `isHostedServerAuthMode()`
so self-host behavior does not change. Keep `llm_spend` as the local
ledger regardless (it is what the cost stamps read).

## F2.3 — HIGH · the auth-error pause can only be tripped by a human

`routines/services/AutopilotService.ts:271`

Spec 0025 says any adapter auth error pauses autopilot immediately.
`reconcile` reads `publish_connections.status='failed'` — a column only
ever written by the **manual** "Test connection" button. An unattended
publish that 401s never sets it, so the pause never fires and autopilot
keeps hammering a dead credential.

**Fix:** have the publish path record the auth failure on the connection
row (status `failed` + reason) when an adapter throws
`PUBLISH_AUTH_FAILED`, so the existing reconcile branch becomes
reachable. That keeps one definition of "this connection is broken".

## F2.4 — HIGH · approved page types never bind their keywords

`page-plan/services/PagePlanService.ts:193`

`proposeTypes` skips candidates whose name is already `decided` — which
skips the *binding* path as well as the write. `bindKeywordsToPageType`
is only called from `decidePageType` on the approve transition, so
keywords that enter the backlog **after** a type was approved are never
bound to it, and never become net-new proposals. The flywheel's output
silently stops reaching the writer.

**Fix:** re-bind on every plan run for approved types (binding is
idempotent — it only claims unclaimed `discovered`/`planned` rows), or
bind at selection time. Prove with a test: approve a type, add a
matching keyword, run the plan, assert the new keyword is bound.

## F2.5 — HIGH · PublishWorkflow can strand an article forever

`workflows/PublishWorkflow.ts:69`

The only workflow in this phase with no terminal failure handler.
`preflight` claims the article into `publishing`; any throw in the five
steps after it leaves that status set permanently — **including when the
post is already live on the user's site**.

**Fix:** wrap the post-preflight steps with a terminal handler that
records the failure and lands the article deterministically: back to
`review` when nothing was written, or to `published` with the recorded
`adapterRef` when the create succeeded and a later step threw (the
adapterRef is the evidence). Never leave `publishing`.

## F2.6 — HIGH · a publish can never be retried

`publish/services/PublishService.ts:522`

`startPublish` uses the article id as the Workflow instance id and
swallows every `create()` rejection as `alreadyPublishing: true`.
Instance ids are permanent, so once any publish run has existed for an
article, no second run can ever start — every retry silently reports
"already publishing" and nothing happens.

**Fix:** derive the instance id per attempt (article id + attempt
counter or run id) and distinguish "instance exists" from other create
failures instead of swallowing all of them.

## F2.7 — HIGH · WordPress rendered HTML written back as source

`publish/services/wordpressClient.ts:423`

`findPostContentBySlug` falls back to `content.rendered` when
`content.raw` is absent, and that rendered HTML is merged and PUT back
as the post's source — the exact write the function's own comment says
must never happen. Shortcodes, blocks and plugin markup are destroyed
on a user's live post.

**Fix:** treat a missing `content.raw` as "cannot safely edit this post"
— skip link injection for it, record the skip on the article
(`linksInjectedJson` already carries per-target status), and surface it
plainly. Never write rendered output back as source.

## F2.8 — MEDIUM · the throttle is per-run, not per-day

`routines/services/AutopilotRunService.ts:200`

`indexation.logic` computes a **daily** cap ("posts net-new may propose
today"), but `approvePhase` resets its counter every tick, so a capped
project can approve the cap 96 times a day.

**Fix:** compare against net-new already approved/executing **today**
(the same `countCommittedNetNew` idea used for the quota), not a
per-run counter.

## F2.9 — MEDIUM · fabricated winners-vs-median deltas

`competitors/study.logic.ts:225`

`percentWith` returns 0 for an empty cohort, so an unmeasured median
sample yields `medianPct=0` for every feature and manufactures deltas
that are stored, rendered, and used to derive template contracts.

**Fix:** return null for an empty cohort and propagate "not measured"
through the summary and the card — the product's own rule is that a
number without evidence is not rendered.

## F2.10 — MEDIUM · unserved clustering drops the wrong sibling

`universe/unserved.logic.ts:164`

The incidental-serving rule is applied per raw query *before*
clustering, so a phrasing the site already serves is removed from the
rollup instead of disqualifying its cluster — a sibling phrasing then
forms its own cluster and gets proposed as unserved.

**Fix:** cluster first, then apply the serving rule to the cluster.

## F2.11 — MEDIUM · 'removed' decided against a rank-limited window

`competitors/services/CompetitorStudyService.ts:321`

`current` is the top-100 by etv; `prior` is the full stored set. A page
that merely fell out of the top 100 is marked `removed` — feeding the
what-not-to-build panel with false evidence.

**Fix:** only mark `removed` when the sitemap (the inventory signal)
also lacks the URL; otherwise mark `decayed` or leave active.

## F2.12 — MEDIUM · the articles lock has no stale-heal

`writing/services/ArticleWriteService.ts:117`

Every other rankloop lock probes `getStaleRunReason` before conceding;
`startArticle` just returns `alreadyWriting`. An article whose workflow
died is stuck forever.

**Fix:** apply the same probe, matching the house idiom.

## F2.13 / F2.14 — MEDIUM/LOW · archived projects keep working

`routines/repositories/AutopilotRepository.ts:183` and
`writing/repositories/WriterSettingsRepository.ts:33`

Neither due-query joins `projects`, so the unattended actor keeps
running — and holding a per-tick slot — on soft-deleted projects.

**Fix:** the `isNull(projects.archivedAt)` join every other due-query
already has.

## F2.15 — LOW · the honesty screen prints the unadjusted number

`client/features/rankloop-receipts/RankloopReceiptsPanel.tsx:82`

The panel renders the raw clicks delta under a footer stating "results
trend-adjusted against your site". `result.adjustedClicksDelta` is
stored and never read.

**Fix:** render the adjusted value, or change the footer. Rendering the
adjusted value is correct — the whole point of receipts is that the
number survives an algorithm update.

---

## Acceptance

1. Every HIGH fix ships a regression test that **fails against the
   pre-fix code**; quote the pre-fix failure.
2. F2.1's test must fail by **truncation**, not by a graded report —
   the existing kill-switch proof does not cover this class.
3. `pnpm ci:check && pnpm test:ci && pnpm vite build` green; parity and
   migrations green; dev boots.
4. No behavior change beyond the 16 defects.
5. State explicitly which findings' fixes differ from the reporter's
   proposal and why (the audit JSON records the verifier's reasoning).
