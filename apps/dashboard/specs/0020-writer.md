# The writer: draft → laws gate → fix loop (rankloop S7b)

## Status

Accepted (August 2026) — second half of step S7 of `../../docs/PLAN.md`.
Depends on S7a (proposals + briefs). This is the first step in the whole
build that calls a model.

## Goal

An approved net-new proposal becomes a drafted article that has **passed
machine-checkable laws** — or is sitting in a review queue explaining
exactly which law it failed. Generation is the user's key and the user's
cost, metered into a ledger. The gate that judges the draft contains no
model call, and never will.

## The boundary, restated because this is where it could erode

`@rankloop/engine` grades. The writer writes. They are separate packages
and the grader has no model client on its dependency graph. A draft that
fails is not "asked nicely to be better" by a second model acting as
judge — it is handed the **specific violated laws as data** and asked to
fix those. After a bounded number of attempts it goes to a human. There
is no path in which an LLM decides that an article is good enough.

## Non-goals

Publishing and link injection (S8) · hub pages (S8) · the agent/MCP
writer path (S8) · autopilot honoring the trust dial end-to-end (S9 —
here the dial gates whether a passing draft auto-approves) · pSEO
instances needing datasets (S6b).

## Provider

Use the fork's existing LLM plumbing (`OPENROUTER_API_KEY` +
`OPENROUTER_MODEL`, already threaded through compose.yaml and
alchemy.run.ts, with the cost helper the chat agent uses). No key
configured → the Write button renders the house setup pitch, never an
error, and the workflow refuses to start with a clear AppError.

Per-project model override lives in `writer_settings.model` (new
nullable column); default is the deployment's `OPENROUTER_MODEL`.

## ArticleWriteWorkflow

Params `{ articleId, projectId }`. One in-flight article per proposal is
already enforced by the S0 partial unique. Steps (pgStep throughout):

1. **brief** (free) — S7a's `buildBrief`, stored verbatim on
   `articles.briefMd`. The article is written from a frozen brief, so a
   later SERP refresh cannot make the law report unexplainable.
2. **draft** (metered, retries 0) — one generation call. System prompt:
   the honesty contract (no fabricated benchmarks, statistics, quotes or
   testing; describe pricing models not prices; hedge or cut what cannot
   be verified) + the voice card + the page-type contract. User message:
   the brief. **Required output shape**: markdown with `--- key: value
   ---` frontmatter (title, description, date, category, keyword) then
   the body — the exact shape `@rankloop/engine`'s parity-tested
   `parseMdPost` reads. Cost + tokens → `llm_spend` in the same step.
3. **gate** (free, no model) — parse with `parseMdPost`, build the
   `EngineConfig` from the project + the page type's contract merged
   over engine defaults, run `validate`. Store the full law report
   (every law, pass or fail, with its threshold) on
   `articles.lawReportJson` — the report is the product's receipt for
   quality, so passes are recorded too, not just failures.
4. **fix loop** (metered, retries 0, **max 3 attempts total including
   the first draft**) — on failure, a repair call receives: the previous
   draft, the violated laws as structured data with their thresholds and
   the offending excerpts where the law can produce one (banned phrase
   hit, the em dash's surrounding sentence, the unresolvable link), and
   the instruction to change only what the violations require. Re-gate
   after each attempt; a law that newly breaks is reported.
5. **land** — all laws pass → status `review` (or `approved` when the
   trust dial is `titles`, i.e. the human already approved the title and
   asked not to review drafts). Still failing after attempt 3 → status
   `failed`, law report intact, proposal stays `approved` so the human
   can retry or decline. Every terminal state records
   `attempts` and total `costUsd`.

Failure honesty: a provider error, a truncated generation, or an
unparseable frontmatter all land the article in `failed` with the reason
stored — never a silent retry loop and never a partial article
presented as complete.

## Schema

- `writer_settings.model` — nullable text (per-project override).
- `articles` already carries briefMd, content, lawReportJson, attempts,
  status, costUsd, writerMode. No other changes.
- `llm_spend` (S0) receives one row per model call: operation
  ('draft'|'fix'), model, input/output tokens, costUsd, articleId.

## Surfaces

- **Articles → Proposed/Approved rows** gain "Write" (`btn btn-primary
  btn-sm`) on approved net-new rows. Without a key: the button is
  replaced by the house setup pitch link. With a key: a confirm modal
  stating the estimated cost in the "~" idiom before spending.
- **Writing / Review / Failed tabs** (the statuses already exist):
  rows poll at 3000ms while a workflow runs, showing the current step
  as a gerund ("Drafting…", "Checking laws…", "Fixing 2 violations…").
- **Article detail** (`articles/$articleId`): two columns.
  - left: the draft rendered as `prose prose-sm`, and a **minimal
    editor** — a textarea holding the raw markdown with "Save & re-check"
    which re-runs the gate on save (no model call) and updates the law
    report. This is what makes `drafts` mode usable: fixing one sentence
    must not cost another generation.
  - right: the **law report** as a checklist (StatusDot per law, the
    threshold shown, failures carrying their excerpt), the brief in a
    collapsible, and a cost/attempts stamp ("2 attempts · ~$0.31 ·
    claude-sonnet-4-6 via OpenRouter").
- Copy for the failed state, house voice: "Three attempts did not clear
  the laws. The draft and the report are below — edit it yourself, or
  decline the proposal."

## Files

- `writer_settings.model` migration (both dialects + parity)
- `src/server/workflows/ArticleWriteWorkflow.ts` + wrangler + server.ts
- `src/server/features/rankloop/writing/{draft.ts,gate.ts,
  repair.logic.ts,services,repositories}` — `gate.ts` adapts the draft
  to `@rankloop/engine` (parseMdPost → EngineConfig → validate) and owns
  the excerpt extraction; `repair.logic.ts` turns a law report into the
  structured repair payload (pure, tested)
- `serverFunctions/rankloopWriter.ts` + zod schemas
- Articles tabs + detail route + editor
- tests: gate adapter (each law's pass/fail against fixture drafts,
  contract merge, excerpt extraction), repair payload shape per law,
  attempt bounding (3 including the first), terminal states for provider
  error / truncation / unparseable frontmatter, ledger rows written per
  call, trust-dial branch (titles → approved, drafts → review),
  editor re-gate without a model call

## Acceptance

1. Parity + migrations green; `pnpm ci:check && pnpm test:ci && pnpm
   vite build` green; dev boots.
2. **Keyless proof**: with no key, the Write button shows the setup
   pitch and the workflow refuses with a clear error — no crash, no
   half-written article.
3. **Mocked-provider proof** (this is the real test): with the model
   client mocked, drive three scenarios end to end and verify the stored
   rows — (a) a compliant draft passes on attempt 1 and lands in the
   right status per trust dial; (b) a draft with a banned phrase and an
   unresolvable internal link fails, the repair payload contains both
   laws with excerpts, the second attempt passes; (c) a draft that never
   complies exhausts 3 attempts and lands `failed` with the report
   intact. Assert `llm_spend` rows match the number of model calls.
4. **Grep proof**: `@rankloop/engine` has no model dependency, and
   `gate.ts` contains no provider import — the grader is never the
   author.
5. The editor's "Save & re-check" performs no model call (assert in
   test).
