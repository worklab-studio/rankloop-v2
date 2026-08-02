# Repo mode — Phase 3

## Status

Accepted (August 2026). Implements Phase 3 of `docs/PRODUCT.md`.

## Why

rankloop can plan what to publish and gate what gets written, and then it
hands you a markdown file. The gap between "here is a good post" and "the
post is live, on your site, looking like your site" is the whole remaining
distance, and it is where every other tool either takes over your hosting
(Byword Pages serves from their edge) or gives up (copy-paste).

Repo mode closes it without taking anything over: rankloop opens a pull
request against your repository. Your domain, your files, your git history,
your review. Merging is the human gate.

## Three parts

    theme      what your site looks like, derived from your site
    stack      what your repo is built with, derived from your repo
    scaffold   a PR that puts a blog in it, in that theme, in that stack

## 1. Theme extraction

Crawl representative pages and derive design tokens: font stacks, colour
roles, radius scale, container width.

**Extraction is a proposal, not a fact.** It will be roughly 80% right, so
every token renders as an editable swatch with a confidence, and a token we
are unsure about says so. A theme silently wrong is worse than no theme —
it produces a blog that looks *almost* like the site, which reads as broken
rather than unstyled.

### What the real page taught us

Measured against productlaunchos.com (Framer, 657 KB of HTML):

- **Values arrive HTML-escaped.** `--framer-font-family: &quot;Inter&quot;`
  reaches a naive regex as `&quot`. Entities are decoded before parsing.
- **`var()` indirection is everywhere.** `var(--token-a7a6b367-…, rgba(54,
  58, 91, 0.18))` — the usable value is the fallback, so `var()` is resolved
  to it rather than skipped.
- **Colours are `rgb()`, not hex.** 285 occurrences of `rgb(0, 153, 255)`
  against 41 of `#000`. An extractor that only reads hex finds a site's
  least-used colours and calls them the brand.
- **`border-radius: inherit` outnumbers real radii 171 to 5.** Keyword
  values have to be filtered or the radius scale is the word "inherit".
- **Fonts resist extraction.** Framer encodes them in a base64
  `--font-selector` and leaves `font-family` as a `var()` chain. Fonts get
  the lowest confidence of any token, and the UI says so.

### Colour roles

Frequency is the signal, but frequency alone names the wrong things — the
most common colour on most pages is white. Roles are assigned by frequency
*within* a bucket:

    background  most frequent very-light (or very-dark) colour
    foreground  most frequent very-dark (or very-light) colour
    accent      most frequent saturated colour that is neither
    border      most frequent low-alpha or near-background colour

## 2. Stack detection

From a connected repo, read a small set of marker files and decide:

| Stack | Marker |
|---|---|
| Next.js app router | `next.config.*` + an `app/` directory |
| Next.js pages router | `next.config.*` + a `pages/` directory |
| Astro | `astro.config.*` |
| Plain HTML | none of the above, and an `index.html` |

Detection returns a confidence and the evidence it used. An unrecognised
repo is reported as unrecognised — scaffolding a Next.js blog into an
Eleventy site because we guessed is a PR nobody can merge and a bad first
impression of the feature.

## 3. The scaffold PR

One pull request, opened against a branch, never committed to the default
branch:

- a blog index route and a post route in the detected stack
- a tokens stylesheet from the extracted theme
- the post structure the laws already enforce (hero, TOC, ≥4 H2, FAQ,
  related, CTA)
- `sitemap`/`llms.txt` wiring where the stack has a convention for it

The PR body explains every file it added and every token it used, so review
is reading a description rather than reverse-engineering a diff.

**rankloop only edits a block it created** still holds: the scaffold adds
files. It does not rewrite a user's existing layout, and if a target path is
already occupied the PR says so and skips it rather than overwriting.

## Non-goals

- No hosting. Pages live in the user's repo and deploy through whatever
  they already use.
- No headless browser for theme extraction — tokens come from the HTML and
  its stylesheets, and any token we cannot derive that way is left for the
  user rather than guessed at.
- Framer, Webflow and Wix have no repo. They get theme extraction and
  preview; publishing stays copy-paste until an adapter exists.

## Acceptance

1. No token is presented without a confidence.
2. `var()` fallbacks are resolved; HTML entities are decoded; keyword values
   are excluded from the radius and colour scales.
3. An unrecognised stack is reported as unrecognised, never guessed.
4. The scaffold never overwrites an existing file.
5. Nothing is committed to the default branch.
