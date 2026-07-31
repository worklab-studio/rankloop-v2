# rankloop 2.0

**Open-source automated pSEO engine.** Point it at your domain: it studies your
site and your real Google data, queues article ideas that can actually rank,
writes them in your voice with your own AI key, gates every draft behind
machine-checkable quality laws (no AI grades the AI), publishes to your stack,
and reports the rankings each article moved. The results feed the next ideas.

Successor to [rankloop](https://github.com/worklab-studio/rankloop) (the
Python CLI, which remains the reference implementation of the method), rebuilt
as a self-hostable product with the pipeline that ran notchbay in production.

```
STUDY site + GSC + competitors ─► QUEUE scored ideas ─► WRITE (your AI key)
        ▲                                                      │
   MEASURE receipts (GSC) ◄── PUBLISH (WordPress/webhook/git) ◄── LAWS GATE (no LLM)
        └── unserved queries feed the queue back ── the flywheel
```

## Status

Early. Build order:

- [x] M0 `packages/engine` — the method, ported from rankloop 0.2 with parity fixtures
- [x] M1 `packages/seo-data` — DataForSEO behind the spend ledger
- [x] M2 `apps/web` — dashboard shell, every screen on demo data
- [ ] M3 db schema + writer package + CLI end-to-end (dogfooding starts here)
- [ ] M4 worker + routines + GSC sync + live signals
- [ ] M5 publish adapters + onboarding agent + first real publish
- [ ] M6 docs + launch

## Principles (carried over, non-negotiable)

1. **The grader is never the author.** `packages/engine` contains zero LLM
   calls; the laws that decide whether a post ships are pure functions.
2. **Grounded, never brainstormed.** Every topic exists because there is
   evidence of demand: Search Console, autocomplete, real questions, gaps.
3. **BYO keys.** AI key (required to write), DataForSEO key (optional
   metrics), Search Console (free). Keys are configuration; the engine is
   the product.
4. **Throttled cadence with catch-up quota.** Missed days are owed, not
   skipped, capped so an outage never floods a site.
5. **Honest by design.** No fabricated claims, no detector-evasion
   "humanizing", no outreach automation, no rank scraping.

## Layout

    packages/engine    pure TS port of the rankloop method (laws, scoring,
                       briefs, quota, pool-mix, wire artifacts) + parity tests
    packages/seo-data  budget-capped DataForSEO client (keywords, SERP,
                       competitors, keyword gap, backlinks) + spend ledger
    apps/web           the dashboard (Next.js + daisyui, openseo-style) —
                       M2: all screens on demo data
    tools/             gen-parity-fixtures.py — runs the Python rankloop to
                       produce the expected-output fixtures the tests assert
    docs/VISION.md     what this is, how it works, the user journey
    docs/PLAN.md       the full plan + the precise SEO intelligence layer
                       (signals, scores, receipts — panel-reviewed)

## Development

    pnpm install
    pnpm test

MIT.
