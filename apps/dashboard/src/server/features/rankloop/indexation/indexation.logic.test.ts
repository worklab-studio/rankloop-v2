import { describe, expect, it } from "vitest";
import {
  computeIndexationRate,
  indexationThrottle,
  type CohortPage,
  type UrlCheck,
} from "./indexation.logic";

const TODAY = "2026-08-01";

/** n posts, all published inside the cohort window, url_1 … url_n. */
function cohort(n: number, publishedAt = "2026-07-01"): CohortPage[] {
  return Array.from({ length: n }, (_, i) => ({
    url: `https://acme.com/p${i + 1}`,
    publishedAt,
  }));
}

/** The first `indexed` of `n` pages pass; the rest are crawled, not indexed. */
function checks(n: number, indexed: number): UrlCheck[] {
  return Array.from({ length: n }, (_, i) => ({
    url: `https://acme.com/p${i + 1}`,
    verdict: i < indexed ? "PASS" : "FAIL",
    checkedAt: "2026-07-30T09:00:00.000Z",
  }));
}

function rateOf(pages: CohortPage[], urlChecks: UrlCheck[]) {
  return computeIndexationRate({ pages, checks: urlChecks, today: TODAY });
}

// ---------------------------------------------------------------------------
// The cohort window
// ---------------------------------------------------------------------------

describe("computeIndexationRate", () => {
  it("counts a post the day it turns 7 days old and drops it the day after 45", () => {
    const pages: CohortPage[] = [
      // 6 days old — Google may simply not have got to it yet.
      { url: "https://acme.com/too-new", publishedAt: "2026-07-26" },
      { url: "https://acme.com/edge-young", publishedAt: "2026-07-25" },
      { url: "https://acme.com/edge-old", publishedAt: "2026-06-17" },
      // 46 days old — a verdict on a strategy that may already have changed.
      { url: "https://acme.com/too-old", publishedAt: "2026-06-16" },
    ];
    const urlChecks: UrlCheck[] = pages.map((page) => ({
      url: page.url,
      verdict: "PASS",
      checkedAt: "2026-07-30T09:00:00.000Z",
    }));

    const result = rateOf(pages, urlChecks);

    expect(result.cohort).toBe(2);
    expect(result.indexed).toBe(2);
  });

  it("windows on the publish day, not on the stamp, so an ISO timestamp lands in the same cohort as a bare date", () => {
    const pages = [
      { url: "https://acme.com/a", publishedAt: "2026-07-25T23:40:00.000Z" },
      { url: "https://acme.com/b", publishedAt: "2026-06-17T00:10:00.000Z" },
    ];

    expect(
      rateOf(
        pages,
        pages.map((page) => ({
          url: page.url,
          verdict: "PASS",
          checkedAt: "2026-07-30T09:00:00.000Z",
        })),
      ).cohort,
    ).toBe(2);
  });

  it("reads only the latest check per URL, so a page that has since been indexed counts as indexed", () => {
    const pages = cohort(5);
    const urlChecks: UrlCheck[] = [
      ...checks(5, 5),
      // p1's history: refused three weeks ago, indexed since. The old row
      // stays for the receipts flow; it must not drag the rate down.
      {
        url: "https://acme.com/p1",
        verdict: "FAIL",
        checkedAt: "2026-07-10T09:00:00.000Z",
      },
    ];

    const result = rateOf(pages, urlChecks);

    expect(result).toEqual({ rate: 1, indexed: 5, cohort: 5 });
  });

  it("ignores checks for URLs outside the cohort", () => {
    const result = rateOf(cohort(5), [
      ...checks(5, 5),
      {
        url: "https://acme.com/about",
        verdict: "FAIL",
        checkedAt: "2026-07-30T09:00:00.000Z",
      },
    ]);

    expect(result.cohort).toBe(5);
  });

  it("counts unchecked cohort posts in neither column", () => {
    // 20 published, 6 swept so far: the sweep is 20 URLs a day and a big
    // cohort takes days to cover. Counting the unswept 14 as failures would
    // invent a collapse on the morning the job first runs.
    const result = rateOf(cohort(20), checks(6, 5));

    expect(result).toEqual({ rate: 0.8333, indexed: 5, cohort: 6 });
  });

  // -------------------------------------------------------------------------
  // The 5-post minimum
  // -------------------------------------------------------------------------

  it("returns null rather than 100% for an engine that has published twice", () => {
    const result = rateOf(cohort(2), checks(2, 2));

    expect(result).toEqual({ rate: null, indexed: 2, cohort: 2 });
  });

  it("returns null with nothing published at all", () => {
    expect(rateOf([], []).rate).toBeNull();
  });

  it("starts answering at the fifth checked post", () => {
    expect(rateOf(cohort(4), checks(4, 4)).rate).toBeNull();
    expect(rateOf(cohort(5), checks(5, 4)).rate).toBe(0.8);
  });

  it("treats every verdict but PASS as not indexed", () => {
    const result = rateOf(cohort(5), [
      { url: "https://acme.com/p1", verdict: "PASS", checkedAt: "2026-07-30" },
      { url: "https://acme.com/p2", verdict: "FAIL", checkedAt: "2026-07-30" },
      {
        url: "https://acme.com/p3",
        verdict: "NEUTRAL",
        checkedAt: "2026-07-30",
      },
      {
        url: "https://acme.com/p4",
        verdict: "PARTIAL",
        checkedAt: "2026-07-30",
      },
      {
        url: "https://acme.com/p5",
        verdict: "VERDICT_UNSPECIFIED",
        checkedAt: "2026-07-30",
      },
    ]);

    expect(result.indexed).toBe(1);
    expect(result.rate).toBe(0.2);
  });
});

// ---------------------------------------------------------------------------
// The throttle branches
// ---------------------------------------------------------------------------

describe("indexationThrottle", () => {
  it("leaves the engine alone at or above 65%", () => {
    expect(
      indexationThrottle({ rate: 0.65, indexed: 13, cohort: 20 }),
    ).toBeNull();
    expect(
      indexationThrottle({ rate: 0.92, indexed: 23, cohort: 25 }),
    ).toBeNull();
  });

  it("holds the quota at one post below 65%, and says the number", () => {
    expect(indexationThrottle({ rate: 0.52, indexed: 13, cohort: 25 })).toEqual(
      {
        cap: 1,
        reason: "quota held at 1 — 52% of recent posts are indexed",
      },
    );
  });

  it("pauses net-new below 40%", () => {
    expect(indexationThrottle({ rate: 0.3, indexed: 6, cohort: 20 })).toEqual({
      cap: 0,
      reason: "net-new paused — 30% of recent posts are indexed",
    });
  });

  it("throttles rather than pauses at exactly 40%", () => {
    expect(indexationThrottle({ rate: 0.4, indexed: 8, cohort: 20 })?.cap).toBe(
      1,
    );
  });

  it("never throttles on an unknown rate", () => {
    // The alternative reads "we don't know" as "it's bad" and stops every new
    // site's engine on the one day it has nothing to judge and everything to
    // gain from publishing.
    expect(
      indexationThrottle({ rate: null, indexed: 3, cohort: 3 }),
    ).toBeNull();
  });

  it("floors the percentage it prints, so a throttled rate never reads as a healthy one", () => {
    // 0.6499 rounds to 65 — the exact number the rule says should not
    // throttle, printed next to a throttle that is running.
    expect(
      indexationThrottle({ rate: 0.6499, indexed: 649, cohort: 999 })?.reason,
    ).toBe("quota held at 1 — 64% of recent posts are indexed");
    expect(
      indexationThrottle({ rate: 0.3999, indexed: 399, cohort: 999 })?.reason,
    ).toBe("net-new paused — 39% of recent posts are indexed");
  });
});
