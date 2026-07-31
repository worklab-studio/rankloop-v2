# Publishing: adapters, hubs, links, receipts (rankloop S8a)

## Status

Accepted (August 2026) — first half of step S8 of `../../docs/PLAN.md`.
Depends on S7b (drafts that pass the laws). S8b adds indexation checks,
the quota throttle, and the agent/MCP path.

## Goal

An approved article reaches the user's site, its page type's **hub
exists first**, contextual links point at it from pages that already
exist, and a receipt opens with a real baseline. Publishing is the step
where rankloop writes to something the user owns, so every rule here is
about restraint and reversibility.

## The three rules that govern writing to someone's site

1. **Hub before instance.** A page type's hub page is created on its
   first publish, before the instance goes live. An instance that
   nobody links to is an orphan, and orphans are how programmatic pages
   die in "Discovered — currently not indexed".
2. **rankloop only ever edits what rankloop owns.** Link injection
   never rewrites the user's prose. It maintains a delimited block
   (`<!-- rankloop:related start -->` … `end`) that rankloop created,
   is idempotent across re-runs, and can be deleted by the user without
   breaking anything. If the block is absent, it is appended once.
3. **Nothing publishes that has not passed the laws**, and nothing
   publishes without the human decision the trust dial requires.

## Adapters (one interface, three implementations)

`PublishAdapter`: `createPost` · `updatePost` · `getPost` ·
`ensureHub` · `capabilities` (what this target supports — the UI reads
it rather than guessing).

- **WordPress REST** — extends the S3b client (which is update-only)
  with create; posts land as `status: 'draft'` or `'publish'` per a
  per-project setting (default `draft` — the safe default is that a
  human sees it in WordPress before the world does). Hubs are pages.
  Categories map to WP categories when they exist, otherwise are
  skipped with a note; rankloop never creates taxonomy the user did
  not ask for.
- **Webhook** — POSTs a signed JSON envelope (article, frontmatter,
  hub, links to inject) to a configured URL, with an HMAC signature
  header derived from a per-project secret. The response may return the
  published URL; if it does not, the URL is computed from the page
  type's `urlPattern` and marked `unverified`.
- **GitHub App / token** — commits markdown to a branch and opens a PR
  (default) or commits directly (opt-in). This is the adapter for
  Claude-built sites: the content is `--- frontmatter --- + body`, the
  exact shape the engine parses, at the path the page type's
  `urlPattern` implies. For this adapter **only**, rankloop also
  regenerates the derived artifacts with the engine's
  `sitemap`/`rss`/`llmsTxt`/`llmsFull` from the corpus manifest,
  because it is the only target where those files are ours to own.
  WordPress and webhook targets keep their own sitemap generation, and
  the UI says so rather than implying we handle it.

Credentials for all three reuse the S3b encrypted `publish_connections`
row (config shape is per adapter; masked reads unchanged).

## PublishWorkflow

Params `{ articleId, projectId }`. Steps (pgStep):

1. **preflight** (free) — re-run the gate on the stored content (laws
   can change between drafting and publishing; a stale pass is not a
   pass), confirm the trust dial's requirement is satisfied, confirm
   the adapter is connected. Any failure → article back to `review`
   with the reason, nothing written to the site.
2. **hub** (adapter) — `ensureHub` for the article's page type;
   creates it when missing, and records `page_types.hubContentPageId`.
3. **publish** (adapter, retries 0 — a retried create is a duplicate
   post) — create the post; store `adapterRef` (WP id / PR number /
   webhook echo) and `publishedUrl`.
4. **manifest** (free) — upsert the new page into `content_pages` with
   `source='publish'` so the corpus knows about it immediately, before
   any crawl.
5. **links** (adapter) — pick up to 3 link targets from
   `content_pages`: same page type first, then shared-token neighbours,
   excluding the hub and the new page; maintain the owned block in each
   (rule 2); record what was injected on the article row. A failure
   here is **non-fatal** — the article is published; the run records
   `linksInjected < intended` and the reason.
6. **wire** (GitHub adapter only) — regenerate sitemap/rss/llms.txt/
   llms-full.txt from the manifest via the engine and commit them in
   the same PR.
7. **indexnow** (free, best-effort) — submit the new URL. Non-fatal.
8. **receipt** (free) — open the receipt with its baseline **in the
   same transaction** as the article's flip to `published`, reusing
   S3b's `openReceipt`. Target query = the proposal's keyword.
   Also flip the proposal to `done` and the backlog row to `published`.

Idempotency: the article's `adapterRef` is the guard — a workflow that
resumes after step 3 never creates a second post.

## Schema

- `publish_connections.configJson` gains adapter-specific shapes
  (no migration — it is already an encrypted blob), plus a new
  `defaultPostStatus` ('draft'|'publish') and `linkInjection`
  (bool, default true) in the same blob.
- `articles` gains `linksInjectedJson` (nullable) — what was injected
  where, so the UI can show it and a future unpublish could reverse it.
- Migration for the one new column, both dialects + parity.

## Surfaces

- **Article detail** gains a **Publish** panel: the target and what will
  happen, stated plainly before the button — "Creates a draft post on
  yoursite.com, adds it to the Comparisons hub, and links to it from 2
  existing posts." `btn btn-primary btn-sm` "Publish". Post-publish the
  panel becomes a receipt line: the live URL (SafeExternalLink), the
  hub, and the injected links as paths.
- **Publishing settings** (S3b's collapsible) gains: adapter select
  (WordPress / Webhook / GitHub), the per-adapter fields, default post
  status, a link-injection toggle with the sentence "rankloop only
  edits a block it created, marked in your HTML", and — for
  non-GitHub targets — the honest line "your site keeps generating its
  own sitemap; rankloop does not touch it".
- **Articles → Published tab** shows URL, hub, links injected, and the
  receipt's status chip.

## Files

- `src/server/features/rankloop/publish/adapters/{wordpress,webhook,
  github}.ts` behind one interface + `capabilities`
- `linkTargets.logic.ts` (pure: pick ≤3 neighbours) and
  `relatedBlock.logic.ts` (pure: parse/merge/render the owned block,
  idempotent) — both exhaustively tested
- `PublishWorkflow.ts` + wrangler + server.ts
- serverFunctions `rankloopPublishArticle.ts` + zod schemas
- surfaces as above
- tests: adapter contract tests against mocked fetch for all three
  (create, hub-create, failure modes, WP draft-vs-publish, webhook
  signature, GitHub PR shape); owned-block idempotency (append once,
  re-run changes nothing, user edits outside the block survive);
  link-target selection (hub excluded, self excluded, ≤3, same-type
  first); preflight rejection paths; the publish→receipt transaction;
  adapterRef idempotency on resume

## Acceptance

1. Parity + migration green; `pnpm ci:check && pnpm test:ci && pnpm
   vite build` green; dev boots.
2. Mocked-adapter proof, all three adapters: a passing article
   publishes, its hub is created first (assert ordering), links are
   injected into ≤3 real neighbours via the owned block, the receipt
   row exists with a baseline, and the proposal/backlog rows moved.
   Re-running the workflow does **not** create a second post.
3. Owned-block proof: injecting twice leaves one block; text the user
   wrote outside the block is byte-identical afterwards.
4. Keyless/unconnected proof: with no publish connection the Publish
   panel shows the setup pitch and the workflow refuses cleanly.
5. Grep proof: no adapter writes anywhere outside the delimited block
   except when creating a new post.
