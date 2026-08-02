// Programmatic SEO's failure mode is not a bug, it is a site that gets
// filed as spam. Every test here is a page this engine must REFUSE to
// write, or a refusal it must explain rather than apply quietly.

import { describe, expect, it } from "vitest";
import {
  combinationKey,
  combinations,
  combinationSlug,
  completeness,
  planProgrammaticPages,
  quoteProgrammatic,
  rowFingerprint,
  unsourcedFields,
  type DataRow,
  type VariableSet,
} from "./combinations.logic";

const CITIES: VariableSet = { name: "city", values: ["austin", "denver", "miami"] };
const SERVICES: VariableSet = { name: "service", values: ["plumbing", "hvac"] };

/** A row where every cell is sourced. */
function sourced(fields: Record<string, string>): DataRow {
  return Object.fromEntries(
    Object.entries(fields).map(([k, v]) => [
      k,
      { value: v, provenance: "census-2026", confidence: 0.9 },
    ]),
  );
}

describe("combinations()", () => {
  it("produces the full grid", () => {
    const { combinations: grid } = combinations([CITIES, SERVICES]);
    expect(grid).toHaveLength(6);
    expect(grid[0]?.values).toEqual({ city: "austin", service: "plumbing" });
  });

  it("caps the grid and says how much it dropped", () => {
    // 50 x 12 x 6 is 3,600 pages. Generating them all to then drop 3,400
    // wastes the work and invites a UI that shouts "3,600 pages!" before
    // anything has been checked.
    const big: VariableSet[] = [
      { name: "a", values: Array.from({ length: 50 }, (_, i) => `a${i}`) },
      { name: "b", values: Array.from({ length: 12 }, (_, i) => `b${i}`) },
    ];
    const { combinations: grid, truncated } = combinations(big, 100);
    expect(grid).toHaveLength(100);
    expect(truncated).toBe(500);
  });

  it("ignores a variable with no values instead of collapsing the grid", () => {
    // The cartesian product of anything with an empty set is empty. A user
    // who added a third dimension and has not filled it yet should not watch
    // their whole plan disappear.
    const { combinations: grid } = combinations([
      CITIES,
      SERVICES,
      { name: "format", values: [] },
    ]);
    expect(grid).toHaveLength(6);
  });

  it("returns nothing when there is nothing to combine", () => {
    expect(combinations([]).combinations).toHaveLength(0);
  });
});

describe("combinationKey()", () => {
  it("is order-independent, so one combination is not counted twice", () => {
    expect(combinationKey({ city: "austin", service: "hvac" })).toBe(
      combinationKey({ service: "hvac", city: "austin" }),
    );
  });
});

describe("completeness()", () => {
  it("treats an unsourced cell as absent", () => {
    // The strict reading, and the intended one: a page assembled from
    // unsourced values cannot survive being asked where it got them.
    const row: DataRow = {
      population: { value: "2.1m", provenance: "census-2026", confidence: 0.9 },
      rate: { value: "$95/hr", provenance: null, confidence: null },
    };
    expect(completeness(row, ["population", "rate"])).toBe(0.5);
  });

  it("treats an empty value as absent", () => {
    const row: DataRow = {
      a: { value: "  ", provenance: "src", confidence: 1 },
      b: { value: "x", provenance: "src", confidence: 1 },
    };
    expect(completeness(row, ["a", "b"])).toBe(0.5);
  });

  it("is 1 when everything is sourced", () => {
    expect(completeness(sourced({ a: "1", b: "2" }), ["a", "b"])).toBe(1);
  });

  it("names the unsourced fields so the gap can be filled", () => {
    const row: DataRow = {
      a: { value: "1", provenance: "src", confidence: 1 },
      b: { value: "2", provenance: null, confidence: null },
    };
    expect(unsourcedFields(row)).toEqual(["b"]);
  });
});

describe("rowFingerprint()", () => {
  it("identifies duplicates by data, not by title", () => {
    // "CRM for dentists" and "CRM for orthodontists" with identical rows are
    // one page with two URLs, and their titles will never say so.
    const a = sourced({ price: "$49", seats: "5" });
    const b = sourced({ price: "$49", seats: "5" });
    expect(rowFingerprint(a, ["price", "seats"])).toBe(
      rowFingerprint(b, ["price", "seats"]),
    );
  });

  it("separates rows that actually differ", () => {
    expect(rowFingerprint(sourced({ price: "$49" }), ["price"])).not.toBe(
      rowFingerprint(sourced({ price: "$99" }), ["price"]),
    );
  });

  it("ignores case and padding, which are not differences", () => {
    expect(rowFingerprint(sourced({ a: " Austin " }), ["a"])).toBe(
      rowFingerprint(sourced({ a: "austin" }), ["a"]),
    );
  });
});

describe("planProgrammaticPages() — the refusals", () => {
  const required = ["population", "rate"];

  it("refuses a combination with no data row at all", () => {
    // The law, applied literally. A page about "CRM for dentists" with
    // nothing true to say about dentists is the page that gets a site
    // penalised.
    const plan = planProgrammaticPages({
      variables: [CITIES, SERVICES],
      rows: {},
      requiredFields: required,
    });
    expect(plan.pages).toHaveLength(0);
    expect(plan.dropped).toHaveLength(6);
    expect(plan.dropped.every((d) => d.reason === "no_data_row")).toBe(true);
  });

  it("refuses a row that is mostly unsourced", () => {
    const key = combinationKey({ city: "austin", service: "plumbing" });
    const plan = planProgrammaticPages({
      variables: [{ name: "city", values: ["austin"] }, { name: "service", values: ["plumbing"] }],
      rows: {
        [key]: {
          population: { value: "2.1m", provenance: "census", confidence: 1 },
          rate: { value: "$95/hr", provenance: null, confidence: null },
        },
      },
      requiredFields: required,
      minCompleteness: 0.6,
    });
    expect(plan.pages).toHaveLength(0);
    expect(plan.dropped[0]?.reason).toBe("row_too_thin");
    expect(plan.dropped[0]?.detail).toContain("Unsourced: rate");
  });

  it("refuses the second of two identical rows", () => {
    const k1 = combinationKey({ city: "austin", service: "plumbing" });
    const k2 = combinationKey({ city: "denver", service: "plumbing" });
    const identical = sourced({ population: "1m", rate: "$95/hr" });
    const plan = planProgrammaticPages({
      variables: [
        { name: "city", values: ["austin", "denver"] },
        { name: "service", values: ["plumbing"] },
      ],
      rows: { [k1]: identical, [k2]: { ...identical } },
      requiredFields: required,
    });
    expect(plan.pages).toHaveLength(1);
    expect(plan.dropped[0]?.reason).toBe("duplicate_row");
    expect(plan.dropped[0]?.detail).toContain("identical to");
  });

  it("applies the page cap after the quality refusals, not before", () => {
    // Otherwise a run spends its budget on pages that would have been
    // dropped anyway, and produces fewer good pages than the cap allows.
    const rows: Record<string, DataRow> = {};
    const cities = ["a", "b", "c", "d"];
    cities.forEach((c, i) => {
      const key = combinationKey({ city: c, service: "plumbing" });
      // The first two have no data; the last two are good.
      if (i >= 2) rows[key] = sourced({ population: `${i}m`, rate: `$${i}0/hr` });
    });

    const plan = planProgrammaticPages({
      variables: [
        { name: "city", values: cities },
        { name: "service", values: ["plumbing"] },
      ],
      rows,
      requiredFields: required,
      maxPages: 2,
    });
    expect(plan.pages).toHaveLength(2);
    expect(plan.dropped.filter((d) => d.reason === "over_cap")).toHaveLength(0);
  });

  it("reports over_cap once real pages exceed the limit", () => {
    const rows: Record<string, DataRow> = {};
    for (const city of CITIES.values) {
      rows[combinationKey({ city, service: "plumbing" })] = sourced({
        population: `${city}-pop`,
        rate: `${city}-rate`,
      });
    }
    const plan = planProgrammaticPages({
      variables: [CITIES, { name: "service", values: ["plumbing"] }],
      rows,
      requiredFields: required,
      maxPages: 2,
    });
    expect(plan.pages).toHaveLength(2);
    expect(plan.dropped.filter((d) => d.reason === "over_cap")).toHaveLength(1);
  });
});

describe("planProgrammaticPages() — what it reports", () => {
  it("rolls up reasons instead of listing hundreds of rows", () => {
    // "260 dropped: 180 had no data" is readable. 260 rows is not.
    const plan = planProgrammaticPages({
      variables: [CITIES, SERVICES],
      rows: {},
      requiredFields: ["population"],
    });
    expect(plan.dropSummary).toEqual([
      { reason: "no_data_row", count: 6, label: "no data to write about" },
    ]);
  });

  it("explains each reason in words a user can act on", () => {
    const plan = planProgrammaticPages({
      variables: [CITIES, SERVICES],
      rows: {},
      requiredFields: ["population"],
    });
    expect(plan.dropSummary[0]?.label).not.toContain("_");
  });

  it("flags a shipped page's unsourced cells rather than trusting them", () => {
    // The page is good enough to write and one of its cells still has no
    // source. It ships flagged, not silently.
    const key = combinationKey({ city: "austin", service: "plumbing" });
    const plan = planProgrammaticPages({
      variables: [
        { name: "city", values: ["austin"] },
        { name: "service", values: ["plumbing"] },
      ],
      rows: {
        [key]: {
          population: { value: "2.1m", provenance: "census", confidence: 1 },
          rate: { value: "$95/hr", provenance: "survey", confidence: 1 },
          extra: { value: "guess", provenance: null, confidence: null },
        },
      },
      requiredFields: ["population", "rate"],
    });
    expect(plan.pages).toHaveLength(1);
    expect(plan.pages[0]?.needsReview).toEqual(["extra"]);
    expect(plan.pages[0]?.completeness).toBe(1);
  });
});

describe("quoteProgrammatic()", () => {
  it("prices only the pages that will actually be written", () => {
    // Quoting the grid rather than the plan would bill for pages the engine
    // already decided to refuse.
    const plan = planProgrammaticPages({
      variables: [CITIES, SERVICES],
      rows: {},
      requiredFields: ["population"],
    });
    expect(quoteProgrammatic(plan, 0.36)).toEqual({
      pages: 0,
      costUsd: 0,
      dropped: 6,
    });
  });

  it("shows the bill before anything runs", () => {
    const rows: Record<string, DataRow> = {};
    for (const city of CITIES.values) {
      rows[combinationKey({ city, service: "plumbing" })] = sourced({ population: city });
    }
    const plan = planProgrammaticPages({
      variables: [CITIES, { name: "service", values: ["plumbing"] }],
      rows,
      requiredFields: ["population"],
    });
    expect(quoteProgrammatic(plan, 0.36).costUsd).toBeCloseTo(1.08, 2);
  });
});

describe("combinationSlug()", () => {
  it("builds a URL segment in variable order", () => {
    expect(combinationSlug({ city: "Austin", service: "HVAC" }, ["service", "city"])).toBe(
      "hvac-austin",
    );
  });

  it("survives punctuation and spacing", () => {
    expect(combinationSlug({ city: "St. Louis" }, ["city"])).toBe("st-louis");
  });

  it("skips a missing value rather than leaving a double dash", () => {
    expect(combinationSlug({ city: "austin" }, ["city", "service"])).toBe("austin");
  });
});
