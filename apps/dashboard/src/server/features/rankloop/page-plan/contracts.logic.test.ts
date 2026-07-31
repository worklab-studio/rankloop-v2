import { describe, expect, it } from "vitest";
import { defaultLaws } from "@rankloop/engine";
import { deriveTemplateContract, type FeatureDelta } from "./contracts.logic";

const laws = defaultLaws();

function delta(
  feature: string,
  winnersPct: number,
  medianPct: number,
): FeatureDelta {
  return { feature, winnersPct, medianPct };
}

function derive(
  overrides: Partial<Parameters<typeof deriveTemplateContract>[0]> = {},
) {
  return deriveTemplateContract({
    format: "comparison",
    deltas: [],
    winnersMedianWordCount: null,
    ourMedianWordCount: null,
    competitorDomain: null,
    ...overrides,
  });
}

describe("deriveTemplateContract", () => {
  it("requires a block the winners nearly all carry and the ordinary pages nearly all don't", () => {
    const contract = derive({
      deltas: [delta("Data table", 78, 22)],
      competitorDomain: "rival.example",
    });

    expect(contract.requiredBlocks).toEqual(["dataTable"]);
    expect(contract.notes[0]).toBe(
      "Data table required — 78% of rival.example winners carry one, 22% of their ordinary pages do.",
    );
  });

  it("leaves out a block both cohorts carry — that is house style, not a contract", () => {
    const contract = derive({ deltas: [delta("Byline", 90, 85)] });
    expect(contract.requiredBlocks).toEqual([]);
  });

  it("leaves out a block the winners only sometimes carry", () => {
    const contract = derive({ deltas: [delta("FAQ block", 55, 10)] });
    expect(contract.requiredBlocks).toEqual([]);
  });

  it("holds the rule at its exact edges", () => {
    expect(
      derive({ deltas: [delta("FAQ block", 60, 39)] }).requiredBlocks,
    ).toEqual(["faq"]);
    expect(
      derive({ deltas: [delta("FAQ block", 60, 40)] }).requiredBlocks,
    ).toEqual([]);
    expect(
      derive({ deltas: [delta("FAQ block", 59, 39)] }).requiredBlocks,
    ).toEqual([]);
  });

  it("ignores a feature label it has no block for rather than inventing one", () => {
    expect(
      derive({ deltas: [delta("Video embed", 99, 1)] }).requiredBlocks,
    ).toEqual([]);
  });

  it("bands the word count around the winners' median and says where it came from", () => {
    const contract = derive({
      winnersMedianWordCount: 1800,
      ourMedianWordCount: 900,
      competitorDomain: "rival.example",
    });

    expect(contract.wordBand).toEqual([1530, 2250]);
    expect(contract.notes).toEqual([
      "Word band from rival.example's winners (median 1,800 words); your own posts median 900.",
    ]);
  });

  it("never bands below the publish laws' own floor", () => {
    const contract = derive({ winnersMedianWordCount: 400 });
    expect(contract.wordBand[0]).toBe(laws.wordMin);
    expect(contract.wordBand[1]).toBeGreaterThanOrEqual(contract.wordBand[0]);
  });

  it("falls back to the engine's law defaults, labelled as defaults", () => {
    const contract = derive();

    expect(contract).toMatchObject({
      requiredBlocks: [],
      wordBand: [laws.wordMin, laws.wordMax],
      h2Min: laws.h2Min,
      faqMin: laws.faqMin,
      internalLinksMin: laws.internalLinksMin,
      notes: ["defaults — no competitor signal"],
    });
  });

  it("picks the primary schema type from the page format", () => {
    expect(derive({ format: "how-to" }).schemaType).toBe("HowTo");
    expect(derive({ format: "listicle" }).schemaType).toBe("ItemList");
    expect(derive({ format: "data" }).schemaType).toBe("Dataset");
    expect(derive({ format: "explainer" }).schemaType).toBe("Article");
    expect(derive({ format: "something-new" }).schemaType).toBe("Article");
  });

  it("never claims FAQPage as the page's own type just because an FAQ is required", () => {
    const contract = derive({ deltas: [delta("FAQ block", 80, 10)] });
    expect(contract.requiredBlocks).toEqual(["faq"]);
    expect(contract.schemaType).toBe("Article");
  });
});
