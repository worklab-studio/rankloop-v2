# rankloop 2.0

Point rankloop at a site you own. It crawls the site, pulls your Google Search
Console history, studies three competitors, builds a keyword universe from
queries you already almost rank for plus the gaps your competitors cover, and
proposes a page plan you approve once. From then on it improves pages you
already have (retitle, push, refresh, prune) and writes new ones with your own
AI key, gating every draft behind quality laws that are pure code rather than
another model's opinion. Each published change opens a receipt: the same GSC
data, 14 to 42 days later, measured against the site's own trend. Those results
feed the next round of proposals. You run it yourself, on your own keys, and
nothing publishes without passing the laws.

## The loop

```
  ADD SITE
     |
     v
  [auto] site study  ->  [auto] competitor study  ->  [auto] keyword universe
     |
     v
  DRAFT PAGE PLAN --> GATE 1: you approve page types
                              |
                              v
                      proposals --> GATE 2: you approve titles
                              |
                              v
     brief -> draft (your AI key) -> LAWS GATE (pure code, no LLM)
                              |
                              v
     publish + hub + internal links -> IndexNow -> RECEIPT (day 14-42)
                              |
     unserved queries and near-misses feed the queue back
                              |
                              +-------------------> back to the universe

  running in parallel from week one: the optimize-existing track
  (retitle / push / refresh / prune on the pages you already have)
```

## What it costs to run

You bring the keys and pay the vendors directly. There is no rankloop bill.
Every call is logged to a spend ledger with a hard ceiling, and the UI states
the cost before you trigger anything expensive.

| Action | Cost | How often |
|---|---|---|
| Site crawl and audit | free | weekly |
| Search Console sync | free | daily |
| Site overview data (authority, backlinks) | ~$0.05 | weekly |
| Competitor study | ~$0.10 to $0.20 each | monthly, top 3 by default |
| Keyword expansion | ~$0.01 per seed | weekly |
| SERP snapshot | ~$0.002 per keyword, cached | at plan time and brief time |
| Page plan recompute | ~$0.08 | on demand |
| One article | ~$0.10 to $0.50 LLM, ~$0.01 data | per article |

A concrete example the page plan shows you before you approve it: a comparison
page type covering 47 pages costs about $12 to write, at roughly $0.25 each.

### The three keys

1. **OpenRouter** (`OPENROUTER_API_KEY`). Required to write. This is the
   writer's key and the one thing rankloop cannot work around. Without it the
   site study, Search Console memory, competitor study, keyword universe and
   page plan all still run; no article, no title and no strategy chat is ever
   produced. Keys: https://openrouter.ai/settings/keys
2. **DataForSEO** (`DATAFORSEO_API_KEY`). Optional. It supplies search volumes,
   difficulty, competitor discovery, keyword gaps and backlinks. Without it you
   can still add competitors by hand and work from Search Console data alone;
   the screens say so instead of erroring. Setup:
   `apps/dashboard/docs/DATAFORSEO_API_KEY.md`
3. **Google Search Console**. Free, but self-hosting it means creating your own
   Google OAuth client and setting `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
   and `BETTER_AUTH_SECRET` (which encrypts the stored tokens). Optional in the
   sense that the app boots without it, load-bearing in the sense that the
   flywheel, the receipts and the optimize-existing track all read GSC. Setup:
   `apps/dashboard/docs/SELF_HOSTING_GOOGLE_SEARCH_CONSOLE.md`

Also optional: `INDEXNOW_KEY` (pings IndexNow on publish, and only works once
the matching `<key>.txt` is served from your site root) and `OPENROUTER_MODEL`
(overrides the writer's model slug).

## How to run it

The Docker path below was executed end to end on 2026-08-01 and is described as
it actually behaved. There is no published image: `ghcr.io/every-app/open-seo`
is upstream OpenSEO and contains none of rankloop, so you build the image
yourself.

You need Docker, and a clone of the **whole repo**. The image build context is
the repo root, because the dashboard depends on `packages/engine` through a
workspace link; a build rooted at `apps/dashboard` cannot see it.

```sh
git clone https://github.com/worklab-studio/rankloop-v2
cd rankloop-v2/apps/dashboard
cp .env.example .env
# set OPENROUTER_API_KEY in .env
docker compose up -d --build
```

Then open `http://localhost:3001` (override with `PORT`). What to expect:

- The image build takes several minutes and produces about 780 MB.
- The container's first start runs migrations and then builds the app before it
  serves anything. Budget roughly four more minutes. `docker compose logs -f`
  shows both.
- `/api/health` returns `{"status":"ok", ...}` once it is up;
  `docker compose ps` reports the health check.
- Your data (projects, keywords, drafts, receipts) lives in the named volume
  mounted at `/app/apps/dashboard/.wrangler`. `docker compose down` keeps it.
- `docker compose up -d --force-recreate`, which the docs suggest after an
  `.env` change, discards the build and repeats the four-minute boot build.

**Docker mode runs with `AUTH_MODE=local_noauth`: no auth checks at all, one
injected admin user.** Put it behind your own reverse proxy, tunnel or private
network. Do not expose the port to the internet.

What was verified in that run: the image builds, the container reaches
`healthy`, the dashboard renders, creating a project persists to the database
inside the container, and the background machinery genuinely works under
Docker. Workflows execute (triggering "Study my site" ran the site study, which
chained the site audit and made real outbound requests) and the Durable Object
alarm that dispatches routines armed itself. Plan and Articles both render with
no keys configured, showing setup prompts rather than errors.

Longer version, including the by-hand build command and troubleshooting:
`apps/dashboard/docs/SELF_HOSTING_DOCKER.md`.

There is a second self-host path, Cloudflare Workers via
`pnpm run deploy:selfhost` and `alchemy.run.ts`, documented in
`apps/dashboard/docs/SELF_HOSTING_CLOUDFLARE.md`. It has **not** been run since
the fork; see Status below.

## The two decisions you make

Everything else is automatic. These are the only two places the pipeline stops
and waits for you.

**Gate 1: approve the page types.** After the study finishes, rankloop proposes
a handful of page types. Each card gives you the count, three real example
titles, the demand in plain words, what it costs to write the set, the
competitor evidence behind it, and the authority gap ("they're DR 55, you're DR
15"). Programmatic types must name a data source before they can be approved;
if there is no data behind a type, it gets downgraded to a blog type or killed.

**Gate 2: approve the titles.** Each proposed title arrives with the evidence
that produced it. You approve, edit or reject. Autopilot exists but is earned
rather than switched on: it unlocks per action type only after that action's
90-day receipt cohort shows it works.

## What it will not do

- **It never sends outreach.** The outreach planner researches link targets,
  drafts messages and gives you a tracking board. You send them. It does not
  scrape email addresses (contact-page links only), and automated sending is
  permanently out of scope.
- **It never publishes a draft that has not passed the laws.** The laws are
  pure functions in `packages/engine`: em dash ban, filler-phrase ban, title
  and description limits, word band, H2 and FAQ minimums, keyword density
  ceiling, first-person evidence, and internal links that must actually
  resolve. No model grades another model's output. A failing draft gets up to
  three fix attempts and then goes to a review queue.
- **It never writes outside its own delimited block on your site.** Link
  injection into existing posts maintains a
  `<!-- rankloop:related start -->` block that rankloop created. It is
  idempotent across runs, and you can delete it without breaking anything. Your
  prose is never rewritten.
- **It never invents data for programmatic pages.** No data row, no page. When
  rankloop compiles a dataset it extracts values from pages it fetched, and
  every cell stores its `sourceUrl` and `fetchedAt`. The laws gate checks that
  rendered cells carry provenance: no source, no number. Low-confidence cells
  go to a human spot-check list.

## Repo layout

```
apps/dashboard              the product: a vendored OpenSEO fork, extended
  src/server/features/rankloop/
      site-study competitors universe page-plan proposals writing
      publish indexation receipts routines outreach gsc-sync agent
  src/client/features/rankloop-plan | -articles | -receipts | -automation
  specs/0009-0026.md        one spec per shipped step, in order
  docs/SELF_HOSTING_*.md    the self-host guides
  Dockerfile.selfhost       built from the REPO ROOT context
  compose.yaml              the one-command path

packages/engine             the method as pure TypeScript: laws, scoring,
                            briefs, quota, pool mix, wire artifacts.
                            Zero LLM calls, by design.
packages/cli                `rankloop init` / `check` / `brief` for repo-based
                            sites: scaffolds config and a writer prompt, runs
                            the laws in CI. Makes no network call, ever.
packages/seo-data           budget-capped DataForSEO client + spend ledger
packages/db                 empty placeholder, no code

apps/web                    dead Next.js shell from the pre-fork prototype.
                            Not built, not deployed, kept only for reference.
docs/PLAN.md                the full plan
docs/JOURNEY.md             the same thing as a narrative
tools/                      gen-parity-fixtures.py, produces the fixtures the
                            engine's parity tests assert against
```

## Attribution

`apps/dashboard` is a vendored fork of **OpenSEO**
(https://github.com/every-app/open-seo), MIT licensed, Copyright (c) 2026 Ben
Senescu, taken at commit `9d19e439905a9a954ccdefe22d9270d7c389695d`
(2026-07-31).

That is not a thin base. The crawler, the audit workflow, the DataForSEO
integration, the Search Console plumbing, the auth modes, the MCP server, the
job architecture, the self-host paths and the entire design system are
OpenSEO's work, and rankloop's screens were built inside it deliberately so
they look and behave like the rest of the app rather than like a graft. If you
want SEO tooling without the pSEO pipeline, use OpenSEO directly; it is very
good on its own.

rankloop's additions are the write side: site study derivation, competitor
studies, the keyword universe, the page plan, proposals, the writer and its
laws gate, publishing and link injection, indexation throttling, receipts,
routines and autopilot, and the agent/MCP path. Upstream's license is preserved
at `apps/dashboard/LICENSE` and the fork point is recorded in
`apps/dashboard/ATTRIBUTION.md`. rankloop's own code is MIT.

## Status

Specs 0009 through 0026 are implemented, 2,206 tests pass, and the Docker
self-host path works as described above. What follows is what is not proven, so
that you find out here rather than three hours in.

- **The npm package is not published.** `npx rankloop` does not work yet. To
  use the CLI, clone the repo, `pnpm install`, `pnpm --filter rankloop build`,
  then run `node packages/cli/dist/rankloop.js`. For the same reason,
  `rankloop init` scaffolds its CI workflow with the check step commented out,
  so nobody mistakes a green tick for an enforced gate.
- **The Cloudflare self-host path has not been run since the fork.** It has
  been checked statically only: the workflow and Durable Object bindings are
  derived from `wrangler.jsonc` so they cannot drift, and the two rankloop env
  vars that had no binding were added. Nobody has deployed it to a real
  Cloudflare account. Expect to debug.
- **Postgres has never been exercised.** SQLite (D1) is the default and the
  tested path. The Postgres schema and migrations in `drizzle-pg/` exist and
  are kept in sync at the source level, but they have not been applied against
  a live Postgres instance since the rankloop tables were added. Treat
  `docs/LOCAL_POSTGRES.md` as untested for this fork.
- **The rankloop screens have no end-to-end test coverage.** The 2,206 tests
  are unit and integration tests. The Playwright suite in `apps/dashboard/e2e`
  covers upstream surfaces (domain overview, keyword research) and touches none
  of Plan, Articles or Receipts.
- **CI does not build the Docker image, for this repo.** The GitHub workflows
  still sit at `apps/dashboard/.github/workflows/`, which GitHub Actions never
  reads, because the repo root has no `.github`. The Docker job in them also
  still assumes the pre-fork build context. Until those move, nothing stops a
  self-host regression from shipping green.
- **The app is still branded OpenSEO.** The page title, the sidebar wordmark,
  the empty states and the in-app help links all say OpenSEO and point at
  upstream. The rankloop screens (Plan, Articles, Receipts, the pipeline card
  on the Dashboard) are rankloop's, but they sit inside upstream's shell. This
  is cosmetic, and it is being fixed, but it is the first thing you will
  notice.
- **The container rebuilds the app at every start**, including a full
  typecheck. That is why first boot takes minutes, and it means a type error
  anywhere fails the container at runtime instead of at image build time.
- **Nothing here has run for 90 days on a stranger's site.** The method is the
  one that ran notchbay.com, conclick.io and xautopilot.app in production, and
  the receipts machinery is built to tell you the truth about whether it works
  on yours. But this rebuild is new, and the honest claim is that the pipeline
  runs, not that it has been proven on your site.

MIT.
