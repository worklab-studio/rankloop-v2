import { describe, expect, it } from "vitest";
import {
  computeCandidateEvidence,
  pageMatchesCandidate,
  type EvidenceCompetitor,
} from "./evidence.logic";
import {
  detectCandidates,
  type PageTypeCandidate,
  type PlannerBacklogRow,
} from "./planner.logic";

let nextId = 0;

function row(keyword: string): PlannerBacklogRow {
  nextId += 1;
  return {
    id: `kw_${nextId}`,
    keyword,
    searchVolume: 100,
    keywordDifficulty: 20,
    impressions28: null,
  };
}

function comparisonsCandidate(): PageTypeCandidate {
  const [candidate] = detectCandidates([
    row("breville vs delonghi"),
    row("gaggia vs rancilio"),
    row("sage vs breville"),
    row("delonghi vs gaggia"),
  ]);
  return candidate;
}

function clusterCandidate(): PageTypeCandidate {
  const [candidate] = detectCandidates([
    row("espresso machine cleaning routine"),
    row("espresso machine descaling schedule"),
    row("espresso machine water filter"),
  ]);
  return candidate;
}

function competitor(
  domain: string,
  pages: Array<{ url: string; etv: number | null }>,
  studied = true,
): EvidenceCompetitor {
  return { domain, studied, pages };
}

describe("pageMatchesCandidate", () => {
  it("reads a competitor URL through the same pattern table the keywords went through", () => {
    const candidate = comparisonsCandidate();
    expect(
      pageMatchesCandidate(
        candidate,
        "https://rival.example/breville-vs-delonghi/",
      ),
    ).toBe(true);
    expect(
      pageMatchesCandidate(candidate, "https://rival.example/best-grinders/"),
    ).toBe(false);
  });

  it("applies pattern precedence, so a URL reading as two shapes counts once", () => {
    // "/best-breville-vs-delonghi/" is a comparison first, exactly as the
    // keyword of the same words would be.
    const url = "https://rival.example/best-breville-vs-delonghi/";
    expect(pageMatchesCandidate(comparisonsCandidate(), url)).toBe(true);
  });

  it("matches an editorial cluster only when the URL carries every cluster stem", () => {
    const candidate = clusterCandidate();
    expect(
      pageMatchesCandidate(
        candidate,
        "https://rival.example/blog/espresso-machine-descaling.html",
      ),
    ).toBe(true);
    expect(
      pageMatchesCandidate(
        candidate,
        "https://rival.example/blog/espresso-beans/",
      ),
    ).toBe(false);
  });

  it("tolerates a bare path stored instead of a URL", () => {
    expect(
      pageMatchesCandidate(comparisonsCandidate(), "/gaggia-vs-sage/"),
    ).toBe(true);
  });
});

describe("computeCandidateEvidence", () => {
  it("names the competitor earning the largest traffic share from the shape", () => {
    const evidence = computeCandidateEvidence({
      candidate: comparisonsCandidate(),
      competitors: [
        competitor("small.example", [
          { url: "/a-vs-b/", etv: 100 },
          { url: "/guides/water/", etv: 900 },
        ]),
        competitor("big.example", [
          { url: "/x-vs-y/", etv: 400 },
          { url: "/z-vs-w/", etv: 200 },
          { url: "/guides/beans/", etv: 400 },
        ]),
      ],
    });

    expect(evidence).toEqual({
      hasCompetitorSignal: true,
      leadDomain: "big.example",
      matchedPages: 2,
      totalPages: 3,
      pageSharePct: 67,
      etvSharePct: 60,
      competitorsChecked: 2,
      competitorsWithSignal: 2,
    });
  });

  it("omits the sentence rather than faking one when no competitor carries the shape", () => {
    const evidence = computeCandidateEvidence({
      candidate: comparisonsCandidate(),
      competitors: [
        competitor("rival.example", [
          { url: "/guides/water/", etv: 900 },
          { url: "/best-grinders/", etv: 500 },
        ]),
      ],
    });

    expect(evidence).toEqual({
      hasCompetitorSignal: false,
      competitorsChecked: 1,
    });
  });

  it("ignores a competitor nobody has studied — no playbook is not zero evidence", () => {
    const evidence = computeCandidateEvidence({
      candidate: comparisonsCandidate(),
      competitors: [
        competitor("unstudied.example", [{ url: "/a-vs-b/", etv: 500 }], false),
      ],
    });

    expect(evidence).toEqual({
      hasCompetitorSignal: false,
      competitorsChecked: 0,
    });
  });

  it("reports a null traffic share when the provider priced nothing, and still counts pages", () => {
    const evidence = computeCandidateEvidence({
      candidate: comparisonsCandidate(),
      competitors: [
        competitor("keyless.example", [
          { url: "/a-vs-b/", etv: null },
          { url: "/guides/water/", etv: null },
        ]),
      ],
    });

    expect(evidence).toMatchObject({
      hasCompetitorSignal: true,
      leadDomain: "keyless.example",
      pageSharePct: 50,
      etvSharePct: null,
    });
  });

  it("returns no signal when there is no competitor at all", () => {
    expect(
      computeCandidateEvidence({
        candidate: comparisonsCandidate(),
        competitors: [],
      }),
    ).toEqual({ hasCompetitorSignal: false, competitorsChecked: 0 });
  });
});
