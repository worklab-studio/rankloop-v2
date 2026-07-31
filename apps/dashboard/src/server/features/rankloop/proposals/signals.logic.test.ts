import { describe, expect, it } from "vitest";
import type {
  PageDayRow,
  PageQueryAggregate,
  PageQueryDayRow,
  SignalPageMeta,
} from "./signals.logic";
import type { RecentDecision } from "./suppression.logic";
import {
  aggregatePageQueryWindows,
  brandTokens,
  computePushCandidates,
  computeRefreshCandidates,
  computeRetitleCandidates,
  expectedCtr,
  isBrandQuery,
  pushProximity,
} from "./signals.logic";

const SENTINEL = "__rankloop:other__";

function page(
  id: string,
  path: string,
  publishedAt: string | null = null,
): SignalPageMeta {
  return { id, path, title: null, publishedAt };
}

function pagesByUrl(entries: Array<[string, SignalPageMeta]>) {
  return new Map(entries);
}

function decision(overrides: Partial<RecentDecision>): RecentDecision {
  return {
    type: "retitle",
    target: "/a",
    decidedAt: null,
    executedAt: null,
    ...overrides,
  };
}

function aggregate(overrides: Partial<PageQueryAggregate>): PageQueryAggregate {
  return {
    pageUrl: "https://acme.com/a",
    query: "best espresso grinder",
    clicks: 0,
    impressions: 0,
    weightedPosition: 3,
    ...overrides,
  };
}

describe("aggregatePageQueryWindows", () => {
  it("weights position by impressions across daily rows", () => {
    const rows: PageQueryDayRow[] = [
      // 100 impressions at pos 4 vs 1 impression at pos 90: an unweighted
      // mean would say 47; the weighted one stays near 4.
      { pageUrl: "u", query: "q", clicks: 5, impressions: 100, position: 4 },
      { pageUrl: "u", query: "q", clicks: 0, impressions: 1, position: 90 },
    ];
    const [agg] = aggregatePageQueryWindows(rows, SENTINEL);
    expect(agg.clicks).toBe(5);
    expect(agg.impressions).toBe(101);
    expect(agg.weightedPosition).toBeCloseTo((4 * 100 + 90) / 101);
  });

  it("excludes sentinel remainder rows on either dimension", () => {
    const rows = [
      {
        pageUrl: SENTINEL,
        query: SENTINEL,
        clicks: 9,
        impressions: 500,
        position: 40,
      },
      {
        pageUrl: "u",
        query: SENTINEL,
        clicks: 1,
        impressions: 50,
        position: 8,
      },
      { pageUrl: "u", query: "q", clicks: 1, impressions: 10, position: 5 },
    ];
    const aggs = aggregatePageQueryWindows(rows, SENTINEL);
    expect(aggs).toHaveLength(1);
    expect(aggs[0]).toMatchObject({ pageUrl: "u", query: "q" });
  });

  it("drops zero-impression pairs — no position or CTR to reason about", () => {
    const rows = [
      { pageUrl: "u", query: "q", clicks: 0, impressions: 0, position: 0 },
    ];
    expect(aggregatePageQueryWindows(rows, SENTINEL)).toHaveLength(0);
  });
});

describe("expectedCtr", () => {
  it("maps the band curve", () => {
    expect(expectedCtr(1)).toBe(0.28);
    expect(expectedCtr(2)).toBe(0.15);
    expect(expectedCtr(3)).toBe(0.1);
    expect(expectedCtr(4)).toBe(0.07);
    expect(expectedCtr(5)).toBe(0.05);
    expect(expectedCtr(6)).toBe(0.03);
    expect(expectedCtr(10)).toBe(0.03);
    expect(expectedCtr(11)).toBe(0.015);
  });

  it("rounds fractional positions to the nearest band, p20 in / p21 out", () => {
    expect(expectedCtr(20.4)).toBe(0.015);
    // 20.5 rounds to 21 — past page two, CTR is noise and no band applies.
    expect(expectedCtr(20.5)).toBeNull();
    expect(expectedCtr(21)).toBeNull();
    // GSC positions start at 1, but a sub-1 float must not fall off the curve.
    expect(expectedCtr(0.9)).toBe(0.28);
  });
});

describe("brand exclusion", () => {
  it("tokenizes the project name and stems the domain", () => {
    expect(brandTokens("Acme Coffee", "https://www.acme.com/blog")).toEqual([
      "acme",
      "coffee",
    ]);
  });

  it("prefers the longest label over a multi-part TLD fragment", () => {
    expect(brandTokens("X", "acme.co.uk")).toEqual(["acme"]);
  });

  it("drops sub-3-char tokens that would match half the dictionary", () => {
    expect(brandTokens("io", "io.io")).toEqual([]);
  });

  it("matches as substring — brand queries concatenate", () => {
    expect(isBrandQuery("acmeapp login", ["acme"])).toBe(true);
    expect(isBrandQuery("best espresso grinder", ["acme"])).toBe(false);
  });
});

describe("computeRetitleCandidates", () => {
  const urls = pagesByUrl([["https://acme.com/a", page("cp_a", "/a")]]);
  const base = {
    pagesByUrl: urls,
    brandTokens: ["acme"],
    recentDecisions: [],
    now: "2026-07-31T00:00:00.000Z",
  };

  it("fires exactly at the 55%-of-expected boundary, not above it", () => {
    // Position 3 expects 10% CTR; 5.5% is the boundary, 5.6% is not.
    const at = computeRetitleCandidates({
      ...base,
      aggregates: [aggregate({ clicks: 55, impressions: 1000 })],
    });
    expect(at).toHaveLength(1);
    const above = computeRetitleCandidates({
      ...base,
      aggregates: [aggregate({ clicks: 56, impressions: 1000 })],
    });
    expect(above).toHaveLength(0);
  });

  it("enforces the 100-impression floor", () => {
    const under = computeRetitleCandidates({
      ...base,
      aggregates: [aggregate({ clicks: 0, impressions: 99 })],
    });
    expect(under).toHaveLength(0);
    const met = computeRetitleCandidates({
      ...base,
      aggregates: [aggregate({ clicks: 0, impressions: 100 })],
    });
    expect(met).toHaveLength(1);
  });

  it("skips branded queries and pages outside the inventory", () => {
    const candidates = computeRetitleCandidates({
      ...base,
      aggregates: [
        aggregate({ query: "acme review", clicks: 0, impressions: 5000 }),
        aggregate({
          pageUrl: "https://acme.com/unknown",
          clicks: 0,
          impressions: 5000,
        }),
      ],
    });
    expect(candidates).toHaveLength(0);
  });

  it("emits no signal past position 20 — the curve ends there", () => {
    const candidates = computeRetitleCandidates({
      ...base,
      aggregates: [
        aggregate({ clicks: 0, impressions: 5000, weightedPosition: 25 }),
      ],
    });
    expect(candidates).toHaveLength(0);
  });

  it("folds qualifying queries into one proposal per page, headline by impressions, score summed", () => {
    const candidates = computeRetitleCandidates({
      ...base,
      aggregates: [
        // Recovered: 1000 × (0.10 − 0.05) = 50.
        aggregate({ query: "espresso tamper", clicks: 50, impressions: 1000 }),
        // Higher impressions → headline. Recovered: 2000 × 0.10 = 200.
        aggregate({ query: "espresso dose", clicks: 0, impressions: 2000 }),
      ],
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].title).toBe('Rewrite the title for "espresso dose"');
    expect(candidates[0].score).toBe(250);
    expect(candidates[0].target).toBe("/a");
    // Explainability is a product law — both JSON columns must be populated.
    expect(candidates[0].factors.length).toBeGreaterThan(0);
    expect(candidates[0].evidence[0]).toContain('"espresso dose"');
    expect(candidates[0].evidence[1]).toContain('"espresso tamper"');
  });

  it("suppresses a page whose retitle was decided under 60 days ago", () => {
    const aggregates = [aggregate({ clicks: 0, impressions: 1000 })];
    const at59 = computeRetitleCandidates({
      ...base,
      aggregates,
      recentDecisions: [
        decision({ type: "retitle", decidedAt: "2026-06-02T00:00:00.000Z" }),
      ],
    });
    expect(at59).toHaveLength(0);
    // 61 days out the new title has had its data window — propose again.
    const at61 = computeRetitleCandidates({
      ...base,
      aggregates,
      recentDecisions: [
        decision({ type: "retitle", decidedAt: "2026-05-31T00:00:00.000Z" }),
      ],
    });
    expect(at61).toHaveLength(1);
  });
});

describe("pushProximity", () => {
  it("peaks at 1.5× on position 11 and decays to 1.0× at both band edges", () => {
    expect(pushProximity(11)).toBe(1.5);
    expect(pushProximity(5)).toBe(1);
    expect(pushProximity(20)).toBe(1);
    expect(pushProximity(8)).toBe(1.25);
    expect(pushProximity(15.5)).toBe(1.25);
  });
});

describe("computePushCandidates", () => {
  const urls = pagesByUrl([["https://acme.com/a", page("cp_a", "/a")]]);
  const base = {
    pagesByUrl: urls,
    brandTokens: ["acme"],
    recentDecisions: [],
    now: "2026-07-31T00:00:00.000Z",
  };

  it("scores engine base times proximity", () => {
    const candidates = computePushCandidates({
      ...base,
      // Volume imputed from impressions: score(90) = log10(100) = 2.0 —
      // times the 1.5× peak at position 11 → 3.0.
      aggregates: [
        aggregate({ clicks: 1, impressions: 90, weightedPosition: 11 }),
      ],
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].score).toBe(3);
    expect(candidates[0].title).toBe(
      'Push "best espresso grinder" from position 11.0',
    );
    expect(candidates[0].factors).toHaveLength(3);
    expect(candidates[0].evidence).toEqual([
      "pos 11.0",
      "90 impr",
      '"best espresso grinder"',
    ]);
  });

  it("enforces the 30-impression floor and the 5–20 band edges", () => {
    const make = (impressions: number, weightedPosition: number) =>
      computePushCandidates({
        ...base,
        aggregates: [aggregate({ clicks: 1, impressions, weightedPosition })],
      });
    expect(make(29, 11)).toHaveLength(0);
    expect(make(30, 11)).toHaveLength(1);
    expect(make(100, 4.9)).toHaveLength(0);
    expect(make(100, 5)).toHaveLength(1);
    expect(make(100, 20)).toHaveLength(1);
    expect(make(100, 20.1)).toHaveLength(0);
  });

  it("skips branded queries", () => {
    const candidates = computePushCandidates({
      ...base,
      aggregates: [
        aggregate({
          query: "acme grinder",
          clicks: 1,
          impressions: 100,
          weightedPosition: 11,
        }),
      ],
    });
    expect(candidates).toHaveLength(0);
  });

  it("suppresses a page whose push is still inside its receipt's 42-day window", () => {
    // Executed 41 days ago: the receipt closes tomorrow, and a second
    // execution now is exactly what isContaminated would kill it for.
    const candidates = computePushCandidates({
      ...base,
      aggregates: [
        aggregate({ clicks: 1, impressions: 100, weightedPosition: 11 }),
      ],
      recentDecisions: [
        decision({ type: "push", executedAt: "2026-06-20T00:00:00.000Z" }),
      ],
    });
    expect(candidates).toHaveLength(0);
  });

  it("suppresses a declined push — a no the engine must not re-litigate", () => {
    const candidates = computePushCandidates({
      ...base,
      aggregates: [
        aggregate({ clicks: 1, impressions: 100, weightedPosition: 11 }),
      ],
      // No executedAt and no receipt: only decidedAt can hold this back.
      recentDecisions: [
        decision({ type: "push", decidedAt: "2026-07-21T00:00:00.000Z" }),
      ],
    });
    expect(candidates).toHaveLength(0);
  });
});

describe("computeRefreshCandidates", () => {
  // Watermark 2026-07-27: trailing window opens 2026-06-30, prior window
  // opens 2026-06-02.
  const windowEnd = "2026-07-27";
  const url = "https://acme.com/old-post";
  const urls = pagesByUrl([[url, page("cp_old", "/old-post", "2024-01-15")]]);

  function decayedDays(): PageDayRow[] {
    return [
      // Prior window: 100 clicks / 2000 impressions.
      { pageUrl: url, date: "2026-06-05", clicks: 50, impressions: 1000 },
      { pageUrl: url, date: "2026-06-10", clicks: 50, impressions: 1000 },
      // Trailing window: 70 clicks / 1500 impressions — exactly the 0.7
      // boundary, and demand fell too.
      { pageUrl: url, date: "2026-07-10", clicks: 35, impressions: 800 },
      { pageUrl: url, date: "2026-07-20", clicks: 35, impressions: 700 },
    ];
  }

  const base = {
    pagesByUrl: urls,
    earliestStoredDate: "2026-05-01",
    windowEnd,
    sentinel: SENTINEL,
    recentDecisions: [],
    now: "2026-07-31T00:00:00.000Z",
  };

  it("fires on real decay, scored in lost clicks, inclusive of the 0.7 boundary", () => {
    const candidates = computeRefreshCandidates({
      ...base,
      pageDays: decayedDays(),
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].score).toBe(30);
    expect(candidates[0].title).toBe(
      "Refresh — clicks down 30% against the prior 28 days",
    );
    expect(candidates[0].evidence).toContain("clicks 100 → 70");
    expect(candidates[0].factors.length).toBeGreaterThan(0);
  });

  it("suppresses everything on thin memory — under 8 stored weeks", () => {
    const candidates = computeRefreshCandidates({
      ...base,
      pageDays: decayedDays(),
      // Backfill started mid-prior-window: the "decline" would just be the
      // backfill's start date.
      earliestStoredDate: "2026-06-10",
    });
    expect(candidates).toHaveLength(0);
  });

  it("suppresses young pages and pages with no publish date", () => {
    const young = computeRefreshCandidates({
      ...base,
      pageDays: decayedDays(),
      pagesByUrl: pagesByUrl([
        [url, page("cp_old", "/old-post", "2026-05-01")],
      ]),
    });
    expect(young).toHaveLength(0);
    const undated = computeRefreshCandidates({
      ...base,
      pageDays: decayedDays(),
      pagesByUrl: pagesByUrl([[url, page("cp_old", "/old-post", null)]]),
    });
    expect(undated).toHaveLength(0);
  });

  it("suppresses a clicks-only decline — flat impressions mean a CTR problem, not decay", () => {
    const days = decayedDays().map((day) =>
      day.date >= "2026-06-30" ? { ...day, impressions: 1000 } : day,
    );
    expect(computeRefreshCandidates({ ...base, pageDays: days })).toHaveLength(
      0,
    );
  });

  it("suppresses pages that never had a 10-click week", () => {
    const days = decayedDays().map((day) => ({
      ...day,
      clicks: Math.floor(day.clicks / 10),
    }));
    expect(computeRefreshCandidates({ ...base, pageDays: days })).toHaveLength(
      0,
    );
  });

  it("suppresses a page refreshed inside its receipt's 42-day window", () => {
    const candidates = computeRefreshCandidates({
      ...base,
      pageDays: decayedDays(),
      recentDecisions: [
        decision({
          type: "refresh",
          target: "/old-post",
          executedAt: "2026-07-01T00:00:00.000Z",
        }),
      ],
    });
    expect(candidates).toHaveLength(0);
  });

  it("ignores sentinel page rows", () => {
    const days = decayedDays().map((day) => ({ ...day, pageUrl: SENTINEL }));
    expect(computeRefreshCandidates({ ...base, pageDays: days })).toHaveLength(
      0,
    );
  });
});
