# Operating rankloop — the first 90 days

Installing rankloop takes an afternoon. Learning what it is supposed to
look like takes longer, mostly because the honest version of this product
is slow in places where the dishonest version would be fast.

This document is what to expect, in order, with the real numbers. If your
install is doing something described here, it is working. Setup is in
[SELF-HOSTING.md](./SELF-HOSTING.md).

---

## The shape of it

| When | What happens | What you do |
|---|---|---|
| Day 0 | Site study, 90-day Search Console backfill, competitor study, keyword universe, draft page plan | Add the site, connect Search Console, approve a page type |
| Days 1–7 | Optimize-existing proposals on the corpus you already have | Approve retitles and pushes; turn the quota on |
| Days 7–14 | First net-new articles written, gated, published | Approve titles |
| Days 14–42 | First receipts measure | Read them |
| Days 21–60 | REFRESH wakes up; competitor re-study; the flywheel starts feeding itself | Less |
| Day 90 | You have a cohort. You do not yet have autopilot. | Judge the cohort |

Autopilot is not on this table before day 90 because it cannot be. The
arithmetic is in [Autopilot is earned](#autopilot-is-earned-and-it-takes-longer-than-90-days).

---

## Day 0 — what the machine does while you make coffee

Adding a site kicks one automatic pipeline. The progress spine on the
Dashboard narrates it; nothing needs you until the last line.

**Site study.** A robots-respecting crawl of your site, extended to pull
publish dates, modified dates and same-origin outlinks, then derived into
a content inventory: which URLs are posts, which are pages, which are
hubs, how many internal links point at each. This is the corpus every
later phase reads — link candidates, duplicate checks, the denominator
your quota counts against. It re-runs weekly.

**Search Console memory.** The backfill covers 93 days ago through 4 days
ago, on Google's Pacific-time calendar. After that a daily sync re-pulls
the trailing 3 days, because GSC finalizes numbers late. Per day it stores
the top 2,500 page × query rows by impressions and rolls everything below
that into one honest "other" row rather than pretending the tail does not
exist.

**Competitors.** With a DataForSEO key, the top 3 discovered competitors
are studied immediately — roughly $0.10–$0.20 each, refreshed monthly.
The interesting half is the blog study: rankloop identifies their
*top-earning* pages, crawls those first, and diffs their structure
against that competitor's own median post. What the winners have and the
median lacks is the signal. It also surfaces their decayed and removed
pages, which is the cheapest what-not-to-build data there is. If their
HTML is blocked, the study degrades to sitemap XML plus SERP titles and
stamps the card with what it actually saw.

**Keyword universe.** Unserved GSC queries + competitor gap + seed
expansion + free autocomplete + harvested questions, all through one
relevance gate derived from your own pages and queries (and editable —
it is shown as tag chips, never as a regex).

**Page plan.** Candidates are clustered by pattern, cross-referenced
against the competitor playbook, and validated against sampled SERPs
before you ever see them. Types where Reddit or Quora hold two of the top
five are killed, not proposed — post-hidden-gems, that is a hard SERP, not
a weak one. Types where nothing outside the top 3 looks winnable are
killed too. About $0.08 of SERP cost moves to plan time so you are not
asked to approve something dead on arrival.

Total, day 0, with keys: a few dollars at most. The ledger records every
cent from the actual response envelopes, not from estimates.

---

## The page plan gate — your one strategy decision

Everything above is automatic. This is not.

Each approval card is built to be judged by someone who is not an SEO:
the type name and page count, three real example titles rendered from
actual candidate keywords, demand stated in words ("18,400 searches a
month across 47 pages"), the money math ("~$12 to write all 47 at ~$0.25
each"), the competitor evidence sentence, and the SERP verdict as a
sample — labelled a sample, because that is what it is. URL patterns,
keyword patterns, template contracts and difficulty bands live behind
"More details" for when you want them.

A type needs at least 4 instances (3 for editorial clusters) to be
proposed at all. A page type of two pages is not a type.

**Programmatic types require a data backbone.** A pSEO type with no data
source — your own CSV or API, or a provenance-tracked extraction pipeline
where every cell stores where it came from and when — will not produce
pages. It is excluded with the reason stated. The alternative, an LLM
filling a template from a keyword, is Google's own definition of scaled
content abuse, and the sites that survived programmatic SEO all rendered
real rows. This rule has no override, because the override is the failure
mode.

Approving binds the type's keywords, derives its template contract from
the competitor winners-vs-median diff, and arranges for the type's **hub
page to publish before any instance of it**. Orphan pages are how
programmatic sites die.

---

## Week one — optimize before you generate

The first week writes nothing new. This is deliberate: the corpus you
already have is where the safest wins are, the edits are reversible, and
the receipts they open start the clock on everything else.

Three signals, all computed from your own stored data, all with named
thresholds:

**RETITLE — you rank but nobody clicks.** For a page × query with at
least 100 impressions in 28 days, rankloop compares your actual CTR to
the expected CTR for your position band. Below 55% of expected, it
proposes a new title, with the winning queries as evidence. One proposal
per page; the same page is suppressed for 60 days after a retitle
decision. The score is in units of clicks you would recover.

**PUSH — you are close.** Impressions-weighted position between 5 and 20,
at least 30 impressions in 28 days. The score peaks around position 11 —
the top of page two, where a nudge is worth the most — and decays in both
directions. rankloop gives you the top three internal-link sources from
your own site and a copyable anchor. You place the links; automated link
insertion arrives with net-new publishing, not here.

**REFRESH — it used to work.** Requires at least 8 weeks of stored
memory, a page at least 6 months old, a peak week of at least 10 clicks,
and a decline in *both* clicks and impressions — demand loss, not a CTR
wobble. **This will produce nothing at all for about two months.** That is
not a bug; the code shipped with its tests before the data existed to feed
it.

MERGE and PRUNE exist and are human-only, permanently. No amount of good
receipts makes a machine allowed to delete your pages.

Proposals expire after 10 days. A stale queue is a queue nobody trusts.

Executed retitles apply through your publish adapter (WordPress first,
because updating a title is the least dangerous thing you can write to
someone's site). Executed pushes are attested manually. Either way, a
receipt opens with a real baseline.

---

## When net-new starts

Three things have to be true, and one of them catches almost everyone:

1. A page type is **approved**.
2. The type's keywords are bound and have a data source if it is
   programmatic.
3. **The quota is on.** Articles → writer settings → *Quota starts* is
   empty by default, and empty means off. A default date would start a
   clock you never asked to start — but it also means a perfectly
   configured install proposes nothing until you set it.

Then: `Posts per day` (default 2) with a `Catch-up cap` (default 6). A
missed day is owed, not skipped — but a fortnight offline cannot dump 28
posts into your site in one morning. Exactly one slot per batch is
reserved for the fresh-question pool, so harvested real questions never
get permanently outranked by metric rows.

Per approved title: a grounded brief (readable in full before a word is
generated) → one draft with your key → the laws gate → at most two
repair attempts → Review, or Failed with the report intact. Then publish:
hub first, the post, up to 3 contextual links injected into related
existing posts inside a delimited block rankloop created and can be
deleted without breaking anything, then IndexNow, then a receipt baseline
recorded in the same transaction as the publish.

Cost is roughly $0.10–$0.50 of model per article plus about a cent of
data. Every call is metered into the ledger with its real cost.

**The grader is never the author.** The laws gate is pure code in
`@rankloop/engine` with no model client anywhere on its dependency graph.
A failing draft is handed its violated laws as structured data — the
banned phrase, the sentence around the em dash, the link that does not
resolve — and asked to fix exactly those. There is no path in which an
LLM decides that an article is good enough.

---

## Why receipts take 14 to 42 days

Every executed action opens a receipt with a baseline: the prior 28 days
of impressions, clicks, CTR and impressions-weighted position for that
page, plus your site-wide totals. The evaluation window is days **14
through 42** after the action.

Why not sooner: Google does not re-evaluate a changed title in a week,
your own data is 2–4 days behind, and a 7-day read on a page with 300
monthly impressions is noise with a number on it.

Why site totals: the result is **trend-adjusted** — the page's change
minus your site's change over the same window. If everything you own rose
12% because it is December, a page that rose 12% did nothing. This is a
control, not a proof; it does not know about a Google update that hit your
category specifically.

If another proposal executes on the same page inside the window, the
receipt is marked **contaminated**. The result is still computed and
stored, because a marked result is more useful than a missing one, but it
does not count as clean evidence.

Measurement waits until your stored memory actually covers the end of the
window. A receipt sitting at "waiting" three days after day 42 is waiting
on Google, not on rankloop.

Some receipts will measure to nothing. Those get reported too. A tool that
only shows you its wins is a tool you cannot use to make decisions.

---

## Autopilot is earned, and it takes longer than 90 days

The trust dial has three positions: `titles` (you approve each proposal;
a passing draft auto-approves), `drafts` (you also read the draft before
it publishes), and `autopilot`.

Autopilot is **per action type**, and a type becomes eligible only when
its receipts say so. The rule, over receipts whose evaluation window
closed at least 90 days ago:

- at least **5 measured receipts** for that action type,
- the **median trend-adjusted position change is an improvement**,
- **at most 1 in 5 is worse** than baseline.

Otherwise: not eligible, with the numbers stated on screen — "net-new:
needs 5 measured results, has 2". MERGE and PRUNE are never eligible,
regardless of receipts.

Run the arithmetic. A retitle applied on day 7 has its window close on
day 49, and settles 90 days later on day 139. You need five of those.
**Autopilot on any action type is a month-five conversation at the
earliest, and that is the intended behavior.** A toggle you could flip on
day one would be a toggle you flip on faith, and faith is what this
product is built to replace.

When a type is eligible and the dial is set to autopilot, the routine
approves, writes, gates and publishes without you — capped per run at
today's remaining quota of approvals, 2 writes and 2 publishes. Every
unattended decision is recorded as `decidedBy='autopilot'`, so the
Receipts screen can separate machine judgment from yours and a bad
autopilot period is auditable after the fact.

Retitle and push execution stay human-clicked even under autopilot. They
write to a live page through an adapter and their execution path is not
eligibility-gated yet. The Automation screen says so rather than implying
otherwise.

**Kill switches**, because this is the mode that publishes without asking:
three consecutive drafts landing in Failed pauses autopilot; any adapter
auth error pauses it immediately (a wrong credential retried unattended is
how accounts get locked). The pause and its reason appear in the digest,
and resuming is a deliberate click in Settings.

---

## The throttles, and why you want them

**Indexation.** Of the articles published 7–45 days ago — young enough to
be recent, old enough for Google to have decided — rankloop checks what
share are actually indexed, at most 20 URL inspections per project per
day. Below 65% the daily quota is held at 1. Below 40% net-new proposing
pauses entirely, and you are told why.

Publishing into "Crawled — currently not indexed" is the most reliable way
to earn a sitewide quality demotion, and a content engine that cannot see
it happening will keep digging. Optimize-track proposals are never
throttled: improving what exists is exactly the right move when indexation
is poor.

Below 5 articles in the cohort the rate is `null`, not 100%. Nothing is
throttled and nothing is claimed.

**Spend.** Every metered call writes its real cost to the ledger. Costs
are shown in the "~" style before you spend, not after.

**Cadence.** The catch-up cap, above.

---

## Honest limits

Read this section before you make a decision you cannot reverse.

**Vendor estimates are estimates.** Search volume, keyword difficulty,
estimated traffic and domain rank all come from DataForSEO. Volume is a
smoothed monthly average, difficulty is a model, estimated traffic is a
model built on a model. They are useful for ranking candidates against
each other and close to worthless as absolute numbers. Money math on
approval cards is prefixed "~" for this reason.

**Search Console lags 2–4 days**, and finalizes late. The daily sync ends
4 days back and re-pulls the trailing 3 days because Google keeps
adjusting. Nothing rankloop reports about yesterday is trustworthy,
which is why nothing rankloop reports is about yesterday.

**There is no rank tracking of our own.** Receipts read Search Console's
impressions-weighted average position for your page and query. rankloop
does not scrape SERPs to check where you rank, and will not. Average
position from GSC is a different measurement from a rank tracker's — it
averages across devices, locations and personalizations, and it moves for
reasons that have nothing to do with you. (The fork's Rank Tracking screen
is upstream's, metered separately through DataForSEO, and does not feed
receipts.)

**A receipt is evidence, not attribution.** Diff-in-diff against your own
site trend controls for the obvious. It does not control for a core update
that hit your category, a competitor's relaunch, or seasonality specific
to one page.

**The SERP verdict on a page type is a sample** — 5 or 6 SERPs per
candidate type, capped at 40 per plan run. It is labelled a sample on the
card. rankloop also does not claim to know each SERP result's domain
authority; it states the comparison it actually has, which is your domain
rank against your tracked competitors'.

**Zero-volume rows are kept on purpose.** A volume floor starves exactly
the long-tail queries a young site can win, so there is no floor, and a
null difficulty always passes the adaptive ceiling.

**rankloop never sends outreach.** The outreach planner researches
targets, drafts messages and tracks status. Sending is yours, permanently,
and email addresses are never scraped — contact-page links only.

**rankloop never invents your page design.** Template contracts govern
structure; your site governs how it looks.

---

## "Nothing happened today" — a translation table

| What you see | What it means |
|---|---|
| No digest | Nothing happened worth reporting. Empty digests are not generated, stored or sent. |
| No proposals | Quota off, no approved page type, memory still syncing, or a pSEO type with no data source. All four say so on screen. |
| No REFRESH proposals, week 6 | It needs 8 weeks of memory. Come back. |
| Quota shows 1 | Indexation below 65%. The reason is printed next to it. |
| "Not enough published posts yet to judge — needs 5" | The indexation cohort is too small to conclude anything, so it concludes nothing. |
| A receipt at "waiting" past day 42 | Your GSC memory has not yet covered the window end. Check the sync. |
| An article in Failed | Three attempts did not clear the laws. The report is on the article. Edit and re-check — no model call, no cost. |
| "no competitor signal for this shape" | There was no matching competitor data, and the evidence sentence was omitted rather than faked. |
| "not sampled" on a page type card | No DataForSEO key, so no SERP validation. Detection still ran. |
| Autopilot "needs 5 measured results, has 2" | Working. See the arithmetic above. |

---

## The division of labor, restated

**You:** approve the page plan once per type, approve titles until
autopilot is earned, pay for two BYO keys, place the links a PUSH
proposal suggests, and decide about merges and prunes.

**The machine:** everything else — and it refuses to write without
evidence, refuses to publish a law-breaking draft, and refuses to outrun
your site's indexation.
