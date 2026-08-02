# The Verdict — Act I

## Status

Accepted (August 2026). Implements Act I of `docs/PLAN-3ACTS.md`.

## Why

A new user does not arrive wanting a loop. They arrive wanting to know what
shape their site is in. Today that answer is spread across seven routes
(`/audit`, `/backlinks`, `/domain`, `/keywords`, `/rank-tracking`,
`/search-performance`, `/plan`) that each have to be found and run by hand,
and no screen answers the question directly.

The Verdict is one screen, reachable ~90 seconds after a domain is added,
that answers it in four cards — and hands over **fixes as artifacts, not
advice**. A tool that only describes problems is an audit. rankloop's claim
is that it closes them.

## The four cards

### 1. Reach

`backlinks/summary` (already wired, `lib/dataforseo/backlinks.ts`).

Domain Rank · referring domains · total backlinks · dofollow share · new and
lost referring domains over 30 days.

**Naming law.** The metric is rendered as **"Domain Rank (DataForSEO)"**,
never as DA or DR. It is DataForSEO's own 0–1000 score; Moz DA and Ahrefs DR
are different vendors' different scales. Labelling a vendor score with a
competitor's trademark is the exact species of lie the publish laws exist to
prevent, and it would be the first thing a user checks against a tool they
already trust.

### 2. Index

Pages we crawled vs pages actually indexed.

- **GSC connected** → Index Coverage is the truth; use it.
- **Not connected** → `site:` result count via DataForSEO SERP, plus our own
  crawl reading `<meta name="robots">` and the `X-Robots-Tag` header per URL.

The fallback is **labelled as an estimate in the UI**. A `site:` count is
approximate by construction and must never be shown with the same authority
as Index Coverage.

Reports: crawlable · `noindex` · blocked by robots.txt · orphans (zero
internal links in, which the site study already computes via
`invertInlinkCounts`) · canonical conflicts.

### 3. AI access

**New. Nothing in the codebase does this today.**

Per-agent allow/block parsed from robots.txt for the crawlers that matter:

    GPTBot · OAI-SearchBot · ChatGPT-User
    ClaudeBot · Claude-User · Claude-SearchBot
    PerplexityBot · Perplexity-User
    CCBot · Google-Extended · Bytespider · Amazonbot
    Applebot-Extended · meta-externalagent

Parsing follows RFC 9309: group selection by case-insensitive product-token
match with `*` as fallback, and rule precedence by **longest match wins,
Allow breaking ties**. `*` wildcards and `$` anchoring are honoured (the
Google extension every real robots.txt in the wild assumes).

Evaluated against two paths, because they fail independently: the site root
and the blog path. A site that allows `/` but disallows `/blog/` is invisible
exactly where rankloop publishes.

Three checks robots.txt cannot answer:

- **llms.txt / llms-full.txt present.** The engine already generates both
  (`wire.ts`), so a miss here is one click from fixed.
- **Edge-level AI blocking.** Cloudflare's "block AI scrapers" returns
  403/429/challenge regardless of what robots.txt says. Detected by fetching
  one URL with a bot UA and comparing status and body length against a
  browser UA. This is the check that catches a site whose robots.txt is
  perfect and whose content is still unreachable.
- **Content visible without JavaScript.** If a page's raw-HTML text is
  negligible, most AI crawlers see nothing. Measured on raw HTML only — we do
  not execute JavaScript, so the finding is phrased as what we can actually
  prove: *"we found N words of text in the HTML of this page"*. No claim about
  what a rendering crawler would see.

### 4. Structure

Reuses the existing audit crawl. Schema coverage (Article / FAQPage /
Organization / BreadcrumbList) · title and description length outliers · H1
count · sitemap.xml present **and** referenced in robots.txt · RSS.

## The finding → fix contract

Every finding carries a `fix`, and a fix is an artifact:

| Finding | Artifact |
|---|---|
| AI agent blocked in robots.txt | unified diff of the exact lines to add |
| llms.txt missing | the generated file content (engine `llmsTxt`) |
| sitemap not in robots.txt | one-line diff |
| `noindex` / canonical conflict | the per-URL list |
| schema missing | the JSON-LD block for that page type |
| edge-level AI blocking | the named provider setting to change |
| content not in HTML | the affected URLs and their HTML word counts |

Where a publish connection exists (the GitHub adapter is built), the fix
offers **Apply fix** → opens a PR. Where it does not (Framer, Webflow), the
fix is copy-to-clipboard plus the exact location to paste it. `rankloop only
edits a block it created` still holds: a robots.txt patch is fenced in a
`# rankloop` block and re-applying it replaces that block, never the file.

## Non-goals

- No headless browser. We do not render JavaScript, and no finding may be
  phrased as if we did.
- No new spend path. Every DataForSEO call routes through the existing budget
  cap and spend ledger in `packages/seo-data`.
- The Verdict never writes to the user's site on its own. Every fix is an
  explicit human action, same law as outreach.

## Acceptance

1. robots.txt parsing is unit-tested against RFC 9309 precedence, including
   longest-match, allow-ties, `$` anchoring, and grouped user-agent lines.
2. Every AI-agent verdict names the rule that produced it — the user can check
   our answer against their own file.
3. A finding with no artifact cannot exist: the type makes `fix` required.
4. The `site:` fallback is visibly labelled an estimate.
5. Domain Rank is never rendered as DA or DR anywhere in the UI.
6. Schema parity (D1/PG) holds; `schema-parity.test.ts` passes.
