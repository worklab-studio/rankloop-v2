// The unserved-query flywheel (spec 0016): the free source that reads the
// project's own 28-day Search Console memory and finds the queries it earns
// impressions for while serving them by accident. Pure — no I/O, unit-tested
// directly in unserved.logic.test.ts.
//
// This is rankloop's oldest idea and the one that costs nothing: Google is
// already telling the site what it is nearly relevant for. A query the site
// shows up for at position 34 is demand it has proven exists and a page it
// has not written.

import { normalizeTokenSet } from "@/server/features/rankloop/universe/gate.logic";
import type { PageQueryAggregate } from "@/server/features/rankloop/proposals/signals.logic";

// ---------------------------------------------------------------------------
// The incidental-serving rule
// ---------------------------------------------------------------------------

/**
 * Past which position a serving page is only serving the query by accident.
 *
 * A page in the top 10 already answers the query — writing a second page for
 * it is how a site cannibalizes itself. Position 11 and beyond is Google
 * saying "you are adjacent to this", which is the whole signal.
 */
export const INCIDENTAL_POSITION = 10;

/** The 28-day impression floors, smallest site first. */
const FLOOR_NEW_SITE = 3;
const FLOOR_GROWING_SITE = 5;
const FLOOR_ESTABLISHED_SITE = 10;

/** Where the floor steps up, in 28-day impressions across the whole project. */
const GROWING_SITE_IMPRESSIONS = 1_000;
const ESTABLISHED_SITE_IMPRESSIONS = 10_000;

/**
 * The impression floor a query must clear, scaled to the project's own volume.
 *
 * Three impressions is a real signal on a site that gets two hundred and
 * noise on a site that gets a hundred thousand — an absolute floor either
 * drowns a young project in nothing or hands a big one every typo it has ever
 * been shown for. Scaling off the project's own total keeps the rule the same
 * sentence at both ends: "enough people searched this that it isn't noise
 * here".
 */
export function unservedFloor(totalImpressions28: number): number {
  if (totalImpressions28 >= ESTABLISHED_SITE_IMPRESSIONS) {
    return FLOOR_ESTABLISHED_SITE;
  }
  if (totalImpressions28 >= GROWING_SITE_IMPRESSIONS) {
    return FLOOR_GROWING_SITE;
  }
  return FLOOR_NEW_SITE;
}

// ---------------------------------------------------------------------------
// Query rollup
// ---------------------------------------------------------------------------

/** One query across every page that served it in the window. */
type QueryRollup = {
  query: string;
  impressions28: number;
  /** The best position any page reached for it — the "best-serving page"
   *  the incidental rule judges. */
  bestPosition: number;
};

/**
 * Roll (page, query) aggregates up to one row per query.
 *
 * Impressions sum because a query split across three pages is still one
 * query's worth of demand. The position is the best any page reached, not the
 * average: one page at 4 and two at 60 means the query is served, and an
 * average of 41 would call it unserved and propose a page that competes with
 * the one already ranking.
 *
 * Exported because the KD ceiling reads the same rollup from the other end —
 * queries whose best position is inside the top 10 are exactly the ones the
 * ceiling is earned from.
 */
export function rollUpQueries(aggregates: PageQueryAggregate[]): QueryRollup[] {
  const byQuery = new Map<string, QueryRollup>();
  for (const aggregate of aggregates) {
    const existing = byQuery.get(aggregate.query);
    if (!existing) {
      byQuery.set(aggregate.query, {
        query: aggregate.query,
        impressions28: aggregate.impressions,
        bestPosition: aggregate.weightedPosition,
      });
      continue;
    }
    existing.impressions28 += aggregate.impressions;
    existing.bestPosition = Math.min(
      existing.bestPosition,
      aggregate.weightedPosition,
    );
  }
  return [...byQuery.values()];
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/** Variants kept on a clustered row. A founder reads three of these to
 *  recognize the shape; a notesJson that grows without bound is a row nobody
 *  can read and a column the table has to truncate anyway. */
const MAX_STORED_VARIANTS = 10;

type UnservedCandidate = {
  /** The phrasing real searchers used most — the row's keyword. */
  keyword: string;
  /** Summed across the cluster: the demand the page would actually serve. */
  impressions28: number;
  bestPosition: number;
  /** The normalized token set the cluster formed on. Stored so a later run
   *  can recognize the same cluster without re-reading the whole window. */
  clusterKey: string;
  /** The other phrasings, most-searched first. Kept because they are the
   *  evidence for the row and the H2s the brief will want. */
  variants: string[];
};

/**
 * Find the queries this site earns impressions for and does not serve.
 *
 * Four exclusions, in the order they cost least to apply: below the project's
 * own floor, already served inside the top 10, already the primary keyword of
 * a page in the manifest, and already sitting in the backlog. The last two
 * compare normalized token sets rather than raw strings — "descale a breville"
 * and "how to descale breville" are the same page, and exact matching would
 * cheerfully add the second one next to the first every week.
 *
 * Survivors are clustered by that same token set, so the run proposes one row
 * per question instead of eleven rows per phrasing. The project's total is
 * measured off the same aggregates the candidates come from, which is what
 * makes the floor a fact about this window rather than a number from
 * somewhere else.
 */
export function selectUnservedQueries(input: {
  aggregates: PageQueryAggregate[];
  /** content_pages.keyword — what the site's pages already target. */
  servedKeywords: string[];
  /** keyword_backlog.keyword — what previous runs already admitted. */
  existingBacklogKeywords: string[];
}): UnservedCandidate[] {
  const totalImpressions28 = input.aggregates.reduce(
    (sum, aggregate) => sum + aggregate.impressions,
    0,
  );
  const floor = unservedFloor(totalImpressions28);

  const claimed = new Set(
    [...input.servedKeywords, ...input.existingBacklogKeywords]
      .map(normalizeTokenSet)
      .filter(Boolean),
  );

  const clusters = new Map<string, QueryRollup[]>();
  for (const rollup of rollUpQueries(input.aggregates)) {
    if (rollup.impressions28 < floor) continue;
    if (rollup.bestPosition <= INCIDENTAL_POSITION) continue;
    const clusterKey = normalizeTokenSet(rollup.query);
    // A query of nothing but stopwords has no token set to cluster on, and an
    // empty key would collect every one of them into a single meaningless row.
    if (clusterKey === "") continue;
    if (claimed.has(clusterKey)) continue;
    clusters.set(clusterKey, [...(clusters.get(clusterKey) ?? []), rollup]);
  }

  const candidates = [...clusters.entries()].map(([clusterKey, members]) =>
    buildCandidate(clusterKey, members),
  );
  // Biggest proven demand first; the keyword breaks ties so two runs over the
  // same window admit the same rows in the same order.
  return candidates.toSorted(
    (a, b) =>
      b.impressions28 - a.impressions28 || a.keyword.localeCompare(b.keyword),
  );
}

function buildCandidate(
  clusterKey: string,
  members: QueryRollup[],
): UnservedCandidate {
  // The most-searched phrasing represents the cluster: it is the wording real
  // people used, which is the wording the page should be about. Shorter wins
  // ties — "descale breville" is a better title than "breville descale how".
  const ranked = members.toSorted(
    (a, b) =>
      b.impressions28 - a.impressions28 ||
      a.query.length - b.query.length ||
      a.query.localeCompare(b.query),
  );
  return {
    keyword: ranked[0].query,
    impressions28: ranked.reduce(
      (sum, member) => sum + member.impressions28,
      0,
    ),
    bestPosition: Math.min(...ranked.map((member) => member.bestPosition)),
    clusterKey,
    variants: ranked.slice(1, MAX_STORED_VARIANTS + 1).map((m) => m.query),
  };
}
