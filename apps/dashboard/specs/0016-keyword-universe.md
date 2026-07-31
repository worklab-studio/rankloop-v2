# Keyword universe (rankloop S5)

## Status

Accepted (August 2026) — step S5 of `../../docs/PLAN.md`. Depends on S1
(GSC memory), S2 (content inventory), S4a (competitors).

## Goal

Fill `keyword_backlog` from every source through one gate: the relevance
gate → classifier → scorer from `@rankloop/engine`. Add the adaptive KD
ceiling (this is the first step where it can exist), the derived-and-
editable relevance gate, and the Plan → **Keywords** tab.

## Non-goals

Proposals from these rows (net-new WRITE_NEW arrives with the page plan,
S6) · page-type assignment (S6) · SERP snapshots for candidates (S6
plan-time sampling) · the pool-mix rule (S6/S7 selection).

## The relevance gate problem, solved deterministically

The engine's gate needs positive/negative patterns — niche knowledge
that v1 got from a hand-authored `rankloop.toml`. Here it is **derived,
then edited**, never guessed by a model:

`deriveRelevanceGate` (pure, tested) from the project's own evidence —
content_pages titles + paths, and the GSC queries the site already
earns impressions for:
- tokenize, drop stopwords + the brand tokens, count document frequency
- positives = tokens appearing in ≥3 documents, capped at 40, stored as
  literal alternation (never a user-facing regex)
- negatives = a small shipped default list (jobs, salary, torrent,
  casino, crypto, login, coupon code, free download — WHY-commented as
  "the junk orbit every niche shares"), plus anything the user adds
- stored on a new **project_gate** row (see schema), regenerated on
  demand, **never overwritten once the user edits it** (dirty flag)

The Keywords tab shows the gate as editable tag-chips with counts
("espresso · 41 pages"), an add-token input, and the honest stamp:
"derived from your own pages and queries — edit anytime".

## Adaptive KD ceiling (pure, tested)

`computeKdCeiling({ rankedTop10WithKd })`:
- fewer than 10 non-brand samples with a non-null KD → fixed **20**
- else `p75(KD) + 10`, moved at most **+5** per computation (stored
  previous value; a single sync can never reprice the whole backlog)
- **NULL KD always passes the ceiling** (the min_volume=0 doctrine's
  sibling: long-tail rows are what a young site wins)
Samples come from gsc_performance (weighted position ≤ 10) joined to
upstream `keyword_metrics` for KD.

## Sources (one workflow, per-source steps, all upserting through the gate)

`KeywordUniverseWorkflow { runId, projectId, sources[] }`:

1. **GSC unserved** (free, always): from the 28d memory — queries with
   `impr28 >= unservedFloor` (3, scaling to 5 at ≥1k impr/mo, 10 at
   ≥10k — a pure function of the project's own volume) where the
   best-serving page ranks **worse than position 10** (incidental
   serving — a page ranking top-5 already serves it), no content_pages
   row's primary keyword matches, and no backlog row exists. Near-
   duplicates clustered by normalized token set → one row each, the
   variants stored in notesJson. source='gsc'.
2. **Competitor gap** (metered, key-gated): Labs `domain_intersection`
   per tracked competitor (they top-10, we absent), **admitted
   unfiltered** by KD; the ceiling applies at scoring below. Stores the
   competitor + their position in notesJson. source='gap'.
3. **Seed expansion** (metered, key-gated, opt-in): Labs related
   keywords for the top-scoring existing rows (max 20 seeds/run).
   source='expansion'.
4. **Autocomplete** (free): Google/Bing/DuckDuckGo suggest endpoints,
   8 question prefixes × the seed set, browser UA, paced 150ms, one
   endpoint failing never fails the step. source='autocomplete'.
5. **Harvest** (free, opt-in per project): StackExchange per-tag Atom
   feeds (2s inter-tag pacing) and Reddit public per-sub RSS (**20s
   pacing, one retry at 2× on 429** — v1's hard-won constants, cited in
   a WHY-comment). Question-shaped titles only; rows are pool-flagged
   in notesJson so S6/S7 can honor the pool-mix rule.
   source='harvest'.

Every row: gate → `classify` → `score` from the engine, with **volume
imputation for GSC-evidenced rows** (`vol = max(volume ?? 0, impr28)`)
so proven demand never loses to vendor zeros. Rows failing the gate are
counted, not stored (the run reports "1,284 seen · 312 kept").

Dispatch: manual per source from the UI; scheduled weekly block (free
sources only — metered sources never auto-run) after the competitor
block, ≤3 projects/tick.

## Schema (dual-dialect + parity)

- **project_gate** — id · projectId (fk cascade, unique) ·
  positivesJson · negativesJson · brandTokensJson · kdCeiling int ·
  kdCeilingUpdatedAt nullable · userEdited int(0/1) default 0 ·
  derivedAt · updatedAt.
- **keyword_universe_runs** — id · projectId (fk cascade) · sourcesJson
  · status ('pending'|'running'|'done'|'error') · seenCount int nullable
  · keptCount int nullable · error nullable · startedAt · finishedAt.
  Partial unique(projectId) WHERE status IN ('pending','running');
  staleRunProbe applies.

## Surface — Plan → Keywords tab (replaces its S4a placeholder)

- **Header row**: source buttons — "Sync from Search Console" (free,
  btn-sm), "Find gaps" (metered, disabled + setup pitch without a key,
  cost sentence "~$0.02 per competitor"), "Expand seeds" (metered),
  "Autocomplete" (free), "Harvest questions" (free, only when configured
  in a small Collapsible: StackExchange site+tags, subreddits). Running
  state: the house spinner + gerund, polled at 3000ms.
- **Gate card** (Collapsible, collapsed): the derived tokens as
  editable tag-chips + add-token input + "Re-derive" ghost button
  (disabled with a tooltip once userEdited, per the never-overwrite
  rule), the KD ceiling as a Stat with its stamp ("earned from 14
  keywords you already rank top-10 for · moves at most +5 per week").
- **Table** (AppDataTable, paginated, sortable): keyword · volume
  (tabular-nums, — for null) · KD via the house score-badge tiers ·
  intent · score (tabular-nums, sortable, default desc) · source
  tag-chip (gsc=sky, gap=violet, expansion=slate, autocomplete=slate,
  harvest=lime, manual=slate) · status badge-ghost · cluster. Filters:
  source multi-select + a search input (350ms debounce, the house
  FILTER_DEBOUNCE_MS constant). Bulk selection → "Skip selected"
  (status='skipped') using the house TableBulkActionBar.
- Stamp: "1,284 candidates seen · 312 passed your gate · NULL-volume
  rows are kept on purpose — long tail is where a new site wins".
- Progress spine: "Keywords · 312 in the backlog" row goes live between
  Competitors and the muted Page plan row.

## Files

- schema pair additions + parity + migrations
- `src/server/workflows/KeywordUniverseWorkflow.ts` + wrangler +
  server.ts
- `src/server/features/rankloop/universe/{services,repositories,
  gate.logic.ts,unserved.logic.ts,kdCeiling.logic.ts,sources/*.ts}`
- `src/serverFunctions/rankloopUniverse.ts` + zod schemas
- scheduled weekly block (free sources only)
- `src/client/features/rankloop-plan/` Keywords tab components
- vitest: gate derivation (stopwords, brand exclusion, DF threshold,
  cap), KD ceiling (all four branches incl. the +5 clamp and NULL
  passthrough), unserved (incidental-serving rule, floor scaling,
  clustering, exclusions), volume imputation, each source's parser with
  mocked fetch (incl. one endpoint failing mid-step), gate-reject
  counting

## Acceptance

1. Parity + migrations green; `pnpm ci:check && pnpm test:ci && pnpm
   vite build` green; dev boots.
2. Keyless seeded proof: with seeded gsc_performance + content_pages,
   "Sync from Search Console" produces gated, scored, clustered backlog
   rows visible in the tab; the gate card shows derived tokens; the KD
   ceiling shows its fixed-20 branch with the honest stamp; metered
   buttons show setup pitches, not errors.
3. Free-source parsers proven against mocked fetch (no live calls in
   tests); pacing constants asserted.
4. No source can write a row that fails the gate; the seen/kept counts
   reconcile.
