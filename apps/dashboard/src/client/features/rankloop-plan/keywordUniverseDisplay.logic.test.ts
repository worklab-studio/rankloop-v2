import { describe, expect, it } from "vitest";
import {
  clusterLabel,
  costSentence,
  formatMetric,
  formatScore,
  gateTokenLabel,
  kdCeilingStamp,
  runningLabel,
  sourceDisplay,
  statusLabel,
  universeStamp,
} from "./keywordUniverseDisplay.logic";

describe("sourceDisplay", () => {
  it("colors the three sources that mean something different about a row", () => {
    expect(sourceDisplay("gsc")).toEqual({
      label: "search console",
      color: "sky",
    });
    expect(sourceDisplay("gap")).toEqual({
      label: "competitor gap",
      color: "violet",
    });
    expect(sourceDisplay("harvest")).toEqual({
      label: "harvest",
      color: "lime",
    });
  });

  it("leaves the idea sources sharing the neutral chip", () => {
    for (const source of ["expansion", "autocomplete", "manual"]) {
      expect(sourceDisplay(source).color).toBe("slate");
    }
  });

  it("renders a source this build doesn't know rather than dropping it", () => {
    expect(sourceDisplay("csv_import")).toEqual({
      label: "csv_import",
      color: "slate",
    });
  });
});

describe("costSentence", () => {
  it("prices the metered sources per unit the user chose, with the tilde", () => {
    expect(costSentence("gap")).toBe("~$0.02 per competitor");
    expect(costSentence("expansion")).toBe(
      "~$0.01 per seed · up to 20 seeds a run",
    );
  });
});

describe("runningLabel", () => {
  it("names the step that is spending time", () => {
    expect(runningLabel(["gap"])).toBe("Finding gaps…");
    expect(runningLabel(["gsc", "autocomplete"])).toBe(
      "Reading Search Console…",
    );
  });

  it("falls back rather than blanking for a run whose sources didn't survive a parse", () => {
    expect(runningLabel([])).toBe("Filling the backlog…");
    expect(runningLabel(["something_new"])).toBe("Filling the backlog…");
  });
});

describe("universeStamp", () => {
  it("reconciles what the sources returned with what the gate kept", () => {
    expect(universeStamp({ seenCount: 1284, keptCount: 312 })).toBe(
      "1,284 candidates seen · 312 passed your gate · NULL-volume rows are kept on purpose — long tail is where a new site wins",
    );
  });

  it("still states the NULL-volume doctrine before any run has counted", () => {
    expect(universeStamp(null)).toBe(
      "NULL-volume rows are kept on purpose — long tail is where a new site wins",
    );
    expect(universeStamp({ seenCount: null, keptCount: null })).toBe(
      "NULL-volume rows are kept on purpose — long tail is where a new site wins",
    );
  });
});

describe("kdCeilingStamp", () => {
  it("admits an uncomputed ceiling is the starting floor", () => {
    expect(kdCeilingStamp({ kdCeilingUpdatedAt: null })).toBe(
      "the starting ceiling — you need 10 keywords ranking top-10 before it moves · moves at most +5 per computation",
    );
  });

  it("quotes the sample count when the payload carries one", () => {
    expect(
      kdCeilingStamp({
        kdCeilingUpdatedAt: "2026-07-31T00:00:00.000Z",
        sampleCount: 14,
      }),
    ).toBe(
      "earned from 14 keywords you already rank top-10 for · moves at most +5 per computation",
    );
  });

  it("drops the count rather than inventing one when it wasn't stored", () => {
    expect(
      kdCeilingStamp({ kdCeilingUpdatedAt: "2026-07-31T00:00:00.000Z" }),
    ).toBe(
      "earned from the keywords you already rank top-10 for · moves at most +5 per computation",
    );
  });
});

describe("gateTokenLabel", () => {
  it("shows what admitted a derived token", () => {
    expect(gateTokenLabel({ token: "espresso", documentCount: 41 })).toBe(
      "espresso · 41 pages",
    );
    expect(gateTokenLabel({ token: "grinder", documentCount: 1 })).toBe(
      "grinder · 1 page",
    );
  });

  it("counts nothing for a token a human typed", () => {
    expect(gateTokenLabel({ token: "portafilter" })).toBe("portafilter");
  });
});

describe("table cells", () => {
  it("renders an unmeasured metric as an em dash, never a zero", () => {
    expect(formatMetric(null)).toBe("—");
    expect(formatMetric(0)).toBe("0");
    expect(formatMetric(12400)).toBe("12,400");
    expect(formatScore(null)).toBe("—");
    expect(formatScore(61.25)).toBe("61.3");
  });

  it("says what a status means to a founder", () => {
    expect(statusLabel("discovered")).toBe("in the backlog");
    expect(statusLabel("planned")).toBe("in a page type");
    expect(statusLabel("half_written")).toBe("half_written");
  });

  it("prints the cluster key the plan actually clusters on", () => {
    expect(clusterLabel("vs-comparison")).toBe("vs-comparison");
    expect(clusterLabel(null)).toBe("—");
  });
});
