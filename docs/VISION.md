# rankloop 2.0 — vision

## What it is, in one paragraph

A content team in a box you point at your website. You give it your domain; it
figures out what your site is about, how you write, and — using your own
Google data — which searches you are almost winning. It writes the articles
that close those gaps, checks them against hard quality rules so nothing
reads like AI slop, publishes them to your site, and comes back with
receipts: "this article moved you from #12 to #4." Open source; you bring
three keys (AI, DataForSEO optional, Search Console free).

## The loop

1. **Study** — crawl the site (niche, voice card, taxonomy, design tokens);
   pull Search Console (what Google already shows you for); pull DataForSEO
   Labs (ranked keywords, competitor discovery, keyword gap).
2. **Queue** — every idea scored (volume × inverse difficulty × intent, plus
   an opportunity factor). Free sources carry neutral priors and surface via
   a guaranteed fresh-question slot (the pool-mix rule).
3. **Write** — grounded brief (cached SERP, People-Also-Ask, voice card,
   laws, real internal-link candidates) → draft via the user's AI key.
4. **Gate** — the laws: banned filler phrases, em-dash ban, first person,
   keyword density ceiling, structure minima, links must resolve, length
   band, readability band. Pure functions, no LLM. Fail → bounded fix loop →
   still failing → human review queue. The grader is never the author.
5. **Publish** — adapter: WordPress REST, webhook, git/filesystem (more
   later: Webflow, Shopify, Ghost). Sitemap + llms.txt rewired, IndexNow.
6. **Measure** — per-article target-query tracking in GSC: positions
   climbed, impressions earned (receipts). Unserved queries (impressions,
   no page) are harvested back into the queue — the flywheel.

## User journey

- **Min 0–2**: sign up / `docker compose up`; enter domain.
- **Min 2–10**: onboarding agent studies the site live, narrating; proposes
  plan (topics, voice, laws, cadence); user edits + approves.
- **Min 10–15**: connect GSC, choose publish target, paste AI key, set the
  trust dial (approve titles / approve drafts / full autopilot).
- **Daily**: approve or decline proposed titles, each with evidence
  attached. Approved → researched, written, gated, illustrated, shipped on
  a steady cadence. Autopilot skips even this.
- **Weekly**: receipts view + improve queue (low-CTR retitle candidates,
  page-2 push targets).
- **Month 2+**: a growing share of new articles come from queries the
  site's own traffic surfaced. The engine feeds itself.

## How open source works with paid APIs

| Dependency | Self-host (free) | Hosted tier (later) |
|---|---|---|
| AI API | BYO key, any provider, ~$0.10–0.50/article | bundled, metered credits |
| DataForSEO | BYO key, budget-capped, **optional** | bundled, marked up per call |
| Search Console | free; user's own OAuth client (guided) | verified OAuth app, one click |

The open-source wedge: run the same engine for the price of your API keys
(competitors charge ~$1.65–3 per article). The hosted margin is convenience.

## Anti-goals

- No detector-evasion "humanizer" (spam signal, snake oil). Human-reading
  output comes from enforced voice + laws.
- No outreach automation, no fabricated claims, no rank scraping.
- The engine never invents topics.
