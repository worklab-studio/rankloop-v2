import { describe, expect, it } from "vitest";
import type { PageQueryAggregate } from "@/server/features/rankloop/proposals/signals.logic";
import {
  rollUpQueries,
  selectUnservedQueries,
  unservedFloor,
} from "./unserved.logic";

function agg(
  query: string,
  impressions: number,
  weightedPosition: number,
  pageUrl = "https://site.example/a/",
): PageQueryAggregate {
  return { pageUrl, query, clicks: 0, impressions, weightedPosition };
}

function select(
  aggregates: PageQueryAggregate[],
  overrides: {
    servedKeywords?: string[];
    existingBacklogKeywords?: string[];
  } = {},
) {
  return selectUnservedQueries({
    aggregates,
    servedKeywords: overrides.servedKeywords ?? [],
    existingBacklogKeywords: overrides.existingBacklogKeywords ?? [],
  });
}

describe("unservedFloor", () => {
  it("steps up with the project's own volume", () => {
    expect(unservedFloor(0)).toBe(3);
    expect(unservedFloor(999)).toBe(3);
    expect(unservedFloor(1_000)).toBe(5);
    expect(unservedFloor(9_999)).toBe(5);
    expect(unservedFloor(10_000)).toBe(10);
  });
});

describe("rollUpQueries", () => {
  it("sums impressions across pages and keeps the best position", () => {
    const rollups = rollUpQueries([
      agg("descale breville", 100, 8, "https://site.example/a/"),
      agg("descale breville", 900, 40, "https://site.example/b/"),
    ]);

    expect(rollups).toEqual([
      { query: "descale breville", impressions28: 1000, bestPosition: 8 },
    ]);
  });
});

describe("selectUnservedQueries", () => {
  it("leaves alone a query a page already ranks top-10 for", () => {
    expect(select([agg("descale breville", 500, 6)])).toEqual([]);
  });

  it("takes a query the site only serves by accident", () => {
    const [candidate] = select([agg("descale breville", 500, 34)]);

    expect(candidate.keyword).toBe("descale breville");
    expect(candidate.impressions28).toBe(500);
  });

  it("judges on the best-serving page, not the average of them", () => {
    // One page at 8 and one at 40 means the query IS served; averaging to 37
    // would propose a second page that competes with the one already ranking.
    expect(
      select([
        agg("descale breville", 100, 8, "https://site.example/a/"),
        agg("descale breville", 900, 40, "https://site.example/b/"),
      ]),
    ).toEqual([]);
  });

  it("keeps a three-impression query on a small site", () => {
    const [candidate] = select([agg("burr grinder swap", 3, 30)]);

    expect(candidate.keyword).toBe("burr grinder swap");
  });

  it("drops the same query once the project is big enough for it to be noise", () => {
    // The floor scales off the project's own window: three impressions is a
    // signal at 3 total and static at 2,003.
    expect(
      select([
        agg("burr grinder swap", 3, 30),
        agg("espresso machine", 2_000, 4),
      ]),
    ).toEqual([]);
  });

  it("clusters near-duplicate phrasings into one row and keeps the rest", () => {
    const [candidate] = select([
      agg("how to descale a breville", 12, 30),
      agg("descale breville how", 5, 40),
    ]);

    // The most-searched phrasing represents the cluster; the demand is the
    // whole cluster's, because one page would serve all of it.
    expect(candidate.keyword).toBe("how to descale a breville");
    expect(candidate.impressions28).toBe(17);
    expect(candidate.variants).toEqual(["descale breville how"]);
    expect(candidate.clusterKey).toBe("breville descale");
    expect(candidate.bestPosition).toBe(30);
  });

  it("leaves a cluster alone when any phrasing of it is already top-10", () => {
    // Both phrasings normalize to "breville descale", so one page answers
    // both. Judging the sibling on its own would propose a second page that
    // cannibalizes the one already ranking sixth.
    expect(
      select([
        agg("how to descale a breville", 400, 6),
        agg("how do i descale a breville", 60, 22),
      ]),
    ).toEqual([]);
  });

  it("skips a query whose words are all function words", () => {
    // An empty token set would collect every such query into one meaningless
    // row keyed on the empty string.
    expect(select([agg("how to", 50, 30)])).toEqual([]);
  });

  it("skips what a page already targets, on token sets rather than strings", () => {
    expect(
      select([agg("how to descale a breville", 40, 30)], {
        servedKeywords: ["descale breville"],
      }),
    ).toEqual([]);
  });

  it("skips what an earlier run already admitted, however it was phrased", () => {
    // Exact-string matching would cheerfully add this row again every week
    // under a slightly different wording.
    expect(
      select([agg("how to descale a breville", 40, 30)], {
        existingBacklogKeywords: ["Breville descale, how?"],
      }),
    ).toEqual([]);
  });

  it("orders by proven demand so two runs admit the same rows in the same order", () => {
    const candidates = select([
      agg("portafilter basket size", 40, 22),
      agg("grinder burr replacement", 90, 31),
    ]);

    expect(candidates.map((candidate) => candidate.keyword)).toEqual([
      "grinder burr replacement",
      "portafilter basket size",
    ]);
  });
});
