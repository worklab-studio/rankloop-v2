# DESIGN-DNA — the OpenSEO dashboard visual language

Reference for grafting the "Write" feature group (Opportunities, Articles, Receipts) into
`apps/dashboard` so it is indistinguishable from upstream. Every class string below is
verbatim from the codebase; file paths are relative to `apps/dashboard/`.

The stack: Tailwind v4 + daisyUI (custom `openseo` / `openseo-dark` themes), lucide-react
icons, recharts, sonner toasts, TanStack Table/Query/Router/Form. There is **no** custom
font, **no** shadcn, **no** framer-motion, **no** CSS modules. One stylesheet:
`src/client/styles/app.css`. Everything else is utility classes inline in TSX.

---

## 1. Theme tokens (src/client/styles/app.css)

Both themes are **pure-neutral gray** (zero chroma) with a single muted indigo primary:

```css
@plugin "daisyui/theme" {
  name: "openseo";
  default: true;
  --color-base-100: oklch(100% 0 0);   /* card/panel surface */
  --color-base-200: oklch(97% 0 0);    /* app background, sidebar */
  --color-base-300: oklch(92% 0 0);    /* hairline borders */
  --color-primary: oklch(50% 0.12 262);  /* muted indigo — the ONLY brand color */
  --color-success: oklch(65% 0.18 145);
  --color-warning: oklch(80% 0.15 80);
  --color-error: oklch(65% 0.2 25);
  --radius-selector: 0.5rem;
  --radius-field: 0.5rem;
  --radius-box: 0.75rem;
  --border: 1px;
  --depth: 0;      /* flat — daisyUI depth/noise effects disabled */
  --noise: 0;
}
```

Dark theme (`openseo-dark`, `prefersdark: true`) flips the ladder: base-100 `oklch(18% 0 0)`
(panel), base-200 `oklch(12% 0 0)` (background), base-300 `oklch(27% 0 0)`, primary
lightened to `oklch(66% 0.12 262)`. Dark overrides target `html[data-theme="openseo-dark"]`.

Global rules worth knowing before writing any screen:

- `html, body { @apply m-0 bg-base-200; ... overflow: hidden; }` — the page never scrolls;
  scrolling happens inside the content panel.
- Inputs/textarea/select get `@apply text-base` (16px, prevents iOS zoom).
- Input focus is customized globally: `border-color: var(--color-primary);
  background-color: color-mix(in oklab, var(--color-primary) 10%, transparent);` — no ring.
- Default (variant-less) `.btn` is re-skinned per theme so it reads on the panel: light =
  `--btn-color: var(--color-base-100); --btn-border: var(--color-base-300)` (white button
  with visible border); dark = `--btn-color: oklch(25% 0 0)` (lifts above panel).
- `.tabs-border > .tab.tab-active::before { --tab-border-color: var(--color-primary); }`
  — the underline-tab accent is primary, commented in-source as "(PostHog-style)".
- `.alert` is re-styled: `@apply flex gap-3 rounded-lg border p-4 text-base-content/70;`
  and each variant is a translucent tint, e.g. `.alert-warning { @apply border-warning/70
  bg-warning/40 text-base-content/90; }` (dark: `border-warning/60 bg-warning/20`).

## 2. App shell & the "cutout" (src/client/layout/AppShell.tsx)

```
<div className="flex h-[100dvh] bg-base-200">
  <div className="hidden shrink-0 md:block"><Sidebar/></div>
  <div className="flex min-w-0 flex-1 flex-col">
    {/* PostHog-style cutout: the main content sits on a raised panel with a
        thin strip of the sidebar background above it and a hairline border. */}
    <div className="flex min-h-0 flex-1 flex-col md:pt-2">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-base-100 md:rounded-tl-lg md:border-l md:border-t md:border-base-300">
        ...banners...
        <div className="min-h-0 flex-1 overflow-auto">{children}</div>
```

The sidebar (`src/client/components/Sidebar.tsx`) is `flex h-full w-60 flex-col bg-base-200`.
Nav item classes (verbatim consts):

```tsx
const navItemBaseClass =
  "relative flex items-center gap-2.5 rounded-md px-3 py-1.5 text-sm text-base-content/70";
const navItemClass = `${navItemBaseClass} transition-colors hover:bg-base-300/30 hover:text-base-content`;
// active:
"bg-base-300/50 hover:bg-base-300/50 font-medium text-base-content"
// active left rail:
<div className="absolute left-0 top-1 bottom-1 w-[3px] rounded-r-full bg-primary" />
```

Group labels: `px-3 pb-1 pt-3 text-xs font-semibold uppercase tracking-wider
text-base-content/40`. Groups are **Overview / Research / My Site / Connect**
(`src/client/navigation/items.ts` — "Write" would be a fourth project group here; note the
source comment: *"Grouped by scope: 'My Site' is the project's own domain (tracked data),
'Research' is point-at-anything lookup tools."*). Item icons are lucide at `h-4 w-4 shrink-0`.

## 3. Page anatomy

Every page follows the same skeleton. From `SearchPerformancePage.tsx` (max-width tier is
the only variable):

```tsx
<div className="px-4 py-4 pb-24 overflow-auto md:px-6 md:py-6 md:pb-8">
  <div className="mx-auto max-w-7xl space-y-4">
    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
      <div>
        <h1 className="text-2xl font-semibold">Search Performance</h1>
        <p className="text-sm text-base-content/70">
          See your site&apos;s clicks, impressions, CTR, and position from Google Search Console.
        </p>
      </div>
      {/* quiet page-level action, right-aligned: */}
      <Link className="link link-hover shrink-0 self-start text-sm font-medium text-base-content/60 transition-colors hover:text-base-content sm:mt-1">
        Change property
      </Link>
    </div>
    ...sections...
```

Rules extracted:

- **Padding**: outer scroll div is always `px-4 py-4 md:px-6 md:py-6` with `pb-24 ... md:pb-8`
  (mobile bottom-bar clearance).
- **Max width tiers**: `max-w-7xl` for data/research tools (Keywords, Backlinks, Domain,
  Search Performance, Brand Lookup); `max-w-5xl` for dashboard/audit/lighthouse; `max-w-3xl`
  for chat and gates. Wrapper is either `mx-auto max-w-7xl space-y-4` or
  `mx-auto flex max-w-5xl flex-col gap-5` (DashboardPage). Section rhythm is `space-y-4`
  or `gap-5`, never more.
- **H1** is always `text-2xl font-semibold` (never bigger, never bolder) with a one-sentence
  `text-sm text-base-content/70` subtitle directly under it. No breadcrumbs, no icons in H1.
- Page titles are Title Case ("Keyword Research", "Saved Keywords", "Site Audit"); everything
  below H1 is sentence case.

## 4. Card anatomy

### CardShell — the dashboard card (src/client/features/dashboard/cardParts.tsx)

The file opens with the design intent, verbatim:

```tsx
// Shared building blocks for the dashboard cards. Same visual language as
// the GSC IntegrationCard (rounded-xl, shadow-sm, header row + divider) so
// the embedded SearchConsoleConnectionCard doesn't read as a different
// design system.
export function CardShell({ title, stamp, action, children }) {
  return (
    <div className="overflow-hidden rounded-xl border border-base-300 bg-base-100 shadow-sm">
      <div className="flex items-center justify-between gap-4 px-5 py-4">
        <h2 className="text-base font-semibold leading-tight">{title}</h2>
        {action}
      </div>
      <div className="border-t border-base-300 p-5">
        {children}
        {stamp ? (
          <p className="mt-4 text-[11px] text-base-content/45">{stamp}</p>
        ) : null}
      </div>
    </div>
  );
}
```

- Card `h2` is `text-base font-semibold leading-tight` — cards never shout.
- The header action slot takes `moreDetailsClass = "btn btn-ghost btn-xs"` ("More details").
- The **stamp** is the provenance footer: `text-[11px] text-base-content/45` with middot
  separators — `"Google Search Console · last 28 days"`,
  `` `Backlinks · snapshot ${formatDay(...)}` ``, `"Site audit · crawled 128 pages · Jul 12"`.
  Any new card that shows fetched data gets one.
- `IntegrationCard` in `src/client/features/gsc/SearchConsoleConnectionCard.tsx` is the
  same shell at `p-5 sm:p-6` with a `StatusPill` instead of a button:

```tsx
<span className={["inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium",
  connected ? "border-success/30 bg-success/10 text-success" : ...].join(" ")}>
  <span className={["size-1.5 rounded-full", connected ? "bg-success" : ...].join(" ")} />
  Connected
```

### Plain daisyUI card — everything outside the dashboard

Forms, stat cards and chart panels use `card bg-base-100 border border-base-300` (NO
shadow) with `card-body p-4` (stats) or `card-body gap-4` (forms). Examples:
`StatCard.tsx`, `DomainSearchCard.tsx`, `LaunchFormCard.tsx` (`<h2 className="card-title
text-base">Start New Audit</h2>`), `BacklinksOverviewPanels.tsx` TrendCard
(`card-body gap-2 p-4`, title `text-sm font-medium`, description
`text-xs text-base-content/55`).

### Stats

`Stat` (cardParts.tsx): label `text-xs uppercase tracking-wide text-base-content/60`,
value `text-2xl font-semibold tabular-nums`, optional tone `text-success`/`text-error`.
`PercentDelta` renders `▲ 12%` / `▼ 3%` as `text-xs tabular-nums` in success/error.
Search-perf `TotalCard` (`SearchPerformanceParts.tsx`): `rounded-lg border border-base-300
bg-base-100 p-4`, delta sits baseline-aligned next to the value with a `title={deltaTitle}`
comparison-period tooltip. The audit results strip (`audit/results/ResultsView.tsx`) uses
the **gap-px divider trick**:

```tsx
<div className="grid grid-cols-2 md:grid-cols-4 gap-px rounded-lg border border-base-300 bg-base-300/70 overflow-hidden">
  <div className="bg-base-100 px-4 py-3">
    <p className="text-[11px] uppercase tracking-wider text-base-content/50">{label}</p>
    <p className="text-xl font-semibold mt-0.5 tabular-nums">{value}</p>
```

### The one accented card

`OnboardingChecklist` (DashboardPage.tsx) is the sole primary-tinted surface:
`rounded-xl border border-primary/25 bg-primary/5 shadow-sm`, eyebrow
`text-xs font-medium uppercase tracking-wide text-primary` ("Onboarding checklist"),
pager `‹ 2 / 4 ›` with `btn btn-ghost btn-xs btn-square` chevrons and a
`text-xs tabular-nums text-base-content/60` counter. Tinted cards mean "act on this",
nothing else.

## 5. Table anatomy

### The shared engine (src/client/components/table/AppDataTable.tsx)

`useAppTable` wraps TanStack Table with opt-in flags (`withSorting`, `withExpanded`,
`withPagination`). `AppDataTable` defaults: `className = "table table-sm"`,
`wrapperClassName = "overflow-x-auto"`. Column alignment lives in column `meta`:

```tsx
const rightAligned = {
  headerClassName: "text-right",
  cellClassName: "text-right tabular-nums",
} as const;                       // SearchPerformanceColumns.tsx
```

Class choices per context:

- GSC dimension/striking tables: `className="table table-zebra table-sm"`.
- Keyword research (dense, half-pane): `className="table table-xs min-w-max md:w-full"`,
  `wrapperClassName="h-full overflow-auto"`.
- Sticky header: pass `stickyHeader` → each `<th>` gets `bg-base-200`
  (used in `rank-tracking/KeywordSuggestionStep.tsx`; manual variant
  `thead className="sticky top-0 bg-base-100"` in `KeywordTrendModal.tsx`).
- Clickable rows (KeywordResearchDesktopTable.tsx):

```tsx
className: `cursor-pointer border-b border-base-200 hover:bg-base-200/50 ${
  active ? "bg-primary/5 border-l-2 border-l-primary" : ""}`
```

### Sorting (src/client/components/table/SortableHeader.tsx)

```tsx
<button type="button"
  className="inline-flex items-center gap-1 font-medium transition-colors hover:text-base-content"
  onClick={column.getToggleSortingHandler()}
  aria-label={`Sort by ${label}`} aria-pressed={!!sorted}>
  {label}
  {sorted === "asc" ? <ArrowUp className="size-3 shrink-0" />
   : sorted === "desc" ? <ArrowDown className="size-3 shrink-0" /> : null}
</button>
// right-aligned headers wrap in: <span className="flex w-full justify-end">
```

The arrow appears **only when sorted** — no permanent up/down glyph pairs. Column help
text is a `HeaderHelpLabel` tooltip on the plain label (no ⓘ icon), e.g.
`helpText="Organic ranking difficulty (0-100): higher means harder to reach Google's top 10."`.

### Selection

`makeSelectionColumn` — 32px column of `checkbox checkbox-xs [--radius-selector:0.25rem]`
checkboxes with shift-click range selection (`tableSelection.ts` anchor ref).

### Cell/number conventions

- Formatters: `Intl.NumberFormat("en-US")` counts, `formatCtr = (v*100).toFixed(1)%`,
  `formatPosition = v.toFixed(1)`, compact `Intl.NumberFormat(..., { notation: "compact",
  maximumFractionDigits: 1 })`. CPC `value.toFixed(2)`.
- Null renders `"-"` (or `"—"` in dashboard stats) styled `text-base-content/40` — never
  0, never "N/A".
- Long strings: `<span className="block max-w-xl truncate" title={value}>` (max-w-xs for
  queries, max-w-sm for URLs). URLs render `link link-hover` with `target="_blank"
  rel="noreferrer"` after a `/^https?:\/\//` check.
- Rank-tracking cells use `font-mono` for positions and the old→new idiom
  (`RankTrackingTableParts.tsx`): `prev` at `font-mono text-xs text-base-content/40 w-6
  text-right`, arrow `<span className="text-base-content/30">→</span>`, new value in
  `font-mono rounded px-1.5 py-0.5 text-xs font-semibold bg-success/20 text-success`
  (or `bg-warning/20 text-warning`, `bg-error/20 text-error` + literal word `lost`).

### Table panel + toolbar

Tables live inside a panel: `overflow-hidden rounded-xl border border-base-300 bg-base-100`
with a toolbar row `flex flex-col gap-3 border-b border-base-300 px-4 py-3 lg:flex-row
lg:items-center lg:justify-between` — underline tabs (`role="tablist"` +
`tabs tabs-border w-fit`, tab labels carry counts: `` `Striking distance (${n})` ``) on the
left; `select select-bordered select-sm w-36` filters and a ghost Export menu on the right.
The compact variant (`DomainTableTabSurface.tsx`) is `flex items-center gap-2 px-4 py-2
border-b border-base-300` with a Filters toggle (`btn btn-ghost btn-sm gap-1.5` +
`badge badge-xs badge-primary border-0 text-primary-content` active-count), a
`text-sm text-base-content/60` row count, `<div className="flex-1" />` spacer, export menu.

### Pagination (src/client/components/table/TablePagination.tsx)

```
<div className="flex flex-col gap-3 border-t border-base-300 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
```

Left: range `1–50 of 1,234` in `text-sm text-base-content/70 tabular-nums` plus a
`loading loading-spinner loading-xs` while fetching. Right: "Rows per page" +
`select select-bordered select-sm w-20`, then `Page 2 of 25` and two
`btn btn-ghost btn-sm btn-square` chevrons. Open-ended totals render `1–50` (en-dash, no
"of") and rely on `hasNextPage`.

### Bulk action bar (src/client/components/table/TableBulkActionBar.tsx)

Appears floating above the bottom on selection:

```tsx
"pointer-events-none fixed inset-x-0 bottom-6 z-30 flex justify-center px-4"
  "pointer-events-auto flex items-stretch overflow-visible rounded-xl border border-base-content/15 bg-base-300/85 shadow-2xl backdrop-blur"
```

Count cell: X-clear button + `font-medium tabular-nums` count +
`text-base-content/60` noun (`selectedLabel` singular/plural chosen by caller: `"query"` /
`"queries"`), separated by `border-r border-base-content/10`. Actions are
`TableBulkActionButton`: `inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm
disabled:opacity-50` + `text-base-content/85 hover:bg-base-content/10` (danger variant:
`text-error hover:bg-error/10`), icons at `size-3.5`.

## 6. Chips & badges

Two custom systems live in app.css; daisyUI badges fill the gaps.

### tag-chip system (app.css + src/shared/tag-colors.ts + saved-keywords/TagChip.tsx)

Eight colors (`slate rose amber lime emerald sky violet fuchsia`), each a muted
`color-mix` tint: `background-color: color-mix(in oklab, #10b981 14%, transparent);
color: #065f46; --tw-ring-color: color-mix(in oklab, #10b981 30%, transparent);` with a
dark-theme text override (`html[data-theme="openseo-dark"] .tag-chip-emerald { color: #6ee7b7; }`).
Applied via `tagChipClass(color)` → `` `tag-chip-${color} ring-1 ring-inset` ``. TagChip
markup: `inline-flex items-center gap-1.5 rounded-md font-medium` + size (`xs: "h-5 px-1.5
text-[11px]"`, `sm: "h-6 px-2 text-xs"`, `md: "h-7 px-2.5 text-sm"`) + a
`size-1.5 shrink-0 rounded-full` color dot. Untagged colors are assigned deterministically
by hashing the tag id. The filter panel reuses the chips for include/exclude tokens
(`tag-chip-emerald` / `tag-chip-rose`).

### score-badge tiers (app.css + keywords/utils.ts + DifficultyBadge.tsx)

`scoreTierClass` maps difficulty 0–100 to `score-tier-1..6` (green → deep red at
breakpoints 20/35/50/65/80) plus `score-tier-na`; same color-mix tint + ring recipe.
Rendered as a **circle**, not a pill:

```tsx
<span className={`score-badge ${scoreTierClass(value)} inline-flex size-6 items-center justify-center rounded-full text-[10px] font-semibold tabular-nums`}>
  {value}   {/* or "—" for null */}
```

### IntentBadge (keywords/components/IntentBadge.tsx)

`inline-flex h-6 min-w-11 cursor-help items-center justify-center rounded-full border px-2
text-xs font-semibold leading-none` + tint map like
`informational: "border-info/30 bg-info/15 text-info"`. Short labels (`Info`, `Comm`,
`Trans`, `Nav`, `?`) with a rich FloatingTooltip explaining the intent.

### Where daisyUI `badge` IS used

Status and counts only (`audit/shared.tsx`, `BacklinksTableColumns.tsx`,
`RankTrackingTableParts.tsx`, `DomainTableTabSurface.tsx`):

- Run status: `badge badge-info badge-sm gap-1` + `<Loader2 className="size-3 animate-spin" /> Running`;
  done is a *softened* outline: `badge badge-outline badge-sm gap-1 text-success/80
  border-success/30 bg-success/5`; failed `badge badge-error badge-sm`.
- HTTP codes: `badge badge-success|warning|error badge-sm`, null `badge badge-ghost badge-sm`.
- SERP features: `badge badge-xs gap-0.5 cursor-help bg-base-300 border-0 text-base-content/70`
  with abbreviations (`FS`, `PAA`, `AI`) and `title=` tooltips.
- Filter counts: `badge badge-xs badge-primary border-0 text-primary-content`.
- Backlink attributes: `badge badge-sm badge-outline` (`Nofollow`), `badge badge-sm
  badge-error badge-outline` (`Lost`).

**Not** used for tags, difficulty, or intent — those are the custom systems above. Solid
loud `badge-primary`/`badge-success` fills are essentially absent outside tiny counts.

### Severity dots

Issue severity is a bare dot, not a badge (`DashboardCards.tsx`, ResultsView):
`size-2 shrink-0 rounded-full` + `bg-error` / `bg-warning` / `bg-base-content/30`, count in
`shrink-0 tabular-nums text-base-content/60` ("14 pages").

## 7. Button hierarchy

Grep facts: 41 `btn-primary` uses; **zero** `btn-secondary`, `btn-accent`, `btn-info`,
`btn-success`, `btn-warning`. The ladder:

1. **Primary** — `btn btn-primary` (often `btn-sm`), at most one per region: `Save`,
   `Start Audit`, `Run an audit`, `Search`, `Open setup guide`.
2. **Neutral** — plain `btn` / `btn btn-sm` (theme-reskinned white/lifted surface):
   `Cancel`, `Try again`, `Retry`, `Go to Billing`.
3. **Ghost** — `btn btn-ghost btn-sm` / `btn-xs` — the workhorse: card actions
   (`moreDetailsClass = "btn btn-ghost btn-xs"`), export menus (`btn btn-ghost btn-sm
   gap-1.5` + `<ChevronDown className="size-3 opacity-60" />`), pagination, dismissals.
4. **Icon-only** — `btn btn-ghost btn-sm btn-square` (chevrons, close) or `btn-circle`
   (sidebar close), always with `aria-label`.
5. **Destructive** — `btn btn-error btn-sm gap-1` for real deletes; quiet destructive is
   `btn btn-ghost btn-sm text-error hover:bg-error/10` (`Disconnect`).
6. **Link CTA** — `link link-primary text-sm font-medium` with a literal arrow:
   `Set up in AI &amp; MCP →`.
7. **Back link** — `btn btn-ghost btn-sm gap-2 px-0 text-base-content/70
   hover:bg-transparent` + `<ArrowLeft className="size-4" /> Recent searches` (ghost stripped
   of its hover box).
8. **Segmented** — `SegmentedToggle.tsx`: `inline-flex rounded-lg bg-base-300 p-0.5` with
   `btn btn-xs gap-1.5 px-2` items, active `bg-primary/20 text-primary shadow-sm`, inactive
   `btn-ghost text-base-content/40`. Range toggles use `join` + `btn btn-xs join-item`
   (`btn-active` vs `btn-ghost`) — `30d / 90d / All`.

Busy buttons keep their label: `<Loader2 className="size-4 animate-spin" /> Starting...`.

## 8. Forms & inputs

- Text: `input input-bordered` wrapped in a `<label>` for icon composition
  (`DomainSearchCard.tsx`): `input input-bordered flex items-center gap-2 w-full` with
  `<Search className="size-4 text-base-content/60" />` and an inner `input className="grow
  min-w-0"`. Error state appends `input-error` and a `<p className="text-sm text-error">`
  below (wired with `aria-invalid` / `aria-describedby`).
- Sizes: `input-sm w-28` for numbers, `input-xs` in filter panels; selects are
  `select select-bordered select-sm` with **fixed widths** (`w-36`, `w-20`, `w-44`).
- Checkbox `checkbox checkbox-sm` + `label cursor-pointer gap-2 py-0` + `label-text`;
  feature toggles `toggle toggle-sm toggle-primary`.
- Input+button fusion uses `join`: `input input-bordered join-item w-52` +
  `btn btn-primary join-item` (domain step, DashboardPage).
- Option sub-panels inside form cards: `rounded-lg border border-base-300 bg-base-200/20
  p-3 space-y-2` headed by `text-xs font-medium uppercase tracking-wide
  text-base-content/60` (LaunchFormCard) — settings grouped in quiet inset boxes, not
  fieldsets.
- Filter panel (`SavedKeywordsFilterPanel.tsx`) — the only gradient in the app:
  `space-y-3 border-b border-base-300 bg-gradient-to-b from-base-100 to-base-200/30 px-4
  py-3`, "Refine results" `text-sm font-semibold`, `Clear all` = `btn btn-xs btn-ghost
  gap-1` + `RotateCcw size-3`. Token inputs: `flex min-h-9 flex-wrap items-center gap-1.5
  rounded-md border border-base-300 bg-base-200/30 px-2 py-1.5 focus-within:border-primary`
  with an unstyled inner `bg-transparent text-xs outline-none placeholder:text-base-content/40`.
- Form-level submit errors: `alert alert-error py-2` + `<span className="text-sm">`, or the
  inline recipe `rounded-lg border border-error/30 bg-error/10 p-3 text-sm text-error flex
  items-start gap-2` + `<AlertCircle className="size-4 shrink-0 mt-0.5" />`.

## 9. Modals, dropdowns, toasts, banners

**Modals** — three flavors, all `z-50` over `bg-black/50` (or `/45`):

- Shared `Modal` (`components/Modal.tsx`): `fixed inset-0 z-50 flex items-center
  justify-center bg-black/50 p-4` → `card bg-base-100 border border-base-300 w-full
  max-w-sm max-h-full shadow-xl` with `card-body gap-4 overflow-y-auto`; Escape-to-close;
  `maxWidth` prop (`max-w-3xl` for chart modals).
- daisyUI `modal modal-open` + `modal-box` + `modal-action` (KeywordSaveDialog): title
  `font-bold text-lg`, body `text-base-content/70 text-sm`, actions `btn` +
  `btn btn-primary`, clickable `modal-backdrop`.
- Hand-rolled alert modal (`AppShellParts.tsx`): `w-full max-w-lg rounded-xl border
  border-base-300 bg-base-100 p-5 shadow-2xl`, icon chip `rounded-full bg-warning/20 p-2
  text-warning`, footer `mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end`
  with `btn btn-ghost` Dismiss + `btn btn-primary` CTA. Full a11y: `role="dialog"
  aria-modal="true" aria-labelledby aria-describedby tabIndex={-1}` + focus on open.

**Dropdowns** — always daisyUI: `dropdown dropdown-end` trigger (`tabIndex={0}`,
`aria-haspopup="menu"`) + menu `dropdown-content menu z-10 w-56 rounded-box border
border-base-300 bg-base-100 p-2 shadow-lg` (w-52/w-56/w-64; `dropdown-top ... mb-1 z-30`
for the sidebar account menu). Items: lucide `size-4` icon + label; two-line items nest
`<span className="flex flex-col items-start">` with a `text-xs text-base-content/50`
subtitle ("Update keyword stats / Volume, difficulty & CPC"). Divider:
`<li aria-hidden className="pointer-events-none my-1 h-px bg-base-300 p-0" />`.

**Toasts** — sonner, configured once in `src/routes/__root.tsx`:
`<Toaster position="bottom-right" mobileOffset={{ bottom: 100 }} />`. Copy pattern:
`` toast.success(`Saved ${n} ${n === 1 ? "keyword" : "keywords"}`) `` — concrete counts,
correct pluralization; errors always route through
`toast.error(getStandardErrorMessage(error, "Couldn't save the domain. Try again."))`.

**Banners** — `alert alert-warning` / `alert-info` inside `shrink-0 px-4 py-2.5 md:px-6` +
`mx-auto max-w-7xl`, content `<AlertTriangle className="size-4 shrink-0" />` +
`<span className="text-sm">` with an inline `link link-primary font-medium` ("help page").
Rendered above page content inside the panel, never floating.

**Tooltips** — custom portal `FloatingTooltip` (`keywords/components/FloatingTooltip.tsx`):
`pointer-events-none fixed z-[1000] w-max max-w-64 -translate-x-1/2 -translate-y-full
rounded-md border border-base-300 bg-base-100 px-2.5 py-2 text-[11px] font-normal
normal-case leading-snug text-base-content shadow-md`, 150ms hover delay, focus/Escape
support. Cheap tooltips use native `title=` liberally. daisyUI `tooltip` class is not the
idiom.

## 10. Loading states

- **Skeletons mirror the loaded layout.** The doctrine, verbatim from
  `SearchPerformanceLoadingState.tsx`:
  ```
  // Skeleton loading state for the Search Performance (GSC) page. Mirrors the
  // loaded layout — four totals cards over a tabbed table panel — so the shell
  // stays put and only the data fills in, matching the other pages' loaders
  ```
  Blocks are daisyUI `skeleton h-3 w-20`, `skeleton h-7 w-24`, etc., placed inside the same
  card/panel chrome as the loaded state (`rounded-lg border border-base-300 bg-base-100 p-4
  space-y-2`), container marked `aria-busy`. Row skeletons replicate the real column grid:
  `grid grid-cols-[24px_minmax(0,1fr)_64px_56px_48px_40px] items-center gap-3`
  (KeywordResearchLoadingState).
- **Refetch-in-place**: a lone `<Loader2 className="size-4 animate-spin
  text-base-content/40" />` next to the filters, or dimming the existing table:
  `opacity-60 transition-opacity` (DomainTableTabSurface).
- Small inline waits: `loading loading-spinner loading-xs|sm` + `Checking…` / `Loading…`
  in `text-sm text-base-content/50`.
- First-fetch table body: `flex items-center gap-2 p-8 text-sm text-base-content/60` +
  spinner + `Loading…`.

## 11. Empty & error states

- **Nothing-yet (invitational)**: dashed card — `rounded-2xl border border-dashed
  border-base-300 bg-base-100/70 p-6 text-center text-base-content/50 space-y-3`, lucide
  icon `size-10 mx-auto opacity-40`, title `text-lg font-medium text-base-content/80`
  ("Enter a keyword to get started"), body `text-sm max-w-md mx-auto`. Chart variant:
  `flex h-56 items-center justify-center rounded-xl border border-dashed border-base-300
  text-sm text-base-content/55` — "Not enough historical data yet."
- **No results**: solid `rounded-2xl border border-base-300 bg-base-100 p-6 md:p-8
  text-center space-y-4 mx-auto` with `Globe size-10 text-base-content/40`, echoing the
  query back in `font-medium text-base-content`.
- **Table empty**: just a sentence — `<p className="p-6 text-sm text-base-content/60">No
  data for this period yet. Search Console data trails by a few days.</p>`. Empty states
  teach: *"No striking-distance queries in this period. These are queries ranking at
  positions 5 to 20, where an improvement is most likely to move traffic."*
- **Page error**: `alert alert-error` + `getStandardErrorMessage`, or the big recipe
  (`BacklinksPageStates.tsx`): `section rounded-2xl border border-error/30 bg-error/5 p-6
  space-y-3` with icon chip `rounded-xl bg-error/10 p-2.5 text-error shrink-0`
  (`ShieldAlert size-5`), `text-lg font-semibold` title, and a plain `btn btn-sm` Retry.
  Inline query error: `w-full max-w-xl rounded-xl border border-error/30 bg-error/10 p-5
  text-error space-y-3`.

## 12. Charts (recharts)

All charts share these decisions (`DisplayPrimitives.tsx` AreaTrendChart,
`RankTrackingTrendChart.tsx`, `BacklinksPageCharts.tsx`, `RankTrackingOverview.tsx`):

- **Explicit pixel width** via a ResizeObserver `useChartWidth()` hook — never
  `ResponsiveContainer`. Fixed heights 210–224px (`h-[210px]`, `h-56`, `height = 224`).
- **No animation**: `isAnimationActive={false}` on every series; dots `r: 2–3`,
  `activeDot r: 4–5`.
- **Quiet axes**: `tick={{ fontSize: 10, fill: "#888" }}` or
  `tick={{ fill: "var(--trend-axis-color)", fontSize: 11 }}`, always `axisLine={false}
  tickLine={false}`, `minTickGap`, date ticks via `toLocaleDateString("en-US", { month:
  "short", day: "numeric" })`, compact Y formatter (`1.2M`, `45K`).
- **Dashed 10% grid**: `strokeDasharray="3 3" stroke="currentColor" opacity={0.1}`
  (often `vertical={false}`); the keyword trend uses `"2 4"` + theme var
  `var(--trend-grid-color)`.
- **Primary-gradient area fill**: linearGradient from `var(--color-primary)` at
  `var(--trend-fill-start-opacity)` (0.32 light / 0.24 dark) to
  `var(--trend-fill-end-opacity)` (0.05 / 0.03) — all tuned per theme in app.css.
- **Themed tooltip**: `contentStyle={{ backgroundColor: "var(--trend-tooltip-bg)", border:
  "1px solid var(--trend-tooltip-border)", borderRadius: "10px", boxShadow: "0 8px 24px
  var(--trend-tooltip-shadow)", color: "var(--color-base-content)" }}` or a fully custom
  `content` renderer; cursor `{ stroke: "rgba(150,150,150,0.3)" }`.
- **Series colors are hex literals**, one saturated hue per series: `#2563eb`, `#14b8a6`,
  `#16a34a`, `#ef4444`, `#f59e0b`, `#6b7280`.
- **Custom mini-legends**, not recharts defaults (mostly): `inline-flex items-center gap-1
  text-[11px] text-base-content/60` + `size-2 rounded-sm` swatch.
- **Axis caption row** above rank charts:
  `flex items-center justify-between text-[11px] text-base-content/50` —
  `Google position (1 = best)` / `Better ↑`; the reversed Y axis + a `ReferenceArea`
  bottom band (`fillOpacity={0.06}`) for "not in top N".

## 13. Tabs & the search-tab strip

- In-page and sidebar tabs are the daisyUI **underline** style: `role="tablist"` +
  `tabs tabs-border w-fit`, buttons `tab ${active ? "tab-active" : ""}` with
  `role="tab" aria-selected` (see `TabButton` in SearchPerformanceParts.tsx). Active
  underline is primary via the app.css override.
- `SearchTabStrip.tsx` is browser-tabs-in-a-box: container `rounded-xl border
  border-base-300 bg-base-100 p-1`, chips `group flex shrink-0 items-stretch
  overflow-hidden rounded-md text-sm transition` — active `bg-base-300 text-base-content
  shadow-sm`, idle `text-base-content/80 hover:bg-base-200`; label
  `max-w-[10rem] truncate font-medium`; close X `size-3.5` fades in on group-hover; status
  slot shows `Loader2 size-3 animate-spin`, `size-2 rounded-full bg-error` (error) or
  `bg-primary` (unread result).

## 14. Code conventions that shape the UI files

- Feature folders under `src/client/features/<feature>/` with flat `PascalCase.tsx` files;
  recurring suffixes: `*Page`, `*Parts` (small shared pieces), `*Card`, `*Table`,
  `*Columns`, `*LoadingState`, `*EmptyState`, `*States`, `*FilterPanel`,
  `*HistorySection`, `*Modals`, `cardParts.tsx`, `shared.tsx`, `utils.ts`.
- Components take a `projectId: string` prop; queries via TanStack Query with array keys
  `["searchPerformance", projectId, ...]`; mutations toast on error and invalidate on
  success; server calls are typed `serverFunctions` (`getX({ data: { projectId } })`).
- Conditionals render with ternary + `null` (`{cond ? <X/> : null}`), class merging by
  template literal or `[...].filter(Boolean).join(" ")` — no `clsx`/`cn` helper.
- WHY-comments everywhere, referencing product reasoning ("PostHog-style", "Free
  first-party GSC data", "so the tab opens instantly instead of showing a spinner").
  New code without them reads foreign.
- Analytics: `captureClientEvent("feature:action", {...})` at interaction points.
- Copy uses real typographic characters: `·` in stamps, `—` em dashes, `…`, `‹ ›`, `→`,
  `▲▼`; HTML entities `&apos;` `&rsquo;` `&ldquo;` in JSX text.

---

## 15. Why it doesn't look AI-generated

Rules inferred from the code. Any new Write screen must obey all of them.

1. **Grayscale body, color only for meaning.** Base surfaces have literally zero chroma
   (`oklch(N% 0 0)`). Color appears exclusively where it encodes data: score tiers, tag
   chips, chart series, severity dots, one indigo primary. Never color a heading, a card
   background (except the single `bg-primary/5` checklist), or an icon for decoration.
2. **Tints, not fills.** Every colored surface is a translucent tint of a semantic color —
   `bg-success/10`, `bg-error/20`, `color-mix(... 14%, transparent)` — with a matching
   `/30` border or inset ring and the full-strength color reserved for text and dots. Solid
   `badge-primary`-style pills are near-absent (only the tiny filter-count badge).
3. **Borders carry the structure, shadows are rationed.** Separation is hairline
   `border-base-300`: card dividers are `border-t`, stat grids use the `gap-px` +
   `bg-base-300/70` trick, table toolbars are `border-b`. `shadow-sm` appears only on
   dashboard/integration cards; `shadow-lg` only on dropdowns; `shadow-xl/2xl` only on
   overlays; `backdrop-blur` only on the floating bulk bar. Tables, stat cards, and form
   cards have no shadow at all.
4. **One restrained type scale.** Page h1 `text-2xl font-semibold` — nothing on a page is
   ever larger. Card titles `text-base font-semibold`. Labels are the signature micro-type:
   `text-xs`/`text-[11px]` `uppercase tracking-wide(r)` at `/50–/60` opacity. Bold weight
   (`font-bold`) is virtually unused; `font-semibold` is the ceiling.
5. **The opacity ladder replaces a gray palette.** Secondary text is always
   `text-base-content/70`, hints `/60`, stamps and fine print `/45–/55`, disabled/null
   `/40`, group labels `/40`. Never `text-gray-500` or a second neutral hue.
6. **Numbers behave like numbers.** `tabular-nums` on every metric, right-aligned columns
   via column-meta, `Intl.NumberFormat` with locale commas, one-decimal CTR/positions,
   `font-mono` for rank positions and URLs-as-data, `—`/`-` at 40% opacity for null. A
   left-aligned or un-formatted number column is an instant tell.
7. **Ghost-first buttons, one primary per view.** Anything that isn't the single main
   action is `btn-ghost btn-sm/btn-xs` or a plain `btn`. There are zero
   `btn-secondary/accent/info/success/warning` in the codebase. Destructive is quiet until
   it's a real delete.
8. **Icons are labels' assistants, never art.** Lucide only, `size-3`→`size-5` inline with
   text, `size-10 opacity-40` max in empty states. No emoji, no illustrations, no hero
   graphics, no icon-tile grids.
9. **Skeletons clone the final layout; nothing jumps.** Loading states rebuild the exact
   card/table geometry with `skeleton` blocks (`aria-busy`), refetches dim in place
   (`opacity-60 transition-opacity`) or show one small spinner beside the filters. Never a
   full-page centered spinner; charts never animate in.
10. **Copy is concrete, lowercase-calm, and provenance-stamped.** One-sentence subtitles;
    empty states explain the mechanism with real numbers ("positions 5 to 20"); footers
    stamp the data source and date ("Google Search Console · last 28 days"); toasts count
    and pluralize ("Saved 5 keywords"); errors say what to do ("Couldn't save the domain.
    Try again."). No "Oops!", no "🎉", no marketing adjectives inside the product.
11. **Asymmetric, data-first composition.** Header rows put the title left and a quiet
    ghost/link action right; dashboard cards holding data sort ahead of setup pitches
    (`toSorted((a, b) => Number(b.hasData) - Number(a.hasData))`); nothing is centered
    except empty states. Grids are pragmatic (`lg:grid-cols-2`, `grid-cols-2 lg:grid-cols-4`),
    not gallery layouts.
12. **A small, fixed radius vocabulary.** `rounded-md` for controls/chips, `rounded-lg` for
    inset sub-panels and small stat cards, `rounded-xl` for cards/panels (`--radius-box:
    0.75rem`), `rounded-2xl` only for large empty/error sections, `rounded-full` only for
    pills, dots, and the score circle. Mixing radii outside this ladder — or reaching for
    `rounded-3xl` — breaks the dialect.
