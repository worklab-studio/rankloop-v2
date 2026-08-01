# Self-hosting rankloop

You run rankloop on your own machine or your own server, with your own
keys. Nothing about your site, your Search Console data, or your drafts
goes anywhere except to the APIs you configured yourself.

This guide covers the Docker path, which is the one that has actually
been run end to end. The Cloudflare path is described at the bottom with
an honest warning attached.

> **The app is branded OpenSEO.** rankloop 2.0 is built inside a vendored
> fork of [OpenSEO](https://github.com/every-app/open-seo), and the shell
> still says so — page title, sidebar wordmark, help links. The rankloop
> surfaces are the **Write** group in the sidebar (Plan, Articles,
> Receipts) and the pipeline card on the Dashboard. Everything else is
> upstream's, and it works. Rebranding has not happened yet.

---

## Before you start

You need:

- **Docker Desktop**, or Docker Engine + Docker Compose.
- **A git clone of the whole repo**, not just `apps/dashboard`. The image
  build reads `packages/engine`, and a build rooted at `apps/dashboard`
  cannot see it. This is not a style preference — see
  [the build context failure](#the-container-builds-then-exits-with-rollup-failed-to-resolve-import-rankloopengine).
- **An OpenRouter API key** — [openrouter.ai](https://openrouter.ai/settings/keys).
  This is the writer's key. Without it rankloop studies, gathers keywords
  and plans pages, but never writes a word.
- **About 10 minutes in Google Cloud Console** if you want Search Console,
  which you do — see [Search Console](#search-console).
- Optional: a **DataForSEO** key for volume, difficulty, competitor and
  backlink data. rankloop runs without it in a named degraded mode.

Disk and time: the image is about 780 MB. The image build takes several
minutes; the container's first start then runs migrations plus an
app build before it serves. Budget ten minutes of waiting the first time.

### The one security fact

Docker self-hosting runs with `AUTH_MODE=local_noauth`: **no auth checks
at all**, a single injected admin (`admin@localhost`). Compose binds the
port to `127.0.0.1` only. If you put it on a network anyone else can
reach, put your own auth in front of it — a reverse proxy, a tunnel with
access control, a private network. There is no login screen to protect
you.

---

## Install

From `apps/dashboard`:

```bash
cp .env.example .env
```

Edit `.env` — at minimum set `OPENROUTER_API_KEY`. Then, still from
`apps/dashboard`:

```bash
docker compose up -d --build
```

Compose builds from the **repo root** context (`context: ../..`) and tags
the image `rankloop:local`. Watch it come up:

```bash
docker compose logs -f
```

Open `http://localhost:3001` (or your `PORT`). Check it is really up:

```bash
curl -s localhost:3001/api/health
# {"status":"ok","authMode":"local_noauth", ...}
```

If you would rather build by hand, from the **repo root**:

```bash
docker build -f apps/dashboard/Dockerfile.selfhost -t rankloop:local .
```

then `docker compose up -d` from `apps/dashboard`.

### Where your data lives

The named volume `open_seo_data` is mounted at
`/app/apps/dashboard/.wrangler` — the miniflare state directory holding
D1, KV, R2 and the Durable Object SQLite. Every project, keyword, draft
and receipt is in there. `docker compose down` keeps it;
`docker compose down -v` destroys it.

Note what is *not* in the volume: the built app (`dist/`). See
[first start is slow](#every-restart-rebuilds-the-app).

---

## The environment, variable by variable

`.env` in `apps/dashboard` is the whole configuration. Compose forwards
every value in it to the container.

### `OPENROUTER_API_KEY` — the writer's key

**Required for anything to be written.** rankloop's own pipeline is not
an LLM: the study, the keyword universe, the page plan, the optimize
signals and the laws gate are all deterministic code. But the draft
itself comes from a model, and the model is yours.

Without it:

- Articles → **Write** shows the setup pitch instead of the button, and
  `ArticleWriteWorkflow` refuses to start with a clear error rather than
  half-writing something.
- The onboarding strategy chat and SAM (the fork's in-app agent) stay
  dark.
- Everything else works: site study, GSC memory, optimize-existing
  proposals, competitors, the keyword universe, the page plan.

`OPENROUTER_MODEL` optionally pins a model slug for the whole
deployment. A per-project override lives on Articles → writer settings
and wins when set.

> **Known wart:** `/api/health` reports `"ai": {"status":"ok"}` even with
> no key set, because the preflight's `info` level maps to `ok`. Do not
> read a green health check as "the writer is configured". Check the
> preflight lines in `docker compose logs` instead.

### Search Console

`GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` + `BETTER_AUTH_SECRET`.

Formally optional. Practically, this is the one that decides whether you
have a product.

Search Console is where rankloop's memory comes from: page × query × date
history, 90 days back-filled on first sync, then daily. Without it:

- **No optimize-existing proposals, ever.** RETITLE, PUSH and REFRESH are
  computed from stored GSC rows against your crawled pages. No rows, no
  signals. That is the entire first week of the product.
- **No receipts.** A receipt's baseline and its result are both read from
  GSC performance. Actions still execute; they just never report back.
- **No indexation checks.** The daily job calls URL Inspection through
  your own GSC grant. Without a connection it is a clean no-op and the
  UI says indexation is unknown, which is honest but blind.

**There is no service-account path.** rankloop only speaks OAuth: you
create a Google Cloud OAuth client (type: Web application) with the
redirect URI `http://localhost:3001/api/gsc/oauth/callback` (scheme, host
and port exact, no trailing slash), and connect your own Google account
through it. The full walkthrough is
`apps/dashboard/docs/SELF_HOSTING_GOOGLE_SEARCH_CONSOLE.md`.

`BETTER_AUTH_SECRET` must be at least 32 characters
(`openssl rand -base64 32`). It is the encryption key for stored OAuth
tokens — **and for publish credentials**, below. Change it and everything
already encrypted becomes unreadable.

### `BETTER_AUTH_SECRET` — also your publish credentials

`publish_connections.configJson` is encrypted at rest with the same
helper and the same secret. That row holds your WordPress application
password, your webhook signing secret, or your GitHub token. Without
`BETTER_AUTH_SECRET` set you cannot save a publish connection at all, so
nothing rankloop approves can ever reach your site.

Set it even if you skip Search Console.

### `DATAFORSEO_API_KEY` — optional, and the degraded mode is named

Format: base64 of `email:password` for your DataForSEO account. See
`apps/dashboard/docs/DATAFORSEO_API_KEY.md`.

Without it rankloop runs in what the UI calls the **keyless** state — a
setup pitch, never an error:

| Surface | Without a DataForSEO key |
|---|---|
| Dashboard → Authority | Setup pitch. No backlinks, referring domains or domain rank. |
| Plan → Competitors | Automatic discovery is off; adding a competitor by hand still works. Metrics record as null; the study falls back to crawl + sitemap. |
| Plan → Keywords | Volume and difficulty are null. This is survivable by design: `min_volume=0` is doctrine, and a NULL difficulty always passes the adaptive ceiling. |
| Plan → Page types | Detection still runs free. SERP validation is skipped and each card reads `not sampled` rather than pretending to a verdict. |

You lose the competitive evidence and the authority reality-check. You
keep the loop.

### `INDEXNOW_KEY` — optional

Pinged when rankloop publishes. It only does anything once the matching
`<key>.txt` is served from your own site root; absent, publishing skips
the submission rather than collecting 403s.

### The rest

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3001` | Bound to `127.0.0.1` by compose. |
| `ALLOWED_HOST` | unset | A single reverse-proxy hostname to allow in Vite preview. Set it before putting a domain in front. |
| `OPEN_SEO_IMAGE` | `rankloop:local` | The tag compose runs. |
| `AUTH_MODE` | `local_noauth` | Set by compose. Do not change it in Docker. |
| `OPENSEO_TELEMETRY_DISABLED` / `DO_NOT_TRACK` | unset | `=1` opts out of the anonymized usage heartbeat. Details in `SELF_HOSTING_DOCKER.md#telemetry`. |
| `LOOPS_TRANSACTIONAL_DIGEST_ID` | unset | Hosted-mode email digest only. Self-hosters use the digest webhook on Settings → Automation instead. |

> `ghcr.io/every-app/open-seo:*` is **upstream OpenSEO** and contains none
> of rankloop. No rankloop image is published anywhere. You build it.

---

## First run, step by step

Roughly 5 minutes of your attention, then the machine works for a while.

**1. Create a project and set the domain.** New project modal, top of the
sidebar. The domain is what everything else is scoped to.

**2. Connect Search Console.** Dashboard → the Search Console card →
**Connect with Google** → authorize → pick your verified property. The
same card lives on Settings and on GSC Insights if you miss it. On
connect, a 90-day backfill starts: 93 days ago through 4 days ago,
computed on Google's Pacific-time calendar. It takes a few minutes.

If you see `redirect_uri_mismatch`, your OAuth client's redirect URI does
not exactly equal `<your-origin>/api/gsc/oauth/callback`. If you see
`access_denied`, your Google account is not a test user on the consent
screen while the app is in Testing mode.

**3. Study your site.** Dashboard → Content inventory → **Study my site**.
This crawls your site (robots-respecting, batched), extracts publish
dates, modified dates and same-origin outlinks, and derives the content
inventory every later phase reads: internal-link candidates, duplicate
checks, the corpus the quota counts against. The progress spine narrates
it live — "Studying your site · 134/214 pages". A weekly re-study runs on
its own afterwards.

**4. Wait.** With a DataForSEO key, competitor discovery auto-studies your
top 3 competitors, then the keyword universe fills from GSC unserved
queries + competitor gap + expansion + autocomplete + harvested
questions, then the page plan drafts. Without one, the universe fills
from the free sources and the plan still drafts. The spine tells you
where it is. Nothing needs you until the last line.

**5. Gate 1 — approve a page type.** Plan → **Page types**. Each card is
built to be judged by someone who is not an SEO: the type name and page
count, three real example titles, demand in words, the money math, the
competitor evidence sentence (or its honest absence), and a SERP verdict.
Types the planner killed sit collapsed under "Not worth building" with
their reasons. Approving binds the keywords to the type and derives its
template contract.

This is the only strategy decision in the product. Take your time.

**6. Turn the quota on.** Articles → writer settings. **Quota starts** is
empty by default and an empty value means *the quota is off* — net-new
proposals will not appear no matter how good your page plan is. This is
deliberate (a default date would start a clock nobody asked to start) and
it is also the single most common reason a fresh install looks stuck.
Set the date. `Posts per day` defaults to 2, `Catch-up cap` to 6.

**7. Connect a publish target.** Articles → the **Publishing** section at
the bottom. WordPress (base URL + username + application password),
webhook (URL + signing secret), or GitHub (App or token; opens a PR by
default). Test the connection. WordPress posts land as `draft` by
default — a human sees them in WordPress before the world does.

**8. Gate 2 — approve a title, then write.** Articles → **Proposed** →
Approve → **Write**. The workflow builds a grounded brief (you can read
it before a single word is generated), drafts once, runs the laws gate —
pure code, no model — and repairs at most twice more. A passing draft
lands in **Review**; a draft that never complies lands in **Failed** with
its full law report. Edit it yourself and hit **Save & re-check**, which
re-runs the gate with no model call and no cost.

**9. Publish.** The article detail's Publish panel states what will happen
before you click: which site, that the page type's hub is created first,
and how many existing posts will get a contextual link. A receipt opens
with its baseline in the same transaction.

---

## What runs on its own

One routine, nine blocks, in dependency order: GSC sync → site study →
receipts → indexation → competitors → keyword universe → net-new
proposals → digest → autopilot.

**On Docker, a Durable Object alarm drives it, every 15 minutes.**
Cloudflare's cron never fires outside Cloudflare, which is exactly the
trap this design exists to avoid: on a self-host the cron would silently
never run and nothing would admit it. The alarm is armed when a project
is created, re-armed at the end of every wake, and re-armed by a cheap
check on ordinary read paths if it was ever lost.

Settings → **Automation** states which dispatcher is driving *this*
deployment and when the next run is due. If that line is missing or the
next run never advances, that is a real bug worth reporting; a quiet
routine is not.

---

## Troubleshooting

### The container builds, then exits with `Rollup failed to resolve import "@rankloop/engine"`

You built from `apps/dashboard` instead of the repo root.

`apps/dashboard/package.json` declares `"@rankloop/engine":
"link:../../packages/engine"`. `pnpm install` does not verify `link:`
targets — it writes a dangling symlink and exits 0. So the image builds
green and the failure is deferred to the container's boot-time build,
minutes later, after migrations. With `restart: unless-stopped` it then
loops forever.

Fix: build from the repo root, or just use `docker compose up -d --build`
from `apps/dashboard`, which already sets `context: ../..`.

This was a real, shipped bug — the documented build command was wrong
from the day the fork was vendored until it was run for the first time.
Which brings us to:

> **No CI builds this image.** The workflows live at
> `apps/dashboard/.github/workflows/`, a path GitHub Actions never reads —
> the repo root has no `.github`. The `docker-build` job in `ci.yml` also
> still assumes `context: .` = `apps/dashboard`, valid only for the
> pre-fork layout. Until those four workflows move to `/.github/workflows`
> with `defaults.run.working-directory: apps/dashboard` and the docker job
> is repointed at the root context, nothing stops this exact regression
> from recurring. Treat a green "CI" badge as saying nothing about Docker.

### The container restarts in a loop

`restart: unless-stopped` plus a boot-time build means any startup error
becomes a slow rebuild loop with no fast-fail. Read the actual error
before rebuilding:

```bash
docker compose logs --tail=200
docker compose down
```

The preflight runs *before* migrations and the build, so genuine
misconfiguration (bad `AUTH_MODE`, missing auth config) fails in seconds
with the exact fix named. A failure that takes minutes to appear is a
build failure, not a config failure.

### Every restart rebuilds the app

The entrypoint runs `pnpm run build` (`vite build` + `tsc --noEmit`) at
container start, because Vite inlines client env vars into the bundle. It
fingerprints the build-relevant env and skips the rebuild when nothing
changed — but the output lives in the container filesystem, not in the
volume. So `docker compose up -d --force-recreate`, which the Search
Console doc tells you to run after an `.env` change, throws the build away
and pays the multi-minute cost again.

Prefer `docker compose up -d open-seo` for a plain restart. Use
`--force-recreate` only when compose actually needs to reapply `.env`,
and expect the wait.

(Moving the build into the image and dropping the `tsc --noEmit` pass
from the boot path is the obvious improvement and has not been done.)

### Nothing is being proposed

In order of likelihood:

1. **The quota is off.** Articles → writer settings → **Quota starts** is
   empty. Net-new proposals need it. See step 6 above.
2. **Search memory has not synced.** Optimize-existing proposals are
   computed from stored GSC rows; the Articles empty state says so
   ("No proposals yet — they appear after your search memory syncs").
3. **No page type is approved.** Net-new candidates are backlog rows bound
   to an *approved* type.
4. **The type has no data source.** pSEO types whose data source is unset
   are excluded with a stated reason — "needs a data source — see the page
   plan". No data row, no page. That rule is not negotiable and it is
   enforced here rather than as a surprise later.
5. **REFRESH specifically produces nothing for about two months.** It
   needs at least 8 weeks of stored memory before it will fire at all.

### The daily quota dropped to 1, or net-new stopped

That is the indexation throttle, working. Of the articles published 7–45
days ago, if fewer than 65% are indexed the daily quota is held at 1; below
40%, net-new proposing pauses entirely. The reason is printed in the
Articles header and on the run.

Optimize-track proposals are **never** throttled — improving what already
exists is precisely the right move when indexation is poor.

Below 5 articles in the cohort the rate is `null`, not 100%, and nothing
is throttled. An engine that has published twice must not conclude
anything.

### There was no digest today

A digest with nothing in it is not generated, not stored and not
delivered. Silence is information. If you want the digest somewhere other
than the in-app card, set a webhook URL on Settings → Automation; it
arrives as a signed `digest.daily` envelope.

### An article is stuck in Review, or landed in Failed

Working as designed. Nothing publishes that has not passed the laws, and
no model is ever allowed to decide that an article is good enough. The
gate is pure code in `@rankloop/engine`; a failing draft is handed its
violated laws as structured data and asked to fix exactly those, at most
three attempts including the first draft.

The article detail shows the full law report — every law, pass or fail,
with its threshold and the offending excerpt. Edit the markdown and
**Save & re-check**: it re-runs the gate with no model call, so fixing one
sentence never costs another generation.

### A receipt says "waiting" and never measures

The evaluation window is days 14–42 after the action. Measurement also
waits until your GSC memory actually covers the end of that window —
Google finalizes late, and a partial measurement is worse than none.
Check that the daily sync is running (Settings → Automation) and that the
memory stamp on GSC Insights is advancing.

### Search Console problems

`redirect_uri_mismatch`, `access_denied`, "connected but no properties to
pick", and "Google OAuth client not configured" are all covered with
their exact causes in
`apps/dashboard/docs/SELF_HOSTING_GOOGLE_SEARCH_CONSOLE.md`. The most
common one on a self-host is the third variable: `BETTER_AUTH_SECRET`
missing or shorter than 32 characters.

### Confirming what the container actually sees

```bash
docker compose config          # the resolved environment
docker compose ps              # container health
curl -s localhost:3001/api/health
```

---

## The other path: Cloudflare

`pnpm run deploy:selfhost` deploys to your own Cloudflare account through
`alchemy.run.ts`.

**This has not been run.** It was checked statically only, because it
needs a real Cloudflare account. What the static check found:

- Alchemy derives the Durable Object and Workflow bindings by reading
  `wrangler.jsonc`, so those cannot drift out of sync with the app.
- Two rankloop env vars had no binding at all — `INDEXNOW_KEY` and
  `LOOPS_TRANSACTIONAL_DIGEST_ID`. Setting them in `.env.selfhost` was a
  silent no-op. They have been added.

That is the only gap found, and "the only gap I could find in a static
read" is not the same claim as "it works". Someone should run this path
once before relying on it.

On Cloudflare the `*/15` cron drives the routine and the Durable Object
alarms idle as a backstop — the reverse of Docker. Both call the same
`runProjectRoutines`, so a routine cannot behave differently by
environment.

Walkthrough: `apps/dashboard/docs/SELF_HOSTING_CLOUDFLARE.md`.

---

## Known rough edges

Stated plainly rather than discovered by you at 2am.

- **No CI builds the self-host image.** Detailed above. This is
  structural and unfixed.
- **The Cloudflare deploy path is unverified.** Detailed above.
- **Six user-facing "OpenSEO" strings remain**, all on hosted-mode
  surfaces (support, billing). They were left deliberately: their correct
  replacements are rankloop URLs that do not exist yet, and an invented
  support address is worse than an honest upstream one. The shell itself
  — wordmark, page title, product copy — is rankloop's, and the "Built on
  OpenSEO (MIT)" credit in the sidebar is deliberate, not leftover.
- **`apps/dashboard/web` is still upstream's marketing site** for
  openseo.so. It is not part of the product and is not deployed by any
  rankloop path; it is retained as vendored upstream content.
- **`packages/seo-data` and `packages/cli` are not consumed by the
  dashboard.** Only `@rankloop/engine` is. The dashboard uses upstream's
  own DataForSEO client.
- **Docker mode has no auth.** Said twice on purpose.
- **`/api/health` reports the AI check as ok with no key configured.** The
  message was corrected; the level was deliberately left alone rather than
  quietly changing health semantics. For rankloop specifically, an install
  that cannot write anything is arguably a warning.
