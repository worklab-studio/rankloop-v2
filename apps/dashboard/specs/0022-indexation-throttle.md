# Indexation checks + the quota throttle (rankloop S8b)

## Status

Accepted (August 2026) — second half of step S8 of `../../docs/PLAN.md`.
Depends on S8a (published articles exist). Also carries four S8a
follow-ups the verify pass surfaced.

## Goal

Close the loop that keeps a programmatic site alive: **watch whether
Google actually indexes what we publish, and slow the engine down when
it does not.** Publishing into "Crawled — currently not indexed" is the
single most reliable way to earn a sitewide quality demotion, and a
content engine that cannot see it happening will keep digging.

## The rule

`indexationRate` = of the articles published 7–45 days ago (young enough
to be recent, old enough for Google to have decided), the share whose
URL Inspection verdict is indexed. Below **65%**, the daily quota is
**throttled to 1** and the reason is stated in the UI and on the run.
Below **40%**, net-new proposing pauses entirely and the operator is
told why. Optimize-track proposals (retitle/push/refresh) are never
throttled — improving what exists is exactly the right move when
indexation is poor.

Cohort minimum: 5 articles. Below that the rate is `null`, not 100% —
an engine that has published twice must not conclude anything.

## Data

`indexation_checks` (exists, S0: projectId · url · verdict ·
coverageState · checkedAt) gains nothing; it has simply never been
written. The daily job:

- selects published `content_pages` (source='publish') aged 7–45 days
  whose most recent check is older than 7 days (or missing), oldest
  first, **≤20 per project per day** (URL Inspection is free but quota'd
  at 2k/day/property; 20 keeps a hosted instance far clear);
- calls the existing `GscService.inspectUrls` (already written for the
  MCP surface, results never persisted until now) in batches of 10 with
  per-URL error capture;
- writes one row per URL per run; no GSC connection → the job is a
  clean no-op, and the UI says indexation is unknown rather than
  implying a problem.

`computeIndexationRate` (pure, tested) reads the latest check per URL
within the cohort window.

## Throttle wiring

`computeNetNewSlots` (S7a) gains an indexation term applied **after**
the quota and catch-up math: `slots = min(engineQuota, throttleCap)`
where `throttleCap` is `Infinity | 1 | 0` per the rule. The reason
string travels with the result so the Articles header and the run row
can state it: "quota held at 1 — 52% of recent posts are indexed".

The engine is untouched: catch-up arithmetic stays in
`@rankloop/engine`, and the throttle is an app-level cap over its
output. A future site with different tolerances changes the constants
here, not the method.

## Surfaces

- **Dashboard → Indexation card** (the S2 placeholder finally has
  data): the rate as a Stat with the cohort in the stamp ("28 of 34
  posts published 7–45 days ago are indexed · checked daily"), a
  tag-chip when throttling is active (amber "quota held at 1" / rose
  "net-new paused"), and the honest null state ("not enough published
  posts yet to judge — needs 5").
- **Articles header**: when throttled, the quota line states it
  plainly instead of silently showing a smaller number.
- **Article detail**: the URL's own latest verdict as a small line
  ("indexed · checked 2 days ago" / "crawled, not indexed · checked
  yesterday"), so a failing page is visible where the user is already
  looking.

## S8a follow-ups (carried here)

1. **The panel misdescribes direct-commit GitHub.** `actionFor`
   branches on `capabilities.publishedUrl === 'returned'` to choose
   "commits" vs "opens a pull request", but GitHub's is always
   `'computed'`, so a direct-commit connection is described as opening
   a PR. The panel must state what the button will actually do — read
   the connection's `directCommit` flag, not a URL-confidence proxy.
2. **`publicDir` has no form field**, so a repo serving from anywhere
   but `public/` cannot have its derived artifacts committed correctly.
   Add it to the GitHub settings fields with the default shown.
3. **The webhook `connection.test` event is undocumented.** The
   settings help text must name it and say what it carries (no
   article, any 200 passes), since receivers have to handle it.
4. **No DOM test asserts the setup pitch paints.** vitest only collects
   `src/**/*.test.ts`, so component tests are silently uncollected —
   either widen the include to `.test.tsx` for this one case or assert
   it in the existing Playwright e2e. Choose one and say which.

## Files

- `src/server/features/rankloop/indexation/{indexation.logic.ts,
  services,repositories}` + colocated tests
- the daily scheduled block (after the receipts block), ≤20/project
- `computeNetNewSlots` throttle term + its reason string
- Dashboard indexation card, Articles header line, article detail line
- the four follow-ups above
- tests: cohort windowing (7–45 days, latest-check-per-URL), the
  5-article minimum returning null, the 65%/40% branches, throttle
  applied after catch-up, optimize track never throttled, no-GSC no-op,
  batch error capture

## Acceptance

1. Parity (no schema change expected) + `pnpm ci:check && pnpm test:ci
   && pnpm vite build` green; dev boots; migrations applied.
2. Seeded proof: seed published pages + inspection results at rates
   spanning the thresholds and assert the quota cap and the UI copy at
   each: healthy (no cap), 52% (held at 1), 30% (net-new paused),
   4-article cohort (null, no cap).
3. Optimize-track proposals still flow at 30% indexation — prove it.
4. The four S8a follow-ups are closed, each with the evidence named.
