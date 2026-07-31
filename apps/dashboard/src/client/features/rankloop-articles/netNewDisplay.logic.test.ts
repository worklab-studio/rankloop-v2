import { describe, expect, it } from "vitest";
import {
  exclusionLine,
  formatCost,
  isFreshQuestionSlot,
  netNewEvidenceChips,
  quotaLine,
  serpSourceStamp,
} from "./netNewDisplay.logic";

describe("isFreshQuestionSlot", () => {
  // The literals are spelled out rather than imported from the module under
  // test: they are the contract with buildNetNewProposal's slotFactor, and a
  // shared constant would let both sides drift together silently.
  it("reads the pool slot off the factor compute recorded", () => {
    expect(
      isFreshQuestionSlot([
        {
          name: "Slot",
          value: "fresh question",
          note: "one slot per batch goes to a harvested question",
        },
      ]),
    ).toBe(true);
  });

  it("leaves score-ranked rows unchipped", () => {
    expect(
      isFreshQuestionSlot([
        {
          name: "Slot",
          value: "scored",
          note: "ranked into the batch on score",
        },
        { name: "Volume", value: 480, note: "imputed" },
      ]),
    ).toBe(false);
  });

  it("stays false on an optimize row, which records no slot at all", () => {
    expect(
      isFreshQuestionSlot([{ name: "Impressions", value: 1240, note: "" }]),
    ).toBe(false);
  });
});

describe("netNewEvidenceChips", () => {
  it("drops the two facts that render as coloured chips of their own", () => {
    expect(
      netNewEvidenceChips(
        [
          "Comparison pages",
          "harvested question",
          "1,240 impressions over 28 days",
          "fresh question",
        ],
        "Comparison pages",
      ),
    ).toEqual(["harvested question", "1,240 impressions over 28 days"]);
  });

  it("leaves optimize evidence untouched when there is no page type", () => {
    expect(
      netNewEvidenceChips(['"espresso tamper size" · pos 8.2'], null),
    ).toEqual(['"espresso tamper size" · pos 8.2']);
  });
});

describe("quotaLine", () => {
  it("says the quota is off when no start date is set", () => {
    expect(quotaLine({ owed: null, outstanding: 3 })).toBe(
      "quota off — propose manually",
    );
  });

  it("reconciles what is owed against what is already in the queue", () => {
    expect(quotaLine({ owed: 2, outstanding: 1 })).toBe(
      "2 owed today · 1 already proposed",
    );
  });

  it("names the empty queue rather than leaving the second half off", () => {
    expect(quotaLine({ owed: 2, outstanding: 0 })).toBe(
      "2 owed today · none proposed yet",
    );
  });

  it("drops the redundant half when nothing is owed and nothing is queued", () => {
    expect(quotaLine({ owed: 0, outstanding: 0 })).toBe("nothing owed today");
    expect(quotaLine({ owed: 0, outstanding: 2 })).toBe(
      "nothing owed today · 2 already proposed",
    );
  });
});

describe("exclusionLine", () => {
  it("carries the planner's own reason and the backlog it is holding", () => {
    expect(
      exclusionLine({
        pageTypeName: "Comparison pages",
        keywordCount: 12,
        reason: "needs a data source — see the page plan",
      }),
    ).toBe(
      "Comparison pages · 12 keywords held back · needs a data source — see the page plan",
    );
  });

  it("pluralizes the count by hand", () => {
    expect(
      exclusionLine({
        pageTypeName: "Alternatives",
        keywordCount: 1,
        reason: "needs a data source — see the page plan",
      }),
    ).toBe(
      "Alternatives · 1 keyword held back · needs a data source — see the page plan",
    );
  });
});

describe("formatCost", () => {
  it("keeps sub-cent SERP costs from rounding away to $0.00", () => {
    expect(formatCost(0.0025)).toBe("~$0.0025");
  });

  it("renders whole-cent figures at two decimals", () => {
    expect(formatCost(0.08)).toBe("~$0.08");
  });
});

describe("serpSourceStamp", () => {
  it("never collapses a reused snapshot into the wording for a paid fetch", () => {
    expect(serpSourceStamp("plan")).toBe(
      "SERP reused from the page plan snapshot",
    );
    expect(serpSourceStamp("grounding")).toBe(
      "SERP reused from an earlier brief",
    );
    expect(serpSourceStamp("fetched")).toBe("SERP fetched for this brief");
  });

  it("says what the brief does instead when nothing is cached", () => {
    expect(serpSourceStamp("none")).toBe(
      "no SERP cached — the brief says to write from the topic itself",
    );
  });
});
