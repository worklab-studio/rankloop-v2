import { describe, expect, it } from "vitest";
import {
  authoritySentence,
  cardStamp,
  contractLines,
  demandSentence,
  evidenceSentence,
  kdBandLabel,
  kindDisplay,
  moneySentence,
  planStamp,
  requiredBlockLabel,
  serpSummaryLine,
  serpVerdictDisplay,
  serpVerdictLine,
} from "./pagePlanDisplay.logic";

const sampled = {
  status: "ok",
  reason: null,
  sampled: 6,
  hardSerps: 1,
  aiOverviews: 2,
  winnable: 5,
};

describe("kindDisplay", () => {
  it("gives the two page-type shapes their own chip colors", () => {
    expect(kindDisplay("pseo")).toEqual({ label: "pSEO", color: "violet" });
    expect(kindDisplay("blog")).toEqual({ label: "blog", color: "lime" });
  });

  it("renders an unmapped kind neutrally rather than crashing", () => {
    expect(kindDisplay("hub")).toEqual({ label: "hub", color: "slate" });
    expect(kindDisplay("future")).toEqual({ label: "future", color: "slate" });
  });
});

describe("serpVerdictDisplay", () => {
  it("labels every verdict as the sample it is", () => {
    expect(serpVerdictDisplay(sampled)).toEqual({
      label: "winnable sample",
      color: "emerald",
    });
    expect(serpVerdictDisplay({ ...sampled, status: "caution" })).toEqual({
      label: "mixed sample",
      color: "amber",
    });
    expect(serpVerdictDisplay({ ...sampled, status: "unsampled" })).toEqual({
      label: "not sampled",
      color: "slate",
    });
  });

  // A missing serp_check_json is the same state a keyless run leaves behind.
  it("reads a missing check as not sampled rather than as a verdict", () => {
    expect(serpVerdictDisplay(null)).toEqual({
      label: "not sampled",
      color: "slate",
    });
  });
});

describe("serpVerdictLine", () => {
  it("counts the beatable results in an ok sample", () => {
    expect(serpVerdictLine(sampled)).toBe(
      "Sampled 6 keywords · 5 with a beatable result outside the top three.",
    );
  });

  it("quotes the planner's stored reason for a caution instead of re-deriving one", () => {
    expect(
      serpVerdictLine({
        ...sampled,
        status: "caution",
        reason: "An AI Overview sits above the results in 4 of 6 samples.",
      }),
    ).toBe("An AI Overview sits above the results in 4 of 6 samples.");
  });

  it("falls back to a plain caution line when no reason was stored", () => {
    expect(serpVerdictLine({ ...sampled, status: "caution" })).toBe(
      "Mixed signals across the keywords we sampled.",
    );
  });

  it("says an unsampled type was proposed from the backlog alone", () => {
    expect(
      serpVerdictLine({ ...sampled, status: "unsampled", sampled: 0 }),
    ).toBe("Not sampled — this shape was proposed from your backlog alone.");
    expect(serpVerdictLine(null)).toBe(
      "Not sampled — this shape was proposed from your backlog alone.",
    );
  });
});

describe("serpSummaryLine", () => {
  it("reads out every stored count", () => {
    expect(serpSummaryLine(sampled)).toBe(
      "6 keywords sampled · 1 with a forum or Reddit in the top five · 2 with an AI Overview · 5 with a beatable result",
    );
  });

  it("claims nothing when nothing was sampled", () => {
    expect(serpSummaryLine({ ...sampled, status: "unsampled" })).toBe(
      "No SERP sample stored for this type.",
    );
    expect(serpSummaryLine(null)).toBe("No SERP sample stored for this type.");
  });
});

describe("demandSentence", () => {
  it("puts demand in words with the page count", () => {
    expect(demandSentence(18400, 47)).toBe(
      "18,400 searches a month across 47 pages.",
    );
  });

  it("says a free-source cluster has no measured volume rather than printing 0", () => {
    expect(demandSentence(0, 5)).toBe(
      "No measured volume across 5 pages — long-tail keywords often carry none.",
    );
    expect(demandSentence(null, 5)).toBe(
      "No measured volume across 5 pages — long-tail keywords often carry none.",
    );
  });
});

describe("moneySentence", () => {
  it("rounds to whole dollars past ten so it reads as an estimate", () => {
    expect(moneySentence(47)).toBe("~$12 to write all 47 at ~$0.25 each");
  });

  it("keeps cents under ten dollars", () => {
    expect(moneySentence(4)).toBe("~$1.00 to write all 4 at ~$0.25 each");
  });
});

describe("evidenceSentence", () => {
  it("names the competitor and the share of traffic the shape earns them", () => {
    expect(
      evidenceSentence({
        hasCompetitorSignal: true,
        leadDomain: "espressotoolbox.example",
        pageSharePct: 33,
        etvSharePct: 41.4,
      }),
    ).toBe(
      "espressotoolbox.example earns 41% of its search traffic from pages like these.",
    );
  });

  // Traffic share is the better sentence, but only when the provider priced
  // the pages — otherwise the page share is what we actually know.
  it("falls back to the page share when no matching page was priced", () => {
    expect(
      evidenceSentence({
        hasCompetitorSignal: true,
        leadDomain: "espressotoolbox.example",
        pageSharePct: 33.2,
        etvSharePct: null,
      }),
    ).toBe(
      "espressotoolbox.example puts 33% of its top-earning pages into this shape.",
    );
  });

  // The honesty rule: no competitor match means no sentence to fake — and the
  // absence names how many competitors were checked so it can be audited.
  it("says there is no competitor signal and how many were checked", () => {
    expect(
      evidenceSentence({ hasCompetitorSignal: false, competitorsChecked: 3 }),
    ).toBe(
      "No competitor signal for this shape — 3 studied competitors carry no page like it.",
    );
    expect(
      evidenceSentence({ hasCompetitorSignal: false, competitorsChecked: 1 }),
    ).toBe(
      "No competitor signal for this shape — 1 studied competitor carries no page like it.",
    );
  });

  it("distinguishes nothing-studied from studied-and-no-match", () => {
    expect(
      evidenceSentence({ hasCompetitorSignal: false, competitorsChecked: 0 }),
    ).toBe(
      "No competitor signal for this shape — no competitor has been studied yet.",
    );
    expect(evidenceSentence(null)).toBe("No competitor signal for this shape.");
  });
});

describe("kdBandLabel", () => {
  it("reports the p25–p75 band as the middle half", () => {
    expect(kdBandLabel({ p25: 23.6, p75: 38.2 })).toBe(
      "KD 24–38 (middle half)",
    );
  });

  it("says so when every keyword in the cluster has a null difficulty", () => {
    expect(kdBandLabel(null)).toBe("No difficulty data on these keywords");
  });
});

describe("contractLines", () => {
  it("states the contract in sentences a founder can argue with", () => {
    expect(
      contractLines({
        requiredBlocks: ["dataTable", "faq"],
        wordBand: [900, 1400],
        h2Min: 6,
        faqMin: 4,
        internalLinksMin: 8,
        schemaType: "Product",
        notes: [],
      }),
    ).toEqual([
      "900–1,400 words",
      "at least 6 H2 sections",
      "at least 4 FAQ entries",
      "at least 8 internal links",
      "Product structured data",
    ]);
  });

  it("drops the schema line when the contract asserts no schema type", () => {
    expect(
      contractLines({
        requiredBlocks: [],
        wordBand: [600, 900],
        h2Min: 1,
        faqMin: 1,
        internalLinksMin: 1,
        schemaType: "",
        notes: [],
      }),
    ).toEqual([
      "600–900 words",
      "at least 1 H2 section",
      "at least 1 FAQ entry",
      "at least 1 internal link",
    ]);
  });

  it("renders nothing for a type with no derived contract", () => {
    expect(contractLines(null)).toEqual([]);
  });
});

describe("requiredBlockLabel", () => {
  it("says what a block id means in words", () => {
    expect(requiredBlockLabel("dataTable")).toBe("data table");
    expect(requiredBlockLabel("dateModified")).toBe(
      "visible last-updated date",
    );
  });

  it("passes an unknown block through rather than dropping it", () => {
    expect(requiredBlockLabel("calculator")).toBe("calculator");
  });
});

describe("cardStamp", () => {
  it("stamps the sample size and flags the write cost as an estimate", () => {
    expect(cardStamp(sampled)).toBe(
      "SERP sample of 6 keywords · write cost estimated at ~$0.25 a page",
    );
  });

  it("says a type was never sampled", () => {
    expect(cardStamp({ ...sampled, status: "unsampled", sampled: 0 })).toBe(
      "not SERP-sampled · write cost estimated at ~$0.25 a page",
    );
    expect(cardStamp(null)).toBe(
      "not SERP-sampled · write cost estimated at ~$0.25 a page",
    );
  });
});

describe("planStamp", () => {
  it("reconciles what went in with what came out", () => {
    expect(
      planStamp({ keywordsClustered: 312, proposed: 6, notWorthBuilding: 2 }),
    ).toBe(
      "clustered from 312 backlog keywords · 6 types proposed · 2 not worth building",
    );
  });

  it("pluralizes a single backlog keyword and a single type", () => {
    expect(
      planStamp({ keywordsClustered: 1, proposed: 1, notWorthBuilding: 0 }),
    ).toBe(
      "clustered from 1 backlog keyword · 1 type proposed · 0 not worth building",
    );
  });

  it("drops the clustered clause when the run never recorded a count", () => {
    expect(
      planStamp({ keywordsClustered: null, proposed: 6, notWorthBuilding: 2 }),
    ).toBe("6 types proposed · 2 not worth building");
  });
});

describe("authoritySentence", () => {
  it("names the single tracked competitor it is comparing against", () => {
    expect(
      authoritySentence({
        ourRank: 21,
        competitorCount: 1,
        lowestRank: 58,
        highestRank: 58,
        topDomain: "rival.com",
      }),
    ).toBe("Your domain rank is 21 against rival.com at 58.");
  });

  it("gives the spread when several competitors carry a rank", () => {
    expect(
      authoritySentence({
        ourRank: 21,
        competitorCount: 3,
        lowestRank: 34,
        highestRank: 58,
        topDomain: "rival.com",
      }),
    ).toBe("Your domain rank is 21 against 3 tracked competitors at 34–58.");
  });

  it("collapses the spread when every competitor scored the same", () => {
    expect(
      authoritySentence({
        ourRank: 21,
        competitorCount: 2,
        lowestRank: 40,
        highestRank: 40,
        topDomain: "rival.com",
      }),
    ).toBe("Your domain rank is 21 against 2 tracked competitors at 40.");
  });

  it("says nothing at all when the comparison was never measured", () => {
    expect(authoritySentence(null)).toBe("");
  });
});
