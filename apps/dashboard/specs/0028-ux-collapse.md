# The UX collapse — Phase 1

## Status

Accepted (August 2026). Implements Phase 1 of `docs/PRODUCT.md`.

## Why

The dashboard is two products in one filing cabinet: OpenSEO's
point-at-anything research tools and rankloop's operating loop, fourteen
sidebar items deep, with no order of operations. A new user cannot tell
where to start because there genuinely is no start.

Three symptoms, all observed on a real project (productlaunchos.com):

- **Backlink pulse** and **Authority** render the same two numbers side by
  side, linking to the same page. A research card and an operating card both
  wanted to say "107 backlinks".
- **"Connect your AI agent"** appears twice on one screen.
- Three different crawl counts on one screen (1 page / 1 page / 3 pages)
  with nothing explaining why they differ.

None of these are bugs in isolation. They are what an IA with no spine
produces.

## The shape

The UI stops being a filing cabinet and becomes the pipeline:

    TODAY      what needs you + what is happening
    STUDY      your site · your market
    PLAN       page types, angles, titles — the approval surface
    PUBLISH    queue → gate → live → measured
    GROW       directories, listicles, backlink targets
    CONNECT    integrations, automation, theme

    Toolbox ▸  keyword research · domain overview · backlinks ·
               rank tracking · brand lookup · prompt explorer · saved

Research tools are never on the critical path. They are reached from inside
a flow ("inspect this SERP") or from the Toolbox.

## The stage model — one source of truth

Everything above rests on one server-side model: what has run, what is
running, what is blocked, and what needs a human. It is computed in
`pipeline.logic.ts` (pure) from facts gathered by `PipelineService`, and it
is read by:

- the **Today** screen (the needs-you queue and the pipeline spine),
- **every gated screen** (the sequence-gating contract below),
- the **Day-0 cascade orchestrator** (what to start next).

Three surfaces, one answer. The current spine computes its own state inline
across five hooks in JSX; that is why nothing else can reuse it and why
nothing auto-advances.

### Stage statuses

| Status | Meaning | Who unblocks it |
|---|---|---|
| `done` | finished, has output | — |
| `running` | in flight now | — |
| `error` | last run failed | retry (rankloop) |
| `waiting` | a prerequisite has not finished | **rankloop, automatically** |
| `needs_you` | a human decision or connection is required | **the user** |
| `idle` | can start, nothing has started it | rankloop or the user |

`waiting` vs `needs_you` is the distinction the whole UX turns on. Today's
dashboard renders both as an inert grey row, so a user cannot tell "rankloop
is getting to it" from "rankloop is stuck on you". Only `needs_you` may
appear in the needs-you queue, and only `needs_you` may block a screen with
a call to action.

### The stages

    site       crawl the site                       (no prerequisite)
    access     AI access probe                      (no prerequisite)
    memory     Search Console sync                  needs: GSC connected
    market     competitors found and studied        needs: site
    keywords   the keyword universe                 needs: site
    plan       page types proposed                  needs: keywords
    titles     titles proposed and approved         needs: plan approved (Gate 1)
    publish    first article live                   needs: titles + a destination

## The sequence-gating contract

A screen whose prerequisite has not run shows **one sentence and one
button**. Never an empty table, never a zeroed metric grid.

    if stage is `waiting`   → "rankloop is still <doing prerequisite>." + spinner
    if stage is `needs_you` → the one sentence + the one button that unblocks it
    if stage is `error`     → what failed + retry
    otherwise               → the screen

An empty table under a first-run heading reads as "we looked and your site
has nothing", which is a different and false claim.

## Day 0 — the cascade

Adding a domain starts a chain, automatically. No dashboard until it has
something to say. The spine screen renders the stage model full-width, each
stage resolving to one plain sentence.

The orchestrator's rule: **start every stage whose prerequisites are `done`
and which is `idle`.** It is a fixpoint loop over the same model the UI
reads, so there is no second definition of "what comes next" to drift.

Stages that are `needs_you` do not block the chain — the cascade routes
around them. A project with no Search Console still studies its site, finds
competitors, builds a keyword universe and drafts a plan; `memory` simply
sits in the needs-you queue. This is what makes GSC a prompt rather than a
gate.

## Screen mapping

| Now | Becomes |
|---|---|
| Dashboard | **Today** — needs-you queue, pipeline spine, digest, what moved |
| Site Audit, AI Access, GSC Insights | **Study → Your site** |
| Plan → Competitors | **Study → Your market** |
| Plan (universe, page types) | **Plan** |
| Articles, Receipts | **Publish** (receipts becomes its Outcomes tab) |
| Plan → Outreach | **Grow** |
| Settings, AI & MCP, publish connections | **Connect** |
| Domain Overview, Backlinks, Brand Lookup, Prompt Explorer, Rank Tracking, Saved Keywords | **Toolbox** |

Every existing route keeps working. Renaming nav labels while leaving URLs
alone is free; breaking a URL a user has open in a tab is not.

## Card merges

- **Backlink pulse + Authority → Reach.** One card: Domain Rank
  (DataForSEO) · Ref. domains · Backlinks · New/lost 30d. The vendor is
  named on the metric — it is not Moz DA and not Ahrefs DR.
- **The duplicate "Connect your AI agent"** loses its standalone card; the
  onboarding checklist keeps it.

## Acceptance

1. One stage model; the spine, the gates and the orchestrator all read it.
2. `waiting` and `needs_you` are visually and semantically distinct, and
   only `needs_you` enters the needs-you queue.
3. No screen renders an empty table for a stage that has not run.
4. Adding a domain starts the cascade without a click.
5. A project with no Search Console still completes site → market →
   keywords → plan.
6. No metric appears on two surfaces as a primary stat.
7. No existing project URL 404s.
