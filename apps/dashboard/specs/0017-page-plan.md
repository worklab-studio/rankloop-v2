# Page plan — the page-type planner (rankloop S6a)

## Status

Accepted (August 2026) — first half of step S6 of `../../docs/PLAN.md`.
Depends on S4a (competitor playbooks) and S5 (keyword universe). S6b
(spec 0018) adds the data backbone and the no-data-no-page gate; the
writer that consumes template contracts is S7.

## Goal

Turn the keyword universe into a small set of **proposed page types**,
each validated against SERP reality before it is ever shown, each
approved through a card a non-SEO founder can judge. Approval binds
keywords to the type and derives its template contract + laws profile.

This is Gate 1 of the product — the one strategy decision the user
makes. Everything about it optimizes for an honest yes/no.

## Non-goals

Dataset compilation and the no-data-no-page enforcement (S6b) · hub page
generation and instance writing (S7) · proposals from approved types
(S7) · editing template contracts beyond the approval card's fields.

## Schema

- **page_plan_runs** (dual-dialect + parity): id · projectId (fk
  cascade) · status ('pending'|'running'|'done'|'error') · typesProposed
  int nullable · serpSampled int nullable · costUsd real nullable ·
  error nullable · startedAt · finishedAt nullable. Partial
  unique(projectId) WHERE status IN ('pending','running'); staleRunProbe.
- `page_types` (exists, S0) is written by this step: name, kind,
  status, urlPattern, keywordPattern, templateContractJson,
  evidenceJson, serpCheckJson, demand, instanceCount.
- `keyword_backlog.pageTypeId` (exists) is bound on approval.

## Candidate detection (pure, tested — `planner.logic.ts`)

Over gated backlog rows (status 'discovered'):

1. **Pattern types** — a shipped table of structural patterns, each with
   a matcher, a display name, a URL-pattern template and a default
   format: comparisons (`\bvs\b|versus`), alternatives (`alternative
   to|alternatives`), best-of lists (`\bbest\b|\btop\b.*\bfor\b`),
   how-to (`^how (to|do|can)`), glossary (`^what (is|are)`),
   troubleshooting (`not working|won'?t|error|fix`), specs/data
   (`size|dimensions|specs|chart|comparison table`), pricing
   (`price|pricing|cost|how much`).
2. **Editorial clusters** — rows matching no pattern are grouped by
   shared stem tokens (≥3 rows per cluster, ≤2 tokens); these become
   `kind='blog'` candidates named from their dominant token.
3. Each candidate carries: instances (the bound rows), `demand` (Σ
   volume, imputed volume for GSC rows per S5), KD band (p25–p75 of
   non-null KD), and the cluster's example keywords.
4. Candidates below `MIN_INSTANCES` (4 for pseo patterns, 3 for blog)
   are dropped — a "page type" of two pages is not a type.

## Competitor evidence (pure, tested)

From S4a `studySummaryJson` + `competitor_pages`: for each candidate,
compute the share of tracked competitors' **top-earning** pages whose
detected pageType matches this candidate's pattern, and the etv share it
represents. Rendered as the card's evidence sentence:
"espressotoolbox.example earns 41% of its search traffic from pages like
these." No matching competitor data → the sentence is omitted, never
faked, and the card says "no competitor signal for this shape".

## SERP validation (metered, capped, plan-time)

Per candidate, sample `min(6, instances)` keywords spread across the
demand range; fetch SERP through the house client, persist to
`serp_snapshots` (purpose='plan'; reused by S7's briefs, so the cost is
paid once). Cap per run: 40 SERP calls total, cheapest candidates first;
uncovered candidates are proposed with `serpCheck.status='unsampled'`
and say so on the card.

From each sampled SERP compute (pure, tested):
- `ugcTop5` — Reddit/Quora/forum results in positions 1–5. **This is a
  hard SERP**, not a weak one (post-hidden-gems Google boosts them);
- `weakness` — small-forum/UGC, thin, or aged results in positions
  6–10 only, cap 5 (the S3a/panel rule, applied at type level);
- `aiOverview` / `featuredSnippet` presence when the response exposes it;
- `winnableSignal` — at least one result outside the top-3 that is not
  a major brand (a shipped major-domain list + "domain shorter than 12
  chars and no path depth" heuristic, WHY-commented as approximate).

Verdict per candidate:
- **kill** — `ugcTop5 ≥ 2` in a majority of samples, or zero
  `winnableSignal` across all samples;
- **caution** — AI Overview in a majority of samples, or KD band p75
  above the project's adaptive KD ceiling (S5);
- **ok** otherwise.
Killed candidates are stored with status='declined' and reason, shown
collapsed under "Not worth building (N)" — the user can still see why.

Honesty rule: rankloop does **not** claim to know each competitor's
domain rank per SERP result. The card states the authority comparison it
actually has — the project's own domain rank vs the tracked
competitors' — and labels the SERP verdict as what it is: a sample.

## Template contract derivation (pure, tested)

For each surviving candidate, from the matching competitor
winners-vs-median deltas (S4a) plus our own corpus medians (S2):
`{ requiredBlocks: ['dataTable'|'faq'|'media'|'byline'…],
   wordBand: [min, max], h2Min, faqMin, internalLinksMin,
   schemaType, notes[] }`
Blocks are required when winners have them ≥60% of the time AND the
median post has them <40% (the delta is the signal). Absent competitor
data → the house defaults from `@rankloop/engine`'s law defaults,
labelled "defaults — no competitor signal".

## Dispatch

`startPagePlan` server fn (project-scoped) → PagePlanWorkflow: detect →
evidence → SERP sample (metered step, retries 0) → derive contracts →
write page_types rows (proposed/declined) → run done. Recompute is
allowed; existing **approved** types are never touched, and previously
declined-by-user types stay declined (only planner-declined rows are
refreshed).

## Surface — Plan → Page types tab (replaces the S5-era placeholder)

- Empty state: "Build your keyword universe first — page types are
  clustered from it." · keyless: the metered-validation setup pitch,
  but detection still runs free (types propose with 'unsampled').
- **The approval card** (one per proposed type, the product's most
  important surface — house CardShell, NOT a table):
  - title row: `Comparisons — 47 pages` + kind tag-chip
    (pseo=violet / blog=lime)
  - three real example titles rendered from actual candidate keywords,
    in quotes, `text-sm text-base-content/70`
  - demand in words: "18,400 searches a month across 47 pages"
  - money math in house style: "~$12 to write all 47 at ~$0.25 each"
  - competitor evidence sentence (or its honest absence)
  - SERP verdict line with a tag-chip: ok=emerald "winnable sample" ·
    caution=amber "mixed sample" · unsampled=slate "not sampled"
  - actions: `btn btn-primary btn-sm` "Approve" · `btn btn-ghost
    btn-sm` "Decline" · "More details" ghost revealing urlPattern,
    keywordPattern, the template contract, KD band, the sampled SERP
    summary, and the full instance list (paginated table)
- "Not worth building (N)" collapsible with the planner-killed types +
  their reasons (the what-not-to-build panel for our own plan).
- Header: "Recompute plan" btn-sm with the cost sentence "~$0.08 per
  recompute · SERP samples are reused when you write".
- Stamp: "clustered from 312 backlog keywords · 6 types proposed · 2 not
  worth building".
- Progress spine: "Page plan · 6 types proposed" goes live, linking here.

## Files

- schema pair + parity + migration · `PagePlanWorkflow.ts` + wrangler +
  server.ts · `src/server/features/rankloop/page-plan/{planner.logic.ts,
  serpVerdict.logic.ts,contracts.logic.ts,services,repositories}` ·
  `serverFunctions/rankloopPagePlan.ts` + zod schemas ·
  `src/client/features/rankloop-plan/` Page types tab + approval card ·
  spine row
- vitest: pattern matching (each pattern + no-match → editorial
  clustering), MIN_INSTANCES drops, demand/KD-band math with nulls,
  evidence share computation incl. the no-data path, SERP verdict
  (ugcTop5 kill, no-winnable kill, AIO caution, ceiling caution,
  unsampled), contract derivation (delta rule + defaults fallback),
  approval binding (keywords → pageTypeId, status='planned'),
  recompute preserving approved and user-declined rows

## Acceptance

1. Parity + migrations green; `pnpm ci:check && pnpm test:ci && pnpm
   vite build` green; dev boots.
2. Keyless seeded proof: with a seeded backlog + competitor summary,
   "Recompute plan" proposes types with real example titles, demand and
   evidence; SERP verdicts read 'unsampled' honestly; approving one
   binds its keywords (verify in D1) and the spine row updates.
3. Every number on a card traces to stored data — no placeholder or
   estimated figure is rendered without saying so.
