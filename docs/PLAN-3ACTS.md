# rankloop — the three acts

The v2 build weighted everything toward the *ongoing loop* (propose → write →
gate → publish → receipts). That loop is real and tested. But a new user does
not arrive wanting a loop. They arrive wanting to know **what shape their site
is in**, then **where links can come from**, and only then **what gets
written**. This document re-plans the product as three acts and states exactly
what exists, what is thin, and what is missing.

    ACT I   VERDICT   what shape is my site in, and fix it
    ACT II  ARMORY    where can links and listings come from — hundreds
    ACT III VOICE     write it, in my theme, in my structure

---

## What already exists (do not rebuild)

Vendored from OpenSEO and working:

| Surface | Route | Data source |
|---|---|---|
| Site audit crawl | `/p/$id/audit` | own crawler; `isIndexable`, `hasStructuredData`, canonical, noindex, broken links |
| Backlinks + referring domains | `/p/$id/backlinks` | DataForSEO Backlinks API |
| Domain overview | `/p/$id/domain` | DataForSEO |
| Keywords / rank tracking / search performance | `/p/$id/{keywords,rank-tracking,search-performance}` | DataForSEO + GSC |
| AI prompt explorer / brand lookup | `/p/$id/{prompt-explorer,brand-lookup}` | LLM providers |

Built for rankloop:

| Surface | Route |
|---|---|
| Plan: competitors, keyword universe, page types, outreach | `/p/$id/plan` |
| Articles: proposals → drafts → laws gate → publish | `/p/$id/articles` |
| Receipts: measured outcomes | `/p/$id/receipts` |

The link gap already exists: `outreach/linkGap.logic.ts` finds domains linking
to ≥2 tracked competitors but not to you, caps at 100, and filters out
platforms nobody can pitch. Five message shapes exist in `templates.logic.ts`.

**So the gap is not "no data".** The gap is that the data is scattered across
seven screens the user must find and run by hand, there is no verdict, no
fixes, no submission lane, and no theme.

---

## ACT I — VERDICT

**Goal:** one screen, ~90 seconds after adding a domain, that answers "what
shape is my site in" and hands over *applied* fixes, not advice.

Four cards. Every number links to the deep screen that already exists.

### 1. Reach
- Domain Rank (DataForSEO 0–1000). **Label it honestly** — it is not Moz DA
  and not Ahrefs DR. Show the vendor name on the metric.
- Referring domains, total backlinks, dofollow share, new/lost last 30d.
- Source: `backlinks/summary` — already wired.

### 2. Index
- Pages we crawled vs pages actually indexed.
- With GSC connected: Index Coverage is the truth.
- Without GSC: `site:` count via DataForSEO SERP, plus our own crawl reading
  `<meta robots>` and the `X-Robots-Tag` header per URL.
- Report: N crawlable · M `noindex` · K blocked in robots.txt · O orphans
  (zero internal links in) · canonical conflicts.

### 3. AI access — **NEW, nothing like it exists today**
For each agent, allowed or blocked, parsed from robots.txt:
`GPTBot`, `OAI-SearchBot`, `ChatGPT-User`, `ClaudeBot`, `Claude-User`,
`Claude-SearchBot`, `PerplexityBot`, `Perplexity-User`, `CCBot`,
`Google-Extended`, `Bytespider`, `Amazonbot`, `Applebot-Extended`,
`meta-externalagent`.

Plus three checks robots.txt cannot answer:
- **llms.txt / llms-full.txt present?** The engine already generates both
  (`wire.ts`) — so a miss here is one click from fixed.
- **Edge-level AI blocking.** Cloudflare's "block AI scrapers" toggle returns
  403/challenge regardless of robots.txt. Detect by fetching one URL with a
  bot UA and comparing to a browser UA.
- **JS-gated content.** If raw HTML text is <20% of rendered DOM text, most AI
  crawlers see an empty page. This is the single most common silent failure
  on Framer/Webflow/SPA sites and no robots.txt check finds it.

### 4. Structure
Schema coverage (Article / FAQPage / Organization / BreadcrumbList), title and
meta length outliers, H1 count, sitemap.xml present *and* referenced in
robots.txt, RSS.

### The part that matters: fixes are patches, not prose
Every finding carries a concrete artifact:
- robots.txt → a **unified diff** of the exact lines to add
- llms.txt → the **generated file content** (engine already does this)
- noindex/canonical → the **per-URL list**
- missing schema → the **JSON-LD block** for that page type

Where a publish connection exists (GitHub adapter is built), offer **Apply
fix** → opens a PR. Where it does not (Framer), offer copy-to-clipboard and
the exact place to paste it. A verdict that only describes problems is an
audit tool; rankloop's claim is that it closes them.

---

## ACT II — ARMORY

**Goal:** hundreds of concrete places to get listed or linked, each with a
prepared payload, each tracked to "link is live".

Two discovery lanes feeding one board.

### Lane 1 — Link gap (exists)
Domains linking to ≥2 tracked competitors but not to you. Keep as is.

### Lane 2 — Submission targets (**NEW**)
Three sources, deduped by domain:

**a. SERP mining.** For each approved page-type category, run a pattern set
through DataForSEO SERP and keep organic top-20:
`best {noun} tools` · `{noun} directory` · `top {noun} software` ·
`{noun} alternatives` · `submit {noun}` · `{noun} startups list` ·
`{noun} tools 2026`. This surfaces the listicle and roundup universe — the
pages that already rank for the terms you want, and that accept additions.

**b. Competitor backlinks, filtered for submittability.** From referring
domains we already pull, keep those whose linking page URL matches submission
shapes (`/submit`, `/add-listing`, `/directory`, `/tools/`, `/alternatives/`,
`/best-`), or where ≥3 competitors appear on one page — proof the page accepts
this category.

**c. Curated seed pack.** A shipped data file of ~150 universal launch and
directory targets with per-target metadata: submission URL, free/paid, what
the form requires, typical turnaround, approval odds.
**This must be a JSON data file, not code** — hard rule 2 (no niche vocabulary
in code) is what keeps rankloop general.

### Scoring
`relevance × authority × attainability × effort`. Attainability comes from
observable facts, not vibes: a form is high, an editorial pitch is low; a page
already listing ≥2 competitors is proof the category is accepted.

### The Submission Kit
One record holding your product's canonical facts, filled once:
name · one-liner (60ch) · short (160ch) · long (500ch) · logo · OG image ·
category tags · pricing · founder · launch date.

Every target's payload renders from it, per that target's field limits, with
copy-to-clipboard per field — because most directories are manual forms and
always will be.

### State machine
`discovered → queued → prepared → submitted (by you) → live | rejected | no-response`

**Link verification:** a weekly job re-fetches the target page and looks for a
link to your domain. Found → flips to `live`, records an earned receipt, and
that link shows up in Act I's Reach card. The loop closes on its own.

**Unchanged law:** rankloop never submits a form and never sends an email. It
prepares; a human sends. Same rule as outreach today.

---

## ACT III — VOICE

**Goal:** the published post looks like it belongs on the site, and is
structured like a notchbay post by default.

### Theme extraction (**NEW** — nothing exists today)
Crawl three representative pages, then derive a `SiteTheme`:
- font stacks (heading / body / mono)
- color roles: bg, fg, muted, accent, border — from CSS custom properties
  where present, else frequency analysis over declared colors
- radius scale, max content width, heading size ratio, link treatment

Auto-extraction will be roughly 80% right, so it renders as an **editable
swatch card**. One click to override any token. Never silently wrong.

### Blog structure — the notchbay skeleton as default
An explicit `ArticleTemplate` per page type, not an implicit brief hint:

    hero (title · dek · date · read time)
    table of contents
    key takeaways
    ≥4 H2 sections            ← already a law
    comparison table          ← where the page type warrants it
    FAQ block                 ← already a law; mirrors FAQPage JSON-LD
    attribution line
    related posts             ← the internal links the laws already require
    CTA

The laws already enforce the counts. This makes the *shape* explicit and
per-page-type instead of leaving it to the model.

### Renderers
For source-code users, emit real files in their stack, detected from the repo:
- Next.js app router → `app/blog/[slug]/page.tsx` + tokens CSS
- Astro → `.astro` layout
- plain HTML → template

That is the "directory list to upload" kit.

### Preview
Render the draft inside the extracted theme, in the dashboard, before publish.
This is the answer to "how does the blog page UI get decided" — you see it,
you adjust the tokens, you ship.

---

## Order, cost, dependencies

**Recommended order: I → III → II.**

Act I is mostly wiring screens that already exist plus one new crawler module —
highest impact per unit of work, and it is what day 0 looks like. Act III
unblocks actually shipping a post that looks right. Act II is the largest net
new build and the least blocking, because submission is manual by design.

**Cost:** the Backlinks API is the expensive DataForSEO surface, and Act II
lane (b) multiplies it by competitor count. Route every call through the
existing budget cap and spend ledger in `packages/seo-data` — no new spend
path.

**Blockers to name honestly:**
- Framer (productlaunchos.com) has no publish adapter. Acts I and II work
  fully; Act III can extract the theme and preview, but cannot publish.
- GSC is not connected, so Act I's Index card falls back to `site:` counts.
