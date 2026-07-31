// Pure functions behind the optimize-existing signals (spec 0012): CTR-deficit
// retitles, striking-distance pushes, and guarded decay refreshes, all computed
// from the project's own stored memory (gsc_performance × content_pages). No
// I/O — unit-tested directly in signals.logic.test.ts. Every threshold is a
// named constant, and every candidate carries the factors and evidence that
// explain its score: a proposal the UI can't explain is a proposal nobody
// should approve.

import { score } from "@rankloop/engine";
import { suppressedTargets } from "@/server/features/rankloop/proposals/suppression.logic";
import type { SuppressionInput } from "@/server/features/rankloop/proposals/suppression.logic";
import type { ProposalFactor } from "@/types/schemas/rankloopProposals";

// ---------------------------------------------------------------------------
// Inputs and outputs
// ---------------------------------------------------------------------------

/** One day-grain gsc_performance row joined to its page URL and query text. */
export type PageQueryDayRow = {
  pageUrl: string;
  query: string;
  clicks: number;
  impressions: number;
  position: number;
};

/** 28-day rollup per (page, query) — the unit retitle and push evaluate. */
export type PageQueryAggregate = {
  pageUrl: string;
  query: string;
  clicks: number;
  impressions: number;
  weightedPosition: number;
};

/** Per-page daily totals across stored memory — the refresh signal's series. */
export type PageDayRow = {
  pageUrl: string;
  date: string;
  clicks: number;
  impressions: number;
};

/** The slice of a content_pages row the signals need, keyed by URL. */
export type SignalPageMeta = {
  id: string;
  path: string;
  title: string | null;
  publishedAt: string | null;
};

export type SignalCandidate = {
  type: "retitle" | "push" | "refresh";
  /** Site path — the optimize track's target, and the dedupe key. */
  target: string;
  contentPageId: string;
  title: string;
  score: number;
  factors: ProposalFactor[];
  evidence: string[];
};

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/** All windowed signals read a trailing 28-day slice — four whole weeks, so
 *  weekday/weekend traffic shape cancels out of every comparison. */
export const SIGNAL_WINDOW_DAYS = 28;

// Expected CTR by result position, the fixed band curve. Coarse on purpose:
// per-site fitted curves need more history than a fresh project has, and the
// deficit rule below is relative, so the curve only has to be right about
// shape, not about any single site's absolute CTR.
const EXPECTED_CTR_BANDS: ReadonlyArray<{ maxPosition: number; ctr: number }> =
  [
    { maxPosition: 1, ctr: 0.28 },
    { maxPosition: 2, ctr: 0.15 },
    { maxPosition: 3, ctr: 0.1 },
    { maxPosition: 4, ctr: 0.07 },
    { maxPosition: 5, ctr: 0.05 },
    { maxPosition: 10, ctr: 0.03 },
    { maxPosition: 20, ctr: 0.015 },
  ];

// Below 100 impressions a CTR is mostly noise — at position 5 that is ~5
// expected clicks, where one rich-result day swings the ratio by half.
const RETITLE_MIN_IMPRESSIONS = 100;

// Relative, not absolute: fire when actual CTR is at or under 55% of the
// band's expectation. An absolute floor would over-fire at position 1 (where
// 10% CTR is a disaster) and never fire at position 15 (where 1% is fine).
const RETITLE_DEFICIT_RATIO = 0.55;

// How many secondary queries a retitle lists as evidence before folding the
// rest into a "+n more" chip.
const RETITLE_MAX_EVIDENCE_QUERIES = 4;

// Striking distance: close enough that on-page work can move the needle
// (below position 5 there is little left to win; past 20 it's a rewrite, not
// a push), with a 30-impression floor so single-day flukes don't qualify.
const PUSH_MIN_POSITION = 5;
const PUSH_MAX_POSITION = 20;
const PUSH_MIN_IMPRESSIONS = 30;

// The inverted-U: position ~11 is the sweet spot — page two's doorstep, where
// one position gained crosses onto page one. The multiplier peaks at 1.5×
// there and decays linearly to 1.0× at both band edges.
const PUSH_PEAK_POSITION = 11;
const PUSH_PEAK_BONUS = 0.5;

// Decay guards. Memory: both comparison windows (2 × 28d) must be covered by
// stored data, or "prior period" is an artifact of when the backfill started.
// Age: pages younger than ~6 months are still finding their level — early
// volatility looks exactly like decay. Peak week: a page that never earned 10
// clicks in a week has no former glory to refresh back to.
const REFRESH_MIN_MEMORY_DAYS = 2 * SIGNAL_WINDOW_DAYS;
const REFRESH_MIN_PAGE_AGE_DAYS = 183;
const REFRESH_MIN_PEAK_WEEK_CLICKS = 10;

// Fire only when trailing clicks fall to ≤70% of the prior window — and
// impressions must have fallen too. Clicks down with impressions flat is a
// CTR problem (retitle territory), not demand decay.
const REFRESH_CLICKS_RATIO = 0.7;

// Brand tokens shorter than 3 chars ("io", "ai") match half the dictionary
// as substrings; dropping them loses little — real brand queries carry the
// long token too.
const MIN_BRAND_TOKEN_LENGTH = 3;

const MS_PER_DAY = 86_400_000;

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

/** Calendar-day arithmetic on YYYY-MM-DD strings. Local twin of
 *  GscSyncService.addDays so this module stays importable without the
 *  cloudflare:workers shim that service drags in. */
function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (YYYY-MM-DD each). */
function daysBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
      MS_PER_DAY,
  );
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

function fmtPct(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

function fmtInt(n: number): string {
  return n.toLocaleString("en-US");
}

// ---------------------------------------------------------------------------
// Brand exclusion
// ---------------------------------------------------------------------------

/**
 * Tokens that mark a query as branded: the project name's words plus the
 * domain's stem. Navigational queries rank ~1 with sky-high CTR and would
 * otherwise dominate every impression-weighted signal while offering nothing
 * a title or refresh could improve.
 */
export function brandTokens(name: string, domain: string | null): string[] {
  const tokens = new Set<string>();
  for (const token of name.toLowerCase().split(/[^a-z0-9]+/)) {
    if (token.length >= MIN_BRAND_TOKEN_LENGTH) tokens.add(token);
  }
  if (domain) {
    const host = domain
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .split("/")[0];
    const labels = host.split(".").filter(Boolean);
    // The longest non-TLD label is the stem. Crude against multi-part TLDs
    // ("acme.co.uk"), but length wins there too — "acme" beats "co" — and a
    // wrong short label is dropped by the 3-char floor anyway.
    let stem = "";
    for (const label of labels.slice(0, -1)) {
      if (label.length >= stem.length) stem = label;
    }
    if (stem.length >= MIN_BRAND_TOKEN_LENGTH) tokens.add(stem);
  }
  return [...tokens];
}

/** Substring match, not word match: brand queries concatenate ("acmeapp
 *  login", "acmehq") more often than they space out. */
export function isBrandQuery(query: string, tokens: string[]): boolean {
  const q = query.toLowerCase();
  return tokens.some((token) => q.includes(token));
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/**
 * Roll daily (page, query) rows up to one aggregate per pair. Positions are
 * impressions-weighted — Σ(pos×impr)/Σimpr — because an unweighted mean lets
 * a one-impression position-90 day drag the average off a cliff. Sentinel
 * remainder rows (the below-cap long tail the sync folds into one row per
 * day) are excluded: they have no page or query identity to propose against.
 */
export function aggregatePageQueryWindows(
  rows: PageQueryDayRow[],
  sentinel: string,
): PageQueryAggregate[] {
  type PairSums = Omit<PageQueryAggregate, "weightedPosition"> & {
    positionImpressions: number;
  };
  const sums = new Map<string, PairSums>();
  for (const row of rows) {
    if (row.pageUrl === sentinel || row.query === sentinel) continue;
    const key = `${row.pageUrl}\u0000${row.query}`;
    const acc = sums.get(key) ?? {
      pageUrl: row.pageUrl,
      query: row.query,
      clicks: 0,
      impressions: 0,
      positionImpressions: 0,
    };
    acc.clicks += row.clicks;
    acc.impressions += row.impressions;
    acc.positionImpressions += row.position * row.impressions;
    sums.set(key, acc);
  }
  const aggregates: PageQueryAggregate[] = [];
  for (const { positionImpressions, ...pair } of sums.values()) {
    // Zero-impression pairs have no position or CTR to reason about.
    if (pair.impressions <= 0) continue;
    aggregates.push({
      ...pair,
      weightedPosition: positionImpressions / pair.impressions,
    });
  }
  return aggregates;
}

/** Expected CTR at a weighted position, or null past position 20 — beyond
 *  page two, CTR is noise and no deficit is meaningful. Fractional positions
 *  round to the nearest band (20.4 is still p20; 20.5 is out). */
export function expectedCtr(position: number): number | null {
  const p = Math.max(1, Math.round(position));
  for (const band of EXPECTED_CTR_BANDS) {
    if (p <= band.maxPosition) return band.ctr;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Signal 1 — RETITLE (relative CTR deficit)
// ---------------------------------------------------------------------------

type RetitleHit = {
  agg: PageQueryAggregate;
  expected: number;
  actual: number;
};

/**
 * One candidate per page: every qualifying (page, query) contributes
 * recovered clicks — impressions × (expected − actual) — and the sums add
 * because a single title serves every query the page ranks for. The
 * highest-impression qualifying query is the headline evidence.
 */
export function computeRetitleCandidates(
  input: SuppressionInput & {
    aggregates: PageQueryAggregate[];
    pagesByUrl: Map<string, SignalPageMeta>;
    brandTokens: string[];
  },
): SignalCandidate[] {
  const suppressed = suppressedTargets(input, "retitle");

  const hitsByPage = new Map<string, RetitleHit[]>();
  for (const agg of input.aggregates) {
    if (!input.pagesByUrl.has(agg.pageUrl)) continue;
    if (isBrandQuery(agg.query, input.brandTokens)) continue;
    if (agg.impressions < RETITLE_MIN_IMPRESSIONS) continue;
    const expected = expectedCtr(agg.weightedPosition);
    if (expected === null) continue;
    const actual = agg.clicks / agg.impressions;
    if (actual > RETITLE_DEFICIT_RATIO * expected) continue;
    const hits = hitsByPage.get(agg.pageUrl) ?? [];
    hits.push({ agg, expected, actual });
    hitsByPage.set(agg.pageUrl, hits);
  }

  const candidates: SignalCandidate[] = [];
  for (const [pageUrl, hits] of hitsByPage) {
    const page = input.pagesByUrl.get(pageUrl);
    if (!page || suppressed.has(page.path)) continue;
    const sorted = hits.toSorted(
      (a, b) => b.agg.impressions - a.agg.impressions,
    );
    const head = sorted[0];
    const recovered = round3(
      sorted.reduce(
        (sum, hit) => sum + hit.agg.impressions * (hit.expected - hit.actual),
        0,
      ),
    );
    const rest = sorted.slice(1);
    const listed = rest.slice(0, RETITLE_MAX_EVIDENCE_QUERIES);
    const overflow = rest.length - listed.length;
    candidates.push({
      type: "retitle",
      target: page.path,
      contentPageId: page.id,
      title: `Rewrite the title for "${head.agg.query}"`,
      score: recovered,
      factors: [
        {
          name: "Expected CTR",
          value: fmtPct(head.expected),
          note: `band curve at position ${head.agg.weightedPosition.toFixed(1)}`,
        },
        {
          name: "Actual CTR",
          value: fmtPct(head.actual),
          note: `${fmtInt(head.agg.clicks)} clicks / ${fmtInt(head.agg.impressions)} impressions over 28 days`,
        },
        {
          name: "Recovered clicks",
          value: recovered,
          note:
            sorted.length > 1
              ? `impressions × CTR deficit, summed over ${sorted.length} qualifying queries`
              : "impressions × CTR deficit",
        },
      ],
      evidence: [
        `"${head.agg.query}" · pos ${head.agg.weightedPosition.toFixed(1)} · ${fmtInt(head.agg.impressions)} impr · ${fmtPct(head.actual)} vs ${fmtPct(head.expected)} expected`,
        ...listed.map(
          (hit) =>
            `"${hit.agg.query}" · ${fmtPct(hit.actual)} vs ${fmtPct(hit.expected)}`,
        ),
        ...(overflow > 0 ? [`+${overflow} more below expected`] : []),
      ],
    });
  }
  return candidates;
}

// ---------------------------------------------------------------------------
// Signal 2 — PUSH (striking distance)
// ---------------------------------------------------------------------------

/** The inverted-U proximity multiplier: 1.5× at the peak, 1.0× at both band
 *  edges, linear in between (the below-peak slope is steeper because that
 *  side of the band is narrower). */
export function pushProximity(position: number): number {
  const span =
    position < PUSH_PEAK_POSITION
      ? PUSH_PEAK_POSITION - PUSH_MIN_POSITION
      : PUSH_MAX_POSITION - PUSH_PEAK_POSITION;
  const distance = Math.abs(position - PUSH_PEAK_POSITION);
  return 1 + PUSH_PEAK_BONUS * Math.max(0, 1 - distance / span);
}

/**
 * One candidate per (page, query) in the striking-distance band. Score is the
 * engine base — search volume imputed from 28-day impressions (four weeks ≈ a
 * month of demand), difficulty unknown — times the proximity multiplier.
 * Several queries on one page can qualify; the caller's score-ordered insert
 * plus the one-active-per-target unique keeps the strongest.
 */
export function computePushCandidates(
  input: SuppressionInput & {
    aggregates: PageQueryAggregate[];
    pagesByUrl: Map<string, SignalPageMeta>;
    brandTokens: string[];
  },
): SignalCandidate[] {
  const suppressed = suppressedTargets(input, "push");
  const candidates: SignalCandidate[] = [];
  for (const agg of input.aggregates) {
    const page = input.pagesByUrl.get(agg.pageUrl);
    if (!page) continue;
    if (suppressed.has(page.path)) continue;
    if (isBrandQuery(agg.query, input.brandTokens)) continue;
    if (agg.impressions < PUSH_MIN_IMPRESSIONS) continue;
    if (
      agg.weightedPosition < PUSH_MIN_POSITION ||
      agg.weightedPosition > PUSH_MAX_POSITION
    ) {
      continue;
    }
    const base = score(agg.impressions, null, null);
    const proximity = pushProximity(agg.weightedPosition);
    candidates.push({
      type: "push",
      target: page.path,
      contentPageId: page.id,
      title: `Push "${agg.query}" from position ${agg.weightedPosition.toFixed(1)}`,
      score: round3(base * proximity),
      factors: [
        {
          name: "Base score",
          value: base,
          note: `engine score, volume imputed from ${fmtInt(agg.impressions)} impressions over 28 days`,
        },
        {
          name: "Proximity",
          value: round3(proximity),
          note: `inverted-U peaking at position ${PUSH_PEAK_POSITION}`,
        },
        {
          name: "Weighted position",
          value: round3(agg.weightedPosition),
          note: "impressions-weighted over the 28-day window",
        },
      ],
      evidence: [
        `pos ${agg.weightedPosition.toFixed(1)}`,
        `${fmtInt(agg.impressions)} impr`,
        `"${agg.query}"`,
      ],
    });
  }
  return candidates;
}

// ---------------------------------------------------------------------------
// Signal 3 — REFRESH (decay, guarded)
// ---------------------------------------------------------------------------

/** Max clicks in any 7-day bucket counted back from the window end, across
 *  the whole stored series — the "former glory" a refresh restores. */
function peakWeeklyClicks(
  days: Array<{ date: string; clicks: number }>,
  windowEnd: string,
): number {
  const weeks = new Map<number, number>();
  for (const day of days) {
    const bucket = Math.floor(daysBetween(day.date, windowEnd) / 7);
    weeks.set(bucket, (weeks.get(bucket) ?? 0) + day.clicks);
  }
  let peak = 0;
  for (const clicks of weeks.values()) peak = Math.max(peak, clicks);
  return peak;
}

/**
 * One candidate per decayed page, scored in lost clicks (prior-28d minus
 * trailing-28d). Every guard suppresses rather than fires: thin memory, a
 * young page, a never-performing page, or a clicks-only decline all mean the
 * decay can't be trusted — this signal produces zero until memory ages, and
 * that is correct behavior, not a bug.
 */
export function computeRefreshCandidates(
  input: SuppressionInput & {
    pageDays: PageDayRow[];
    pagesByUrl: Map<string, SignalPageMeta>;
    earliestStoredDate: string | null;
    windowEnd: string;
    sentinel: string;
  },
): SignalCandidate[] {
  const trailingStart = shiftDate(input.windowEnd, -(SIGNAL_WINDOW_DAYS - 1));
  const priorStart = shiftDate(input.windowEnd, -(REFRESH_MIN_MEMORY_DAYS - 1));
  // Memory guard: stored data must reach back through the whole prior window,
  // or the comparison would read the backfill's start date as a traffic cliff.
  if (
    input.earliestStoredDate === null ||
    input.earliestStoredDate > priorStart
  ) {
    return [];
  }

  const byPage = new Map<string, PageDayRow[]>();
  for (const row of input.pageDays) {
    if (row.pageUrl === input.sentinel) continue;
    const days = byPage.get(row.pageUrl) ?? [];
    days.push(row);
    byPage.set(row.pageUrl, days);
  }

  const suppressed = suppressedTargets(input, "refresh");
  const candidates: SignalCandidate[] = [];
  for (const [pageUrl, days] of byPage) {
    const page = input.pagesByUrl.get(pageUrl);
    if (!page) continue;
    if (suppressed.has(page.path)) continue;
    // Age guard — an unknown publish date can't prove maturity, so it
    // suppresses too.
    if (
      page.publishedAt === null ||
      daysBetween(page.publishedAt.slice(0, 10), input.windowEnd) <
        REFRESH_MIN_PAGE_AGE_DAYS
    ) {
      continue;
    }
    const peak = peakWeeklyClicks(days, input.windowEnd);
    if (peak < REFRESH_MIN_PEAK_WEEK_CLICKS) continue;

    let trailingClicks = 0;
    let trailingImpressions = 0;
    let priorClicks = 0;
    let priorImpressions = 0;
    for (const day of days) {
      if (day.date >= trailingStart) {
        trailingClicks += day.clicks;
        trailingImpressions += day.impressions;
      } else if (day.date >= priorStart) {
        priorClicks += day.clicks;
        priorImpressions += day.impressions;
      }
    }
    // A page that earned nothing last window has nothing to refresh back to.
    if (priorClicks <= 0) continue;
    if (trailingClicks > REFRESH_CLICKS_RATIO * priorClicks) continue;
    // Demand loss, not CTR loss: impressions must have declined too.
    if (trailingImpressions >= priorImpressions) continue;

    const lost = round3(priorClicks - trailingClicks);
    const dropPct = Math.round((1 - trailingClicks / priorClicks) * 100);
    candidates.push({
      type: "refresh",
      target: page.path,
      contentPageId: page.id,
      title: `Refresh — clicks down ${dropPct}% against the prior 28 days`,
      score: lost,
      factors: [
        {
          name: "Trailing 28d clicks",
          value: trailingClicks,
          note: `down from ${fmtInt(priorClicks)} in the prior window; fires at ≤${fmtPct(REFRESH_CLICKS_RATIO)}`,
        },
        {
          name: "Impressions",
          value: trailingImpressions,
          note: `down from ${fmtInt(priorImpressions)} — demand loss, not CTR loss`,
        },
        {
          name: "Peak week",
          value: peak,
          note: `${REFRESH_MIN_PEAK_WEEK_CLICKS}+ weekly clicks proves the page once earned traffic`,
        },
      ],
      evidence: [
        `clicks ${fmtInt(priorClicks)} → ${fmtInt(trailingClicks)}`,
        `impressions ${fmtInt(priorImpressions)} → ${fmtInt(trailingImpressions)}`,
        `peak week ${fmtInt(peak)} clicks`,
      ],
    });
  }
  return candidates;
}
