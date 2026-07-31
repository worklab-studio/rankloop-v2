# rankloop 2.0 design language = OpenSEO's, exactly

Ported from github.com/every-app/open-seo (MIT). When in doubt, do what
their `src/client` does. This file is the contract every screen follows.

## Theme

- Light `openseo` theme is the default (white cards, oklch grays, muted
  indigo primary `oklch(50% 0.12 262)`); `openseo-dark` auto via
  prefers-color-scheme. Flat: `--depth: 0`, `--noise: 0`. Never invent
  colors — use theme tokens or the tag-chip/score-tier classes.

## Shell (already built — never restyle it per-screen)

- Sidebar `w-60 bg-base-200`, flat on the canvas. Content on a **raised
  white panel** (`bg-base-100 md:rounded-tl-lg md:border-l md:border-t
  md:border-base-300`) — the PostHog-style cutout.
- The layout already provides page padding (`px-4 py-4 md:px-6 md:py-6`)
  and `mx-auto max-w-7xl flex flex-col gap-5`. Pages start straight with
  content; root element of a page should be a fragment or `<>...</>`
  contributing children to that column (gap-5 spacing — do NOT add
  space-y wrappers around the whole page).

## Page anatomy

- `<h1 className="text-2xl font-semibold">Title</h1>` via `PageHeader`
  (subtitle: `text-sm text-base-content/60`).
- Sections are `CardShell`s: `rounded-xl border border-base-300
  bg-base-100 shadow-sm`, header row `px-5 py-4` with `text-base
  font-semibold`, body behind `border-t border-base-300 p-5`, optional
  `stamp` footnote `text-[11px] text-base-content/45`.
- Stat rows: `grid gap-5 sm:grid-cols-2 lg:grid-cols-4` of `StatCard`
  (or `Stat` inside a CardShell). Values always `tabular-nums`.
- Two-column layouts: `grid items-start gap-5 lg:grid-cols-2`.

## Tables

- `table table-sm` (occasionally `table-zebra`). No custom cell padding.
  Numeric cells `tabular-nums`. Truncate long text, don't wrap chips.

## Chips & badges

- Keyword difficulty → `KdBadge` (OpenSEO score tiers: ≤20 green …
  >80 dark red). Never a plain badge for KD.
- Labels/evidence → `TagChip` colors: gsc=sky, volume=slate, gap=violet,
  serp=amber, pool=lime, cluster=slate, decay=rose. Proposal types:
  write=emerald, retitle=sky, refresh=amber, push=violet, merge=rose.
- daisyui `badge-*` classes are for status only (e.g. `badge-ghost
  badge-sm`); prefer TagChip everywhere else.

## Buttons & controls

- Default `btn` is a white bordered surface (theme override) — use `btn
  btn-sm` for row actions, `btn-primary btn-sm` for the one primary
  action per view, `btn btn-ghost btn-xs` for "More details" links.
- Tabs: underline style `tabs tabs-border` (active underline = primary).
  Never boxed tabs.
- Toggles: `toggle toggle-sm`; selects: `select select-sm`.

## Charts

- Only via `components/charts.tsx` (TrafficChart, PositionChart,
  SpendBar) — they carry OpenSEO's trend variables. No inline recharts.

## Voice

- Sentence-case headings ("Keyword gap", not "Keyword Gap"). Quiet
  provenance stamps over loud empty states. Numbers carry the meaning;
  chrome stays out of the way.
