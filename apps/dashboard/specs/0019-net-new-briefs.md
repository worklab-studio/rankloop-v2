# Net-new proposals + grounded briefs (rankloop S7a)

## Status

Accepted (August 2026) — first half of step S7 of `../../docs/PLAN.md`.
Depends on S5 (keyword universe) and S6a (approved page types). S7b
(spec 0020) adds generation; this step deliberately contains **no LLM
call at all** — it produces the proposals and the briefs a writer will
later consume, and every one of them is inspectable first.

## Goal

Track 2 opens: keywords bound to an **approved** page type become
WRITE_NEW proposals under the catch-up quota and the pool-mix rule, and
each one can render its **grounded brief** — the exact document the
writer will receive — on screen, before a single word is generated.

## Non-goals

Generation, the laws gate on drafts, the fix loop, `llm_spend` (all
S7b) · pSEO instances requiring datasets (S6b's no-data-no-page rule) ·
hub pages and link injection (S8).

## Selection (engine-owned, no new heuristics)

`@rankloop/engine` already owns this and is parity-tested against the
Python original — call it, do not reimplement:

- `computeQuota({ startDate, postsPerDay, catchupCap }, publishedDates,
  today)` — a missed day is owed, not skipped, capped. Published dates
  come from `content_pages` (kind='post', source='publish' ∪ 'crawl'),
  so the quota survives resets and manual posts.
- `applyPoolMix(scored, poolCandidates, n)` — **exactly one slot per
  batch** goes to the fresh-question pool (harvest-sourced rows,
  recency-ordered) when one exists. It replaces the weakest scored slot,
  never the top pick.

New per-project writer settings (see schema): `postsPerDay` (default 2),
`catchupCap` (6), `quotaStartDate` (nullable — null means the quota is
off and selection is manual-only).

Candidates: `keyword_backlog` rows with `status='planned'` whose
`pageTypeId` points at an **approved** page type. pSEO-kind types whose
`dataSourceJson.mode` is unset are **excluded with a stated reason**
("needs a data source — see the page plan"), which is the no-data-no-page
law arriving early rather than as a surprise in S6b.

## Proposal creation

`computeNetNewProposals(projectId, { limit })`:
- quota → n; n = 0 → no-op with a reason recorded on the run
- select candidates by score desc, apply pool mix, one proposal each:
  `type='write_new'`, `track='net_new'`, `pageTypeId`,
  `keywordBacklogId`, `target`=keyword, `title`= the type's title
  pattern rendered from the keyword (deterministic; the writer may
  refine it later), `score`, `factorsJson` (the engine's factors +
  the pool-slot marker), `evidenceJson` (source chips + the type name)
- the S0 partial-unique guard makes duplicate insertion a silent skip
- backlog rows move to `status='proposed'`
- TTL, decisions and the suppression rules from S3a/F1.2 apply
  unchanged — a declined net-new keyword is not re-proposed inside the
  suppression window, and returns to `status='planned'` (not
  `discovered`: its type binding survives).

Triggered by: the daily scheduled block (after the universe block), and
a manual "Propose now" on the Articles screen.

## Brief assembly (the writer's contract, rendered without a writer)

`buildBrief(proposalId)` → markdown, via `@rankloop/engine`'s
`renderBrief` with real inputs only:

| brief input | source |
|---|---|
| keyword row | `keyword_backlog` (+ imputed volume, per S5) |
| cached SERP + PAA | `serp_snapshots` — reuse the S6a `purpose='plan'` snapshot when one exists for this keyword; else fetch once (metered, `purpose='grounding'`) and persist |
| category / taxonomy | the page type's name + the project's approved types |
| laws | the page type's `templateContractJson` merged over engine defaults |
| internal link candidates | `content_pages` (real, resolvable paths only — same-category first, deduped by slug) |
| today | the run's date |

Two additions to the engine's stock brief, appended as extra sections
(the engine stays generic; the app supplies site-specific context):
- **Voice card** — the project's stored voice notes when present; when
  absent, the honest line "no voice card yet — write plainly and in
  first person" rather than an invented persona.
- **Page type contract** — the required blocks, word band and schema
  type derived in S6a, rendered as writer requirements.

Briefs are **not** stored on the proposal (they are cheap to rebuild and
stale-prone); the article row stores the exact brief it was written from
when S7b runs.

## Schema

- **writer_settings** (dual-dialect + parity): id · projectId (fk
  cascade, unique) · postsPerDay int notNull default 2 · catchupCap int
  notNull default 6 · quotaStartDate nullable · voiceCardMd nullable ·
  trustDial enum('titles'|'drafts'|'autopilot') notNull default
  'titles' · createdAt · updatedAt. (S7b uses trustDial; it is stored
  now so the settings surface ships once.)
- No other schema changes: `proposals` and `keyword_backlog` already
  carry everything else.

## Surfaces

- **Articles → Proposed tab** gains net-new rows alongside the optimize
  ones, distinguished by the existing type chip plus a violet page-type
  chip. Rows from the pool slot carry a lime "fresh question" chip — the
  rule is visible, not hidden.
- Header: quota line in house voice — "2 owed today · 1 already
  proposed" or "quota off — propose manually" — plus "Propose now"
  (`btn btn-sm`).
- **Brief drawer**: "View brief" (`btn btn-ghost btn-xs`) on any
  net-new row opens the house Modal rendering the assembled markdown in
  a `prose prose-sm` block, with a "Copy brief" button and the stamp
  "this is exactly what the writer receives". Fetching a missing SERP
  is metered — the drawer states the cost before it fetches, per house
  cost-transparency.
- **Writer settings** (Collapsible at the bottom of Articles): posts per
  day, catch-up cap, quota start date, voice card textarea, and the
  trust dial as three radio cards (autopilot's card notes it unlocks
  after receipts prove the loop — it is stored but not yet honored).

## Files

- `writer_settings` pair + parity + migration
- `src/server/features/rankloop/writing/{selection.ts,brief.ts,
  services,repositories}` — selection wraps the engine, brief assembles
  inputs; both pure where possible with colocated tests
- serverFunctions `rankloopWriting.ts` + zod schemas
- scheduled daily block (after universe), manual trigger
- Articles surface additions + settings collapsible
- tests: quota (off / owed / capped / already-met), pool-mix slot
  presence and its absence when the pool is empty, no-data-source
  exclusion with reason, decline→`planned` transition, brief assembly
  (plan-snapshot reuse vs fetch, missing-voice-card honesty, link
  candidates only from real pages, contract merge over engine defaults)

## Acceptance

1. Parity + migrations green; `pnpm ci:check && pnpm test:ci && pnpm
   vite build` green; dev boots.
2. Seeded keyless proof: with an approved blog-kind page type and
   planned keywords, "Propose now" creates exactly quota-many
   proposals, one carrying the pool chip; "View brief" renders a
   complete brief whose SERP section comes from the seeded plan
   snapshot (no fetch, no key); a pSEO type without a data source is
   excluded with its reason shown.
3. Engine functions are called, not reimplemented — grep proof that
   quota and pool-mix come from `@rankloop/engine`.
4. No LLM call exists anywhere in this step (grep proof).
