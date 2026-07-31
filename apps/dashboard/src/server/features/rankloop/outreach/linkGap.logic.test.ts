import { describe, expect, it } from "vitest";
import {
  computeLinkGap,
  matchAssetPage,
  type LinkGapSourceRow,
  type LinkGapTarget,
} from "./linkGap.logic";

function row(overrides: Partial<LinkGapSourceRow> = {}): LinkGapSourceRow {
  return {
    competitorId: "comp_1",
    competitorDomain: "rival-one.example",
    domain: "coffee-journal.example",
    domainRank: 50,
    backlinks: 3,
    ...overrides,
  };
}

function gap(rows: LinkGapSourceRow[], ourDomains: string[] = []) {
  return computeLinkGap({
    competitorDomains: rows,
    ourDomains,
    ourDomain: "our-site.example",
  });
}

describe("computeLinkGap", () => {
  it("keeps a domain linking to two competitors and drops one linking to a single competitor", () => {
    const targets = gap([
      row({ domain: "shared.example", competitorId: "comp_1" }),
      row({
        domain: "shared.example",
        competitorId: "comp_2",
        competitorDomain: "rival-two.example",
      }),
      row({ domain: "lonely.example", competitorId: "comp_1" }),
    ]);

    expect(targets.map((target) => target.domain)).toEqual(["shared.example"]);
    expect(targets[0].competitorCount).toBe(2);
    expect(targets[0].evidence.map((entry) => entry.competitorDomain)).toEqual([
      "rival-one.example",
      "rival-two.example",
    ]);
  });

  it("counts a competitor once however many rows it has for the same domain", () => {
    const targets = gap([
      row({ domain: "shared.example", competitorId: "comp_1" }),
      row({ domain: "shared.example", competitorId: "comp_1", backlinks: 9 }),
      row({ domain: "www.SHARED.example.", competitorId: "comp_1" }),
      row({ domain: "shared.example", competitorId: "comp_2" }),
    ]);

    expect(targets[0].competitorCount).toBe(2);
    expect(targets[0].evidence).toHaveLength(2);
  });

  it("drops domains that already link to us", () => {
    const rows = [
      row({ domain: "shared.example", competitorId: "comp_1" }),
      row({ domain: "shared.example", competitorId: "comp_2" }),
    ];

    expect(gap(rows, ["www.shared.example"])).toEqual([]);
  });

  it("drops our own domain and anything under it", () => {
    const targets = gap([
      row({ domain: "our-site.example", competitorId: "comp_1" }),
      row({ domain: "our-site.example", competitorId: "comp_2" }),
      row({ domain: "docs.our-site.example", competitorId: "comp_1" }),
      row({ domain: "docs.our-site.example", competitorId: "comp_2" }),
    ]);

    expect(targets).toEqual([]);
  });

  it("drops the platforms nobody can pitch, subdomains included", () => {
    const targets = gap([
      row({ domain: "facebook.com", competitorId: "comp_1" }),
      row({ domain: "facebook.com", competitorId: "comp_2" }),
      row({ domain: "en.wikipedia.org", competitorId: "comp_1" }),
      row({ domain: "en.wikipedia.org", competitorId: "comp_2" }),
      // A real publisher whose name merely reads like a platform stays.
      row({ domain: "search.roasters.example", competitorId: "comp_1" }),
      row({ domain: "search.roasters.example", competitorId: "comp_2" }),
    ]);

    expect(targets.map((target) => target.domain)).toEqual([
      "search.roasters.example",
    ]);
  });

  it("never treats a competitor's own subdomain as a gap target", () => {
    const targets = gap([
      row({ domain: "blog.rival-one.example", competitorId: "comp_1" }),
      row({
        domain: "blog.rival-one.example",
        competitorId: "comp_2",
        competitorDomain: "rival-two.example",
      }),
    ]);

    // comp_1's own subdomain contributes nothing, so the domain is left with
    // a single competitor and falls under the 2+ rule.
    expect(targets).toEqual([]);
  });

  it("ranks by competitor count, then domain rank, then domain name", () => {
    const targets = gap([
      row({ domain: "b.example", competitorId: "comp_1", domainRank: 10 }),
      row({ domain: "b.example", competitorId: "comp_2", domainRank: 10 }),
      row({ domain: "a.example", competitorId: "comp_1", domainRank: 10 }),
      row({ domain: "a.example", competitorId: "comp_2", domainRank: 10 }),
      row({ domain: "high.example", competitorId: "comp_1", domainRank: 90 }),
      row({ domain: "high.example", competitorId: "comp_2", domainRank: 90 }),
      row({ domain: "three.example", competitorId: "comp_1", domainRank: 1 }),
      row({ domain: "three.example", competitorId: "comp_2", domainRank: 1 }),
      row({ domain: "three.example", competitorId: "comp_3", domainRank: 1 }),
    ]);

    expect(targets.map((target) => target.domain)).toEqual([
      "three.example",
      "high.example",
      "a.example",
      "b.example",
    ]);
  });

  it("keeps the highest rank reported for a domain", () => {
    const targets = gap([
      row({ domain: "shared.example", competitorId: "comp_1", domainRank: 12 }),
      row({ domain: "shared.example", competitorId: "comp_2", domainRank: 71 }),
    ]);

    expect(targets[0].domainRank).toBe(71);
  });

  it("caps the board at 100 targets", () => {
    const rows = Array.from({ length: 130 }, (_, index) => index).flatMap(
      (index) => [
        row({ domain: `site-${index}.example`, competitorId: "comp_1" }),
        row({ domain: `site-${index}.example`, competitorId: "comp_2" }),
      ],
    );

    expect(gap(rows)).toHaveLength(100);
  });
});

// ---------------------------------------------------------------------------

function gapTarget(overrides: Partial<LinkGapTarget> = {}): LinkGapTarget {
  return {
    domain: "espresso-journal.example",
    domainRank: 40,
    competitorCount: 2,
    evidence: [
      {
        competitorId: "comp_1",
        competitorDomain: "rival-one.example",
        backlinks: 2,
        targetUrl: null,
        anchor: null,
      },
    ],
    ...overrides,
  };
}

const pages = [
  { id: "page_1", path: "/blog/espresso-tamper-guide", title: "Tamper guide" },
  { id: "page_2", path: "/pricing", title: "Pricing" },
  { id: "page_3", path: "/blog/espresso-consumption-statistics", title: null },
];

describe("matchAssetPage", () => {
  it("matches on the competitor URLs when the evidence names them", () => {
    const match = matchAssetPage({
      target: gapTarget({
        evidence: [
          {
            competitorId: "comp_1",
            competitorDomain: "rival-one.example",
            backlinks: 1,
            targetUrl: "https://rival-one.example/guides/espresso-tamper",
            anchor: null,
          },
        ],
      }),
      pages,
    });

    expect(match?.pageId).toBe("page_1");
    expect(match?.matchType.reason).toBe("linked_url_tokens");
    expect(match?.matchType.tokens).toEqual(["espresso", "tamper"]);
    expect(match?.matchType.shape).toBe("guide");
  });

  it("falls back to the linking domain's own name when no URL is known", () => {
    const match = matchAssetPage({ target: gapTarget(), pages });

    // "espresso" from espresso-journal.example; the public suffix is dropped.
    expect(match?.matchType.reason).toBe("domain_tokens");
    expect(match?.matchType.tokens).toEqual(["espresso"]);
    // Both blog pages share exactly one token, so the citable shape breaks
    // the tie in favour of the statistics page.
    expect(match?.pageId).toBe("page_3");
    expect(match?.matchType.shape).toBe("data");
  });

  it("returns nothing rather than a guess when no page overlaps", () => {
    expect(
      matchAssetPage({
        target: gapTarget({ domain: "tractors.example" }),
        pages,
      }),
    ).toBeNull();
  });

  it("returns nothing when the domain name carries no usable token", () => {
    expect(
      matchAssetPage({ target: gapTarget({ domain: "www.example" }), pages }),
    ).toBeNull();
  });

  it("breaks score ties on path so a recompute picks the same page twice", () => {
    const tied = [
      { id: "page_b", path: "/blog/espresso-basics", title: null },
      { id: "page_a", path: "/blog/espresso-advanced", title: null },
    ];

    expect(matchAssetPage({ target: gapTarget(), pages: tied })?.pageId).toBe(
      "page_a",
    );
  });
});
