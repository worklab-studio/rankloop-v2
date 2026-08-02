# Programmatic pages — Phase 4

## Status

Accepted (August 2026). Implements Phase 4 of `docs/PRODUCT.md`.

## Why

One template, thousands of pages, is the highest-leverage thing in
programmatic SEO and the fastest way to build a site Google files as spam.
The difference between the two is entirely whether each page says something
the others do not.

rankloop already has the law that decides this — **no data row, no page** —
and the storage for it (`page_type_data`: entity, rowJson,
provenanceJson, confidence, needsReview). Nothing has ever written to that
table. This phase is what fills it, and the law is what makes the feature
defensible rather than a slop generator with a spreadsheet.

## The shape

    variables        cities × services, tools × industries, products × use cases
       ↓
    combinations     the cartesian product, capped and deduped
       ↓
    data rows        one per combination, each cell with provenance
       ↓
    page specs       only combinations whose row is complete enough
       ↓
    the writer       the same brief → laws → gate path every other post takes

The last line is the important one. Programmatic pages are not a side door
around the publish laws. They go through the same gate, and a thin one fails
the same way a thin blog post does.

## The refusals

A combination is dropped, not written, when:

1. **No data row.** The law, applied literally. A page about "CRM for
   dentists" with nothing true to say about dentists is the page that gets a
   site penalised.
2. **The row is mostly empty.** A row whose cells are below a completeness
   threshold produces a page that is a template with the variables swapped —
   which is exactly what a thin-content filter is looking for.
3. **The row duplicates another.** Two combinations whose data is identical
   are one page with two URLs. Detected by hashing the row's values, not by
   comparing titles.
4. **The fan-out is absurd.** 50 cities × 12 services × 6 formats is 3,600
   pages. The cap is explicit and the count is shown before anything runs,
   because "one template, thousands of pages" is a sentence that should
   worry the person reading it slightly.

Every refusal is reported with its reason. A builder that silently produces
340 pages from a 600-combination grid has told the user nothing about the
260 it dropped.

## Provenance

Every cell carries where it came from. A cell with no provenance is marked
`needsReview` and does not count toward completeness — the schema already
has both columns and this is what they are for.

This is the same rule as the receipts and the AI access card: every number
traces to something stored. A programmatic page is a page whose every claim
can be pointed at a source, or it is not a page rankloop will write.

## Cost

The count is quoted before generation, in pages and in dollars, from the
same per-article constant the writer uses. 340 pages at a real per-article
cost is a number a user must see before pressing a button, not after.

## Publishing: the adapters

Researched 2026-08-02, and one finding corrects the roadmap:

**Framer has a Server API.** Shipped February 2026, `framer-api` on npm
(v0.1.27, `engines: node >= 22`). It is a stateful connection with a real
CMS write path:

    connect(projectUrl, apiKey) → getCollections() / createCollection(name)
    collection.addFields([{ type, name }])
    collection.addItems([{ id?, slug, fieldData }])   // upsert by id
    framer.publish() → framer.deploy(id)

`addItems` taking an optional `id` is upsert-shaped, which maps onto
rankloop's idempotent publish without a translation layer.

**Two unknowns before this can be promised**, both honest blockers rather
than work items:

- The dashboard runs on Cloudflare Workers (workerd), and `framer-api`
  declares a Node engine and uses a stateful transport. Whether it runs
  there at all is unverified, and cannot be verified without a real project
  and API key.
- It is version 0.1.27 and free during open beta. Building against it is
  building on a moving surface.

**Webflow's Data API v2 is stable and REST**, which is the opposite
situation: `POST /v2/collections/{id}/items`, bearer auth, `CMS:write`
scope, `fieldData` with `name` and `slug`, `isDraft` controlling staging.
No package, no runtime question — plain fetch, which workerd runs natively.

So the order is Webflow first, Framer behind a verification step. Anything
else would be promising a publish path nobody has watched work.

## Acceptance

1. No page spec without a backing data row.
2. Every dropped combination is reported with its reason and count.
3. Row-level duplicates are detected by value, not by title.
4. Cells with no provenance do not count toward completeness.
5. The page count and cost are quoted before generation.
6. Programmatic pages go through the same laws gate as every other post.
