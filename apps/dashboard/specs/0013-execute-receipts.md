# Execution + first receipts (rankloop S3b)

## Status

Accepted (August 2026) — second half of step S3 of `../../docs/PLAN.md`.
Depends on S3a (spec 0012). Completes Track 1: approved optimize
proposals get executed through the least-dangerous write path, and every
execution opens a receipt.

## Goal

1. A per-project **publish connection** (WordPress first) stored
   encrypted, with a test-connection flow.
2. **Execution**: approved RETITLE proposals apply through the adapter
   via a human-edited title/meta editor; approved PUSH proposals expose
   guidance and a "Mark done" attestation. Both transitions open a
   **receipt** with a real baseline.
3. The **receipts measurement job** and a minimal **Receipts** screen.

## Non-goals

Post creation (S8) · LLM-drafted titles (S7 pre-fills the same editor) ·
automated link insertion (S8) · webhook/GitHub adapters (S8) · charts on
the Receipts screen (arrive when measured data exists).

## Publish connection

New table **publish_connections** (dual-dialect + parity): id ·
projectId (fk cascade, unique — one connection per project) · adapter
('wordpress') · configJson (ENCRYPTED at rest — reuse the exact helper
upstream uses for GSC OAuth tokens; grep its usage; requires
BETTER_AUTH_SECRET, same operator contract) · status
('unconfigured'|'ok'|'failed') · lastCheckedAt nullable · createdAt ·
updatedAt.

WordPress config shape: { baseUrl, username, applicationPassword }.
Client (fetch-based, service layer): `testConnection` (GET /wp-json/ +
authenticated /wp-json/wp/v2/users/me), `findPostBySlug`
(/wp-json/wp/v2/posts?slug=), `updatePost` (POST /wp-json/wp/v2/posts/:id
with title; meta description best-effort through Yoast/Rank Math REST
fields when detected, silently skipped otherwise and reported in the
result). Never log credentials; AppError codes for auth/网络 failures —
use the closed error-code enum, add codes if missing.

## Execution flows

- **RETITLE → "Apply…"** (Approved tab row action): house Modal.
  Contents: current title (from content_pages, refreshed from WP on
  open when connected), the winning queries as quiet guidance chips,
  inputs for new title + meta description (charcount hints 70/165 in
  text-xs), and the confirm idiom: title "Apply new title to
  /blog/best-espresso-tampers/?", one sentence "The body and publish
  date stay untouched.", ghost Cancel + `btn btn-primary btn-sm`
  "Apply title". Server fn `executeRetitleProposal({ projectId,
proposalId, newTitle, newMetaDescription? })`: valid only from
  'approved'; adapter update; on success in ONE transaction — proposal
  → 'done', content_pages title updated, receipt inserted. Adapter
  failure → proposal stays 'approved', standard error toast.
- **PUSH → guidance + "Mark done"**: expandable detail listing the top
  3 inlink source candidates (content_pages posts sharing path tokens /
  same category with the target — simple heuristic, pure function,
  tested) with their paths; copyable anchor suggestion (the query).
  "Mark done" server fn `attestPushProposal` → proposal 'done' +
  receipt. Copy: "Add these links yourself, then mark done — automated
  link insertion arrives later."

## Receipts

- On execution: insert receipt — actionType from proposal.type ·
  contentPageId · targetQuery (headline query) · status 'baseline' ·
  baselineJson: { window: prior 28d, impressions, clicks, ctr,
  weightedPosition, siteImpressions, siteClicks } (site totals enable
  diff-in-diff later) · windowStart = execution+14d · windowEnd =
  execution+42d.
- **Measurement job**: new scheduled block (daily-ish via the \*/15 cron
  body, guarded by a cheap due-check): receipts with windowEnd passed
  and status 'baseline'|'measuring' → compute resultJson over the
  evaluation window from gsc_performance (same metrics + site totals),
  trend-adjust (page delta minus site-wide delta ratio), set 'measured'.
  **Contamination**: another proposal on the same contentPageId
  executed inside the window → status 'contaminated' (result still
  computed and stored). Between baseline and windowEnd, a due-check
  flips 'baseline'→'measuring' once windowStart passes.
- Guard: receipts need the memory to still be syncing; if latestDate <
  windowEnd, skip until data catches up (no partial measurement).

## Surfaces

- **Articles screen**: Approved-tab rows gain the actions above;
  "done" rows move to a new "Done" tab (label without count). The
  publishing state banner: when no publish connection and an approved
  retitle exists, an alert-info above the table: "Connect WordPress to
  apply retitles from here — or apply them manually and mark done."
  (manual attestation also allowed for retitle via a ghost "Mark done
  (applied manually)" in the row's More-details area).
- **Publishing settings**: a Collapsible section at the bottom of the
  Articles screen ("Publishing" — collapsed by default): adapter select
  (WordPress / Not connected), baseUrl/username/application-password
  inputs (password-masked after save, house input focus styles), "Test
  connection" `btn btn-sm` with success/failed tag-chip + lastCheckedAt
  stamp, and the cost/behavior sentence: "rankloop only ever updates
  what you approved. Application passwords can be revoked in WordPress
  at any time."
- **Receipts screen**: new nav item under Write (icon BarChart3), route
  `receipts/`. h1 "Receipts", subtitle "Every executed action reports
  what it moved. Evaluation window: days 14–42 after." Table table-sm:
  action tag-chip · target (mono) · executed date · status tag-chip
  (baseline=slate "waiting", measuring=sky, measured=emerald,
  contaminated=amber) · position before → after (em dash until
  measured) · clicks delta. Empty state: "No receipts yet — approve and
  apply a proposal to start one." Stamp: "positions are
  impressions-weighted · results trend-adjusted against your site".

## Files

- schema pair + parity (publish_connections) + migrations
- `src/server/features/rankloop/publish/{services,repositories}` (WP
  client + connection mgmt) · `…/rankloop/receipts/{services,
repositories,receipts.logic.ts}` (baseline/measure/trend-adjust pure
  functions, tested) · execution fns in the proposals service
- `src/serverFunctions/rankloopPublish.ts` + `rankloopReceipts.ts` +
  zod schemas · scheduled-handler measurement block
- surface work in `rankloop-articles` feature + new `rankloop-receipts`
  feature + routes + items.ts (one item added to Write)
- vitest: WP client (mocked fetch: auth fail, slug miss, meta-field
  detection), execution transitions (approved-only, tx atomicity via
  repo contract), receipts logic (window math, trend adjustment,
  contamination, data-lag guard), push inlink-candidate heuristic

## Acceptance

1. Parity + migrations green; `pnpm ci:check && pnpm test:ci && pnpm
vite build` green; dev boots.
2. Seeded dev proof: approve a seeded retitle → manual "Mark done
   (applied manually)" path → receipt row appears on the Receipts
   screen with a real baseline from seeded gsc rows; contamination and
   measurement paths proven in service tests (time-travel via injected
   now()).
3. WP path proven against mocked fetch in tests (no live WP required).
4. Credentials never appear in logs, errors, or client payloads
   (masked config reads back as { baseUrl, username, hasPassword }).
