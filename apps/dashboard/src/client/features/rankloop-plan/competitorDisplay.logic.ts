import type { TagColorKey } from "@/shared/tag-colors";

type ChipDisplay = { label: string; color: TagColorKey };

// Coverage is the honesty stamp on a studied competitor: 'full' means we read
// their HTML, 'sitemap_only' means their bot protection turned the crawler
// away and every page-level number came from the sitemap instead. Null is
// "never studied" — the study-status cell covers that, not a chip.
const COVERAGE_DISPLAY = new Map<string, ChipDisplay>([
  ["full", { label: "studied", color: "emerald" }],
  ["sitemap_only", { label: "sitemap only", color: "amber" }],
]);

export function coverageDisplay(coverage: string | null): ChipDisplay | null {
  if (coverage === null) return null;
  return COVERAGE_DISPLAY.get(coverage) ?? null;
}

// The site-study kind vocabulary (post/page/hub/other), reused here so a
// competitor's page mix reads in the same words as your own inventory. An
// unmapped kind renders as a neutral chip rather than crashing on a missing
// color.
const PAGE_TYPE_DISPLAY = new Map<string, ChipDisplay>([
  ["post", { label: "post", color: "sky" }],
  ["page", { label: "page", color: "violet" }],
  ["hub", { label: "hub", color: "lime" }],
  ["other", { label: "other", color: "slate" }],
]);

export function pageTypeDisplay(pageType: string | null): ChipDisplay {
  if (pageType === null) return { label: "unknown", color: "slate" };
  return PAGE_TYPE_DISPLAY.get(pageType) ?? { label: pageType, color: "slate" };
}

// Only the two negative statuses get chips — 'active' is the norm and a chip
// for it would be noise. rose reads as rotting, slate as gone.
const PAGE_STATUS_DISPLAY = new Map<string, ChipDisplay>([
  ["decayed", { label: "decayed", color: "rose" }],
  ["removed", { label: "removed", color: "slate" }],
]);

export function pageStatusDisplay(status: string): ChipDisplay {
  return PAGE_STATUS_DISPLAY.get(status) ?? { label: status, color: "slate" };
}

// Estimated traffic and per-page ETV are DataForSEO's monthly visit
// estimates. Past a thousand they carry no precision worth printing, so the
// column compacts to "12.4K"; below it the exact number is short enough to
// read and rounding to "0.9K" would lose more than it saves.
const COMPACT_TRAFFIC_FORMAT = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

export function formatTraffic(value: number | null): string {
  if (value === null) return "—";
  if (value < 1000) return Math.round(value).toLocaleString("en-US");
  return COMPACT_TRAFFIC_FORMAT.format(value);
}

export function formatCount(value: number | null): string {
  return value === null ? "—" : value.toLocaleString("en-US");
}

// Feature deltas arrive as 0–100 shares of the page set that carried the
// feature. Whole percents: the winners sample is 30 pages and the median
// sample 15, so a decimal would imply resolution the sample can't hold.
export function formatFeaturePct(value: number): string {
  return `${Math.round(value)}%`;
}

// "2026-03" → "Mar 2026". Anchored to UTC with an explicit timeZone so a
// viewer west of Greenwich doesn't see every bar shift into the previous
// month. The cadence strip spans 24 months, so the year is load-bearing —
// two Marches sit in the same row.
export function cadenceMonthLabel(month: string): string {
  const date = new Date(`${month}-01T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return month;
  return date.toLocaleDateString("en-US", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

// Competitor page URLs are absolute and their domain already sits in the page
// header, so the path is the only part that distinguishes rows. Unparseable
// values render whole rather than disappearing.
export function urlPath(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}
