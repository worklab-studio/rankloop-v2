import { describe, expect, it } from "vitest";
import {
  computeKdCeiling,
  FIXED_KD_CEILING,
  passesKdCeiling,
} from "./kdCeiling.logic";

/** n samples at one difficulty, with keywords nothing brand-like matches. */
function samples(difficulty: number | null, count: number) {
  return Array.from({ length: count }, (_, i) => ({
    keyword: `topic ${i}`,
    keywordDifficulty: difficulty,
  }));
}

describe("computeKdCeiling", () => {
  it("returns the fixed floor below ten usable samples", () => {
    const result = computeKdCeiling({
      rankedTop10WithKd: samples(60, 9),
      brandTokens: [],
      previousCeiling: FIXED_KD_CEILING,
    });

    expect(result).toEqual({ ceiling: 20, sampleCount: 9, earned: false });
  });

  it("does not clamp its way back to the floor", () => {
    // A project that lost its samples (a sync gap, a re-pull) drops to 20 in
    // one step on purpose: the fixed branch is not a measurement moving, it
    // is the admission that there is no measurement.
    const result = computeKdCeiling({
      rankedTop10WithKd: samples(60, 3),
      brandTokens: [],
      previousCeiling: 40,
    });

    expect(result.ceiling).toBe(20);
    expect(result.earned).toBe(false);
  });

  it("earns p75 + 10 once ten samples carry a difficulty", () => {
    // Five at 20 and five at 40: nearest-rank p75 is 40, so the target is 50.
    const result = computeKdCeiling({
      rankedTop10WithKd: [...samples(20, 5), ...samples(40, 5)],
      brandTokens: [],
      previousCeiling: 45,
    });

    expect(result).toEqual({ ceiling: 50, sampleCount: 10, earned: true });
  });

  it("moves at most five points up per computation", () => {
    // Same p75 + 10 target of 50, but from the starting floor: one sync must
    // never reprice the whole backlog.
    const result = computeKdCeiling({
      rankedTop10WithKd: [...samples(20, 5), ...samples(40, 5)],
      brandTokens: [],
      previousCeiling: 20,
    });

    expect(result.ceiling).toBe(25);
  });

  it("moves at most five points down per computation", () => {
    const result = computeKdCeiling({
      rankedTop10WithKd: samples(5, 12),
      brandTokens: [],
      previousCeiling: 40,
    });

    // Target is 15; a 25-point drop would orphan every row admitted last week.
    expect(result.ceiling).toBe(35);
  });

  it("ignores samples with no difficulty rather than imputing one", () => {
    const result = computeKdCeiling({
      rankedTop10WithKd: [...samples(60, 9), ...samples(null, 40)],
      brandTokens: [],
      previousCeiling: 20,
    });

    // Forty unpriced rankings do not make nine priced ones into ten.
    expect(result).toEqual({ ceiling: 20, sampleCount: 9, earned: false });
  });

  it("ignores brand rankings, which nobody had to earn", () => {
    const result = computeKdCeiling({
      rankedTop10WithKd: [
        ...samples(30, 9),
        { keyword: "acme login", keywordDifficulty: 80 },
        { keyword: "acmehq pricing", keywordDifficulty: 80 },
      ],
      brandTokens: ["acme"],
      previousCeiling: 20,
    });

    expect(result.sampleCount).toBe(9);
    expect(result.earned).toBe(false);
  });
});

describe("passesKdCeiling", () => {
  it("always passes a keyword nobody has priced", () => {
    // The min_volume=0 doctrine's sibling: the free sources produce unpriced
    // rows, and treating unpriced as too hard deletes the long tail a young
    // site actually wins.
    expect(passesKdCeiling(null, 20)).toBe(true);
  });

  it("passes a keyword sitting exactly on the ceiling", () => {
    expect(passesKdCeiling(20, 20)).toBe(true);
    expect(passesKdCeiling(21, 20)).toBe(false);
  });
});
