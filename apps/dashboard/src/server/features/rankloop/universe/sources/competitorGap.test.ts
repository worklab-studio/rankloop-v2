import { describe, expect, it, vi } from "vitest";
import type { DomainIntersectionItem } from "@/server/lib/dataforseo";

const mocks = vi.hoisted(() => ({
  domainIntersection: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/server/lib/dataforseo", () => ({
  createDataforseoClient: () => ({
    labs: { domainIntersection: mocks.domainIntersection },
  }),
}));

const { collectCompetitorGap, GAP_ROWS_PER_COMPETITOR, toGapCandidates } =
  await import("./competitorGap");

function item(input: {
  keyword: string;
  position: number | null;
  volume?: number | null;
  kd?: number | null;
  intent?: string;
}): DomainIntersectionItem {
  return {
    keyword_data: {
      keyword: input.keyword,
      keyword_info: { search_volume: input.volume ?? null },
      keyword_properties: { keyword_difficulty: input.kd ?? null },
      search_intent_info: { main_intent: input.intent ?? null },
    },
    first_domain_serp_element: { rank_group: input.position },
  };
}

const billingCustomer = {
  userId: "system",
  userEmail: "system@openseo.so",
  organizationId: "org_1",
  projectId: "project_1",
};

describe("toGapCandidates", () => {
  it("admits hard keywords unfiltered — the ceiling applies at scoring", () => {
    const candidates = toGapCandidates(
      [item({ keyword: "Espresso Grinder", position: 3, volume: 900, kd: 78 })],
      "rival.com",
    );
    // KD 78 is far past any adaptive ceiling; dropping it here would mean the
    // row never comes back when the site gets strong enough to want it.
    expect(candidates).toEqual([
      {
        keyword: "espresso grinder",
        source: "gap",
        searchVolume: 900,
        keywordDifficulty: 78,
        intent: null,
        seed: "rival.com",
        notes: { competitor: "rival.com", competitorPosition: 3 },
      },
    ]);
  });

  it("keeps only keywords the competitor actually wins", () => {
    const candidates = toGapCandidates(
      [
        item({ keyword: "inside", position: 10 }),
        item({ keyword: "outside", position: 11 }),
        item({ keyword: "unranked", position: null }),
      ],
      "rival.com",
    );
    expect(candidates.map((candidate) => candidate.keyword)).toEqual([
      "inside",
    ]);
  });

  it("normalizes intent and drops the unknown bucket", () => {
    const [commercial, unknown] = toGapCandidates(
      [
        item({ keyword: "best grinder", position: 2, intent: "commercial" }),
        item({ keyword: "grinder guide", position: 2 }),
      ],
      "rival.com",
    );
    expect(commercial.intent).toBe("commercial");
    expect(unknown.intent).toBeNull();
  });
});

describe("collectCompetitorGap", () => {
  it("asks for one gap per competitor, at the row cap the cost sentence quotes", async () => {
    mocks.domainIntersection.mockResolvedValue([
      item({ keyword: "espresso grinder", position: 2 }),
    ]);

    const candidates = await collectCompetitorGap({
      siteDomain: "mine.com",
      competitorDomains: ["rival.com", "other.com"],
      locationCode: 2840,
      languageCode: "en",
      billingCustomer,
    });

    expect(mocks.domainIntersection).toHaveBeenCalledTimes(2);
    expect(mocks.domainIntersection).toHaveBeenCalledWith({
      target1: "rival.com",
      target2: "mine.com",
      locationCode: 2840,
      languageCode: "en",
      limit: GAP_ROWS_PER_COMPETITOR,
    });
    expect(candidates).toHaveLength(2);
  });

  it("loses one competitor's gap to a failed call, not the whole source", async () => {
    mocks.domainIntersection
      .mockRejectedValueOnce(new Error("no index for this domain"))
      .mockResolvedValueOnce([
        item({ keyword: "espresso grinder", position: 2 }),
      ]);

    const candidates = await collectCompetitorGap({
      siteDomain: "mine.com",
      competitorDomains: ["rival.com", "other.com"],
      locationCode: 2840,
      languageCode: "en",
      billingCustomer,
    });

    expect(candidates.map((candidate) => candidate.seed)).toEqual([
      "other.com",
    ]);
  });
});
