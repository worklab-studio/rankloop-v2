# The rankloop journey — what the user sees, what the pipeline does

The narrative companion to PLAN.md. Screen names are the UI vocabulary
(Dashboard, Plan, Articles, Receipts); pipeline phases A–E are internal.

## Day 0 — add your site (2 minutes of typing, ~20 of machine)

User: creates a project, enters the domain, connects Search Console,
pastes an AI key. The progress spine (the one primary-tinted Dashboard
card) narrates: "Studying your site · 134/214 pages" → "Search Console
connected · pulling 90 days" → "3 competitors found — studying" →
"Building your keyword universe · 1,218 candidates" → "Page plan ready —
review 6 page types →". Nothing needs the user until the last line.

Pipeline, in order (all automatic):
1. **Site study** (SiteAuditWorkflow extended + derive → content_pages):
   pages, posts, publish dates/cadence, word counts, detected page types,
   internal-link graph. Powers internal links + duplicate checks later.
2. **GSC memory** (gsc_performance, interned ids, 90d daily + monthly
   rollups): stored page×query×date history; syncs daily forever,
   re-pulling the trailing 3 days.
3. **Authority pull**: backlinks summary, referring domains, domain rank.
4. **Competitor discovery + auto-study top 3**: metrics; backlink intel +
   link gap; the blog study — winners-vs-losers via labs.relevantPages,
   crawl of their top-earning pages, structural diff vs their median,
   decayed-pages panel; sitemap-only degraded path when HTML is blocked.
5. **Keyword universe**: unserved (GSC) + gap + expansion + autocomplete +
   harvested questions, all through the relevance gate → classify → score.
6. **Page plan drafted**: pattern clustering + competitor evidence +
   plan-time SERP sampling with the authority check; locked formats
   auto-killed before proposal.

## Gate 1 — approve the page plan (the only strategy decision)

Founder-readable cards: type name + page count, three real example
titles, demand in words, money math, competitor-evidence sentence,
authority delta. Programmatic types require a dataSource (dataset / 
extraction pipeline / downgrade to blog): **no data row, no page.**
On approval: template contract + laws profile bound per type, and the
type's hub page publishes FIRST.

## Week 1 — the optimize-existing track (before anything new)

Needs only S1+S2, so it runs immediately: RETITLE (relative CTR deficit),
PUSH (striking distance + inlink placement), REFRESH (guarded decay),
MERGE/PRUNE (human-only). Ships through the minimal WordPress update
adapter — safest writes validate the publish connection, and the first
receipts land within two weeks.

## Daily — Gate 2 (titles) + the writer workflow

User approves proposed titles (each carrying evidence chips) or runs
autopilot. Per approved title:
brief (SERP cache + PAA + voice card + template contract + data rows +
real link candidates) → draft (BYO key; model never picks topics, never
grades itself) → laws gate (pure code: filler, em-dash, first person,
word band, structure, density, links resolve, data blocks from real
rows) → fix loop ≤3 → review queue if still failing → OG card → publish
adapter → linking pass (hub updated + contextual links injected into 2–3
related posts) → wire (sitemap/llms.txt) + IndexNow → receipt baseline
recorded in the same transaction. Cadence throttled by catch-up quota.

## Background rhythms

Daily: GSC sync → signal recompute → proposal refresh; indexation checks
on recent publishes. Weekly: universe refresh, backlinks snapshot.
Monthly: competitor re-study (new winners, new decays). Days 14–42 after
every action: the receipt is measured, diff-in-diff vs site trend,
contamination-marked.

## Month 2+ — the loops close

Flywheel (new almost-rankings become proposals) · indexation throttle
(quota cuts itself before damage compounds) · autopilot earned per action
type by its 90-day receipt cohort · PRUNE keeps the site clean.

## Division of labor

Human: approve page plan (once per type) · approve titles until autopilot
is earned · pay two BYO keys. Machine: everything else — and it refuses
to write without evidence, publish law-breaking drafts, or outrun
indexation. Every cent logged to the ledger; hard ceilings.
