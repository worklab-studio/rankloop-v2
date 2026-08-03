# rankloop — the product, engineered

This document supersedes the IA implied by the current sidebar and absorbs
`PLAN-3ACTS.md`. It exists because the dashboard as shipped is two products
in one filing cabinet — OpenSEO's point-at-anything research tools and
rankloop's operating loop — with no order of operations. A new user cannot
tell where to start because there genuinely is no start.

The fix is not more cards. It is making the UI *be* the pipeline.

---

## 1. What rankloop is (one paragraph)

You give rankloop a domain. It studies the site, the market, and the keyword
space automatically; proposes a content plan — programmatic page types,
listicles, blog angles — each wearing its evidence; and once you approve,
publishes daily, matched to your site's theme, either into your repo as PRs
or as copy-paste-ready articles. Alongside content it builds a growth map:
hundreds of directories, listicles and blogs where your product can be
listed or linked. Everything it ships is measured (receipts), and autonomy
is earned per action type, never assumed. It never invents data, never
claims experience it doesn't have, and never sends anything on your behalf.

Research tool AND generation tool — but the research *feeds* the
generation. There is one path through the product.

## 2. What Byword taught us (studied 2026-08-02)

Byword ($99–999/mo, 85k teams, 3M+ articles) is the strongest UX in the
space. What they get right, adopted here:

1. **One input starts everything.** "Enter your domain" → ranked
   opportunities. No configuration before value.
2. **Everything flows into generation.** Research is not a separate tool; it
   is the top of one funnel. Every keyword row has a "generate" affordance.
3. **Template gallery, not blank canvas.** Their programmatic feature leads
   with proven patterns — `{product} vs {competitor}`, `best {competitor}
   alternatives`, `{service} in {city}`, `{product} for {industry}`,
   `{feature}: complete guide`, `{app} + {platform}`. Users pick a pattern;
   they don't design one.
4. **Four-step mental model** everywhere: connect data → template →
   generate → publish.
5. **Their "Pages" beta** (managed pSEO: variables × variables = pages,
   visual template editor, they host on your subdirectory, drip-feed
   deployment, GSC-connected overnight "agent optimization": retitles to
   intent, flags underperformers, suggests variables, fixes
   cannibalization) — this is our receipts/autopilot loop, rebuilt by them,
   closed-source, on their servers.

Where rankloop deliberately differs — the positioning:

| | Byword | rankloop |
|---|---|---|
| Model | SaaS, $3/article | open source, BYO keys, ~$0 |
| Pages live | their edge, your subdirectory | **your repo, your theme, yours forever** |
| Quality | live score (advisory) | **15 laws (a hard gate); grader never the author** |
| Optimization | black-box agent toggle | **receipts → autonomy earned per action type** |
| Off-page | none | **the Grow armory: directories, listicles, backlinks** |
| Honesty | — | no data row no page; no fabricated experience; never sends outreach |

Byword rents you your own SEO. rankloop installs it.

## 3. The two output modes

**Mode A — Manual (copy-paste).** Zero setup, always available. Every
gated article offers: Copy as Markdown / HTML / plain text, plus assets
(title, meta, JSON-LD block, OG image). "Mark as published" is an
attestation (same idiom as outreach attest) so receipts still open and
measure via GSC. This is the mode a Framer/Webflow/Wix user lives in until
an adapter exists.

**Mode B — Automation.**
- **Repo (flagship).** Connect GitHub → rankloop opens PRs.
  - PR #1 — *the scaffold*: blog index + post template rendered in the
    site's extracted theme tokens, default structure (below), sitemap/RSS
    wiring, robots.txt + llms.txt fixes from the verdict. Stack detected
    (Next.js app router / Astro / plain HTML) → real files in that stack.
  - PR #N — one per article: content file, internal-link injections into
    2–3 existing posts, sitemap + llms.txt updates. IndexNow ping on merge.
  - Merging is the human gate; auto-merge unlocks with earned autopilot.
- **CMS.** WordPress + webhook (built). Webflow then Framer: roadmap
  (spec 0031 has the research).
- **Laptop (`rankloop-local`).** On a machine with the dashboard on
  localhost, a zero-dependency runner drives the agent path on a cron:
  your own CLI writes (`claude -p` — no API key, no per-article cost), the
  server's laws grade, violations feed back until it passes, and in repo
  mode it commits, pushes, waits for the URL to answer 200, and reports —
  which opens the receipt. Spec 0032; verified live.

**Theme & structure.** Theme = tokens extracted from 3 crawled pages
(fonts, color roles, radius, container width), rendered as an editable
swatch card — never silently wrong. Structure = per page type, default is
the proven skeleton (hero → TOC → key takeaways → ≥4 H2 → comparison table
where warranted → FAQ → related → CTA; the laws already enforce the
counts), or a custom section list the user edits. Byword's visual editor is
the ceiling here; a section-list editor is the honest v1.

## 4. Day 0 — the cascade (the whole first-run UX)

Entering a domain does not land on a dashboard. It lands on a full-screen
progress spine, every stage automatic, each resolving to one plain
sentence:

    Studying productlaunchos.com

    ● Your site        1 page on Framer. All 14 AI crawlers allowed.
                       llms.txt missing — fix ready. Theme extracted.
    ● Your market      6 competitors found. Closest: x.com (DR 55).
                       Pulling their keywords and backlinks…
    ● Keywords         1,218 found: 89 you rank for · 412 competitors
                       own · 717 open. 340 short-tail / 878 long-tail.
    ● SERPs            Sampled 60. 214 winnable (weak positions 6–10).
    ● Your plan        4 page types + 12 blog angles drafted, with
                       evidence. First 20 titles staged.
    ● Growth map       312 places to get listed or linked.

    → Review your plan

Two setup prompts slot into the wait, neither blocking: **Connect Search
Console** ("without it rankloop can't see your real queries — everything
else still runs") and **Where will posts live?** ("repo / WordPress /
webhook / copy-paste — you can decide at first publish").

Engineering note: stages 1–5 are the existing runs (site-study, competitor
study, universe, page-plan) chained by one new orchestrator; stage 6 is the
armory build (§6). The new surface is the spine screen + orchestrator, not
new pipelines. Progressive, resumable, each stage independently retryable —
same run-row idioms as everything else.

## 5. Information architecture — six items

The sidebar stops being a filing cabinet and becomes the journey:

    TODAY      what's happening + what needs you (the only dashboard)
    STUDY      your site · your market (read-only, auto-refreshed)
    PLAN       the approval surface: page types, angles, titles
    PUBLISH    the article pipeline: queue → gated → live → measured
    GROW       the armory: directories, listicles, backlink targets
    CONNECT    integrations, automation, theme (the only settings)

    Toolbox ▸  (collapsed) keyword research · domain overview ·
               backlinks explorer · rank tracking · brand lookup ·
               prompt explorer · saved keywords

Where every current screen goes:

| Now (14 items) | Becomes |
|---|---|
| Dashboard | **Today**, cut to: needs-you queue · pipeline state · digest · what moved |
| Site Audit, AI Access, GSC Insights | **Study → Your site** (verdict cards: Reach / Index / AI / Structure, each linking deeper) |
| Plan→Competitors | **Study → Your market** |
| Plan (universe, page types), Keyword Research feeds | **Plan** |
| Articles, Receipts | **Publish** (receipts = its Outcomes tab) |
| Plan→Outreach | **Grow** (absorbed into the armory board) |
| Settings, AI & MCP, publish connections | **Connect** |
| Domain Overview, Backlinks, Brand Lookup, Prompt Explorer, Rank Tracking, Saved Keywords | **Toolbox** (collapsed; deep-linked from flows) |

Rules that keep it simple:
- **Sequence gating.** A screen whose prerequisite hasn't run shows one
  sentence + one button, never empty tables. (The automation-card lesson,
  applied everywhere.)
- **Two numbers, one place.** Every metric has exactly one home; other
  surfaces link to it. (Kills the Backlink pulse / Authority duplicate.)
- **Research tools never interrupt the journey.** They are reached from
  within it ("inspect this SERP") or from the Toolbox, never from the
  critical path.

## 6. Grow — the armory (the "huge" requirement)

Target: **hundreds of rows on day 0**, each actionable, none fabricated.

Three lanes, one board, deduped by domain:

1. **Seed pack** — ~300 curated universal targets (Product Hunt, BetaList,
   AlternativeTo, SaaSHub, G2, Capterra, launch directories, newsletter
   directories…) shipped as a **JSON data file** — hard rule 2: no niche
   vocabulary in code. Per target: submission URL, free/paid, required
   fields, typical turnaround, approval odds.
2. **SERP mining** — per approved category: `best {x}`, `top {x} tools`,
   `{x} alternatives`, `{x} directory`, `submit {x}` → organic top-20 =
   the listicle/roundup universe that already ranks for your terms.
3. **Competitor backlinks, filtered submittable** — linking pages matching
   `/submit`, `/add`, `/directory`, `/tools/`, `/alternatives/`, `/best-`,
   or any page listing ≥2 tracked competitors (proof the category is
   accepted). Extends the existing link-gap logic.

Each row: kind (directory / listicle / blog / resource page) · authority ·
**why-you-qualify evidence** ("lists 3 of your competitors") · prepared
payload rendered from the one-time **Submission Kit** (name, 60/160/500-char
descriptions, logo, OG, category, pricing) per that target's field limits ·
or a pitch draft from the existing outreach templates · state machine
`discovered → queued → prepared → submitted → live / rejected / no-response`.

A weekly job re-fetches target pages looking for your link; found → flips
to `live`, opens a receipt, and the link shows up in Study → Reach. The
loop closes itself. **rankloop prepares; a human sends** — unchanged law.

## 7. Connect — the integrations page

One page, four groups, each with live status:

1. **Publishing** — GitHub repo · WordPress · Webhook · Copy-paste
   (always-on fallback). Test button per connection; the repo card shows
   the scaffold-PR state.
2. **Data** — Google Search Console (OAuth) · DataForSEO key · AI writer:
   API key (OpenRouter / OpenAI / Anthropic) **or CLI-native** (the MCP
   agent path — "your Claude writes, rankloop grades"; already built).
3. **Automation** — the trust dial (approve everything → approve titles →
   earned autopilot per action type) · posts/day quota · schedule · digest
   delivery. First-run states from the automation-card fix carry over.
4. **Design** — theme tokens (extracted, editable swatches) · structure
   per page type (default skeleton / custom section list) · voice card.

## 8. Build order

**Phase 1 — the UX collapse.** New six-item nav + Toolbox; Today cut to
needs-you/pipeline/digest; sequence gating everywhere; merge duplicate
cards; the Day-0 cascade orchestrator + spine screen. *Mostly
rearrangement of built things; highest leverage per line changed.*

**Phase 2 — Grow.** Seed pack, SERP mining, submittable-backlink mining,
Submission Kit, board + state machine, weekly link verification.

**Phase 3 — Repo mode.** Theme extraction, stack detection, scaffold PR,
per-article PRs, structure editor. (Copy-paste mode ships in Phase 1 —
it's an export surface on articles that already exist.)

**Phase 4 — Programmatic depth.** The variables × variables builder
(Byword-Pages equivalent, repo-native), dataset-driven pSEO (CSV/API →
pages, through the same laws), then CMS adapters.

Adapter order corrected after research on 2026-08-02 (see spec 0031):
**Webflow first** — its Data API v2 is stable, REST, bearer-auth, and needs
nothing but `fetch`, which workerd runs natively. **Framer second, behind a
verification step** — it does now have a Server API (shipped February 2026,
`framer-api` v0.1.27) with a real upsert-shaped CMS write path, which
corrects the earlier note in this document that Framer had no adapter
route. Two things remain unverified: whether a package declaring
`engines: node >= 22` with a stateful transport runs under Cloudflare
Workers at all, and how stable a 0.1.x open beta is to build against.

Phases 2–4 are independent of each other; 1 unblocks the product.

## 9. What does not change

The laws. The grader never being the author. No data row, no page. The
engine package making zero LLM calls. Receipts before autonomy. Outreach
prepared, never sent. Budget-capped spend through the ledger. Dual D1/PG
schemas with the parity test. These are the parts users can't get
elsewhere; the UX above exists to deliver them, not dilute them.
