import { describe, expect, it, vi } from "vitest";
import type { TemplateContract } from "@/server/features/rankloop/page-plan/contracts.logic";
import { parseLawReport } from "@/types/schemas/rankloopWriter";
import type { RankloopLawReport } from "@/types/schemas/rankloopWriter";
import { runGate } from "./gate";
import type { GateInput, LawId, LawReport } from "./gate";

// The persisted law-report schema is declared next to the writer's other
// stored shapes, which reaches the db barrel for its enums. The gate itself
// imports only types from there and stays free of that runtime graph.
vi.mock("cloudflare:workers", () => ({ env: {} }));

// One compliant draft, then one deliberate break per law class. Every variant
// is derived from the same fixture by `swap`, which throws when its target is
// missing, so a fixture edit can never turn a violation test into a test of an
// unchanged draft that quietly passes.

const COMPLIANT_DRAFT = `---
title: Dialing in espresso on a home machine
description: What I changed to get repeatable shots without buying anything.
date: 2026-08-01
category: Guides
keyword: espresso grind size
---

I measured every shot on my home machine for a week before I trusted any of
this. The numbers below are the ones I wrote down, not the ones a manufacturer
prints on a box.

## Start coarse and tighten one notch at a time

Espresso grind size is the only variable worth moving on the first day. Set the
dose, keep it there, and change nothing else until the shot runs somewhere near
thirty seconds. Small moves beat big ones, because a burr set travels further
than the numbers on the collar suggest.

## What the shot time is telling you

A fast shot is under extracted and tastes sour. A slow one is over extracted
and tastes bitter and dry. Both are grind problems long before they are machine
problems, which is why I stopped replacing gear to fix taste.

## How long should a double shot take?

Between twenty five and thirty two seconds from first drip, for most beans
roasted for espresso. Older beans run faster and want a finer setting.

## What I would check next

If the taste still swings between two shots in a row, weigh the dose. My own
swing came from scooping rather than weighing, and it disappeared the day I put
the basket on a scale. The [burr grinder guide](/blog/burr-grinder-guide/)
covers the machine side.
`;

/** Same shape, same laws satisfied, nothing written in first person. */
const THIRD_PERSON_DRAFT = `---
title: Dialing in espresso on a home machine
description: What to change to get repeatable shots without buying anything.
date: 2026-08-01
category: Guides
keyword: espresso grind size
---

Every shot on a home machine was measured for a week before this method held
up. The numbers below were written down at the machine, not printed on a box.

## Start coarse and tighten one notch at a time

Espresso grind size is the only variable worth moving on the first day. Set the
dose, keep it there, and change nothing else until the shot runs somewhere near
thirty seconds. Small moves beat big ones, because a burr set travels further
than the numbers on the collar suggest.

## What the shot time is telling you

A fast shot is under extracted and tastes sour. A slow one is over extracted
and tastes bitter and dry. Both are grind problems long before they are machine
problems, which is why replacing gear rarely fixes taste.

## How long should a double shot take?

Between twenty five and thirty two seconds from first drip, for most beans
roasted for espresso. Older beans run faster and want a finer setting.

## What to check next

If the taste still swings between two shots in a row, weigh the dose. Scooping
instead of weighing explains most of that swing, and it goes away the day the
basket meets a scale. The [burr grinder guide](/blog/burr-grinder-guide/)
covers the machine side.
`;

/** The thresholds sized to the fixture. The five numbers a page type is
 *  allowed to move are exactly the five this contract moves. */
const CONTRACT: TemplateContract = {
  requiredBlocks: ["faq"],
  wordBand: [60, 400],
  h2Min: 2,
  faqMin: 1,
  internalLinksMin: 1,
  schemaType: "Article",
  notes: [],
};

function swap(text: string, from: string, to: string): string {
  if (!text.includes(from)) {
    throw new Error(`fixture no longer contains ${JSON.stringify(from)}`);
  }
  return text.replace(from, to);
}

function gateInput(overrides: Partial<GateInput> = {}): GateInput {
  return {
    slug: "dialing-in-espresso",
    draft: COMPLIANT_DRAFT,
    site: {
      url: "https://example.com",
      name: "Example",
      description: "",
    },
    pageTypeName: "Guides",
    contract: CONTRACT,
    urlPattern: "/blog/{slug}/",
    approvedTypeNames: ["Guides", "Comparisons"],
    pages: [
      {
        path: "/blog/burr-grinder-guide/",
        title: "Burr grinders",
        category: "Guides",
      },
      { path: "/blog/descaling/", title: "Descaling", category: "Guides" },
    ],
    checkedAt: "2026-08-01T09:00:00.000Z",
    ...overrides,
  };
}

function failedIds(report: LawReport): LawId[] {
  return report.laws.filter((law) => !law.passed).map((law) => law.id);
}

function verdict(report: LawReport, id: LawId) {
  const found = report.laws.find((law) => law.id === id);
  if (!found) throw new Error(`no ${id} law in the report`);
  return found;
}

describe("runGate: the full report", () => {
  it("passes a compliant draft and still lists every law", () => {
    const report = runGate(gateInput());

    expect(report.passed).toBe(true);
    expect(report.violations).toBe(0);
    expect(failedIds(report)).toEqual([]);
    // The receipt records the passes too, in the engine's own table order.
    expect(report.laws.map((law) => law.id)).toEqual([
      "emDash",
      "categoryKnown",
      "titleMax",
      "descriptionMax",
      "dateParses",
      "wordMin",
      "wordMax",
      "h2Min",
      "faqMin",
      "internalLinksMin",
      "keywordInBody",
      "keywordDensityMax",
      "bannedPhrases",
      "firstPerson",
    ]);
  });

  it("names the engine's own law, numbers and all", () => {
    const report = runGate(gateInput());

    expect(verdict(report, "wordMin").law).toBe("word count >= 60");
    expect(verdict(report, "wordMin").threshold).toBe("60 words");
    expect(verdict(report, "wordMin").observed).toMatch(/^\d+ words$/);
    expect(verdict(report, "titleMax").law).toBe("title <= 70 chars");
    expect(verdict(report, "titleMax").observed).toBe("37 characters");
  });

  it("carries no canonical law for a markdown draft", () => {
    // The writer emits frontmatter plus markdown, so the html-only canonical
    // law is not part of this corpus and must not appear as a phantom pass.
    expect(failedIds(runGate(gateInput()))).toEqual([]);
    expect(
      runGate(gateInput()).laws.some((law) => law.id === "canonical"),
    ).toBe(false);
  });

  it("survives JSON storage unchanged", () => {
    const report = runGate(gateInput({ draft: brokenEmDash() }));
    const stored: unknown = JSON.parse(JSON.stringify(report));

    expect(stored).toEqual(report);
  });

  it("reads back through the persisted law-report shape", () => {
    // What the gate returns IS what articles.law_report_json holds, so the
    // column the detail page renders can never drift from the adapter that
    // wrote it. The gate's extras (id, observed, every excerpt) ride along in
    // the JSON; `parseLawReport` hands the UI the four fields it knows about.
    const report = runGate(gateInput({ draft: brokenEmDash() }));
    // Assignable, not merely serializable: a caller storing or rendering the
    // persisted type never needs a mapping step.
    const persisted: RankloopLawReport = report;
    const stored = parseLawReport(JSON.stringify(persisted));

    expect(stored).not.toBeNull();
    expect(stored?.passed).toBe(false);
    expect(stored?.checkedAt).toBe("2026-08-01T09:00:00.000Z");
    expect(stored?.failure).toBeNull();
    expect(stored?.laws).toHaveLength(report.laws.length);
    expect(
      stored?.laws.find((law) => law.law === "em dash")?.excerpt,
    ).toContain("thirty seconds — give or take");
  });

  it("reports unreadable frontmatter as its own fact", () => {
    const report = runGate(
      gateInput({ draft: "Here is the article you asked for.\n\n## Grind\n" }),
    );

    expect(report.frontmatterParsed).toBe(false);
    // Everything metadata-shaped fails at once, which is exactly why the flag
    // exists: this is a broken generation, not a draft to hand back for edits.
    expect(failedIds(report)).toContain("titleMax");
    expect(failedIds(report)).toContain("categoryKnown");
  });

  it("marks frontmatter parsed when the block is there", () => {
    expect(runGate(gateInput()).frontmatterParsed).toBe(true);
  });
});

describe("runGate: the contract merge", () => {
  it("grades against the page type's numbers, not the engine defaults", () => {
    const report = runGate(
      gateInput({ contract: { ...CONTRACT, wordBand: [800, 4000] } }),
    );

    expect(failedIds(report)).toEqual(["wordMin"]);
    expect(verdict(report, "wordMin").law).toBe("word count >= 800");
    expect(verdict(report, "wordMin").threshold).toBe("800 words");
  });

  it("keeps the anti-slop laws the engine's, whatever the contract says", () => {
    const report = runGate(
      gateInput({
        contract: { ...CONTRACT, wordBand: [60, 400] },
        draft: brokenEmDash(),
      }),
    );

    expect(failedIds(report)).toEqual(["emDash"]);
    expect(verdict(report, "bannedPhrases").threshold).toBe(
      "none of the 15 banned phrases",
    );
  });

  it("falls back to the engine defaults when nothing is stored", () => {
    const report = runGate(gateInput({ contract: null }));

    expect(verdict(report, "wordMin").threshold).toBe("850 words");
    expect(verdict(report, "faqMin").threshold).toBe("3 FAQ entries");
    expect(failedIds(report)).toEqual([
      "wordMin",
      "faqMin",
      "internalLinksMin",
    ]);
  });
});

// ---------------------------------------------------------------------------
// One break per law class
// ---------------------------------------------------------------------------

function brokenEmDash(): string {
  return swap(
    COMPLIANT_DRAFT,
    "somewhere near\nthirty seconds",
    "somewhere near thirty seconds — give or take",
  );
}

describe("runGate: excerpts", () => {
  it("quotes the sentence around an em dash", () => {
    const report = runGate(gateInput({ draft: brokenEmDash() }));
    const law = verdict(report, "emDash");

    expect(law.passed).toBe(false);
    expect(law.threshold).toBe("none anywhere");
    expect(law.excerpts).toHaveLength(1);
    expect(law.excerpts[0]?.label).toBe("em dash");
    expect(law.excerpts[0]?.quote).toContain("thirty seconds — give or take");
    expect(law.excerpts[0]?.quote).not.toContain("burr set");
  });

  it("quotes the sentence around each banned phrase", () => {
    const draft = swap(
      COMPLIANT_DRAFT,
      "Set the\ndose",
      "Let's explore the dose first. Set the dose",
    );
    const report = runGate(gateInput({ draft }));
    const law = verdict(report, "bannedPhrases");

    expect(failedIds(report)).toEqual(["bannedPhrases"]);
    expect(law.observed).toBe("1 phrase");
    expect(law.excerpts).toEqual([
      {
        label: 'banned phrase: "let\'s explore"',
        quote: "Let's explore the dose first.",
      },
    ]);
  });

  it("names the internal link path that resolves to nothing", () => {
    const draft = swap(
      COMPLIANT_DRAFT,
      "/blog/burr-grinder-guide/",
      "/blog/the-grinder-i-wish-existed/",
    );
    const report = runGate(gateInput({ draft }));
    const law = verdict(report, "internalLinksMin");

    expect(failedIds(report)).toEqual(["internalLinksMin"]);
    expect(law.threshold).toBe("1 links that resolve");
    expect(law.observed).toBe("0 resolving links, 1 dead path");
    expect(law.excerpts).toEqual([
      {
        label: "no page at this path",
        quote: "/blog/the-grinder-i-wish-existed/",
      },
    ]);
  });

  it("counts a link to a real page as resolving and quotes nothing", () => {
    const report = runGate(
      gateInput({ contract: { ...CONTRACT, internalLinksMin: 3 } }),
    );
    const law = verdict(report, "internalLinksMin");

    expect(law.passed).toBe(false);
    expect(law.observed).toBe("1 resolving link");
    // Short of the bar is not the same failure as a dead path, and inventing
    // an excerpt here would tell the writer to fix a link that is fine.
    expect(law.excerpts).toEqual([]);
  });

  it("holds no excerpt for a law that fails on an absence", () => {
    const report = runGate(gateInput({ draft: THIRD_PERSON_DRAFT }));

    expect(failedIds(report)).toEqual(["firstPerson"]);
    expect(verdict(report, "firstPerson").excerpts).toEqual([]);
    expect(verdict(report, "firstPerson").threshold).toBe(
      "at least one first-person passage",
    );
  });
});

describe("runGate: the metadata laws", () => {
  it("fails a title over the ceiling and says how far over", () => {
    const draft = swap(
      COMPLIANT_DRAFT,
      "title: Dialing in espresso on a home machine",
      "title: Dialing in espresso on a home machine without spending a single dollar on new gear",
    );
    const report = runGate(gateInput({ draft }));

    expect(failedIds(report)).toEqual(["titleMax"]);
    expect(verdict(report, "titleMax").threshold).toBe("70 characters");
    expect(verdict(report, "titleMax").observed).toBe("82 characters");
  });

  it("fails a description over the ceiling", () => {
    const draft = swap(
      COMPLIANT_DRAFT,
      "description: What I changed to get repeatable shots without buying anything.",
      `description: ${"What I changed to get repeatable shots. ".repeat(5)}`,
    );
    const report = runGate(gateInput({ draft }));

    expect(failedIds(report)).toEqual(["descriptionMax"]);
    expect(verdict(report, "descriptionMax").observed).toBe("199 characters");
  });

  it("fails a category the site never approved, and lists the ones it did", () => {
    const draft = swap(
      COMPLIANT_DRAFT,
      "category: Guides",
      "category: Recipes",
    );
    const report = runGate(gateInput({ draft }));

    expect(failedIds(report)).toEqual(["categoryKnown"]);
    expect(verdict(report, "categoryKnown").threshold).toBe(
      "one of: Guides, Comparisons",
    );
    expect(verdict(report, "categoryKnown").observed).toBe('"Recipes"');
  });

  it("fails a date that is not YYYY-MM-DD", () => {
    const draft = swap(COMPLIANT_DRAFT, "date: 2026-08-01", "date: 1 Aug 2026");
    const report = runGate(gateInput({ draft }));

    expect(failedIds(report)).toEqual(["dateParses"]);
    expect(verdict(report, "dateParses").observed).toBe('"1 Aug 2026"');
  });
});

describe("runGate: the body laws", () => {
  it("fails a body under the contract's floor", () => {
    const report = runGate(
      gateInput({ contract: { ...CONTRACT, wordBand: [800, 4000] } }),
    );

    expect(failedIds(report)).toEqual(["wordMin"]);
  });

  it("fails a body over the contract's ceiling", () => {
    const report = runGate(
      gateInput({ contract: { ...CONTRACT, wordBand: [60, 100] } }),
    );

    expect(failedIds(report)).toEqual(["wordMax"]);
    expect(verdict(report, "wordMax").threshold).toBe("100 words");
  });

  it("fails too few H2 sections", () => {
    const report = runGate(gateInput({ contract: { ...CONTRACT, h2Min: 9 } }));

    expect(failedIds(report)).toEqual(["h2Min"]);
    expect(verdict(report, "h2Min").threshold).toBe("9 H2 sections");
    // The engine keeps the H2 counter private; reporting a number here would
    // be this file counting headings its own way.
    expect(verdict(report, "h2Min").observed).toBeNull();
  });

  it("fails too few question-shaped headings", () => {
    const report = runGate(gateInput({ contract: { ...CONTRACT, faqMin: 4 } }));

    expect(failedIds(report)).toEqual(["faqMin"]);
    expect(verdict(report, "faqMin").threshold).toBe("4 FAQ entries");
  });

  it("fails a keyword that never appears in the body", () => {
    const draft = swap(
      COMPLIANT_DRAFT,
      "keyword: espresso grind size",
      "keyword: flat white milk texture",
    );
    const report = runGate(gateInput({ draft }));

    expect(failedIds(report)).toEqual(["keywordInBody"]);
    expect(verdict(report, "keywordInBody").threshold).toBe(
      'the keyword "flat white milk texture" appears in the body',
    );
  });

  it("fails a keyword stuffed past the density ceiling", () => {
    const draft = swap(
      swap(
        COMPLIANT_DRAFT,
        "keyword: espresso grind size",
        "keyword: espresso",
      ),
      "## What the shot time is telling you",
      [
        "## Espresso, espresso, espresso",
        "",
        "Espresso rewards espresso patience, and espresso beans want espresso",
        "care, so espresso dialling stays espresso work until the espresso",
        "tastes like espresso should.",
        "",
        "## What the shot time is telling you",
      ].join("\n"),
    );
    const report = runGate(gateInput({ draft }));

    expect(failedIds(report)).toEqual(["keywordDensityMax"]);
    expect(verdict(report, "keywordDensityMax").threshold).toBe(
      "2.5% of body words",
    );
  });
});
