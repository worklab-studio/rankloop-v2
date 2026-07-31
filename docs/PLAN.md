# rankloop 2.0 — the master plan

One line: **add your domain → a studied position, a reverse-engineered
competitive playbook, a data-backed page plan, then a stream of articles
that report back what they moved.**

Built INSIDE the vendored OpenSEO dashboard — same design, same
architecture, extended. Companion docs: DESIGN-DNA / DESIGN-VOICE ·
DASHBOARD-ARCHITECTURE / DASHBOARD-JOBS / DASHBOARD-GSC-DATA ·
GRAFT-CONVENTIONS (how code lands). Reviewed by two adversarial panels
(2026-07-31 intelligence layer; 2026-08-01 funnel/pSEO/fork-fit/restraint);
all high-severity findings are integrated below.

## 0. The three survival rules (panel-derived, non-negotiable)

1. **No data row, no page.** Programmatic page types REQUIRE a data
   backbone. An LLM filling a template from a keyword is Google's
   definition of scaled content abuse; a template rendering real rows is
   how survivors (Zapier, Wise, Nomad List) work.
2. **Hub first, links always.** A page type's hub publishes before any
   instance; every instance links to hub + siblings and RECEIVES links
   (injected into related existing posts at publish). Orphan pages →
   indexation collapse → quota throttle → death spiral. Linking is
   architecture, not decoration.
3. **Optimize before you generate.** The existing corpus gets improved
   (retitle/push/refresh/prune) from week one, before any net-new page —
   validating the loop on safe edits and seeding receipts early.

## 1. The journey

A→E are internal pipeline phases; the UI uses only screen names
(Dashboard, Competitors, Keywords, Page plan, Articles, Receipts).
**Adding a site kicks ONE automatic pipeline** — the user makes exactly
two decisions: approve the page plan, and approve titles (trust dial).

```
ADD SITE ─► [auto] site study ─► [auto] competitor discovery+study
         ─► [auto] keyword universe ─► DRAFT PAGE PLAN
                                          │
              GATE 1: approve page types ─┤        (founder-readable cards)
                                          ▼
              topics flow ─► GATE 2: approve titles (or autopilot)
                                          ▼
         writer → laws gate → publish+links → receipts → flywheel

  parallel from week one: optimize-existing track
  (retitle · push · refresh · prune on the current corpus — no gates
   beyond the trust dial; needs only GSC memory + site study)
```

A **progress spine** — the one primary-tinted checklist card on the
Dashboard (their sole accented idiom) — narrates the pipeline live:
"Studying your site · 134/214 pages" → "3 competitors found — studying" →
"Page plan ready — review 6 page types", each phase deep-linking.

## 2. Phase A — Site overview (extended Dashboard, no new page)

New cards in their CardShell DNA:
- **Search reality** (S1): 28d trend, top queries, striking-distance
  count. Stamp: "Google Search Console · last 28 days".
- **Content inventory** (S2): pages, posts, cadence timeline, word-count
  distribution, detected page types, taxonomy. Built by EXTENDING their
  SiteAuditWorkflow (publish-date extraction added to crawlPage) + a
  derive phase promoting audit_pages → a maintained `content_pages`
  registry. Stamp: "crawled 214 pages · 4h ago".
- **Authority**: backlinks, referring domains, domain rank (the DA
  number), new/lost 30d. Stamp: "DataForSEO · snapshot Jul 31".
- **Indexation** (S8): cohort rate; feeds the throttle.

## 3. Phase B — Competitor intelligence (auto-run, review as drill-in)

Discovery (Labs competitors_domain ∪ SERP co-occurrence ∪ manual) →
**top 3 auto-study immediately** (skippable per competitor), more on
request. Cost stated in-card ("~$0.15 per competitor · refreshes monthly").

Per competitor — CompetitorStudyWorkflow:
1. **Metrics**: domain rank, keyword count, est. traffic.
2. **Backlink intel** + link gap (domains linking to ≥2 competitors, not
   you) → feeds the **Outreach planner**: prioritized targets with real
   context (what they linked, which of your assets fits — pSEO data pages
   are the designed linkable assets), drafted template messages per
   target (editable), and a manual tracking board (to contact / sent /
   replied / linked). rankloop researches, drafts and organizes; it NEVER
   sends and never scrapes email addresses (contact-page links only).
   Automated outreach stays permanently out of scope.
3. **Blog study, winners-vs-losers** (the differentiator): per-page
   earnings via `labs.relevantPages` (already wrapped upstream; NOT
   rankedKeywords aggregation, which fabricates precision) → crawl their
   TOP-EARNING pages first (cap ≤200/run, 25 fetches/step reusing the
   audit batching) → extract structural blocks (tables, tools, FAQ,
   media, bylines, dateModified) and DIFF earners vs their median post —
   that per-type feature delta seeds template contracts empirically.
   Monthly snapshots persist to `competitor_pages`; **their decayed/
   removed pages surface as a panel** — the cheapest what-not-to-build
   signal there is.
   **Degraded path is first-class**: blocked HTML → sitemap-XML-only
   study (URL shapes → type mix, lastmod → cadence) + Labs/SERP titles,
   coverage stamped on the card ("studied from sitemap + SERP · HTML
   blocked").
4. **Keyword gap** → Phase C with `gap` provenance (admitted unfiltered;
   the KD ceiling applies at scoring time, where it can first exist).

Screens: Competitors is a TAB on the Plan screen; competitor detail is a
drill-in route (no nav entry).

## 4. Phase C — Keyword universe

Sources through the engine gate → classify → score: GSC unserved ·
competitor gap · seed expansion · autocomplete (free) · StackExchange/
Reddit questions (pool-flagged) · manual. SERP snapshots persist to
`serp_snapshots` (plan-time and grounding-time — see Phase D).
Screen: Keywords tab on Plan (statuses, sources, clusters, bulk actions;
min_volume=0 doctrine as the stamp).

## 5. Phase D — Page plan (GATE 1) — pSEO page types + blog

The planner clusters the universe by pattern, cross-references the
competitor playbook, and **validates against SERP reality before
proposing**: 5–10 sampled SERPs per candidate type; a type is proposed
only when comparable-or-weaker-authority domains rank top-10 with that
format. Authority delta shown plainly ("they're DR 55, you're DR 15");
types locked by big brands / Reddit top-5 / AI Overviews are auto-killed
or downgraded. ~$0.02 of SERP cost moves to plan time and prevents
approving a dead-on-arrival set.

```
PageType {
  kind: pseo | blog | hub
  dataSource: REQUIRED for pseo — one of:
              (a) user dataset (CSV/API),
              (b) AI-COMPILED with provenance: DatasetBuildWorkflow —
                  entity discovery from SERPs/competitor pages/category
                  pages → crawler fetches official pages → LLM EXTRACTS
                  (never invents) attribute values → every cell stores
                  sourceUrl + fetchedAt → low-confidence cells to a
                  human spot-check list → scheduled refresh,
              (c) "editorial → downgrade to blog"
  urlPattern · keywordPattern · templateContract (derived from the
              competitor earners-vs-median diff, human-edited)
  hub: publishes FIRST, instances append to it
}
```

Instance flow: `pick_next` refuses instances whose entity has no data
coverage; the laws gate verifies data blocks render from real rows AND
that rendered cells carry provenance — no source, no number.

**Design inheritance (who owns the pixels)**: rankloop never invents page
design. CMS adapters → the site's theme renders structured content. Repo
sites (GitHub adapter) → a one-time derived template PR built from the
site's real CSS/components (the v1 `setup` method), then reused. Agent
path (§6b) → the user's own agent writes pages with the repo's native
components. Template contracts govern structure; the site governs looks.

**The approval card leads with what a founder can judge**: "Comparisons —
47 pages" · three example titles rendered from real candidates · the
evidence sentence ("espressotoolbox earns 41% of its traffic from pages
like these") · demand in words ("18,400 searches/mo across 47 pages") ·
the money math ("~$12 to write all 47 at ~$0.25 each") · the authority
check. Regexes, URL patterns and laws profiles live behind "More details".

## 6. Phase E — Articles (GATE 2) + the pipeline

**Two tracks, different gates:**
- **Track 1 — optimize existing** (unlocks at S3, needs only S1+S2):
  RETITLE (CTR deficit) · PUSH (striking distance + inlink placement) ·
  REFRESH (guarded decay) · MERGE/PRUNE (human-only). Ships with a
  minimal WordPress update adapter — the least dangerous write validates
  the publish connection and starts the receipts cohort on safe edits.
- **Track 2 — net-new per type** (gated on the approved page plan):
  proposals per type with quota mix + the guaranteed pool slot →
  ArticleWriteWorkflow: brief (engine + serp_snapshots + data rows) →
  draft (BYO key, their LLM plumbing) → **laws gate (engine, incl.
  internal-link and data-block laws)** → fix ≤3 → review/autopilot →
  publish: hub updated, contextual links injected into 2–3 related
  existing posts, IndexNow → receipts (baseline in the same transaction;
  "hub live + inlinks placed" recorded so indexation failures can be
  correlated with link starvation).

The Opportunities queue is the **"Proposed" tab of Articles** — no extra
nav item. Receipts: day 14–42 window, diff-in-diff, contamination marks,
autopilot per action type gated on the 90-day cohort.

### 6a. The repo kit ("works as a GitHub file")

For repo-based sites (the Claude-built-site audience): `npx rankloop init`
(a small CLI bin on @rankloop/engine) scaffolds the repo side —
`rankloop.json` (content dir mapped once, auto-detected; taxonomy; laws
overrides), `rankloop/` (writer-prompt.md, derived post-template as a
one-time reviewed PR, seeds.txt), and two workflows:
`rankloop-daily.yml` (the routine) and **`rankloop-check.yml` — the laws
as a required CI status check**: no PR merges a law-breaking post,
regardless of which writer produced it. Split of truth: repo owns
config/voice/template/content (versioned, agent-editable); dashboard owns
data/signals/queue/receipts. Connected via GitHub App or token.

**Writer modes, per site and per page type**: `agent` (CLI-native — their
Claude writes in-repo via the skill + MCP; GitHub Action or cron
triggers) or `api` (dashboard's ArticleWriteWorkflow, BYO key, publishes
by PR). Same briefs, same laws, same queue and receipts either way; the
CI check is the shared final gate. Mixing is strategy: api for data-backed
pSEO volume, agent for editorial.

### 6b. The agent path (open-source-native publishing)

For devs whose site is a repo and whose writer is their own Claude/agent:
rankloop is the brain, their agent is the hands. Extends the fork's AI &
MCP screen: MCP tools `rankloop_proposals` / `rankloop_brief` /
`rankloop_check` (violations as data) / `rankloop_mark` /
`rankloop_receipts`, plus an installable `rankloop` skill teaching the
routine (pull proposals → write natively in the repo's stack → check
until green → PR → mark). First contact = the v1 `setup` prompt reborn:
their agent studies its own repo, writes the post template + voice card
into the repo, registers the contract. Scheduling = GitHub Action or
cron running the agent (the notchbay cron line, modernized). Publishes
flow into receipts like any adapter. Source code never leaves the repo;
judgment flows to the agent over MCP.

## 7. Nav & screens (restraint cap: ONE new group, 3 items)

```
WRITE
  Plan       tabs: Page types · Keywords · Competitors · Outreach
  Articles   tabs: Proposed · Writing · Review · Published · Failed
  Receipts
```
Dashboard gains the rankloop cards + progress spine. Everything else is
drill-ins. Total sidebar: 11 upstream + 3.

## 8. Engineering sequence

| Step | Ships |
|---|---|
| S0 | spec 0009 · dual-dialect tables (gsc_pages/gsc_queries interned + gsc_performance, content_pages, competitors, competitor_pages, page_types, page_type_data, proposals, articles, receipts, serp_snapshots, indexation_checks, llm_spend) · engine dep |
| S1 | GSC memory: 90d daily grain + monthly rollups (4–16mo), top-N/day cap with remainder row, interned ids (single-D1 10GiB reality) · daily sync · "Sync now" |
| S2 | Site study: extend SiteAuditWorkflow (datePublished) + derive → content_pages · Dashboard cards · progress spine |
| S3 | **Track 1 live**: optimize-existing signals + Articles(Proposed) + minimal WP update adapter + first receipts |
| S4 | Competitor discovery + study workflow (relevantPages, winners-vs-losers crawl, degraded path) + Plan:Competitors tab + Outreach planner (targets, templates — sending stays human) |
| S5 | Keyword universe jobs + Plan:Keywords tab (gap unfiltered; ceiling at scoring) |
| S6 | Page plan: planner + plan-time SERP sampling + data ingestion + founder cards + hub-first publishing |
| S7 | ArticleWriteWorkflow (net-new) + per-type briefs/laws + **dogfooding starts** |
| S8 | Full publish adapters (WP create, webhook, GitHub API, **agent path**: rankloop MCP tools + skill) + link injection + indexation checks → quota throttle |
| S9 | Routine dispatch (cron + DO alarm) · digest · autopilot on 90d cohort |

Each step: PR-sized, upstream CI green, spec section, DESIGN-DNA/VOICE
compliance. Sequencing rule honored: nothing consumes data a later step
produces.

## 9. Cost picture (BYO keys, ledger-capped, shown in-product in "~" style)

Site overview ~$0.05 + free crawl/GSC (weekly) · competitor ~$0.10–0.20
(monthly) · expansion ~$0.01/seed (weekly) · SERP ~$0.002/kw cached ·
article ~$0.10–0.50 LLM + $0.01 data. Real costs from response envelopes
into the ledger. No key → degraded mode, stated plainly.

## 10. Resolved questions

- Template contracts: derived from competitor earners-vs-median diff,
  human-edited at approval. · Stage A lives on the Dashboard. · Vocabulary
  is screen names only. · Competitor pre-confirmation replaced by
  auto-study top 3 + skip.
