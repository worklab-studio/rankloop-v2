// Pure functions behind execution receipts (spec 0013): baseline-window
// resolution, evaluation-window math, metric assembly, the trend adjustment,
// contamination detection, and the data-lag guard. No I/O and no Date.now() —
// callers inject the clock, which is what lets the service tests time-travel
// one receipt through its whole six-week life. Unit-tested directly in
// receipts.logic.test.ts.

import type {
  ReceiptBaseline,
  ReceiptMetrics,
} from "@/types/schemas/rankloopReceipts";

// ---------------------------------------------------------------------------
// Window constants
// ---------------------------------------------------------------------------

/** Four whole weeks, matching the optimize signals' window — weekday/weekend
 *  traffic shape cancels out of the before/after comparison. */
const BASELINE_WINDOW_DAYS = 28;

/** The evaluation window opens 14 days after execution: Google needs to
 *  recrawl the page and searchers need to see the new snippet, so days 0–13
 *  mostly measure the old state and would dilute any real effect. */
const MEASUREMENT_OPEN_AFTER_DAYS = 14;

/**
 * ...and closes at day 42. windowEnd is exclusive: days +14 through +41 are
 * the 28 measured days, the same width as the baseline — an inclusive end
 * would silently compare 29 days against 28 and bias every delta positive.
 */
const MEASUREMENT_CLOSE_AFTER_DAYS = 42;

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

/** Calendar-day arithmetic on YYYY-MM-DD strings. Local twin of
 *  GscSyncService.addDays so this module stays importable without the
 *  cloudflare:workers shim that service drags in. */
export function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The calendar day of an ISO instant (its date part, no zone math — GSC
 *  dates and receipt windows all live on the same UTC day strings). */
export function isoDay(iso: string): string {
  return iso.slice(0, 10);
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

// ---------------------------------------------------------------------------
// Window math
// ---------------------------------------------------------------------------

/**
 * The 28 stored days a baseline reads, ending at the memory watermark rather
 * than at execution: GSC finalizes ~4 days late, so the days just before
 * execution have no stored rows yet — ending there would undercount the
 * baseline by roughly 4/28 and flatter every action that follows. With no
 * watermark at all the day before execution stands in, and the zeros that
 * result are the honest baseline of a project with no memory.
 */
export function resolveBaselineWindow(
  executedAt: string,
  latestStoredDate: string | null,
): { start: string; end: string } {
  const dayBeforeExecution = shiftDate(isoDay(executedAt), -1);
  const end =
    latestStoredDate !== null && latestStoredDate < dayBeforeExecution
      ? latestStoredDate
      : dayBeforeExecution;
  return { start: shiftDate(end, -(BASELINE_WINDOW_DAYS - 1)), end };
}

/** The stored windowStart/windowEnd pair: execution +14d and +42d. */
export function evaluationWindow(executedAt: string): {
  windowStart: string;
  windowEnd: string;
} {
  const executedDay = isoDay(executedAt);
  return {
    windowStart: shiftDate(executedDay, MEASUREMENT_OPEN_AFTER_DAYS),
    windowEnd: shiftDate(executedDay, MEASUREMENT_CLOSE_AFTER_DAYS),
  };
}

/** The inclusive day span a measurement actually reads: windowStart through
 *  the day before the (exclusive) windowEnd — 28 days. */
export function measuredWindow(
  windowStart: string,
  windowEnd: string,
): { start: string; end: string } {
  return { start: windowStart, end: shiftDate(windowEnd, -1) };
}

// ---------------------------------------------------------------------------
// Metric assembly
// ---------------------------------------------------------------------------

/** One day-grain gsc_performance row for the receipt's page (any query). */
export type MetricDayRow = {
  clicks: number;
  impressions: number;
  position: number;
};

type SiteWindowTotals = { clicks: number; impressions: number };

/**
 * Roll a window's page rows into one metrics block. Position is
 * impressions-weighted — Σ(pos×impr)/Σimpr — because an unweighted mean lets
 * a one-impression position-90 day drag the average off a cliff; CTR is
 * recomputed from the summed counts, not averaged from daily ratios.
 */
export function assembleWindowMetrics(
  pageRows: MetricDayRow[],
  site: SiteWindowTotals,
): ReceiptMetrics {
  let clicks = 0;
  let impressions = 0;
  let positionImpressions = 0;
  for (const row of pageRows) {
    clicks += row.clicks;
    impressions += row.impressions;
    positionImpressions += row.position * row.impressions;
  }
  return {
    impressions,
    clicks,
    ctr: impressions > 0 ? round4(clicks / impressions) : 0,
    weightedPosition:
      impressions > 0 ? round2(positionImpressions / impressions) : null,
    siteImpressions: site.impressions,
    siteClicks: site.clicks,
  };
}

// ---------------------------------------------------------------------------
// Trend adjustment
// ---------------------------------------------------------------------------

type TrendAdjustment = {
  clicksDelta: number;
  siteClicksDeltaRatio: number | null;
  adjustedClicksDelta: number;
};

/**
 * Page delta minus the site-wide drift: if the whole site's clicks moved by
 * some ratio between the two windows, the page was expected to move by that
 * ratio too, and only the remainder is credited to the action. A site-wide
 * +20% window with the page up 20% nets to zero — correctly, because that
 * page would have risen without anyone touching it. A zero-click site
 * baseline has no ratio to speak of, so the raw delta stands unadjusted.
 */
export function trendAdjust(
  baseline: ReceiptBaseline,
  result: ReceiptMetrics,
): TrendAdjustment {
  const clicksDelta = result.clicks - baseline.clicks;
  const siteClicksDeltaRatio =
    baseline.siteClicks > 0
      ? round4((result.siteClicks - baseline.siteClicks) / baseline.siteClicks)
      : null;
  const expectedDrift = baseline.clicks * (siteClicksDeltaRatio ?? 0);
  return {
    clicksDelta,
    siteClicksDeltaRatio,
    adjustedClicksDelta: round2(clicksDelta - expectedDrift),
  };
}

// ---------------------------------------------------------------------------
// Contamination
// ---------------------------------------------------------------------------

/** An executed proposal, as the contamination check sees it. */
type ExecutedAction = {
  contentPageId: string | null;
  executedAt: string;
};

/**
 * Another action on the same page before the window closed means the window
 * measured two changes at once and the numbers would lie about either. The
 * comparison is strict on both edges: the receipt's own execution shares its
 * createdAt instant (the execution flow writes both in one transaction), so
 * `>` excludes it, and an action ON the windowEnd day can't touch any of the
 * measured days (which end the day before).
 */
export function isContaminated(
  receipt: {
    contentPageId: string | null;
    createdAt: string;
    windowEnd: string;
  },
  actions: ExecutedAction[],
): boolean {
  if (receipt.contentPageId === null) return false;
  return actions.some(
    (action) =>
      action.contentPageId === receipt.contentPageId &&
      action.executedAt > receipt.createdAt &&
      isoDay(action.executedAt) < receipt.windowEnd,
  );
}

// ---------------------------------------------------------------------------
// The due-check
// ---------------------------------------------------------------------------

type MeasurementStep = "none" | "start_measuring" | "wait_for_data" | "measure";

/**
 * What the measurement pass should do with one receipt right now. The
 * data-lag guard lives here: a closed window whose last days the sync hasn't
 * stored yet must wait — measuring early would freeze a partial window into
 * resultJson forever. Requiring the watermark to reach windowEnd itself (one
 * day past the last measured day) also guarantees that day is final, since
 * the sync only advances the watermark over finalized dates. In practice GSC
 * lag lands measurement around day 46, not day 42.
 */
export function decideMeasurementStep(input: {
  status: "baseline" | "measuring";
  windowStart: string;
  windowEnd: string;
  latestStoredDate: string | null;
  /** YYYY-MM-DD from the injected clock. */
  today: string;
}): MeasurementStep {
  if (input.today >= input.windowEnd) {
    return input.latestStoredDate !== null &&
      input.latestStoredDate >= input.windowEnd
      ? "measure"
      : "wait_for_data";
  }
  if (input.status === "baseline" && input.today >= input.windowStart) {
    return "start_measuring";
  }
  return "none";
}
