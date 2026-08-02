import { describe, expect, it } from "vitest";
import type { TemplateContract } from "@/server/features/rankloop/page-plan/contracts.logic";
import { runGate } from "./gate";
import type { LawId, LawReport, LawVerdict } from "./gate";
import { buildRepairPayload, renderRepairPayload } from "./repair.logic";

// Every law id this build knows how to explain. Listed here rather than
// exported from gate.ts so that adding a law to the engine fails this test
// (no guidance) instead of shipping a fix call that says nothing useful.
const LAW_IDS: LawId[] = [
  "emDash",
  "canonical",
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
  "unknown",
];

function verdict(overrides: Partial<LawVerdict> = {}): LawVerdict {
  return {
    id: "wordMin",
    law: "word count >= 850",
    passed: false,
    threshold: "850 words",
    observed: "612 words",
    excerpt: null,
    excerpts: [],
    ...overrides,
  };
}

function report(laws: LawVerdict[]): LawReport {
  return {
    slug: "dialing-in-espresso",
    passed: laws.every((law) => law.passed),
    violations: laws.filter((law) => !law.passed).length,
    checkedAt: "2026-08-01T09:00:00.000Z",
    failure: null,
    frontmatterParsed: true,
    laws,
  };
}

describe("buildRepairPayload", () => {
  it("carries every violated law with its threshold and what was measured", () => {
    const payload = buildRepairPayload(
      report([
        verdict({ id: "titleMax", law: "title <= 70 chars", passed: true }),
        verdict(),
      ]),
    );

    expect(payload.violations).toHaveLength(1);
    expect(payload.violations[0]).toMatchObject({
      id: "wordMin",
      law: "word count >= 850",
      threshold: "850 words",
      observed: "612 words",
    });
    expect(payload.violations[0]?.fix).toContain("Do not pad");
  });

  it("drops the laws that passed", () => {
    const payload = buildRepairPayload(
      report([
        verdict({ passed: true }),
        verdict({ id: "emDash", law: "em dash" }),
      ]),
    );

    // The stored report keeps the passes; the fix call does not get them.
    // Naming a satisfied law in a repair prompt is an invitation to touch it.
    expect(payload.violations.map((violation) => violation.id)).toEqual([
      "emDash",
    ]);
  });

  it("returns nothing to fix for a clean report", () => {
    const payload = buildRepairPayload(report([verdict({ passed: true })]));

    expect(payload.violations).toEqual([]);
    expect(renderRepairPayload(payload)).toContain("nothing to fix");
  });

  it("states the change-only-what-is-required rule", () => {
    const payload = buildRepairPayload(report([verdict()]));

    expect(payload.instruction).toContain("Fix only what the violations");
    expect(payload.instruction).toContain("Leave every other sentence");
    // The honesty contract survives the fix call: a word-count violation is
    // exactly where a writer starts inventing a benchmark to fill the gap.
    expect(payload.instruction).toContain("Do not invent facts");
  });

  it("carries the excerpts through untouched", () => {
    const excerpts = [
      {
        quote: "Let's explore the dose first.",
        label: 'banned phrase: "let\'s explore"',
      },
    ];
    const payload = buildRepairPayload(
      report([
        verdict({ id: "bannedPhrases", law: "no filler AI phrases", excerpts }),
      ]),
    );

    expect(payload.violations[0]?.excerpts).toEqual(excerpts);
  });
});

describe("buildRepairPayload: one instruction per law", () => {
  it.each(LAW_IDS)("tells the writer what to do about %s", (id) => {
    const payload = buildRepairPayload(report([verdict({ id })]));
    const fix = payload.violations[0]?.fix ?? "";

    expect(fix.length).toBeGreaterThan(0);
    // A writer mirrors the punctuation of the document it is handed, and the
    // em-dash ban is one of the laws being enforced.
    expect(fix).not.toContain("—");
  });

  it("says something different about each law", () => {
    const fixes = LAW_IDS.map(
      (id) => buildRepairPayload(report([verdict({ id })])).violations[0]?.fix,
    );

    expect(new Set(fixes).size).toBe(LAW_IDS.length);
  });
});

describe("renderRepairPayload", () => {
  it("counts the failures and hand-pluralizes them", () => {
    const one = renderRepairPayload(buildRepairPayload(report([verdict()])));
    const two = renderRepairPayload(
      buildRepairPayload(
        report([verdict(), verdict({ id: "emDash", law: "em dash" })]),
      ),
    );

    expect(one).toContain("1 law failed");
    expect(two).toContain("2 laws failed");
  });

  it("prints the law, the bar, the measurement, the fix and the excerpt", () => {
    const message = renderRepairPayload(
      buildRepairPayload(
        report([
          verdict({
            id: "internalLinksMin",
            law: "internal links >= 2",
            threshold: "2 links that resolve",
            observed: "1 resolving link, 1 dead path",
            excerpts: [
              {
                quote: "/blog/the-grinder-i-wish-existed/",
                label: "no page at this path",
              },
            ],
          }),
        ]),
      ),
    );

    expect(message).toContain("## 1. internal links >= 2");
    expect(message).toContain("Required: 2 links that resolve");
    expect(message).toContain("In your draft: 1 resolving link, 1 dead path");
    expect(message).toContain("Fix: Link only to the pages the brief listed");
    expect(message).toContain(
      'no page at this path: "/blog/the-grinder-i-wish-existed/"',
    );
  });

  it("omits the lines it has nothing to say on", () => {
    const message = renderRepairPayload(
      buildRepairPayload(
        report([
          verdict({
            id: "h2Min",
            law: "h2 sections >= 4",
            threshold: "4 H2 sections",
            observed: null,
          }),
        ]),
      ),
    );

    expect(message).toContain("Required: 4 H2 sections");
    expect(message).not.toContain("In your draft:");
    expect(message).not.toContain("Offending text:");
  });
});

// ---------------------------------------------------------------------------
// The gate and the payload, composed
// ---------------------------------------------------------------------------

const CONTRACT: TemplateContract = {
  requiredBlocks: [],
  wordBand: [60, 400],
  h2Min: 2,
  faqMin: 1,
  internalLinksMin: 1,
  schemaType: "Article",
  notes: [],
};

/** Spec 0020's scenario (b): a banned phrase and a link to a page that does
 *  not exist, both of which the repair call has to receive as text. */
const TWO_VIOLATION_DRAFT = `---
title: Dialing in espresso on a home machine
description: What I changed to get repeatable shots without buying anything.
date: 2026-08-01
category: Guides
keyword: espresso grind size
---

I would check every shot on my own machine for a week before trusting any of
this. Let's explore the dose first, because espresso grind size moves further
than the collar numbers suggest.

## Start coarse and tighten one notch at a time

Set the dose, keep it there, and change nothing else until the shot runs
somewhere near thirty seconds. Small moves beat big ones, because a burr set
travels further than the numbers on the collar suggest.

## What the shot time is telling you

A fast shot is under extracted and tastes sour. A slow one is over extracted
and tastes bitter and dry. Both are grind problems long before they are machine
problems, which is why I stopped replacing gear to fix taste.

## How long should a double shot take?

Between twenty five and thirty two seconds from first drip, for most beans
roasted for espresso. Older beans run faster and want a finer setting. The
[grinder guide](/blog/the-grinder-i-wish-existed/) covers the machine side.
`;

describe("the payload a real law report produces", () => {
  it("hands the fix call both violations with their offending text", () => {
    const gateReport = runGate({
      slug: "dialing-in-espresso",
      draft: TWO_VIOLATION_DRAFT,
      site: { url: "https://example.com", name: "Example", description: "" },
      pageTypeName: "Guides",
      contract: CONTRACT,
      urlPattern: "/blog/{slug}/",
      approvedTypeNames: ["Guides"],
      pages: [
        {
          path: "/blog/burr-grinder-guide/",
          title: "Burr grinders",
          category: "Guides",
        },
        { path: "/blog/descaling/", title: "Descaling", category: "Guides" },
      ],
      checkedAt: "2026-08-01T09:00:00.000Z",
    });
    const payload = buildRepairPayload(gateReport);
    const message = renderRepairPayload(payload);

    expect(payload.violations.map((violation) => violation.id)).toEqual([
      "internalLinksMin",
      "bannedPhrases",
    ]);
    expect(message).toContain('"/blog/the-grinder-i-wish-existed/"');
    expect(message).toContain("Let's explore the dose first");
    // The eleven laws this draft satisfied are nowhere in the message.
    expect(message).not.toContain("date parses");
    expect(message).not.toContain("first-person");
  });
});
