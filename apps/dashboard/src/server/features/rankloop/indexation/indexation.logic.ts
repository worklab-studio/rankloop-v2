// Pure functions behind the indexation throttle (spec 0022): which published
// posts form the cohort, what share of them Google actually indexed, and how
// hard that answer clamps the day's net-new quota. No I/O and no Date.now() —
// the caller injects `today`, which is what lets the tests walk one cohort
// across both of its edges. Unit-tested directly in indexation.logic.test.ts.
//
// The rule this file encodes: publishing into "Crawled — currently not
// indexed" is the most reliable way to earn a sitewide quality demotion, so an
// engine that cannot see it happening will keep digging. Below 65% the quota
// is held at one post a day; below 40% net-new stops entirely.

import {
  isoDay,
  shiftDate,
} from "@/server/features/rankloop/receipts/receipts.logic";

// ---------------------------------------------------------------------------
// The cohort
// ---------------------------------------------------------------------------

/** Old enough that Google has had its say. Inspecting a three-day-old post
 *  measures crawl latency, not indexation, and would read as a failure. */
export const INDEXATION_MIN_AGE_DAYS = 7;

/** Young enough to describe what the engine is doing now. A post from four
 *  months ago is a verdict on a strategy that may already have been changed. */
export const INDEXATION_MAX_AGE_DAYS = 45;

/** Below this many checked posts the rate is null, not a number. Two posts
 *  indexed out of two is not "100% indexed" — it is no evidence at all, and a
 *  throttle that acts on it would be acting on noise. */
export const INDEXATION_MIN_COHORT = 5;

/** At or above this share, the engine runs at its own pace. */
const HEALTHY_RATE = 0.65;

/** Below this share, net-new stops rather than slows. */
const PAUSE_RATE = 0.4;

/** URL Inspection's verdict for "this URL is in the index". Everything else —
 *  FAIL, NEUTRAL, PARTIAL — is a page Google saw and did not index. */
const INDEXED_VERDICT = "PASS";

/** One published post, as the cohort sees it. */
export type CohortPage = {
  url: string;
  /** Either a bare YYYY-MM-DD or a full ISO stamp; content_pages holds both. */
  publishedAt: string;
};

/** One stored indexation_checks row. */
export type UrlCheck = {
  url: string;
  verdict: string;
  checkedAt: string;
};

/** What the dashboard card and the throttle both read. */
type IndexationRate = {
  /** 0–1, or null when the cohort is too small to conclude anything. */
  rate: number | null;
  indexed: number;
  /** Cohort posts that have been checked — the rate's denominator. */
  cohort: number;
};

/**
 * The share of the 7–45 day cohort Google has indexed, from the latest check
 * per URL.
 *
 * The denominator is checked posts, not published ones. The daily job covers
 * 20 URLs per project, so a site with 80 recent posts takes four days to sweep
 * its cohort once — counting the unswept ones as "not indexed" would invent a
 * collapse on the morning the feature turns on and pause an engine that is
 * doing fine. A post nobody has asked about is not a post Google rejected.
 */
export function computeIndexationRate(input: {
  pages: CohortPage[];
  checks: UrlCheck[];
  /** YYYY-MM-DD. */
  today: string;
}): IndexationRate {
  const oldest = shiftDate(input.today, -INDEXATION_MAX_AGE_DAYS);
  const newest = shiftDate(input.today, -INDEXATION_MIN_AGE_DAYS);
  const cohortUrls = new Set(
    input.pages
      .filter((page) => {
        const day = isoDay(page.publishedAt);
        return day >= oldest && day <= newest;
      })
      .map((page) => page.url),
  );

  // Latest wins: a URL checked weekly for six weeks has six rows, and only the
  // most recent one describes the page as it stands. An average over the
  // history would keep a page that has since been indexed pinned to its worst
  // week.
  const latest = new Map<string, UrlCheck>();
  for (const check of input.checks) {
    if (!cohortUrls.has(check.url)) continue;
    const held = latest.get(check.url);
    if (held === undefined || check.checkedAt > held.checkedAt) {
      latest.set(check.url, check);
    }
  }

  const cohort = latest.size;
  let indexed = 0;
  for (const check of latest.values()) {
    if (check.verdict === INDEXED_VERDICT) indexed += 1;
  }
  return {
    rate:
      cohort >= INDEXATION_MIN_COHORT
        ? Math.round((indexed / cohort) * 10000) / 10000
        : null,
    indexed,
    cohort,
  };
}

// ---------------------------------------------------------------------------
// The throttle
// ---------------------------------------------------------------------------

/** The app-level ceiling over whatever the engine's quota arithmetic returned.
 *  Absent (null) rather than an infinite cap: this value crosses a
 *  server-function boundary, JSON has no Infinity, and "no throttle" is a
 *  state the UI already renders by rendering nothing. */
export type IndexationThrottle = {
  /** Posts net-new may propose today — 1 or 0 today, and the number the chip
   *  reads rather than parsing it back out of the sentence. */
  cap: number;
  /** The line the Articles header and the run row print verbatim. */
  reason: string;
};

/** Floored, not rounded: 64.6% rounds to "65%", and printing the exact number
 *  the rule says should NOT throttle next to a throttle that is running is how
 *  a user decides the feature is broken. */
function pct(rate: number): number {
  return Math.floor(rate * 100);
}

/**
 * Turn the rate into today's ceiling.
 *
 * An unknown rate never throttles. The alternative — treating "we don't know"
 * as "it's bad" — would stop every new site's engine on its first day, which
 * is exactly when it has nothing published to judge and the most to gain from
 * publishing.
 */
export function indexationThrottle(
  rate: IndexationRate,
): IndexationThrottle | null {
  if (rate.rate === null || rate.rate >= HEALTHY_RATE) return null;
  if (rate.rate >= PAUSE_RATE) {
    return {
      cap: 1,
      reason: `quota held at 1 — ${pct(rate.rate)}% of recent posts are indexed`,
    };
  }
  return {
    cap: 0,
    reason: `net-new paused — ${pct(rate.rate)}% of recent posts are indexed`,
  };
}
