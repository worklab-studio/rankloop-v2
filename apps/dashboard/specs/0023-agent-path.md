# The agent path: repo kit, MCP tools, skill (rankloop S8c)

## Status

Accepted (August 2026) — the third part of step S8 of
`../../docs/PLAN.md`, and the open-source-native half of the product.
Depends on S7a (briefs), S7b (the gate), S8a (publishing).

## Goal

Serve the user whose site is a repo their own Claude built: **rankloop
supplies the judgment, their agent supplies the hands.** Their source
code never leaves their machine; briefs and law verdicts cross the
wire. Three deliverables:

1. `packages/cli` — `npx rankloop init` scaffolds the repo side, and
   `rankloop check` runs the publish laws over the content tree as a
   **CI status check**.
2. MCP tools on the existing server so an agent can pull proposals,
   fetch a brief, submit a draft for grading, and report what shipped.
3. A `rankloop` skill teaching the routine, installed the way the
   fork's existing skills are.

## Why the laws-as-CI check is the centerpiece

Whichever writer produced a post — their Claude, our API writer, or a
human at 2am — **nothing merges that breaks the laws.** One gate covers
every mode, it runs in their CI where they already look, and it needs
no rankloop account: the engine is MIT and runs offline.

## 1. `packages/cli` (new package, depends only on @rankloop/engine)

- `rankloop init` — detects the framework and content directory
  (Next/Astro/Hugo/Eleventy/plain markdown; confirmed interactively,
  `--yes` for CI), then scaffolds, never overwriting:
  ```
  rankloop.json                 site config: contentDir, blogPath, mode,
                                taxonomy, laws overrides
  rankloop/writer-prompt.md     voice card + verified-facts contract
  rankloop/post-template.md     the structure a post follows
  .github/workflows/rankloop-check.yml
  ```
  Prints the directory list it created and what to do next. Idempotent:
  re-running reports "nothing to do".
- `rankloop check [--dir]` — reads `rankloop.json`, loads the content
  tree from disk, calls the engine's `manifest` + `validate`, prints
  one line per violation as `path:law` plus a summary, **exits 1 on any
  failure**. `--format=github` emits `::error file=…::` annotations so
  failures land on the PR diff.
- `rankloop brief <keyword>` — offline brief from local config +
  content (no SERP, no network). The grounded version comes over MCP.
- Node ≥20, zero runtime deps beyond the engine, published as
  `rankloop` (bin) from the monorepo. The scaffolded workflow pins
  `npx rankloop@<version> check --format=github`.

## 2. MCP tools (extend the fork's existing server)

Project-scoped through the server's existing OAuth/project auth — an
agent sees only what its token's project can see.

| tool | returns / does |
|---|---|
| `rankloop_status` | quota (incl. any indexation throttle and its reason), counts by status, spend to date |
| `rankloop_proposals` | approved proposals awaiting writing, with evidence and page type |
| `rankloop_brief` | the grounded brief for a proposal (the same one S7a renders) |
| `rankloop_check` | **submit a draft, get the law report back as data** — every law, pass or fail, thresholds and excerpts. No model call; this is the engine |
| `rankloop_publish_report` | the agent reports what it shipped (url, path, commit/PR) → article `published`, manifest upserted, receipt opened |
| `rankloop_receipts` | measured receipts, so the agent can see what its writing moved |

`rankloop_check` is deliberately a *tool*, not advice: an agent that
can call the grader can iterate against it, and the grader still has no
model on its dependency graph.

## 3. The skill

A `rankloop` skill in the fork's skill format, installable through the
existing skills flow. It teaches the routine, not the API:

> pull approved proposals → for each, fetch the brief → write the page
> **natively in this repo's stack** (its components, its conventions) →
> call `rankloop_check` until it passes → open a PR → report it with
> `rankloop_publish_report`.

Plus the first-contact step: study this repo (framework, components,
CSS tokens, existing posts) and write `rankloop/writer-prompt.md` and
`rankloop/post-template.md` **into the repo** so the voice and
structure live where the code lives. That is the v1 `setup` prompt,
reborn where it belongs.

## Surfaces

The fork's **AI & MCP** page gains a rankloop section: the tool list
with one-line descriptions, the skill install command, and the repo-kit
quickstart (`npx rankloop init`) with the scaffolded directory list.
Copy states the split plainly: "rankloop holds the judgment. Your agent
holds the hands. Your source never leaves your machine."

Writer mode per site (`writer_settings.writerMode`, new column:
`'api' | 'agent'`, default `'api'`): in `agent` mode the dashboard's
Write button is replaced by "waiting for your agent", and proposals
stay `approved` until an agent reports them. Both modes share one
queue, one gate, one receipts view — mixing is legitimate strategy
(API for pSEO volume, their Claude for editorial).

## Files

- `packages/cli/` (bin, init scaffolds as templates, check, brief) +
  tests: scaffold idempotency, framework detection, check exit codes,
  `--format=github` annotation shape
- `src/server/mcp/tools/rankloop*.ts` registered with the existing
  server + output schemas + tests per tool
- the skill definition + registration
- `writer_settings.writerMode` (both dialects + migration + parity)
- AI & MCP page section; Articles agent-mode state

## Acceptance

1. Parity + migration green; `pnpm ci:check && pnpm test:ci && pnpm
   vite build` green; dev boots.
2. **CLI proof, end to end, offline**: in a scratch directory, `npx
   rankloop init --yes` scaffolds the listed files; a compliant post
   passes `rankloop check` (exit 0); a post with a banned phrase and a
   dead internal link fails with both laws named and **exit 1**;
   `--format=github` emits annotations; re-running `init` reports
   nothing to do.
3. **MCP proof**: each tool called through the server against seeded
   data returns the documented shape; `rankloop_check` grades a
   submitted draft identically to the dashboard's own gate (assert the
   two reports match for the same input).
4. **Boundary proof**: `packages/cli` and the MCP `rankloop_check` path
   contain no model client, and the CLI has no network call at all
   (grep + a test that fails if `fetch` is reachable from `check`).
5. Agent-mode proof: with `writerMode='agent'`, the Write button is
   replaced and a `rankloop_publish_report` call moves the article to
   published with a receipt.
