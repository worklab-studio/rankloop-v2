// Pure functions behind the competitor study: URL-shape page-type mix,
// the 24-month posting cadence, the structural features that separate a
// competitor's winners from its median page, and the snapshot diff that
// turns two studies into decayed/removed evidence. No I/O — unit-tested
// directly in study.logic.test.ts.

import {
  isPostLikePath,
  isSectionIndexPath,
  isUtilityPath,
  type ContentPageKind,
} from "@/server/features/rankloop/site-study/services/derive.logic";

// ---------------------------------------------------------------------------
// Page-type mix and cadence (sitemap-only inputs)
// ---------------------------------------------------------------------------

/**
 * Classify a competitor's path from its shape alone. The kind vocabulary is
 * S2's so the two sides of the product read the same, but the evidence is
 * thinner: no crawl means no publishedAt, no word count, and no outlink
 * graph, so only the utility / post / section-index shapes are provable and
 * everything else lands on 'page'.
 */
export function classifyPathByShape(path: string): ContentPageKind {
  if (isUtilityPath(path)) return "other";
  if (isPostLikePath(path)) return "post";
  if (isSectionIndexPath(path)) return "hub";
  return "page";
}

export type PageTypeMixEntry = { pageType: ContentPageKind; count: number };

// Kind order for ties, so two sites with the same counts render their chips
// in the same order.
const KIND_ORDER: ContentPageKind[] = ["post", "page", "hub", "other"];

/** Counts by kind, biggest first, empty kinds dropped — a site with no hubs
 *  should show three chips, not a chip reading "0 hubs". */
export function summarizePageTypeMix(paths: string[]): PageTypeMixEntry[] {
  const counts = new Map<ContentPageKind, number>();
  for (const path of paths) {
    const kind = classifyPathByShape(path);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return KIND_ORDER.flatMap((pageType) => {
    const count = counts.get(pageType) ?? 0;
    return count > 0 ? [{ pageType, count }] : [];
  }).toSorted((a, b) => b.count - a.count);
}

// Two years of monthly buckets: long enough to show a publishing program
// starting, stalling, or being abandoned — the three things the cadence bar
// is read for — and still a 24-element array in studySummaryJson.
const CADENCE_MONTHS = 24;

export type CadenceBucket = { month: string; count: number };

/**
 * Bucket sitemap lastmods into trailing-24-month counts, oldest first and
 * ending in `now`'s month. Empty months stay present so a publishing gap
 * renders as a gap instead of a missing bar; anything older than the window,
 * dated in the future, or unparseable is dropped rather than clamped.
 */
export function buildCadenceBuckets(
  lastmods: Array<string | null>,
  now: Date,
): CadenceBucket[] {
  const countByMonth = new Map<string, number>();
  for (const lastmod of lastmods) {
    if (!lastmod) continue;
    const parsed = Date.parse(lastmod);
    if (Number.isNaN(parsed)) continue;
    const month = new Date(parsed).toISOString().slice(0, 7);
    countByMonth.set(month, (countByMonth.get(month) ?? 0) + 1);
  }

  const buckets: CadenceBucket[] = [];
  for (let i = CADENCE_MONTHS - 1; i >= 0; i--) {
    const date = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i),
    );
    const month = date.toISOString().slice(0, 7);
    buckets.push({ month, count: countByMonth.get(month) ?? 0 });
  }
  return buckets;
}

// ---------------------------------------------------------------------------
// Structural feature extraction
// ---------------------------------------------------------------------------

export type StructuralFeatures = {
  wordCount: number;
  /** img + video + iframe elements — "does this page carry media at all". */
  mediaCount: number;
  dataTable: boolean;
  faqBlock: boolean;
  byline: boolean;
  dateModified: boolean;
};

// A single <table> with two rows is as often layout as data; three rows is
// where a real comparison/spec table starts.
const DATA_TABLE_MIN_ROWS = 3;
// Three question-shaped headings (or <details> toggles) is an FAQ section;
// one or two are just a page that happens to ask something.
const FAQ_MIN_BLOCKS = 3;

const TAG_STRIP_RE = /<(script|style|noscript)\b[^>]*>[^]*?<\/\1>/gi;
const TAG_RE = /<[^>]+>/g;
const TABLE_ROW_RE = /<tr\b/gi;
const MEDIA_RE = /<(img|video|iframe)\b/gi;
const DETAILS_RE = /<details\b/gi;
const HEADING_RE = /<h[23]\b[^>]*>([^]*?)<\/h[23]>/gi;

const BYLINE_MARKERS = [
  /rel=["']?author/i,
  /<meta[^>]+name=["']author["']/i,
  /itemprop=["']author["']/i,
  /class=["'][^"']*\bbyline\b/i,
  /class=["'][^"']*\bauthor(-|_|\b)/i,
  /"author"\s*:/i,
];

const DATE_MODIFIED_MARKERS = [
  /"dateModified"\s*:/i,
  /property=["']article:modified_time["']/i,
  /itemprop=["']dateModified["']/i,
];

function countMatches(html: string, pattern: RegExp): number {
  // Fresh lastIndex per call: these are module-level /g regexes.
  pattern.lastIndex = 0;
  let count = 0;
  while (pattern.exec(html) !== null) count += 1;
  return count;
}

/** Question-shaped h2/h3 headings — the FAQ signal that survives sites which
 *  never publish FAQPage schema. */
function countQuestionHeadings(html: string): number {
  HEADING_RE.lastIndex = 0;
  let count = 0;
  let match: RegExpExecArray | null;
  while ((match = HEADING_RE.exec(html)) !== null) {
    const text = match[1].replace(TAG_RE, "").trim();
    if (text.endsWith("?")) count += 1;
  }
  return count;
}

/**
 * The six structural features the winners-vs-median table compares. Regex,
 * not a DOM parse: this runs over up to 2 MiB of foreign HTML for 45 pages
 * per study, and every marker below is a flat single-pass scan — loading
 * cheerio 45 times would dominate the step's CPU budget for booleans.
 */
export function extractStructuralFeatures(html: string): StructuralFeatures {
  const stripped = html.replace(TAG_STRIP_RE, " ");
  const text = stripped.replace(TAG_RE, " ");
  const words = text.split(/\s+/).filter(Boolean);

  const faqSchema = /"@type"\s*:\s*"FAQPage"/i.test(html);
  const questionBlocks =
    countQuestionHeadings(stripped) + countMatches(stripped, DETAILS_RE);

  return {
    wordCount: words.length,
    mediaCount: countMatches(stripped, MEDIA_RE),
    dataTable: countMatches(stripped, TABLE_ROW_RE) >= DATA_TABLE_MIN_ROWS,
    faqBlock: faqSchema || questionBlocks >= FAQ_MIN_BLOCKS,
    byline: BYLINE_MARKERS.some((marker) => marker.test(html)),
    dateModified: DATE_MODIFIED_MARKERS.some((marker) => marker.test(html)),
  };
}

// ---------------------------------------------------------------------------
// Winners vs median
// ---------------------------------------------------------------------------

// Labels, not field names: these render straight into the playbook table, so
// they are written the way the card reads them out loud.
const BOOLEAN_FEATURES: Array<{
  key: keyof StructuralFeatures;
  label: string;
}> = [
  { key: "dataTable", label: "Data table" },
  { key: "faqBlock", label: "FAQ block" },
  { key: "byline", label: "Byline" },
  { key: "dateModified", label: "Date modified" },
];

type FeatureDelta = {
  feature: string;
  /** Whole percent of the top-earning cohort carrying the feature. */
  winnersPct: number;
  /** Same, over the median sample — the competitor's ordinary pages. */
  medianPct: number;
};

type WinnersComparison = {
  deltas: FeatureDelta[];
  winnersMedianWordCount: number | null;
  sampleMedianWordCount: number | null;
  winnersStudied: number;
  sampleStudied: number;
};

/** Median of a numeric list; null for an empty one. Even-length lists average
 *  the middle pair, matching the content-inventory median. */
export function medianOf(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = values.toSorted((a, b) => a - b);
  const middle = sorted.length / 2;
  return sorted.length % 2 === 1
    ? sorted[(sorted.length - 1) / 2]
    : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

function percentWith(
  pages: StructuralFeatures[],
  feature: keyof StructuralFeatures,
): number {
  if (pages.length === 0) return 0;
  const hits = pages.filter((page) => page[feature]).length;
  return Math.round((hits / pages.length) * 100);
}

/**
 * What the winners do that the ordinary pages don't.
 *
 * Only features the winners carry MORE often survive: a feature both cohorts
 * use equally is house style, not the template contract the page plan is
 * looking for, and one the winners use LESS is a coincidence at these sample
 * sizes (30 winners, 15 median pages). An empty delta list is therefore a
 * finding — "their earners look like their ordinary posts" — not a gap.
 */
export function compareWinnersToMedian(
  winners: StructuralFeatures[],
  sample: StructuralFeatures[],
): WinnersComparison {
  return {
    deltas: BOOLEAN_FEATURES.flatMap(({ key, label }) => {
      const winnersPct = percentWith(winners, key);
      const medianPct = percentWith(sample, key);
      return winnersPct > medianPct
        ? [{ feature: label, winnersPct, medianPct }]
        : [];
    }),
    winnersMedianWordCount: medianOf(winners.map((page) => page.wordCount)),
    sampleMedianWordCount: medianOf(sample.map((page) => page.wordCount)),
    winnersStudied: winners.length,
    sampleStudied: sample.length,
  };
}

// ---------------------------------------------------------------------------
// Snapshot diff (the what-not-to-build signal)
// ---------------------------------------------------------------------------

// A page that kept 40% of its traffic value is having a bad quarter; below
// that it has been overtaken or left to rot, which is the negative evidence
// the page plan reads.
const DECAY_SURVIVING_ETV_RATIO = 0.4;

export type SnapshotPage = { url: string; etv: number | null };

type SnapshotDiff = {
  active: string[];
  decayed: string[];
  removed: string[];
};

/**
 * Compare the previous study's pages against this one's. Status is recomputed
 * every run rather than latched: a page marked decayed last month that has
 * since recovered shows no fresh drop and goes back to 'active', and a
 * removed URL that reappears in the sitemap does too. A first study has no
 * prior, so everything is 'active' — decay needs two points to exist.
 */
export function diffPageSnapshot(input: {
  prior: SnapshotPage[];
  current: SnapshotPage[];
}): SnapshotDiff {
  const priorEtvByUrl = new Map(
    input.prior.map((page) => [page.url, page.etv]),
  );
  const currentUrls = new Set(input.current.map((page) => page.url));

  const active: string[] = [];
  const decayed: string[] = [];
  for (const page of input.current) {
    const priorEtv = priorEtvByUrl.get(page.url);
    // No prior reading, or a prior of zero, gives nothing to divide by.
    const hasBaseline = priorEtv != null && priorEtv > 0;
    const nowEtv = page.etv ?? 0;
    if (hasBaseline && nowEtv <= priorEtv * DECAY_SURVIVING_ETV_RATIO) {
      decayed.push(page.url);
    } else {
      active.push(page.url);
    }
  }

  const removed = input.prior
    .map((page) => page.url)
    .filter((url) => !currentUrls.has(url));

  return { active, decayed, removed };
}
