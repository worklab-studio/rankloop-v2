import { describe, expect, it } from "vitest";
import {
  allocateSerpBudget,
  computeKdBand,
  detectCandidates,
  effectiveVolume,
  matchPattern,
  pickSerpSampleKeywords,
  stems,
  type PlannerBacklogRow,
} from "./planner.logic";

let nextId = 0;

function row(
  keyword: string,
  overrides: Partial<PlannerBacklogRow> = {},
): PlannerBacklogRow {
  nextId += 1;
  return {
    id: `kw_${nextId}`,
    keyword,
    searchVolume: 100,
    keywordDifficulty: 20,
    impressions28: null,
    ...overrides,
  };
}

/** Four rows of one shape — the pSEO floor, so the candidate survives. */
function pseoRows(keywords: string[]): PlannerBacklogRow[] {
  return keywords.map((keyword) => row(keyword));
}

describe("matchPattern", () => {
  it.each([
    ["breville vs delonghi", "comparisons"],
    ["breville versus delonghi", "comparisons"],
    ["alternative to nespresso", "alternatives"],
    ["nespresso alternatives", "alternatives"],
    ["best espresso grinder", "best-of"],
    ["top grinders for beginners", "best-of"],
    ["how to descale a machine", "how-to"],
    ["how do i clean the group head", "how-to"],
    ["what is a pressurized basket", "glossary"],
    ["what are pid controllers", "glossary"],
    ["grinder not working", "troubleshooting"],
    ["machine won't heat up", "troubleshooting"],
    ["portafilter size guide", "specs"],
    ["basket dimensions", "specs"],
    ["espresso machine price", "pricing"],
    ["how much does a grinder cost", "pricing"],
  ])("claims %s as %s", (keyword, key) => {
    expect(matchPattern(keyword)?.key).toBe(key);
  });

  it("is case-insensitive and resolves overlaps in table order", () => {
    // Comparisons sits above best-of in the table, so a keyword that reads as
    // both is a comparison — the same precedence the URL evidence uses.
    expect(matchPattern("Best Breville VS Delonghi")?.key).toBe("comparisons");
  });

  it("leaves an ordinary topical keyword to the editorial pool", () => {
    expect(matchPattern("espresso machine descaling routine")).toBeNull();
  });
});

describe("detectCandidates", () => {
  it("proposes one candidate per pattern that clears the pSEO floor", () => {
    const candidates = detectCandidates([
      ...pseoRows([
        "breville vs delonghi",
        "gaggia vs rancilio",
        "sage vs breville",
        "delonghi vs gaggia",
      ]),
      ...pseoRows([
        "best espresso grinder",
        "best milk frother",
        "best tamper",
        "best scale",
      ]),
    ]);

    // Equal demand, so the name breaks the tie — two runs over the same
    // backlog must deal the cards in the same order.
    expect(candidates.map((candidate) => candidate.name)).toEqual([
      "Best-of lists",
      "Comparisons",
    ]);
    const comparisons = candidates[1];
    expect(comparisons.kind).toBe("pseo");
    expect(comparisons.urlPattern).toBe("/compare/{slug}/");
    expect(comparisons.instances).toHaveLength(4);
  });

  it("drops a pattern with three instances and a cluster with two", () => {
    const candidates = detectCandidates([
      ...pseoRows(["a vs b", "c vs d", "e vs f"]),
      row("espresso machine cleaning"),
      row("espresso machine descaling"),
    ]);

    expect(candidates).toEqual([]);
  });

  it("clusters unmatched rows on their shared stems and names the type after them", () => {
    const candidates = detectCandidates([
      row("espresso machine cleaning routine"),
      row("espresso machine descaling schedule"),
      row("espresso machine water filter"),
    ]);

    expect(candidates).toHaveLength(1);
    expect(candidates[0].kind).toBe("blog");
    expect(candidates[0].name).toBe("Espresso machine guides");
    expect(candidates[0].clusterTokens).toEqual(["espresso", "machine"]);
    expect(candidates[0].urlPattern).toBe("/blog/{slug}/");
  });

  it("names a cluster on one token when the second is not carried by every member", () => {
    const candidates = detectCandidates([
      row("grinder burr replacement"),
      row("grinder retention guide"),
      row("grinder calibration steps"),
    ]);

    expect(candidates[0].clusterTokens).toEqual(["grinder"]);
    expect(candidates[0].name).toBe("Grinder guides");
  });

  it("never lets a cluster claim a row a pattern already took", () => {
    const candidates = detectCandidates([
      ...pseoRows([
        "espresso machine vs pod machine",
        "espresso machine vs moka pot",
        "espresso machine vs french press",
        "espresso machine vs aeropress",
      ]),
      row("espresso machine cleaning"),
      row("espresso machine descaling"),
      row("espresso machine water"),
    ]);

    const comparisons = candidates.find((c) => c.name === "Comparisons");
    const cluster = candidates.find((c) => c.kind === "blog");
    expect(comparisons?.instances).toHaveLength(4);
    expect(cluster?.instances).toHaveLength(3);
    expect(
      cluster?.instances.every(
        (instance) => !instance.keyword.includes(" vs "),
      ),
    ).toBe(true);
  });

  it("orders candidates by demand and quotes three real keywords", () => {
    const candidates = detectCandidates([
      ...pseoRows(["a vs b", "c vs d", "e vs f", "g vs h"]),
      row("best grinder", { searchVolume: 5000 }),
      row("best tamper", { searchVolume: 4000 }),
      row("best scale", { searchVolume: 3000 }),
      row("best kettle", { searchVolume: 2000 }),
    ]);

    expect(candidates[0].name).toBe("Best-of lists");
    expect(candidates[0].demand).toBe(14_000);
    expect(candidates[0].exampleTitles).toEqual([
      "best grinder",
      "best tamper",
      "best scale",
    ]);
  });
});

describe("demand math", () => {
  it("takes the larger of vendor volume and measured impressions", () => {
    expect(
      effectiveVolume(row("x", { searchVolume: 10, impressions28: 480 })),
    ).toBe(480);
    expect(
      effectiveVolume(row("x", { searchVolume: 900, impressions28: 40 })),
    ).toBe(900);
  });

  it("reads a row with no metrics at all as zero demand, not as a missing row", () => {
    const candidates = detectCandidates([
      row("espresso cleaning tips", {
        searchVolume: null,
        impressions28: null,
      }),
      row("espresso descaling tips", {
        searchVolume: null,
        impressions28: null,
      }),
      row("espresso water tips", { searchVolume: 300, impressions28: null }),
    ]);

    expect(candidates[0].demand).toBe(300);
    expect(candidates[0].instances).toHaveLength(3);
  });
});

describe("computeKdBand", () => {
  it("returns the interquartile band of the non-null difficulties", () => {
    expect(
      computeKdBand(
        [10, 20, 30, 40, 50].map((kd) => row("x", { keywordDifficulty: kd })),
      ),
    ).toEqual({ p25: 20, p75: 40 });
  });

  it("skips null difficulties instead of imputing them", () => {
    expect(
      computeKdBand([
        row("x", { keywordDifficulty: null }),
        row("x", { keywordDifficulty: 40 }),
        row("x", { keywordDifficulty: null }),
        row("x", { keywordDifficulty: 60 }),
      ]),
    ).toEqual({ p25: 40, p75: 60 });
  });

  it("is null when nothing in the cluster carries a difficulty", () => {
    expect(
      computeKdBand([
        row("x", { keywordDifficulty: null }),
        row("x", { keywordDifficulty: null }),
      ]),
    ).toBeNull();
  });
});

describe("stems", () => {
  it("drops stopwords, short tokens and a trailing plural", () => {
    expect(stems("how to clean the espresso machines")).toEqual([
      "clean",
      "espresso",
      "machine",
    ]);
  });

  it("leaves a double-s word alone", () => {
    expect(stems("espresso press")).toEqual(["espresso", "press"]);
  });
});

describe("pickSerpSampleKeywords", () => {
  it("spreads its samples across the demand range rather than taking the head", () => {
    const [candidate] = detectCandidates(
      [5000, 4000, 3000, 2000, 1000, 900, 800, 700].map((volume, index) =>
        row(`best item ${index}`, { searchVolume: volume }),
      ),
    );

    const picked = pickSerpSampleKeywords(candidate, 3);
    expect(picked).toEqual(["best item 0", "best item 4", "best item 7"]);
  });

  it("samples at most six keywords", () => {
    const [candidate] = detectCandidates(
      Array.from({ length: 40 }, (_, index) => row(`best item ${index}`)),
    );

    expect(pickSerpSampleKeywords(candidate)).toHaveLength(6);
  });
});

describe("allocateSerpBudget", () => {
  it("spends on the cheapest candidates first and stops at the cap", () => {
    const candidates = [
      {
        name: "big",
        sampleKeywords: Array.from({ length: 6 }, (_, i) => `b${i}`),
      },
      { name: "small", sampleKeywords: ["s1", "s2"] },
      { name: "medium", sampleKeywords: ["m1", "m2", "m3", "m4"] },
    ];

    const budget = allocateSerpBudget(candidates, 6);
    expect(budget.sampled.map((entry) => entry.name)).toEqual([
      "small",
      "medium",
    ]);
    expect(budget.unsampled.map((entry) => entry.name)).toEqual(["big"]);
  });

  it("takes a candidate whole or not at all", () => {
    const candidates = [
      { name: "a", sampleKeywords: ["1", "2", "3"] },
      { name: "b", sampleKeywords: ["4", "5", "6"] },
    ];

    const budget = allocateSerpBudget(candidates, 4);
    expect(budget.sampled.map((entry) => entry.name)).toEqual(["a"]);
    expect(budget.unsampled.map((entry) => entry.name)).toEqual(["b"]);
  });

  it("defaults to the 40-call cap", () => {
    const candidates = Array.from({ length: 10 }, (_unused, index) => ({
      name: `c${index}`,
      sampleKeywords: Array.from(
        { length: 6 },
        (_slot, sample) => `k${index}-${sample}`,
      ),
    }));

    const budget = allocateSerpBudget(candidates);
    expect(budget.sampled).toHaveLength(6);
    expect(budget.unsampled).toHaveLength(4);
  });
});
