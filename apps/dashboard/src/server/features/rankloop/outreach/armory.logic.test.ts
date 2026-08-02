// The board's value is that every row is worth a human's morning. These
// tests are the cases where a plausible implementation puts unwinnable work
// on the first screen, or loses a target by merging it into another.

import { describe, expect, it } from "vitest";
import {
  attainability,
  classifyTarget,
  dedupeCandidates,
  isNonTarget,
  looksSubmittable,
  miningQueries,
  rankTargets,
  scoreTarget,
  targetKey,
  type ArmoryCandidate,
} from "./armory.logic";

function candidate(over: Partial<ArmoryCandidate> = {}): ArmoryCandidate {
  return {
    domain: "example.com",
    lane: "serp",
    kind: "listicle",
    submissionUrl: null,
    evidence: "ranks for best crm tools",
    domainRank: 40,
    competitorCount: 0,
    ...over,
  };
}

describe("classifyTarget()", () => {
  it("reads a submission form as a directory even inside a roundup URL", () => {
    // `/best-crm-tools/submit` is a form to the person filling it in, not an
    // article to pitch. Getting this backwards sends them to write an email
    // when there was a button.
    expect(classifyTarget("https://x.example/best-crm-tools/submit")).toBe(
      "directory",
    );
  });

  it("recognises roundups", () => {
    expect(classifyTarget("https://x.example/best-crm-software/")).toBe("listicle");
    expect(classifyTarget("https://x.example/notion-alternatives")).toBe("listicle");
  });

  it("recognises directories", () => {
    expect(classifyTarget("https://x.example/directory/crm")).toBe("directory");
    expect(classifyTarget("https://x.example/tools/crm")).toBe("directory");
  });

  it("recognises blog posts", () => {
    expect(classifyTarget("https://x.example/blog/how-we-scaled")).toBe("blog");
  });

  it("calls a roundup published on a blog a roundup", () => {
    // "10 best CRM tools" at /blog/best-crm-tools is exactly the page worth
    // asking to be added to. Filing it as a blog post loses it.
    expect(classifyTarget("https://x.example/blog/best-crm-tools")).toBe("listicle");
  });

  it("does not mistake a best-practices post for a roundup", () => {
    // The one false positive `best-` reliably produces.
    expect(classifyTarget("https://x.example/blog/best-practices-for-crm")).toBe(
      "blog",
    );
  });

  it("falls back to resource page", () => {
    expect(classifyTarget("https://x.example/resources")).toBe("resource_page");
  });

  it("does not throw on a malformed URL", () => {
    expect(classifyTarget("not a url")).toBe("resource_page");
  });
});

describe("filters that keep unwinnable rows off the board", () => {
  it("drops pages nobody can be pitched", () => {
    // A row that cannot succeed is worse than no row: it costs a human the
    // time to work out that it cannot succeed.
    for (const path of ["/login", "/pricing", "/terms", "/checkout"]) {
      expect(isNonTarget(`https://x.example${path}`), path).toBe(true);
    }
  });

  it("keeps real submission pages", () => {
    expect(isNonTarget("https://x.example/submit")).toBe(false);
    expect(looksSubmittable("https://x.example/submit")).toBe(true);
    expect(looksSubmittable("https://x.example/add-listing/")).toBe(true);
  });

  it("does not call an ordinary page submittable", () => {
    expect(looksSubmittable("https://x.example/blog/hello")).toBe(false);
  });
});

describe("targetKey()", () => {
  it("collapses www and casing", () => {
    expect(targetKey("https://WWW.Example.com/submit")).toBe("example.com");
    expect(targetKey("www.example.com")).toBe("example.com");
  });

  it("keeps subdomains distinct", () => {
    // blog.example.com and example.com have different editors. Collapsing
    // them silently loses one of two real targets.
    expect(targetKey("blog.example.com")).not.toBe(targetKey("example.com"));
  });
});

describe("dedupeCandidates()", () => {
  it("merges lanes instead of listing a domain twice", () => {
    const merged = dedupeCandidates([
      candidate({ domain: "g2.com", lane: "link_gap", competitorCount: 3, evidence: "links to 3 competitors" }),
      candidate({ domain: "www.g2.com", lane: "seed", submissionUrl: "https://g2.com/products/new", evidence: "curated directory" }),
    ]);
    expect(merged).toHaveLength(1);
  });

  it("keeps facts from both lanes", () => {
    // A seed target that competitors also link to is the strongest kind of
    // row; dropping either half makes it look ordinary.
    const [row] = dedupeCandidates([
      candidate({ domain: "g2.com", lane: "link_gap", competitorCount: 3, submissionUrl: null, evidence: "links to 3 competitors" }),
      candidate({ domain: "g2.com", lane: "seed", competitorCount: 0, submissionUrl: "https://g2.com/products/new", evidence: "curated directory" }),
    ]);
    expect(row?.lane).toBe("seed");
    expect(row?.submissionUrl).toBe("https://g2.com/products/new");
    expect(row?.competitorCount).toBe(3);
    expect(row?.evidence).toContain("links to 3 competitors");
    expect(row?.evidence).toContain("curated directory");
  });

  it("does not duplicate identical evidence", () => {
    const [row] = dedupeCandidates([
      candidate({ domain: "g2.com", lane: "seed", evidence: "curated directory" }),
      candidate({ domain: "g2.com", lane: "serp", evidence: "curated directory" }),
    ]);
    expect(row?.evidence).toBe("curated directory");
  });
});

describe("attainability()", () => {
  const base = {
    kind: "directory" as const,
    submissionUrl: null,
    competitorCount: 0,
    domainRank: null,
    yourDomainRank: null,
  };

  it("rewards a form over an editorial pitch", () => {
    const form = attainability({ ...base, submissionUrl: "https://x.example/submit" });
    expect(form).toBeGreaterThan(attainability(base));
  });

  it("treats two competitors on a page as proof the category is accepted", () => {
    expect(attainability({ ...base, competitorCount: 2 })).toBeGreaterThan(
      attainability({ ...base, competitorCount: 0 }),
    );
  });

  it("penalises a domain far stronger than yours", () => {
    // The instinct is to sort by domain rank, which puts the least winnable
    // rows on the first screen. A DR 80 site is not a better target for a
    // DR 15 site, it is a worse one.
    const reachable = attainability({ ...base, domainRank: 25, yourDomainRank: 15 });
    const outOfLeague = attainability({ ...base, domainRank: 80, yourDomainRank: 15 });
    expect(outOfLeague).toBeLessThan(reachable);
  });

  it("stays within 0 and 1", () => {
    const max = attainability({
      kind: "directory",
      submissionUrl: "https://x.example/submit",
      competitorCount: 5,
      domainRank: 10,
      yourDomainRank: 60,
    });
    expect(max).toBeLessThanOrEqual(1);
    expect(max).toBeGreaterThanOrEqual(0);
  });
});

describe("scoreTarget()", () => {
  it("does not zero an unranked but perfectly submittable directory", () => {
    // Plenty of good directories carry no domain rank. Multiplying by a
    // missing rank would bury exactly the rows a new site can actually win.
    const scored = scoreTarget(
      candidate({ domainRank: null, submissionUrl: "https://x.example/submit", kind: "directory" }),
      10,
    );
    expect(scored.score).toBeGreaterThan(0);
  });

  it("explains itself in the user's words", () => {
    const scored = scoreTarget(
      candidate({ competitorCount: 3, submissionUrl: "https://x.example/submit", domainRank: 55 }),
      10,
    );
    expect(scored.why).toContain("lists 3 of your competitors");
    expect(scored.why).toContain("takes submissions directly");
  });

  it("says something useful even with no evidence at all", () => {
    const scored = scoreTarget(
      candidate({ competitorCount: 0, submissionUrl: null, domainRank: null }),
      10,
    );
    expect(scored.why.length).toBeGreaterThan(0);
  });
});

describe("rankTargets()", () => {
  it("puts a winnable directory above an out-of-league roundup", () => {
    const ranked = rankTargets(
      [
        candidate({ domain: "huge.example", kind: "listicle", domainRank: 90, competitorCount: 0 }),
        candidate({
          domain: "reachable.example",
          kind: "directory",
          domainRank: 35,
          competitorCount: 3,
          submissionUrl: "https://reachable.example/submit",
          lane: "seed",
        }),
      ],
      12,
    );
    expect(ranked[0]?.domain).toBe("reachable.example");
  });

  it("dedupes as part of ranking", () => {
    const ranked = rankTargets(
      [candidate({ domain: "g2.com" }), candidate({ domain: "www.g2.com", lane: "seed" })],
      12,
    );
    expect(ranked).toHaveLength(1);
  });
});

describe("miningQueries()", () => {
  it("asks for the lists the incumbents are on, not the incumbents", () => {
    const queries = miningQueries("CRM", 2026);
    expect(queries).toContain("best crm tools");
    expect(queries).toContain("crm alternatives");
    expect(queries).toContain("submit crm");
    expect(queries).toContain("crm tools 2026");
  });

  it("returns nothing for an empty category rather than querying for junk", () => {
    // A blank noun would spend SERP calls on "best  tools".
    expect(miningQueries("  ", 2026)).toEqual([]);
  });
});
