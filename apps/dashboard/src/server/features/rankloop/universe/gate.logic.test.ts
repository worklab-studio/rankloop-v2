import { relevant } from "@rankloop/engine";
import { describe, expect, it } from "vitest";
import {
  deriveRelevanceGate,
  normalizeTokenSet,
  POSITIVE_TOKEN_CAP,
  toEngineConfig,
  topicTokens,
} from "./gate.logic";

const project = { name: "Acme Coffee", domain: "acme.com" };

function page(title: string, path: string) {
  return { title, path };
}

describe("topicTokens", () => {
  it("drops function words, short tokens and bare numbers", () => {
    expect(topicTokens("How to descale a Breville in 2024")).toEqual([
      "descale",
      "breville",
    ]);
  });

  it("drops the CMS plumbing that shows up in every URL path", () => {
    // Without this, "blog", "index" and "html" clear a document-frequency bar
    // on any site with a blog and spend three of the forty positive slots.
    expect(topicTokens("/blog/2024/05/espresso-timing/index.html")).toEqual([
      "espresso",
      "timing",
    ]);
  });

  it("counts a repeated word once, so one document votes once", () => {
    expect(topicTokens("espresso espresso espresso")).toEqual(["espresso"]);
  });
});

describe("normalizeTokenSet", () => {
  it("collapses two phrasings of the same question onto one key", () => {
    expect(normalizeTokenSet("how to descale a breville")).toBe(
      normalizeTokenSet("Breville descale, how?"),
    );
  });

  it("is empty for a phrase made entirely of function words", () => {
    expect(normalizeTokenSet("how to")).toBe("");
  });
});

describe("deriveRelevanceGate", () => {
  const evidence = {
    pages: [
      page("Espresso machine descaling guide", "/blog/espresso-descaling/"),
      page("Best espresso grinder", "/blog/best-espresso-grinder/"),
      page("Espresso shot timing", "/blog/espresso-timing/"),
    ],
    queries: ["espresso machine cleaning", "machine descaling tips"],
  };

  it("keeps only tokens carried by three documents, commonest first", () => {
    const gate = deriveRelevanceGate({ evidence, brandTokens: [] });

    // espresso appears in four documents, machine in three; grinder and
    // descaling stop at two, which is a page's opinion rather than the site's.
    expect(gate.positives).toEqual(["espresso", "machine"]);
  });

  it("ships the junk orbit as negatives without asking", () => {
    const gate = deriveRelevanceGate({ evidence, brandTokens: [] });

    expect(gate.negatives).toContain("jobs");
    expect(gate.negatives).toContain("free download");
  });

  it("excludes brand tokens even when every document carries them", () => {
    const gate = deriveRelevanceGate({
      evidence: {
        pages: [
          page("Acme espresso guide", "/acme-espresso/"),
          page("Acme espresso reviews", "/acme-reviews/"),
          page("Acme espresso pricing", "/acme-pricing/"),
        ],
        queries: [],
      },
      brandTokens: ["acme"],
    });

    // The brand is in every title by construction, so it would win the count
    // outright — and a gate positive on the brand admits the whole internet
    // that mentions it.
    expect(gate.positives).not.toContain("acme");
    expect(gate.positives).toContain("espresso");
  });

  it("excludes concatenated brand spellings, not just exact matches", () => {
    const gate = deriveRelevanceGate({
      evidence: {
        pages: [
          page("Acmehq espresso", "/x/"),
          page("Acmehq espresso", "/y/"),
          page("Acmehq espresso", "/z/"),
        ],
        queries: [],
      },
      brandTokens: ["acme"],
    });

    expect(gate.positives).toEqual(["espresso"]);
  });

  it("caps the positives at forty and keeps the commonest", () => {
    const tokens = Array.from({ length: 60 }, (_, i) => `topic${i}alpha`);
    // Every token in three documents; the first ones in four, so the cap has
    // an unambiguous order to keep.
    const pages = [
      page(tokens.join(" "), "/a/"),
      page(tokens.join(" "), "/b/"),
      page(tokens.join(" "), "/c/"),
      page(tokens.slice(0, 10).join(" "), "/d/"),
    ];
    const gate = deriveRelevanceGate({
      evidence: { pages, queries: [] },
      brandTokens: [],
    });

    expect(gate.positives).toHaveLength(POSITIVE_TOKEN_CAP);
    expect(gate.positives.slice(0, 10)).toEqual(tokens.slice(0, 10));
  });

  it("derives nothing from a project that has published nothing", () => {
    const gate = deriveRelevanceGate({
      evidence: { pages: [], queries: [] },
      brandTokens: [],
    });

    expect(gate.positives).toEqual([]);
  });
});

describe("toEngineConfig", () => {
  it("admits what a positive claims and vetoes the junk orbit", () => {
    const gate = deriveRelevanceGate({
      evidence: {
        pages: [
          page("Espresso guide", "/a/"),
          page("Espresso reviews", "/b/"),
          page("Espresso pricing", "/c/"),
        ],
        queries: [],
      },
      brandTokens: [],
    });
    const config = toEngineConfig({ project, ...gate });

    expect(relevant(config, "best espresso machine")).toBe(true);
    expect(relevant(config, "milk frother reviews")).toBe(false);
    // Negatives veto before positives are even consulted.
    expect(relevant(config, "espresso barista jobs")).toBe(false);
  });

  it("admits everything but the junk orbit while the gate is empty", () => {
    // Day one: no pages crawled, no queries earned. Refusing every candidate
    // here would make the first run return nothing and explain nothing.
    const config = toEngineConfig({
      project,
      positives: [],
      negatives: ["casino"],
    });

    expect(relevant(config, "anything at all")).toBe(true);
    expect(relevant(config, "casino bonus")).toBe(false);
  });

  it("treats an edited token as a literal, not a pattern", () => {
    const config = toEngineConfig({
      project,
      positives: ["c++"],
      negatives: [],
    });

    // "c++" is an invalid regex on its own; escaping at this seam is what
    // stops a hand-edited gate from throwing on every keyword it sees.
    expect(relevant(config, "learn c++ fast")).toBe(true);
    expect(relevant(config, "learn rust fast")).toBe(false);
  });
});
