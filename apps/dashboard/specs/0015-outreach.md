# Outreach planner (rankloop S4b)

## Status

Accepted (August 2026) — second half of step S4 of `../../docs/PLAN.md`.
Depends on S4a (spec 0014).

## Goal

Turn competitor backlink data into work a human can actually do: the
**link gap** (domains linking to two or more tracked competitors but not
to you), each target paired with the asset of yours that fits, a drafted
template message, and a manual tracking board.

## The line that never moves

rankloop researches, drafts and organizes. It **never sends anything**
and **never scrapes contact details** — targets link to the site's own
contact/about page and nothing more. Automated outreach is how link
profiles and reputations die; the planner exists to make human outreach
fast, not to replace the human. This sentence ships in the UI, not just
the spec.

Message drafting in S4b is **deterministic template fill** (no LLM):
real context substituted into three template shapes. LLM personalization
can arrive after S7 (the writer) exists; a template a human edits beats
a fabricated pitch.

## Schema (dual-dialect + parity)

- **competitor_link_domains** — id · competitorId (fk cascade) · domain ·
  domainRank int nullable · backlinks int nullable · firstSeenAt ·
  lastSeenAt. unique(competitorId, domain). Referring domains per
  tracked competitor (the raw material of the gap).
- **outreach_targets** — id · projectId (fk cascade) · domain ·
  domainRank int nullable · competitorCount int (how many tracked
  competitors it links to) · evidenceJson (per competitor: which of
  their URLs it links to, anchor when known) · matchedAssetPageId
  nullable (content_pages id — the asset to pitch) · matchTypeJson
  (why it matched: shared topic tokens / data page / guide) ·
  templateKind ('resource_page'|'data_citation'|'broken_link'|null) ·
  draftMessage nullable · status ('to_contact'|'sent'|'replied'|
  'linked'|'declined') default 'to_contact' · contactUrl nullable (their
  contact/about page, discovered from the crawl — NEVER an email) ·
  notes nullable · createdAt · updatedAt. unique(projectId, domain).

## Data collection

Extend CompetitorStudyWorkflow with a **referring-domains step**
(metered, retries 0, key-gated + non-fatal when keyless): the house
backlinks client's referring-domains endpoint for the competitor domain,
top 200 by rank → competitor_link_domains upserts (lastSeenAt refreshed;
rows absent from a refresh are kept — a lost link is still evidence the
domain links out in this niche).

Our own referring domains come from the existing project backlinks
feature (already used by the S2 Authority card) — cached, not re-fetched.

## Gap computation (pure function, tested)

`computeLinkGap({ competitorDomains, ourDomains, ourDomain })`:
- group by domain → count distinct competitors linked
- keep domains with `competitorCount >= 2`
- exclude: domains we already have a link from, the project's own
  domain and its subdomains, and obvious non-targets (social networks,
  search engines, link directories — a named constant list with a
  WHY-comment, not a regex soup)
- rank by `competitorCount desc, domainRank desc`, cap 100
- **asset matching**: for each target, pick the content_pages row whose
  path tokens best overlap the competitor URLs it links to (the S4a/S2
  token heuristic, reused); prefer pages whose kind is a data/guide
  shape when the linking context is a resources page. No match → target
  still listed with matchedAssetPageId null and templateKind null.

Refresh: recomputed at the end of every competitor study run and on
demand; existing targets keep their status/notes (upsert on
(projectId, domain), never resetting human-owned columns).

## Template messages (pure, tested)

Three shapes as functions of (target, evidence, asset, siteName):

- `resource_page` — they link to a competitor's guide from a resources
  page: mentions the specific page of theirs, names the asset, one
  sentence on what it adds that the linked piece lacks.
- `data_citation` — the matched asset is a data page: leads with the
  number, offers it as a citation.
- `broken_link` — reserved (needs link-status checking); NOT emitted in
  S4b, the branch exists and returns null.

Every draft: plain text, ≤120 words, no flattery openers, no fabricated
claims about their site beyond what the evidence contains, editable in
the UI, and ends without a hard ask. A `draftMessage` is stored on
generation so edits persist.

## Surfaces

- **Plan screen → Outreach tab** goes functional (its muted placeholder
  from S4a is replaced).
- Header row: the honesty sentence as a quiet alert-info: "rankloop
  finds and drafts. You send. Nothing here contacts anyone."
- Empty states: no tracked competitors → "Track a competitor first —
  the gap comes from who links to them." · tracked but keyless →
  the house setup pitch (referring domains need DataForSEO) · computed
  but empty → "No domain links to two or more of your competitors yet."
- **Targets table** (table table-sm): domain (external link, house
  SafeExternalLink) · linked competitors as tag-chips (violet, one per
  competitor, hover title = the specific URL) · domain rank
  (tabular-nums, — when unknown) · your matching asset (path, mono, or
  "— no match") · status select (select select-sm inline, optimistic) ·
  "Draft" btn-ghost btn-sm opening the message modal.
- **Message modal** (house Modal): the drafted text in a textarea
  (editable, saves on close), the evidence list ("links to
  rival.example/guides/x from /resources"), the contact-page link when
  known, a "Copy message" btn-sm (clipboard), and the reminder line
  "Copy it into your own email client — rankloop never sends."
- Stamp: "link gap from N tracked competitors · refreshed with each
  monthly study".

## Files

- schema pair additions + parity + migrations
- referring-domains step in CompetitorStudyWorkflow + repo writes
- `src/server/features/rankloop/outreach/{services,repositories,
  linkGap.logic.ts,templates.logic.ts}` + colocated tests
- `src/serverFunctions/rankloopOutreach.ts` + zod schemas
- `src/client/features/rankloop-plan/` Outreach tab components
- vitest: gap computation (2+ rule, exclusions, own-domain, ranking,
  cap), asset matching, template rendering per shape (incl. the
  no-match and broken_link-null branches), status updates preserving
  human columns across refresh

## Acceptance

1. Parity + migrations green; `pnpm ci:check && pnpm test:ci && pnpm
   vite build` green; dev boots.
2. Seeded keyless proof: seeded competitor_link_domains rows for two
   competitors → Outreach tab lists the gap targets with chips, asset
   matches and a draft that renders real evidence; status change
   persists; refresh recompute preserves status/notes.
3. Grep proof in review: no email-address extraction anywhere, no send
   path, contactUrl only ever a page URL.
