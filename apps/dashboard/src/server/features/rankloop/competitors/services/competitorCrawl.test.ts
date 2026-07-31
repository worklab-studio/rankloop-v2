import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  repo: {
    updateCompetitorPageFeatures: vi.fn(),
  },
}));

vi.mock(
  "@/server/features/rankloop/competitors/repositories/CompetitorsRepository",
  () => ({ CompetitorsRepository: mocks.repo }),
);

import {
  crawlFeatureBatch,
  isBlockedBatch,
  pickEvenlySpaced,
  studySitemap,
  type CrawledFeature,
} from "./competitorCrawl";

const fetchMock = vi.fn<typeof fetch>();

function xml(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "application/xml" },
  });
}

function html(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/html" },
    ...init,
  });
}

/** Route the mock by URL so the order discovery fetches in doesn't matter. */
function routeFetch(routes: Record<string, () => Response>) {
  fetchMock.mockImplementation((input) => {
    if (typeof input !== "string") {
      // Discovery and the page fetch both pass plain URL strings; anything
      // else means the code under test changed shape.
      throw new Error("expected the code under test to fetch a URL string");
    }
    const route = routes[input];
    if (!route) return Promise.resolve(new Response("", { status: 404 }));
    return Promise.resolve(route());
  });
}

const SITEMAP = `<?xml version="1.0"?>
<urlset>
  <url><loc>https://acme.com/blog/one</loc><lastmod>2026-07-02</lastmod></url>
  <url><loc>https://acme.com/blog/two</loc><lastmod>2026-06-11</lastmod></url>
  <url><loc>https://acme.com/blog/three</loc><lastmod>2026-06-20</lastmod></url>
  <url><loc>https://acme.com/blog/private</loc><lastmod>2026-06-21</lastmod></url>
  <url><loc>https://acme.com/pricing</loc></url>
  <url><loc>https://acme.com/tag/seo</loc></url>
</urlset>`;

beforeEach(() => {
  fetchMock.mockReset();
  mocks.repo.updateCompetitorPageFeatures.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("studySitemap", () => {
  it("derives cadence, mix and a crawl plan from robots plus the sitemap", async () => {
    routeFetch({
      "https://acme.com/robots.txt": () =>
        new Response("User-agent: *\nDisallow: /blog/private\n", {
          status: 200,
        }),
      "https://acme.com/sitemap.xml": () => xml(SITEMAP),
    });

    const study = await studySitemap({
      domain: "acme.com",
      earningUrls: [
        "https://acme.com/blog/one",
        "https://acme.com/blog/private",
      ],
    });

    // Utility shapes never count as content.
    expect(study.contentPageCount).toBe(5);
    expect(study.pageTypeMix).toEqual([
      { pageType: "post", count: 4 },
      { pageType: "page", count: 1 },
      { pageType: "other", count: 1 },
    ]);
    // Cadence counts posts, and only the ones carrying a lastmod.
    expect(study.cadence).toHaveLength(24);
    expect(
      study.cadence.reduce((total, bucket) => total + bucket.count, 0),
    ).toBe(4);

    // robots.txt is obeyed on both halves of the plan.
    expect(study.winnerUrls).toEqual(["https://acme.com/blog/one"]);
    expect(study.sampleUrls).not.toContain("https://acme.com/blog/private");
    // Winners are never sampled twice.
    expect(study.sampleUrls).not.toContain("https://acme.com/blog/one");
  });

  it("still produces cadence and mix when robots.txt is missing", async () => {
    routeFetch({ "https://acme.com/sitemap.xml": () => xml(SITEMAP) });

    const study = await studySitemap({ domain: "acme.com", earningUrls: [] });

    expect(study.contentPageCount).toBe(5);
    expect(study.sampleUrls.length).toBeGreaterThan(0);
  });

  it("returns an empty study rather than throwing when there is no sitemap", async () => {
    routeFetch({});

    const study = await studySitemap({ domain: "acme.com", earningUrls: [] });

    expect(study.contentPageCount).toBe(0);
    expect(study.pageTypeMix).toEqual([]);
    expect(study.winnerUrls).toEqual([]);
    expect(study.sampleUrls).toEqual([]);
  });
});

describe("pickEvenlySpaced", () => {
  it("spans the list instead of taking its head", () => {
    const items = Array.from({ length: 10 }, (_, index) => index);

    expect(pickEvenlySpaced(items, 3)).toEqual([0, 3, 6]);
  });

  it("returns everything when there is less than asked for", () => {
    expect(pickEvenlySpaced([1, 2], 5)).toEqual([1, 2]);
  });
});

describe("crawlFeatureBatch", () => {
  it("extracts features from the pages it reads and persists them", async () => {
    routeFetch({
      "https://acme.com/blog/one": () =>
        html(
          '<html><h2>What is it?</h2><h3>How?</h3><h2>Why?</h2><img src="a"><p>one two three</p></html>',
        ),
      "https://acme.com/blog/two": () => new Response("nope", { status: 403 }),
    });

    const results = await crawlFeatureBatch({
      competitorId: "comp_1",
      batch: [
        { url: "https://acme.com/blog/one", cohort: "winner" },
        { url: "https://acme.com/blog/two", cohort: "sample" },
      ],
    });

    expect(results[0].features?.faqBlock).toBe(true);
    expect(results[0].features?.mediaCount).toBe(1);
    expect(results[0].blocked).toBe(false);
    // A 403 is a block: no features, and the batch may degrade the study.
    expect(results[1].features).toBeNull();
    expect(results[1].blocked).toBe(true);

    expect(mocks.repo.updateCompetitorPageFeatures).toHaveBeenCalledWith([
      expect.objectContaining({
        competitorId: "comp_1",
        url: "https://acme.com/blog/one",
      }),
    ]);
  });

  it("treats a Cloudflare interstitial as a block, not as page content", async () => {
    routeFetch({
      "https://acme.com/blog/one": () =>
        html("<html><title>Just a moment...</title></html>", { status: 503 }),
    });

    const results = await crawlFeatureBatch({
      competitorId: "comp_1",
      batch: [{ url: "https://acme.com/blog/one", cohort: "winner" }],
    });

    expect(results[0].blocked).toBe(true);
    expect(results[0].features).toBeNull();
    expect(mocks.repo.updateCompetitorPageFeatures).not.toHaveBeenCalled();
  });

  it("does not call a 404 a block", async () => {
    routeFetch({});

    const results = await crawlFeatureBatch({
      competitorId: "comp_1",
      batch: [{ url: "https://acme.com/gone", cohort: "winner" }],
    });

    expect(results[0].blocked).toBe(false);
    expect(results[0].features).toBeNull();
  });
});

function result(overrides: Partial<CrawledFeature> = {}): CrawledFeature {
  return {
    url: "https://acme.com/a",
    cohort: "winner",
    features: null,
    blocked: false,
    ...overrides,
  };
}

describe("isBlockedBatch", () => {
  it("degrades the study only when nothing was measured and something blocked", () => {
    expect(isBlockedBatch([result({ blocked: true }), result()])).toBe(true);
  });

  it("keeps crawling when a batch of dead links measured nothing", () => {
    expect(isBlockedBatch([result(), result()])).toBe(false);
  });

  it("keeps crawling when one page blocked but another still read", () => {
    expect(
      isBlockedBatch([
        result({ blocked: true }),
        result({
          features: {
            wordCount: 500,
            mediaCount: 0,
            dataTable: false,
            faqBlock: false,
            byline: false,
            dateModified: false,
          },
        }),
      ]),
    ).toBe(false);
  });

  it("is not a block when there was nothing to crawl", () => {
    expect(isBlockedBatch([])).toBe(false);
  });
});
