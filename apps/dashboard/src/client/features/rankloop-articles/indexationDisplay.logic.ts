import { parseDbTimestamp } from "@/client/features/dashboard/cardParts";

// Everything the indexation surfaces say, in one pure module: the dashboard
// card's rate and stamp, the chip that appears when the throttle is holding
// the engine back, and the one-line verdict an article carries on its own
// detail screen.
//
// Structural inputs rather than server types, the same way netNewDisplay and
// proposalDisplay take them — this layer states facts in English and has no
// business knowing which repository produced them.

// ---------------------------------------------------------------------------
// The rate
// ---------------------------------------------------------------------------

type IndexationSummary = {
  /** 0–1, or null when the cohort is too small to conclude anything. */
  rate: number | null;
  indexed: number;
  /** Posts published inside the window that have been checked at all. */
  cohort: number;
  /** Below this many posts the rate is null rather than flattering. */
  minimumCohort: number;
};

/**
 * The Stat's value. Null renders the dashboard's em dash rather than 100%,
 * which is the whole point of the cohort minimum: a site that has published
 * twice and had both indexed has not proved anything, and a green 100% would
 * be the engine congratulating itself on two data points.
 */
export function indexationRateLabel(rate: number | null): string {
  if (rate === null) return "—";
  return `${Math.round(rate * 100)}%`;
}

/**
 * The provenance stamp: which posts the rate is about, and how often it moves.
 *
 * The window is in the sentence because it is the arithmetic — 7 days is long
 * enough for Google to have decided, 45 short enough that the number describes
 * what rankloop is publishing now rather than what it published in spring
 * (spec 0022).
 */
export function indexationStamp(summary: IndexationSummary): string {
  const posts = summary.cohort === 1 ? "post" : "posts";
  return `${summary.indexed.toLocaleString()} of ${summary.cohort.toLocaleString()} ${posts} published 7–45 days ago are indexed · checked daily`;
}

/** What the card says instead of a number, when there is honestly no number
 *  to give. Both cases are ordinary states of a young site, so neither reads
 *  as a problem. */
export function indexationUnknownCopy(input: {
  connected: boolean;
  minimumCohort: number;
}): string {
  if (!input.connected) {
    return "Search Console isn't connected, so nothing has been checked yet.";
  }
  return `not enough published posts yet to judge — needs ${input.minimumCohort}`;
}

// ---------------------------------------------------------------------------
// The throttle
// ---------------------------------------------------------------------------

/** What the app-level cap did to today's quota, and why, as the server
 *  computed it. `cap` is the ceiling that was applied; `reason` is the whole
 *  sentence, so the header can state it without reassembling it. */
type IndexationThrottle = { cap: number; reason: string };

/**
 * The chip on the card. Amber is a hold and rose is a stop — the two are
 * genuinely different decisions, and colouring them the same would make the
 * one that matters look routine.
 *
 * Derived from `cap` rather than by reading the reason string, because the
 * reason is prose that will get reworded and the cap is the number the run
 * actually obeyed.
 */
export function indexationThrottleChip(
  throttle: IndexationThrottle | null,
): { label: string; color: "amber" | "rose" } | null {
  if (!throttle) return null;
  if (throttle.cap === 0) {
    return { label: "net-new paused", color: "rose" };
  }
  return { label: `quota held at ${throttle.cap}`, color: "amber" };
}

// ---------------------------------------------------------------------------
// One URL's verdict
// ---------------------------------------------------------------------------

type IndexationCheck = {
  /** GSC's own verdict: PASS, PARTIAL, FAIL, NEUTRAL. */
  verdict: string;
  coverageState: string | null;
  checkedAt: string;
};

/**
 * Google's coverage states, said the way a person would say them.
 *
 * Only the states an operator can act on get a phrase; anything else falls
 * back to Google's own wording, because inventing a friendlier label for a
 * state we don't recognise is how a UI ends up lying about somebody's page.
 */
const COVERAGE_PHRASES: Record<string, string> = {
  "Submitted and indexed": "indexed",
  "Indexed, not submitted in sitemap": "indexed, but not in your sitemap",
  "Crawled - currently not indexed": "crawled, not indexed",
  "Discovered - currently not indexed": "discovered, not crawled yet",
  "URL is unknown to Google": "Google hasn't seen it yet",
  "Page with redirect": "redirects somewhere else",
  "Duplicate without user-selected canonical": "treated as a duplicate",
  "Blocked by robots.txt": "blocked by robots.txt",
};

const MS_PER_DAY = 86_400_000;

/** "checked yesterday" beats "checked 1 day ago", and both beat a timestamp
 *  nobody subtracts in their head. Same-day reads as today rather than "0
 *  days ago". */
function checkedAgo(checkedAt: string, now: number): string {
  const ms = parseDbTimestamp(checkedAt);
  if (Number.isNaN(ms)) return "checked recently";
  const days = Math.floor((now - ms) / MS_PER_DAY);
  if (days <= 0) return "checked today";
  if (days === 1) return "checked yesterday";
  return `checked ${days} days ago`;
}

/**
 * The line under a published article's URL.
 *
 * A page that Google crawled and declined is the single most useful thing this
 * product can tell someone, and it belongs where they are already looking —
 * on the article — not only in an aggregate on the dashboard.
 */
export function indexationVerdictLine(
  check: IndexationCheck,
  now: number = Date.now(),
): string {
  const state =
    check.verdict === "PASS"
      ? "indexed"
      : check.coverageState === null
        ? "not indexed"
        : (COVERAGE_PHRASES[check.coverageState] ?? check.coverageState);
  return `${state} · ${checkedAgo(check.checkedAt, now)}`;
}

/** True when the verdict is worth reading in the error tone: the page is live
 *  and Google is not showing it. */
export function isIndexationFailure(check: IndexationCheck): boolean {
  return check.verdict !== "PASS";
}
