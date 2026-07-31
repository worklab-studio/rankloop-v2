// The adaptive difficulty ceiling (spec 0016): how hard a keyword this
// project has earned the right to chase, computed from what it already ranks
// for. Pure — no I/O, unit-tested directly in kdCeiling.logic.test.ts.
//
// S5 is the first step where this number can exist at all, because it needs
// the site's own top-10 rankings joined to upstream difficulty. Everything
// downstream reads it: the page plan's caution rule, and eventually the
// selection order. It is stored on project_gate.kd_ceiling.

import { isBrandQuery } from "@/server/features/rankloop/proposals/signals.logic";

/**
 * The no-samples ceiling, and the value project_gate.kd_ceiling defaults to.
 *
 * KD 20 is roughly "a page with a real answer and no links can rank" — the
 * only honest assumption about a site that has not proven anything yet.
 */
export const FIXED_KD_CEILING = 20;

/** Below ten samples a p75 is one lucky ranking away from anything. Ten is
 *  few enough that a young site reaches it in a month and many enough that no
 *  single keyword owns the quartile. */
const MIN_SAMPLES = 10;

/** How far past the proven p75 the ceiling reaches. A site ranking top-10 for
 *  a KD-30 keyword can plainly survive KD 40; the headroom is what keeps the
 *  ceiling from freezing a project at exactly what it has already done. */
const CEILING_HEADROOM = 10;

/** Most a single computation may move the ceiling, in either direction. One
 *  sync must never reprice the whole backlog: a ceiling that jumped 30 points
 *  would silently admit a year of work nobody chose, and one that fell 30
 *  would orphan the rows admitted last week. */
const MAX_CEILING_MOVE = 5;

/** One query the project already ranks top-10 for, with whatever difficulty
 *  upstream has priced it at. A null KD is the normal state of a keyword
 *  nobody has paid to measure. */
type KdCeilingSample = {
  keyword: string;
  keywordDifficulty: number | null;
};

export type KdCeilingResult = {
  ceiling: number;
  /** Non-brand samples that carried a difficulty — the number the gate card's
   *  stamp quotes ("earned from 14 keywords you already rank top-10 for"). */
  sampleCount: number;
  /** False on the fixed branch: the ceiling is the starting floor, not
   *  something this project has earned. The card says which, and
   *  kd_ceiling_updated_at stays null. */
  earned: boolean;
};

/**
 * Compute the ceiling from the queries the project ranks top-10 for.
 *
 * Brand queries are excluded first: a site ranks #1 for its own name at
 * whatever difficulty the vendor assigned it, and letting that into the
 * quartile would price the ceiling off a ranking the site did not have to
 * earn. Samples with no difficulty are excluded too — an unknown KD is not an
 * average one, the same rule computeKdBand follows.
 *
 * Then three branches. Under ten usable samples the answer is the fixed
 * floor, unclamped, because it is not a measurement at all: it is the
 * admission that there isn't one. Otherwise the target is p75 + 10, and the
 * move from the stored previous value is capped at 5.
 */
export function computeKdCeiling(input: {
  rankedTop10WithKd: KdCeilingSample[];
  brandTokens: string[];
  /** project_gate.kd_ceiling as it stands — the clamp's anchor. */
  previousCeiling: number;
}): KdCeilingResult {
  const difficulties = input.rankedTop10WithKd
    .filter(
      (sample) =>
        sample.keywordDifficulty !== null &&
        !isBrandQuery(sample.keyword, input.brandTokens),
    )
    .map((sample) => sample.keywordDifficulty ?? 0)
    .toSorted((a, b) => a - b);

  if (difficulties.length < MIN_SAMPLES) {
    return {
      ceiling: FIXED_KD_CEILING,
      sampleCount: difficulties.length,
      earned: false,
    };
  }

  const target = percentile(difficulties, 0.75) + CEILING_HEADROOM;
  return {
    ceiling: clampMove(target, input.previousCeiling),
    sampleCount: difficulties.length,
    earned: true,
  };
}

/**
 * Does this keyword's difficulty sit inside the ceiling?
 *
 * A null KD always passes. This is the min_volume=0 doctrine's sibling: the
 * free sources produce rows nobody has priced, and treating unpriced as too
 * hard would delete exactly the long tail a young site wins on. The ceiling
 * exists to hold back keywords measured as too hard, not keywords nobody
 * measured.
 */
export function passesKdCeiling(
  keywordDifficulty: number | null,
  ceiling: number,
): boolean {
  return keywordDifficulty === null || keywordDifficulty <= ceiling;
}

/** Nearest-rank on a 0-based index, matching planner.logic's computeKdBand so
 *  the plan's band and this ceiling are quoted off the same arithmetic. KD is
 *  an integer estimate; interpolating between 34 and 41 to report 37.5 would
 *  dress a vendor's guess up as a measurement. */
function percentile(sorted: number[], fraction: number): number {
  return sorted[Math.round((sorted.length - 1) * fraction)];
}

function clampMove(target: number, previous: number): number {
  return Math.min(
    previous + MAX_CEILING_MOVE,
    Math.max(previous - MAX_CEILING_MOVE, target),
  );
}
