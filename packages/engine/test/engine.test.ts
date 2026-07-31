/** Native behavior tests (not fixture-driven): the pool-mix rule and the
 * small pure helpers whose contracts the pipeline leans on. */

import { describe, expect, it } from "vitest";
import { applyPoolMix, resolveCategory, rfc822, serpSection } from "../src/index.ts";
import type { EngineConfig } from "../src/index.ts";

const row = (keyword: string) => ({ keyword });

describe("applyPoolMix()", () => {
  const scored = [row("best espresso grinder"), row("how to dial in espresso")];
  const pool = [row("why does my espresso taste sour")];

  it("gives the pool exactly one slot, replacing the weakest scored pick", () => {
    const picks = applyPoolMix(scored, pool, 2);
    expect(picks.map((p) => [p.keyword, p.slot])).toEqual([
      ["best espresso grinder", "score"],
      ["why does my espresso taste sour", "pool"],
    ]);
  });

  it("fills the gap instead of replacing when scored picks come back short", () => {
    const picks = applyPoolMix([scored[0]!], pool, 2);
    expect(picks.map((p) => p.slot)).toEqual(["score", "pool"]);
    expect(picks).toHaveLength(2);
  });

  it("is satisfied without a swap when a pool row already ranked in", () => {
    const picks = applyPoolMix(scored, [row("best espresso grinder")], 2);
    expect(picks.map((p) => p.slot)).toEqual(["score", "score"]);
  });

  it("never spends a slot on the pool for single picks", () => {
    expect(applyPoolMix(scored.slice(0, 1), pool, 1).map((p) => p.slot)).toEqual(["score"]);
  });
});

describe("serpSection()", () => {
  it("tells the writer to work from the topic when no SERP is cached", () => {
    expect(serpSection(null)).toBe(
      "No cached SERP for this keyword. Write from the topic itself.",
    );
  });

  it("degrades to a plain notice when the cache holds nothing usable", () => {
    expect(serpSection({ organic: [], paa: [] })).toBe("No usable SERP data.");
  });
});

describe("resolveCategory()", () => {
  const cfg = { taxonomy: { Guides: "guides", Compare: "compare" } } as unknown as EngineConfig;

  it("keeps a category that is a real hub", () => {
    expect(resolveCategory(cfg, "Compare")).toBe("Compare");
  });

  it("collapses unknown categories to the first configured hub", () => {
    expect(resolveCategory(cfg, "Reviews")).toBe("Guides");
    expect(resolveCategory(cfg, null)).toBe("Guides");
  });
});

describe("rfc822()", () => {
  it("renders the deliberate 09:00 GMT publish hour", () => {
    expect(rfc822("2026-07-20")).toBe("Mon, 20 Jul 2026 09:00:00 GMT");
    expect(rfc822("2026-01-04")).toBe("Sun, 04 Jan 2026 09:00:00 GMT");
  });

  it("returns null for garbage dates", () => {
    expect(rfc822("")).toBeNull();
    expect(rfc822("2026-02-30")).toBeNull();
  });
});
