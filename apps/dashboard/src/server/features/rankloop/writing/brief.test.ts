import { describe, expect, it } from "vitest";
import { defaultLaws } from "@rankloop/engine";
import type { TemplateContract } from "@/server/features/rankloop/page-plan/contracts.logic";
import {
  assembleBrief,
  blogRootFrom,
  mergeContractLaws,
  parseSerpSnapshot,
  toLinkPosts,
} from "./brief";
import type { BriefInputs } from "./brief";

const contract: TemplateContract = {
  requiredBlocks: ["dataTable", "faq"],
  wordBand: [1200, 1800],
  h2Min: 6,
  faqMin: 5,
  internalLinksMin: 3,
  schemaType: "ItemList",
  notes: ["Data table required — 80% of their winners carry one, 10% don't."],
};

function inputs(overrides: Partial<BriefInputs> = {}): BriefInputs {
  return {
    site: {
      url: "https://example.com",
      name: "Example",
      description: "",
    },
    row: {
      keyword: "best espresso machine for small kitchens",
      category: "Best-of lists",
      format: "listicle",
      searchVolume: 320,
      keywordDifficulty: 24,
      intent: "commercial",
      score: 41.5,
      source: "expansion",
      notesJson: null,
    },
    pageTypeName: "Best-of lists",
    contract,
    urlPattern: "/best/{slug}/",
    approvedTypeNames: ["Best-of lists", "Comparisons"],
    pages: [
      {
        path: "/blog/burr-grinder-guide/",
        title: "Burr grinders",
        category: "Best-of lists",
      },
      { path: "/blog/descaling/", title: "Descaling", category: "Guides" },
    ],
    serp: null,
    voiceCardMd: null,
    today: "2026-08-01",
    ...overrides,
  };
}

describe("mergeContractLaws", () => {
  it("moves only the five numbers the page type derived", () => {
    const laws = mergeContractLaws(contract);
    const defaults = defaultLaws();

    expect(laws.wordMin).toBe(1200);
    expect(laws.wordMax).toBe(1800);
    expect(laws.h2Min).toBe(6);
    expect(laws.faqMin).toBe(5);
    expect(laws.internalLinksMin).toBe(3);
    // The anti-slop rules are the engine's; no page type relaxes them.
    expect(laws.bannedPhrases).toEqual(defaults.bannedPhrases);
    expect(laws.banEmDash).toBe(true);
    expect(laws.requireFirstPerson).toBe(true);
    expect(laws.keywordDensityMax).toBe(defaults.keywordDensityMax);
    expect(laws.titleMax).toBe(defaults.titleMax);
  });

  it("falls back to the engine defaults when nothing is stored", () => {
    expect(mergeContractLaws(null)).toEqual(defaultLaws());
  });
});

describe("assembleBrief", () => {
  it("renders the contract's numbers as the hard requirements", () => {
    const brief = assembleBrief(inputs());

    expect(brief).toContain("1200 to 1800 words in the article body");
    expect(brief).toContain("At least 6 H2 sections");
    expect(brief).toContain("At least 5 FAQ entries");
    expect(brief).toContain("At least 3 internal links");
    expect(brief).toContain("NO em dashes anywhere");
  });

  it("uses the engine defaults when the page type stores no contract", () => {
    const brief = assembleBrief(inputs({ contract: null }));

    expect(brief).toContain("850 to 4500 words in the article body");
    expect(brief).toContain("At least 4 H2 sections");
    expect(brief).toContain(
      "Nothing is stored for this page type, so the hard requirements above are the house laws",
    );
  });

  it("says there is no voice card rather than inventing a persona", () => {
    const brief = assembleBrief(inputs());

    expect(brief).toContain("## Voice card");
    expect(brief).toMatch(/no voice card yet/i);
    expect(brief).toContain("write plainly and in first person");
  });

  it("uses the stored voice card verbatim when there is one", () => {
    const voiceCardMd =
      "I am a barista. I measure things and I say the number.";
    const brief = assembleBrief(inputs({ voiceCardMd }));

    expect(brief).toContain(voiceCardMd);
    expect(brief).not.toMatch(/no voice card yet/i);
  });

  it("renders the page type contract as writer requirements", () => {
    const brief = assembleBrief(inputs());

    expect(brief).toContain("## Page type contract: Best-of lists");
    expect(brief).toContain("Required blocks: a data table, an FAQ block");
    expect(brief).toContain("Word band: 1200 to 1800 words");
    expect(brief).toContain("Schema type: ItemList");
  });

  it("offers only pages that exist, at the paths they actually live at", () => {
    const brief = assembleBrief(
      inputs({
        pages: [
          {
            path: "/blog/real-post/",
            title: "Real post",
            category: "Best-of lists",
          },
          {
            path: "/blog/second-post/",
            title: "Second post",
            category: "Guides",
          },
          // Not a post root page, and a level deeper than the engine can
          // rebuild: offering either would print a URL the site never serves.
          { path: "/pricing/", title: "Pricing", category: null },
          { path: "/blog/2024/archived/", title: "Archived", category: null },
        ],
      }),
    );

    expect(brief).toContain("- /blog/real-post/  (Real post)");
    expect(brief).toContain("- /blog/second-post/  (Second post)");
    expect(brief).not.toContain("/pricing/");
    expect(brief).not.toContain("archived");
  });

  it("says there are no link candidates rather than offering an invented one", () => {
    const brief = assembleBrief(inputs({ pages: [] }));

    expect(brief).toContain(
      "(none yet; link only to pages that actually exist",
    );
  });

  it("shows the imputed volume and where it came from", () => {
    const brief = assembleBrief(
      inputs({
        row: {
          ...inputs().row,
          searchVolume: null,
          notesJson: '{"impr28":412}',
        },
      }),
    );

    expect(brief).toContain("volume: 412");
    expect(brief).toContain(
      "provenance: volume is your own Search Console: 412 impressions in 28 days, against no vendor priced this keyword at all",
    );
  });

  it("leaves a vendor-priced row alone when Search Console measured less", () => {
    const brief = assembleBrief(
      inputs({
        row: { ...inputs().row, searchVolume: 320, notesJson: '{"impr28":90}' },
      }),
    );

    expect(brief).toContain("volume: 320");
    expect(brief).not.toContain("provenance:");
  });

  it("marks this post's category inside the approved taxonomy", () => {
    const brief = assembleBrief(inputs());

    expect(brief).toContain(
      "- Best-of lists -> /blog/best-of-lists/  <- this post",
    );
    expect(brief).toContain("- Comparisons -> /blog/comparisons/");
  });

  it("renders the cached SERP as angle and FAQ material", () => {
    const brief = assembleBrief(
      inputs({
        serp: {
          organic: [
            {
              title: "The 7 best espresso machines",
              url: "https://rival.com/x",
            },
          ],
          paa: ["Do small espresso machines need a water softener?"],
        },
      }),
    );

    expect(brief).toContain("The 7 best espresso machines");
    expect(brief).toContain("People Also Ask");
    expect(brief).toContain(
      "Do small espresso machines need a water softener?",
    );
  });

  it("says the SERP is missing instead of writing around it silently", () => {
    const brief = assembleBrief(inputs({ serp: null }));

    expect(brief).toContain("No cached SERP for this keyword");
  });
});

describe("blogRootFrom", () => {
  it("takes the segment the most pages share", () => {
    const root = blogRootFrom(
      ["/blog/a/", "/blog/b/", "/guides/c/"],
      "/best/{slug}/",
    );
    expect(root).toBe("blog");
  });

  it("falls back to the page type's url pattern when nothing is published", () => {
    expect(blogRootFrom([], "/best/{slug}/")).toBe("best");
  });

  it("falls back to the engine's own convention when there is neither", () => {
    expect(blogRootFrom([], null)).toBe("blog");
  });

  it("does not call a single page a root", () => {
    expect(blogRootFrom(["/blog/only-one/"], "/best/{slug}/")).toBe("best");
  });
});

describe("toLinkPosts", () => {
  it("drops anything whose stored path is not /root/slug/", () => {
    const posts = toLinkPosts(
      [
        { path: "/blog/kept/", title: "Kept", category: "Guides" },
        { path: "/blog/also-kept", title: "Also kept", category: null },
        { path: "/blog/", title: "Hub root", category: null },
        { path: "/blog/deep/deeper/", title: "Deep", category: null },
        { path: "/elsewhere/nope/", title: "Nope", category: null },
      ],
      "blog",
    );

    expect(posts.map((post) => post.slug)).toEqual(["kept", "also-kept"]);
  });
});

describe("parseSerpSnapshot", () => {
  it("reads the shape the page plan stores", () => {
    const serp = parseSerpSnapshot({
      organicJson: JSON.stringify([
        {
          position: 1,
          url: "https://a.com",
          domain: "a.com",
          title: "A",
          description: null,
        },
      ]),
      paaJson: JSON.stringify(["Why?"]),
    });

    expect(serp?.organic[0]?.title).toBe("A");
    expect(serp?.paa).toEqual(["Why?"]);
  });

  it("degrades to no SERP rather than throwing on a shape it cannot read", () => {
    expect(
      parseSerpSnapshot({ organicJson: "{oops", paaJson: null }),
    ).toBeNull();
    expect(parseSerpSnapshot({ organicJson: "[]", paaJson: null })).toBeNull();
  });
});
