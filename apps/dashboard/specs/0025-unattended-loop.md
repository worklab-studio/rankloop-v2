# Closing the unattended loop (rankloop S9b)

## Status

Accepted (August 2026) — completes step S9. S9 built the dispatcher, the
digest and the eligibility rule; its own verify pass reported the gap
this spec closes: **nothing in the routine initiates work.** Autopilot
currently gates a human's click instead of replacing it.

## Goal

For action types that have **earned** it, the routine acts without a
human: approve, write, gate, publish — and records that a machine
decided. Plus the two delivery channels the digest still lacks, and the
workspace-wide test script.

## The rule that governs unattended action

A step runs unattended only when **all** hold:

1. the project's `trustDial === 'autopilot'`;
2. `autopilotEligibility(actionType)` is eligible (S9's rule: ≥5
   measured receipts settled 90+ days, median improvement, ≤1 in 5
   worse) — MERGE and PRUNE are never eligible;
3. the indexation throttle allows the volume (S8b);
4. the autopilot kill switch is not tripped (S9);
5. the action's own preconditions pass (a passing gate before publish,
   a connected adapter, etc.).

Any failure is a **no-op with a recorded reason**, never a retry storm
and never a silent skip. Every unattended decision writes
`decidedBy='autopilot'`, which is what makes the Receipts screen able to
separate machine judgment from human judgment — and what makes a bad
autopilot period auditable after the fact.

## What gets added to the routine

A new terminal `RoutineBlock`, `autopilot`, running **last** in
`ROUTINE_BLOCKS` (after every producer, so it acts on the freshest
state), with three phases in order, each capped per project per run:

1. **approve** (cap: the day's remaining quota) — proposals in
   `proposed` whose type is eligible → `approved`,
   `decidedBy='autopilot'`. Net-new obeys the quota and throttle;
   optimize types obey their own suppression rules.
2. **write** (cap 2) — approved net-new articles with no in-flight
   workflow → start `ArticleWriteWorkflow`. The existing partial unique
   is the concurrency guard; a failed gate after 3 attempts lands in
   `failed` exactly as it does today, and counts toward the kill
   switch.
3. **publish** (cap 2) — articles in `review` whose gate currently
   passes → start `PublishWorkflow`. `review` is reached only after the
   laws passed, and preflight re-checks anyway.

Retitle/push execution stays out of scope here: those write to a live
page through an adapter and their own execution path is not yet
eligibility-gated (S9's verify noted this). They remain human-clicked,
and the Automation surface says so rather than implying otherwise.

## Kill switch, made real

`autopilot_state` (new, both dialects + parity): id · projectId (fk
cascade, unique) · consecutiveGateFailures int notNull default 0 ·
pausedAt nullable · pausedReason nullable · updatedAt.

- an article landing `failed` increments the counter; a passing gate
  resets it to 0;
- 3 consecutive → `pausedAt` set, reason recorded, the autopilot block
  becomes a no-op until a human resumes it from Settings;
- any adapter auth error pauses immediately (a wrong credential
  retried unattended is how accounts get locked);
- the pause and its reason appear in the digest and on the Automation
  surface with a "Resume autopilot" action.

## Digest delivery (S9 §2's unfinished half)

`deliveredJson` finally gets written:
- **in-app** — always (the row itself), status `stored`;
- **email** — when the deployment has the fork's Loops transactional
  path configured AND the project opted in; failures recorded, never
  thrown;
- **webhook** — when a URL is configured: the same signed envelope
  shape S8a's webhook adapter uses (HMAC over `timestamp.body`), event
  `digest.daily`.
Opt-ins live on `writer_settings` (`digestEmail` bool,
`digestWebhookUrl` nullable). A digest that is not generated (the empty
day) is not delivered — unchanged.

## Housekeeping (carried from S9's verify)

- root `package.json` gains `test:ci` running the workspace recursively;
  `packages/engine`, `packages/db`, `packages/seo-data` gain `test:ci`
  so `pnpm -r test:ci` is runnable.
- `proposalTypeDisplay` gains `merge`/`prune` labels so the Automation
  surface stops rendering raw lowercase type names beside proper ones.

## Surfaces

- **Settings → Automation** gains: the per-phase caps as plain text
  ("approves up to today's quota, writes 2 and publishes 2 per run"),
  the kill-switch state with **Resume autopilot** when paused, the
  digest delivery toggles, and the explicit line that retitle and push
  still need a human click.
- **Receipts** already carries the `decidedBy` chip; it now has real
  autopilot rows to distinguish.
- **Digest card** shows delivery status per channel.

## Files

- `routines/autopilotBlock.ts` (the terminal RoutineBlock) + services
- `autopilot_state` schema pair + migration + parity;
  `writer_settings.digestEmail` + `digestWebhookUrl`
- digest delivery adapters (in-app / Loops / webhook) + `deliveredJson`
- Settings/Automation + Digest card surfaces
- package.json scripts
- tests: each of the five preconditions blocking with its reason; caps
  respected; `decidedBy='autopilot'` written on every unattended
  decision; kill switch trips at exactly 3 and resets on a pass; adapter
  auth error pauses immediately; resume clears; delivery per channel
  incl. failure recording; MERGE/PRUNE never acted on

## Acceptance

1. Parity + migrations green; `pnpm ci:check && pnpm test:ci && pnpm
   vite build` green; dev boots; `pnpm -r test:ci` runs.
2. **Unattended proof (the point of this spec)**: seed a project with
   `trustDial='autopilot'`, an eligible action type, healthy
   indexation, an approved page type and planned keywords. Run the
   routine with a mocked model and mocked adapter, and assert from
   **stored rows** that a proposal was approved with
   `decidedBy='autopilot'`, an article was written and gated, and it
   published with a receipt — with no human call anywhere in the path.
3. **Refusal proof**: repeat with (a) an ineligible action type, (b)
   indexation at 30%, (c) the kill switch tripped, (d) trustDial
   'drafts' — and assert each is a no-op with the reason recorded.
4. **Kill-switch proof**: three articles landing `failed` pause
   autopilot; the pause appears in the digest; Resume clears it and the
   next run acts again.
5. **Delivery proof**: a digest records `stored`, and with a webhook
   configured, one signed request whose signature verifies.
