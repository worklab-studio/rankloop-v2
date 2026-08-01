import { describe, expect, it } from "vitest";
import {
  formatFactorValue,
  formatScore,
  proposalTypeDisplay,
  retitleWinningQueries,
} from "./proposalDisplay.logic";

describe("proposalTypeDisplay", () => {
  it("maps the three S3a signal types to their spec colors", () => {
    expect(proposalTypeDisplay("retitle")).toEqual({
      label: "Retitle",
      color: "sky",
    });
    expect(proposalTypeDisplay("push")).toEqual({
      label: "Push",
      color: "violet",
    });
    expect(proposalTypeDisplay("refresh")).toEqual({
      label: "Refresh",
      color: "amber",
    });
  });

  it("keeps write_new off violet and lime, which its other two chips own", () => {
    expect(proposalTypeDisplay("write_new")).toEqual({
      label: "Write new",
      color: "emerald",
    });
  });

  it("labels the two types that may never run unattended", () => {
    // Automation lists every type the column knows, so these two were the
    // only ones rendering as raw lowercase beside proper labels.
    expect(proposalTypeDisplay("merge")).toEqual({
      label: "Merge",
      color: "fuchsia",
    });
    expect(proposalTypeDisplay("prune")).toEqual({
      label: "Prune",
      color: "rose",
    });
  });

  it("falls back to a neutral chip for a type nothing has mapped", () => {
    expect(proposalTypeDisplay("transmute")).toEqual({
      label: "transmute",
      color: "slate",
    });
  });
});

describe("formatScore", () => {
  it("formats with locale commas and at most one decimal", () => {
    expect(formatScore(1240.66)).toBe("1,240.7");
    expect(formatScore(42)).toBe("42");
  });
});

describe("formatFactorValue", () => {
  it("keeps two decimals on numbers so sub-1 multipliers stay apart", () => {
    expect(formatFactorValue(0.55)).toBe("0.55");
    expect(formatFactorValue(0.61)).toBe("0.61");
    expect(formatFactorValue(12400)).toBe("12,400");
  });

  it("passes pre-formatted string values through verbatim", () => {
    expect(formatFactorValue("4.5% vs 10% expected")).toBe(
      "4.5% vs 10% expected",
    );
  });
});

describe("retitleWinningQueries", () => {
  it("recovers the bare query from head and secondary evidence chips", () => {
    expect(
      retitleWinningQueries([
        '"espresso tamper size" · pos 8.2 · 1,240 impr · 1.1% vs 3.0% expected',
        '"58mm tamper" · 1.4% vs 3.0%',
      ]),
    ).toEqual([
      {
        query: "espresso tamper size",
        detail:
          '"espresso tamper size" · pos 8.2 · 1,240 impr · 1.1% vs 3.0% expected',
      },
      { query: "58mm tamper", detail: '"58mm tamper" · 1.4% vs 3.0%' },
    ]);
  });

  it("drops the +n-more summary chip, which names no query", () => {
    expect(retitleWinningQueries(["+3 more below expected"])).toEqual([]);
  });

  it("keeps queries that themselves contain quotes intact", () => {
    expect(
      retitleWinningQueries(['"best "naked" portafilter" · 1.0% vs 3.0%']),
    ).toEqual([
      {
        query: 'best "naked" portafilter',
        detail: '"best "naked" portafilter" · 1.0% vs 3.0%',
      },
    ]);
  });
});
