import { describe, expect, it } from "vitest";
import type { LinkGapTarget } from "./linkGap.logic";
import { chooseTemplateKind, renderDraftMessage } from "./templates.logic";

// The spec's ceiling. Every shape has to land under it with the longest
// realistic substitutions, not just the short ones.
const MAX_DRAFT_WORDS = 120;

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function target(overrides: Partial<LinkGapTarget> = {}): LinkGapTarget {
  return {
    domain: "espresso-journal.example",
    domainRank: 44,
    competitorCount: 2,
    evidence: [
      {
        competitorId: "comp_1",
        competitorDomain: "rival-one.example",
        backlinks: 3,
        targetUrl: null,
        anchor: null,
      },
      {
        competitorId: "comp_2",
        competitorDomain: "rival-two.example",
        backlinks: 1,
        targetUrl: null,
        anchor: null,
      },
    ],
    ...overrides,
  };
}

const asset = {
  path: "/blog/espresso-tamper-guide",
  url: "https://our-site.example/blog/espresso-tamper-guide",
  title: "How to choose an espresso tamper",
};

describe("chooseTemplateKind", () => {
  it("offers a data-shaped asset as a citation", () => {
    expect(chooseTemplateKind("data")).toBe("data_citation");
  });

  it("pitches guides and ordinary pages as resources", () => {
    expect(chooseTemplateKind("guide")).toBe("resource_page");
    expect(chooseTemplateKind("page")).toBe("resource_page");
  });

  it("has no template for a target with nothing of ours to point at", () => {
    expect(chooseTemplateKind(null)).toBeNull();
  });
});

describe("renderDraftMessage — resource_page", () => {
  const draft = renderDraftMessage({
    kind: "resource_page",
    siteName: "Our Site",
    target: target(),
    asset,
  });

  it("quotes the competitors the domain links to and names the asset", () => {
    expect(draft).toContain("espresso-journal.example");
    expect(draft).toContain("rival-one.example and rival-two.example");
    expect(draft).toContain("How to choose an espresso tamper");
    expect(draft).toContain(asset.url);
  });

  it("leaves the comparison to the sender instead of inventing one", () => {
    expect(draft).toContain("[One line on what yours adds");
  });

  it("opens without flattery and ends without a hard ask", () => {
    expect(draft?.startsWith("Hi — I run Our Site.")).toBe(true);
    expect(draft).toContain("No reply needed");
    expect(draft).not.toMatch(/love|great|amazing|huge fan/i);
  });

  it("stays under the word ceiling", () => {
    expect(wordCount(draft ?? "")).toBeLessThanOrEqual(MAX_DRAFT_WORDS);
  });

  it("names the linked page when a per-link source knew it", () => {
    const withUrl = renderDraftMessage({
      kind: "resource_page",
      siteName: "Our Site",
      target: target({
        evidence: [
          {
            competitorId: "comp_1",
            competitorDomain: "rival-one.example",
            backlinks: 1,
            targetUrl: "https://rival-one.example/guides/tampers",
            anchor: null,
          },
        ],
      }),
      asset,
    });

    expect(withUrl).toContain("rival-one.example/guides/tampers");
  });
});

describe("renderDraftMessage — data_citation", () => {
  it("leads with the figure the title carries", () => {
    const draft = renderDraftMessage({
      kind: "data_citation",
      siteName: "Our Site",
      target: target(),
      asset: {
        path: "/blog/espresso-statistics",
        url: "https://our-site.example/blog/espresso-statistics",
        title: "62% of home baristas regrind — 2026 survey",
      },
    });

    expect(draft?.split("\n\n")[1].startsWith("62%")).toBe(true);
    expect(draft).toContain("Cite it if it's ever useful.");
    expect(wordCount(draft ?? "")).toBeLessThanOrEqual(MAX_DRAFT_WORDS);
  });

  it("leads with the page when the title carries no number", () => {
    const draft = renderDraftMessage({
      kind: "data_citation",
      siteName: "Our Site",
      target: target(),
      asset: {
        path: "/blog/espresso-survey",
        url: "https://our-site.example/blog/espresso-survey",
        title: null,
      },
    });

    // No title, so the path is the handle — and no figure is invented.
    expect(draft).toContain("/blog/espresso-survey (");
    expect(draft).not.toMatch(/headline number/);
  });
});

describe("renderDraftMessage — broken_link", () => {
  it("writes nothing, because S4b cannot know a link is dead", () => {
    expect(
      renderDraftMessage({
        kind: "broken_link",
        siteName: "Our Site",
        target: target(),
        asset,
      }),
    ).toBeNull();
  });
});
