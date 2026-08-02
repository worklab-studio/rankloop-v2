# The Grow armory — Phase 2

## Status

Accepted (August 2026). Implements Phase 2 of `docs/PRODUCT.md`.

## Why

Off-page was one tab, buried fourth under Plan, containing one lane: the
link gap. Nobody looking for "how do I get backlinks" would find it, and
even having found it, a hundred domains that link to competitors is a
research result, not a to-do list — there is nothing to *do* with a row
except write a cold email.

Grow is the armory: hundreds of concrete places to get listed or linked,
each with a prepared payload, each tracked until the link is actually live.

## The honesty constraint on "hundreds"

The temptation is to ship a data file padded to a round number with
plausible-looking directory URLs. That is fabrication, and it fails the same
way a fabricated statistic in an article fails: the user clicks the fifth
one, gets a 404, and stops trusting the other 295.

So the number comes from three lanes with different provenance:

| Lane | Where rows come from | Honest scale |
|---|---|---|
| **Seed pack** | authored, every entry a site that verifiably exists | tens |
| **SERP mining** | live DataForSEO SERP results for submission-shaped queries | dozens per category |
| **Competitor backlinks** | live referring-domain data, filtered | dozens to hundreds |

Two of the three are discovered from live data at run time, which is what
makes "hundreds" true without anything being invented. The seed pack is the
one authored list, and it is deliberately short and verified rather than
long and plausible. **Every seed entry carries a `verifiedAt` date; the pack
is data, never code** (hard rule 2 — no niche vocabulary in code).

## The three lanes

### 1. Seed pack
Universal launch and directory targets that apply to almost any product:
submission URL, whether it is free, what the form requires, typical
turnaround, and an approval-odds band. Shipped as JSON.

### 2. SERP mining
For each approved page-type category, run submission-shaped queries and keep
the organic top 20:

    best {noun} tools · top {noun} software · {noun} alternatives
    {noun} directory · submit {noun} · {noun} tools 2026

This is the listicle and roundup universe — pages that already rank for the
terms you want and that accept additions. Metered (SERP calls), so it runs
on an explicit action with the cost stated, never on a schedule.

### 3. Competitor backlinks, filtered for submittability
From referring domains already pulled, keep those whose linking page URL
matches a submission shape (`/submit`, `/add`, `/directory`, `/tools/`,
`/alternatives/`, `/best-`), or whose page lists two or more tracked
competitors — proof the category is accepted.

## Scoring

`relevance × authority × attainability`, where attainability comes from
observable facts rather than vibes:

- a form is more attainable than an editorial pitch
- a page already listing ≥2 competitors is proof the category is accepted
- a domain rank far above yours is less attainable, not more valuable

## The Submission Kit

One record per project holding the product's canonical facts, filled once:

    name · one-liner (60) · short (160) · long (500)
    logo URL · category tags · pricing model · founder · launch date

Every target's payload renders from it, truncated per that target's field
limits, with copy-to-clipboard per field. Most directories are manual forms
and always will be; the kit removes the retyping, not the human.

**Truncation never silently cuts a word in half.** A payload that has to be
shortened is cut at a word boundary and the UI says it was shortened.

## The state machine

`outreach_targets.status` already expresses this machine, so the armory
reuses its vocabulary rather than introducing a parallel one beside it:

| Spec name | Existing status |
|---|---|
| discovered | `to_contact` (the default) |
| submitted | `sent` |
| live | `linked` |
| rejected | `declined` |
| — | `replied` |

Renaming would have meant a data migration, a second set of labels in the
UI, and 83 passing tests rewritten, in exchange for words that read slightly
better in a spec. The states are the same states.

`sent` is a human attestation — rankloop never fills a form, never sends an
email, and has no transport to do either. Unchanged law.

## What changes: rankloop can now observe one transition

`outreach_targets` carries the note that "rankloop cannot observe any of
these transitions — nothing here contacts anyone — so the board is a memory
aid the user moves by hand." That was true, and it stops being true for
exactly one transition.

A weekly job re-fetches each `submitted` target's page and looks for a link
to the project's domain. Found → `live`, with the URL and the date it was
first seen. This is observation, not contact: we fetch a public page the
same way any crawler would.

Every other transition stays human-owned. In particular **`rejected` and
`no_response` are never inferred** — a missing link may mean a queue, a
moderator on holiday, or a nofollow we did not parse, and marking someone's
outreach "rejected" on that basis would be a guess presented as a fact.

A target that goes `live` opens a receipt, so an earned link shows up in
Study → Reach next to the rest of the backlink profile.

## Schema

Extends `outreach_targets` rather than adding a parallel table — one board is
the whole point:

    lane           link_gap | seed | serp | backlink_submit
    kind           directory | listicle | blog | resource_page
    submissionUrl  where to submit, when the target is a form
    linkLiveAt     first time verification saw our link
    lastCheckedAt  last verification attempt
    verifiedUrl    the page the link was found on

Plus `submission_kits`, one row per project.

Both dialects, `schema-parity.test.ts` must pass.

## Acceptance

1. No seed entry without a `verifiedAt` and a real submission URL.
2. The seed pack is a data file; no target names appear in `.ts` source.
3. Discovery dedupes by registrable domain across all three lanes.
4. Truncated payload text is cut at a word boundary and labelled.
5. Verification may set `live` and nothing else; `rejected` and
   `no_response` are only ever set by a human.
6. Nothing in this feature sends a message or fills a form.
