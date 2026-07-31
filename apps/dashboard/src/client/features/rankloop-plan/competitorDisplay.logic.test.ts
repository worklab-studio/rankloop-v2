import { describe, expect, it } from "vitest";
import {
  cadenceMonthLabel,
  coverageDisplay,
  formatFeaturePct,
  formatTraffic,
  pageStatusDisplay,
  pageTypeDisplay,
  urlPath,
} from "./competitorDisplay.logic";

describe("coverageDisplay", () => {
  it("maps the two study outcomes to their spec chips", () => {
    expect(coverageDisplay("full")).toEqual({
      label: "studied",
      color: "emerald",
    });
    expect(coverageDisplay("sitemap_only")).toEqual({
      label: "sitemap only",
      color: "amber",
    });
  });

  it("returns null for a competitor that has never been studied", () => {
    expect(coverageDisplay(null)).toBeNull();
  });
});

describe("pageTypeDisplay", () => {
  it("uses the site-study kind vocabulary", () => {
    expect(pageTypeDisplay("post")).toEqual({ label: "post", color: "sky" });
    expect(pageTypeDisplay("hub")).toEqual({ label: "hub", color: "lime" });
  });

  it("renders an unclassified page and an unknown kind as neutral chips", () => {
    expect(pageTypeDisplay(null)).toEqual({
      label: "unknown",
      color: "slate",
    });
    expect(pageTypeDisplay("glossary")).toEqual({
      label: "glossary",
      color: "slate",
    });
  });
});

describe("pageStatusDisplay", () => {
  it("splits the two negative statuses by tone", () => {
    expect(pageStatusDisplay("decayed")).toEqual({
      label: "decayed",
      color: "rose",
    });
    expect(pageStatusDisplay("removed")).toEqual({
      label: "removed",
      color: "slate",
    });
  });
});

describe("formatTraffic", () => {
  it("keeps sub-thousand estimates exact and compacts the rest", () => {
    expect(formatTraffic(940.4)).toBe("940");
    expect(formatTraffic(12_431)).toBe("12.4K");
    expect(formatTraffic(1_200_000)).toBe("1.2M");
  });

  it("renders a missing estimate as an em dash, never zero", () => {
    expect(formatTraffic(null)).toBe("—");
    expect(formatTraffic(0)).toBe("0");
  });
});

describe("formatFeaturePct", () => {
  it("rounds to whole percents — the samples are 30 and 15 pages", () => {
    expect(formatFeaturePct(73.3)).toBe("73%");
    expect(formatFeaturePct(0)).toBe("0%");
  });
});

describe("cadenceMonthLabel", () => {
  it("carries the year, because 24 months holds two of each month", () => {
    expect(cadenceMonthLabel("2026-03")).toBe("Mar 2026");
    expect(cadenceMonthLabel("2025-03")).toBe("Mar 2025");
  });

  it("passes an unparseable bucket key through", () => {
    expect(cadenceMonthLabel("unknown")).toBe("unknown");
  });
});

describe("urlPath", () => {
  it("strips the origin so rows differ by path alone", () => {
    expect(urlPath("https://competitor.com/blog/how-to-x?utm=1")).toBe(
      "/blog/how-to-x?utm=1",
    );
  });

  it("returns the input when it is not a parseable URL", () => {
    expect(urlPath("/blog/how-to-x")).toBe("/blog/how-to-x");
  });
});
