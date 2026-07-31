import { describe, expect, it } from "vitest";
import {
  computeInlinkCandidates,
  headlineQuery,
  slugFromPath,
} from "./execution.logic";

describe("headlineQuery", () => {
  it("extracts the quoted query from retitle and push titles", () => {
    expect(headlineQuery('Rewrite the title for "best espresso tampers"')).toBe(
      "best espresso tampers",
    );
    expect(
      headlineQuery('Push "espresso tamper size" from position 11.2'),
    ).toBe("espresso tamper size");
  });

  it("returns null for unquoted titles and null titles", () => {
    expect(headlineQuery("Refresh — clicks down 40%")).toBeNull();
    expect(headlineQuery(null)).toBeNull();
  });
});

describe("slugFromPath", () => {
  it("takes the last segment however deep the permalink nests", () => {
    expect(slugFromPath("/blog/best-espresso-tampers/")).toBe(
      "best-espresso-tampers",
    );
    expect(slugFromPath("/2026/07/some-post")).toBe("some-post");
  });

  it("returns null for the root path", () => {
    expect(slugFromPath("/")).toBeNull();
  });
});

describe("computeInlinkCandidates", () => {
  const target = { path: "/blog/best-espresso-tampers/", category: "gear" };

  it("ranks by shared slug tokens plus the category bonus, capped at three", () => {
    const candidates = computeInlinkCandidates({
      target,
      pages: [
        // Shares "best" + "espresso" + category ("tampers"/"grinders" differ
        // — token matching is exact, no stemming).
        { path: "/blog/best-espresso-grinders/", title: "G", category: "gear" },
        // Shares "espresso" only.
        { path: "/blog/espresso-ratios/", title: "R", category: "brewing" },
        // Same category only.
        { path: "/blog/kettle-roundup/", title: "K", category: "gear" },
        // No overlap at all — must be dropped, not padded in.
        { path: "/blog/decaf-myths/", title: "D", category: "science" },
        // Shares "espresso" + category.
        { path: "/blog/espresso-machines/", title: "M", category: "gear" },
      ],
    });

    expect(candidates.map((c) => c.path)).toEqual([
      "/blog/best-espresso-grinders/",
      "/blog/espresso-machines/",
      "/blog/kettle-roundup/",
    ]);
    // best+espresso shared tokens (2) + category (2).
    expect(candidates[0]?.score).toBe(4);
  });

  it("excludes the target page itself", () => {
    const candidates = computeInlinkCandidates({
      target,
      pages: [{ path: target.path, title: "Self", category: "gear" }],
    });
    expect(candidates).toEqual([]);
  });

  it("gives no category bonus when the target has no category", () => {
    const candidates = computeInlinkCandidates({
      target: { path: "/blog/best-espresso-tampers/", category: null },
      pages: [{ path: "/blog/kettle-roundup/", title: "K", category: null }],
    });
    expect(candidates).toEqual([]);
  });

  it("breaks score ties by path so the list is stable", () => {
    const candidates = computeInlinkCandidates({
      target: { path: "/blog/espresso/", category: null },
      pages: [
        { path: "/blog/espresso-two/", title: "2", category: null },
        { path: "/blog/espresso-one/", title: "1", category: null },
      ],
    });
    expect(candidates.map((c) => c.path)).toEqual([
      "/blog/espresso-one/",
      "/blog/espresso-two/",
    ]);
  });
});
