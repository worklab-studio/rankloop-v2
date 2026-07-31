import { describe, expect, it } from "vitest";
import {
  isMajorBrand,
  judgeCandidateSerp,
  readSerpSample,
  unsampledSerpCheck,
  type SerpOrganicResult,
  type SerpSample,
  type SerpSampleReading,
} from "./serpVerdict.logic";

const NOW = new Date("2026-07-31T00:00:00Z");

function result(
  position: number,
  domain: string,
  overrides: Partial<SerpOrganicResult> = {},
): SerpOrganicResult {
  return {
    position,
    domain,
    url: `https://${domain}/some/long/article-path/`,
    title: "A perfectly ordinary result",
    description:
      "A description long enough to clear the thin-result floor, because that floor is the only body signal a SERP response actually gives us.",
    ...overrides,
  };
}

function sample(
  organic: SerpOrganicResult[],
  overrides: Partial<SerpSample> = {},
): SerpSample {
  return {
    keyword: "espresso machine vs pod machine",
    organic,
    aiOverview: false,
    featuredSnippet: false,
    ...overrides,
  };
}

function reading(
  overrides: Partial<SerpSampleReading> = {},
): SerpSampleReading {
  return {
    keyword: "k",
    ugcTop5: 0,
    weakness: 0,
    aiOverview: false,
    featuredSnippet: false,
    winnableSignal: true,
    ...overrides,
  };
}

describe("readSerpSample", () => {
  it("counts UGC in the top five as hardness and never as weakness", () => {
    const read = readSerpSample(
      sample([
        result(1, "reddit.com"),
        result(2, "quora.com"),
        result(3, "espresso-obsession.example"),
        result(4, "coffee-lab.example"),
        result(5, "beans-and-brew.example"),
      ]),
      NOW,
    );

    expect(read.ugcTop5).toBe(2);
    expect(read.weakness).toBe(0);
  });

  it("counts the same forum as weakness once it sits at position 8", () => {
    const read = readSerpSample(
      sample([
        result(1, "espresso-obsession.example"),
        result(8, "forum.coffee-talk.example"),
      ]),
      NOW,
    );

    expect(read.ugcTop5).toBe(0);
    expect(read.weakness).toBe(1);
  });

  it("reads thin snippets and stale years in 6–10 as weakness, and stops at position 10", () => {
    const read = readSerpSample(
      sample([
        result(6, "stub.example", { description: "Short." }),
        result(7, "old-guide.example", {
          title: "The 2019 guide to espresso machines",
        }),
        result(11, "stub-two.example", { description: "Also short." }),
      ]),
      NOW,
    );

    expect(read.weakness).toBe(2);
  });

  it("caps weakness at the five slots that exist", () => {
    const read = readSerpSample(
      sample(
        [6, 7, 8, 9, 10].map((position) =>
          result(position, `forum.site-${position}.example`),
        ),
      ),
      NOW,
    );

    expect(read.weakness).toBe(5);
  });

  it("finds a winnable signal below the top three, but not from a major brand", () => {
    const brandsOnly = readSerpSample(
      sample([
        result(4, "amazon.com"),
        result(5, "rei.com", { url: "https://rei.com/" }),
      ]),
      NOW,
    );
    const withIndependent = readSerpSample(
      sample([
        result(4, "amazon.com"),
        result(5, "espresso-obsession.example"),
      ]),
      NOW,
    );

    expect(brandsOnly.winnableSignal).toBe(false);
    expect(withIndependent.winnableSignal).toBe(true);
  });

  it("carries the response's own feature flags through untouched", () => {
    const read = readSerpSample(
      sample([result(4, "espresso-obsession.example")], {
        aiOverview: true,
        featuredSnippet: true,
      }),
      NOW,
    );

    expect(read.aiOverview).toBe(true);
    expect(read.featuredSnippet).toBe(true);
  });
});

describe("isMajorBrand", () => {
  it("catches a listed domain anywhere in the results", () => {
    expect(isMajorBrand(result(7, "www.wikipedia.org"))).toBe(true);
  });

  it("treats an unlisted short domain ranking with its homepage as a brand", () => {
    expect(
      isMajorBrand(result(7, "kettle.com", { url: "https://kettle.com" })),
    ).toBe(true);
  });

  it("leaves the same domain alone when it ranks with a real article", () => {
    expect(
      isMajorBrand(
        result(7, "kettle.com", { url: "https://kettle.com/guides/x/" }),
      ),
    ).toBe(false);
  });
});

describe("judgeCandidateSerp", () => {
  const ok = { kdBandP75: null, kdCeiling: 20 };

  it("kills a shape where UGC owns the top five on most samples", () => {
    const verdict = judgeCandidateSerp({
      ...ok,
      readings: [
        reading({ ugcTop5: 2 }),
        reading({ ugcTop5: 3 }),
        reading({ ugcTop5: 0 }),
      ],
    });

    expect(verdict.status).toBe("kill");
    expect(verdict.hardSerps).toBe(2);
    expect(verdict.reason).toContain("hard SERP, not a weak one");
  });

  it("does not kill on a single hard SERP out of three", () => {
    const verdict = judgeCandidateSerp({
      ...ok,
      readings: [reading({ ugcTop5: 2 }), reading(), reading()],
    });

    expect(verdict.status).toBe("ok");
  });

  it("kills a shape with no winnable signal anywhere in the sample", () => {
    const verdict = judgeCandidateSerp({
      ...ok,
      readings: [
        reading({ winnableSignal: false }),
        reading({ winnableSignal: false }),
      ],
    });

    expect(verdict.status).toBe("kill");
    expect(verdict.reason).toContain("major brand");
  });

  it("cautions when an AI Overview sits on most sampled SERPs", () => {
    const verdict = judgeCandidateSerp({
      ...ok,
      readings: [
        reading({ aiOverview: true }),
        reading({ aiOverview: true }),
        reading(),
      ],
    });

    expect(verdict.status).toBe("caution");
    expect(verdict.aiOverviews).toBe(2);
    expect(verdict.reason).toContain("AI Overview");
  });

  it("cautions when the hard half of the cluster is above the project's ceiling", () => {
    const verdict = judgeCandidateSerp({
      readings: [reading(), reading()],
      kdBandP75: 42,
      kdCeiling: 20,
    });

    expect(verdict.status).toBe("caution");
    expect(verdict.reason).toContain("42");
  });

  it("passes a cluster sitting on the ceiling rather than above it", () => {
    const verdict = judgeCandidateSerp({
      readings: [reading(), reading()],
      kdBandP75: 20,
      kdCeiling: 20,
    });

    expect(verdict.status).toBe("ok");
  });

  it("never cautions on difficulty a cluster does not have", () => {
    const verdict = judgeCandidateSerp({
      readings: [reading(), reading()],
      kdBandP75: null,
      kdCeiling: 20,
    });

    expect(verdict.status).toBe("ok");
  });

  it("says ok in terms of the sample it actually read", () => {
    const verdict = judgeCandidateSerp({
      ...ok,
      readings: [reading(), reading({ weakness: 3 })],
    });

    expect(verdict.status).toBe("ok");
    expect(verdict.sampled).toBe(2);
    expect(verdict.weakSlots).toBe(3);
    expect(verdict.reason).toContain("This is a sample, not a survey.");
  });

  it("reports unsampled with no readings, and carries a reason either way", () => {
    expect(judgeCandidateSerp({ ...ok, readings: [] })).toMatchObject({
      status: "unsampled",
      sampled: 0,
      reason: "Not sampled.",
    });
    expect(unsampledSerpCheck("Not sampled — no SERP provider.")).toMatchObject(
      {
        status: "unsampled",
        reason: "Not sampled — no SERP provider.",
        samples: [],
      },
    );
  });
});
