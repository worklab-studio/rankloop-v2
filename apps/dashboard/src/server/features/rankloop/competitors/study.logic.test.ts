import { describe, expect, it } from "vitest";
import {
  buildCadenceBuckets,
  classifyPathByShape,
  compareWinnersToMedian,
  diffPageSnapshot,
  extractStructuralFeatures,
  medianOf,
  summarizePageTypeMix,
  type StructuralFeatures,
} from "./study.logic";

function features(
  overrides: Partial<StructuralFeatures> = {},
): StructuralFeatures {
  return {
    wordCount: 1000,
    mediaCount: 2,
    dataTable: false,
    faqBlock: false,
    byline: false,
    dateModified: false,
    ...overrides,
  };
}

describe("classifyPathByShape", () => {
  it("reads the common blog shapes as posts", () => {
    expect(classifyPathByShape("/blog/how-to-x")).toBe("post");
    expect(classifyPathByShape("/news/2026/launch")).toBe("post");
    expect(classifyPathByShape("/2024/05/a-post")).toBe("post");
  });

  it("reads a bare section segment as the hub it is, not a post", () => {
    expect(classifyPathByShape("/blog")).toBe("hub");
    expect(classifyPathByShape("/blog/")).toBe("hub");
  });

  it("drops taxonomy, pagination and commerce plumbing to 'other'", () => {
    expect(classifyPathByShape("/tag/seo")).toBe("other");
    expect(classifyPathByShape("/blog/page/3")).toBe("other");
    expect(classifyPathByShape("/checkout")).toBe("other");
  });

  it("leaves everything else a page — a sitemap proves nothing finer", () => {
    expect(classifyPathByShape("/pricing")).toBe("page");
    expect(classifyPathByShape("/")).toBe("page");
  });
});

describe("summarizePageTypeMix", () => {
  it("counts by kind, biggest first, dropping the kinds with nothing in them", () => {
    const mix = summarizePageTypeMix([
      "/blog/a",
      "/blog/b",
      "/blog/c",
      "/pricing",
      "/blog",
    ]);

    expect(mix).toEqual([
      { pageType: "post", count: 3 },
      { pageType: "page", count: 1 },
      { pageType: "hub", count: 1 },
    ]);
  });

  it("returns nothing for an empty sitemap rather than four zero chips", () => {
    expect(summarizePageTypeMix([])).toEqual([]);
  });
});

describe("buildCadenceBuckets", () => {
  const now = new Date("2026-07-15T00:00:00.000Z");

  it("always emits 24 months, oldest first, ending in the current month", () => {
    const buckets = buildCadenceBuckets([], now);

    expect(buckets).toHaveLength(24);
    expect(buckets[0].month).toBe("2024-08");
    expect(buckets[23].month).toBe("2026-07");
    expect(buckets.every((bucket) => bucket.count === 0)).toBe(true);
  });

  it("keeps empty months present so a publishing gap reads as a gap", () => {
    const buckets = buildCadenceBuckets(
      ["2026-07-01", "2026-07-20T10:00:00Z", "2026-05-02"],
      now,
    );
    const byMonth = new Map(buckets.map((b) => [b.month, b.count]));

    expect(byMonth.get("2026-07")).toBe(2);
    expect(byMonth.get("2026-06")).toBe(0);
    expect(byMonth.get("2026-05")).toBe(1);
  });

  it("drops nulls, junk dates and anything outside the 24-month window", () => {
    const buckets = buildCadenceBuckets(
      [null, "not a date", "2019-01-01", "2026-07-04"],
      now,
    );

    expect(buckets.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(1);
  });
});

describe("extractStructuralFeatures", () => {
  it("counts words from text, ignoring script and style bodies", () => {
    const result = extractStructuralFeatures(
      "<html><style>body{color:red}</style><script>var a = 1;</script><p>one two three</p></html>",
    );

    expect(result.wordCount).toBe(3);
  });

  it("needs three rows before calling a table a data table", () => {
    const twoRows = "<table><tr><td>a</td></tr><tr><td>b</td></tr></table>";
    const threeRows = `${twoRows.slice(0, -8)}<tr><td>c</td></tr></table>`;

    expect(extractStructuralFeatures(twoRows).dataTable).toBe(false);
    expect(extractStructuralFeatures(threeRows).dataTable).toBe(true);
  });

  it("finds an FAQ from schema alone, without any question headings", () => {
    const html =
      '<script type="application/ld+json">{"@type":"FAQPage"}</script><p>hi</p>';

    expect(extractStructuralFeatures(html).faqBlock).toBe(true);
  });

  it("finds an FAQ from three question-shaped headings", () => {
    const two = "<h2>What is it?</h2><h3>How much?</h3><h2>Pricing</h2>";
    const three = `${two}<h3>Why bother?</h3>`;

    expect(extractStructuralFeatures(two).faqBlock).toBe(false);
    expect(extractStructuralFeatures(three).faqBlock).toBe(true);
  });

  it("counts img, video and iframe as media", () => {
    const html =
      '<img src="a"><video src="b"></video><iframe src="c"></iframe>';

    expect(extractStructuralFeatures(html).mediaCount).toBe(3);
  });

  it("recognises a byline and a modified date from any of their common markups", () => {
    expect(
      extractStructuralFeatures('<a rel="author" href="/x">Ada</a>').byline,
    ).toBe(true);
    expect(
      extractStructuralFeatures('<span class="post-byline">Ada</span>').byline,
    ).toBe(true);
    expect(
      extractStructuralFeatures(
        '<meta property="article:modified_time" content="2026-01-01">',
      ).dateModified,
    ).toBe(true);
    expect(extractStructuralFeatures("<p>nothing</p>").dateModified).toBe(
      false,
    );
  });
});

describe("medianOf", () => {
  it("averages the middle pair on an even-length list", () => {
    expect(medianOf([100, 300, 200, 500])).toBe(250);
  });

  it("is null for nothing measured", () => {
    expect(medianOf([])).toBeNull();
  });
});

describe("compareWinnersToMedian", () => {
  it("keeps only the features the winners carry more often", () => {
    const result = compareWinnersToMedian(
      [
        features({ dataTable: true, byline: true }),
        features({ dataTable: true, byline: true }),
      ],
      [features({ byline: true }), features({ byline: true })],
    );

    // byline is 100% in both cohorts — house style, not a differentiator.
    expect(result.deltas).toEqual([
      { feature: "Data table", winnersPct: 100, medianPct: 0 },
    ]);
  });

  it("reports no deltas when the earners look like the ordinary posts", () => {
    const both = [features({ faqBlock: true })];

    expect(compareWinnersToMedian(both, both).deltas).toEqual([]);
  });

  it("carries the medians and the cohort sizes the card stamps", () => {
    const result = compareWinnersToMedian(
      [features({ wordCount: 2000 }), features({ wordCount: 3000 })],
      [features({ wordCount: 800 })],
    );

    expect(result.winnersMedianWordCount).toBe(2500);
    expect(result.sampleMedianWordCount).toBe(800);
    expect(result.winnersStudied).toBe(2);
    expect(result.sampleStudied).toBe(1);
  });

  it("claims no deltas when the median cohort was never sampled", () => {
    const result = compareWinnersToMedian(
      [features({ byline: true, dateModified: true })],
      [],
    );

    expect(result.deltas).toEqual([]);
    expect(result.sampleStudied).toBe(0);
  });

  it("survives an empty cohort — a blocked crawl measures nothing", () => {
    const result = compareWinnersToMedian([], []);

    expect(result.deltas).toEqual([]);
    expect(result.winnersMedianWordCount).toBeNull();
    expect(result.winnersStudied).toBe(0);
  });
});

describe("diffPageSnapshot", () => {
  it("leaves everything active on a first study — decay needs two points", () => {
    const diff = diffPageSnapshot({
      prior: [],
      current: [
        { url: "https://a.com/1", etv: 100 },
        { url: "https://a.com/2", etv: null },
      ],
    });

    expect(diff.active).toEqual(["https://a.com/1", "https://a.com/2"]);
    expect(diff.decayed).toEqual([]);
    expect(diff.removed).toEqual([]);
  });

  it("marks a page decayed once it keeps 40% or less of its traffic value", () => {
    const diff = diffPageSnapshot({
      prior: [
        { url: "https://a.com/edge", etv: 100 },
        { url: "https://a.com/safe", etv: 100 },
        { url: "https://a.com/gone", etv: 100 },
      ],
      current: [
        { url: "https://a.com/edge", etv: 40 },
        { url: "https://a.com/safe", etv: 41 },
        { url: "https://a.com/gone", etv: 0 },
      ],
    });

    expect(diff.decayed).toEqual(["https://a.com/edge", "https://a.com/gone"]);
    expect(diff.active).toEqual(["https://a.com/safe"]);
  });

  it("treats a page missing from this snapshot as removed", () => {
    const diff = diffPageSnapshot({
      prior: [
        { url: "https://a.com/kept", etv: 50 },
        { url: "https://a.com/deleted", etv: 50 },
      ],
      current: [{ url: "https://a.com/kept", etv: 60 }],
    });

    expect(diff.removed).toEqual(["https://a.com/deleted"]);
    expect(diff.active).toEqual(["https://a.com/kept"]);
  });

  it("returns a recovered page to active instead of latching it decayed", () => {
    const diff = diffPageSnapshot({
      prior: [{ url: "https://a.com/back", etv: 10 }],
      current: [{ url: "https://a.com/back", etv: 90 }],
    });

    expect(diff.active).toEqual(["https://a.com/back"]);
    expect(diff.decayed).toEqual([]);
  });

  it("cannot judge decay against a zero or missing prior reading", () => {
    const diff = diffPageSnapshot({
      prior: [
        { url: "https://a.com/zero", etv: 0 },
        { url: "https://a.com/unknown", etv: null },
      ],
      current: [
        { url: "https://a.com/zero", etv: 0 },
        { url: "https://a.com/unknown", etv: 0 },
      ],
    });

    expect(diff.decayed).toEqual([]);
    expect(diff.active).toHaveLength(2);
  });
});
