import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  related: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/server/lib/dataforseo", () => ({
  createDataforseoClient: () => ({ keywords: { related: mocks.related } }),
}));

const {
  EXPANSION_ROWS_PER_SEED,
  EXPANSION_SEED_LIMIT,
  expandSeeds,
  toExpansionCandidates,
} = await import("./seedExpansion");

type ExpansionKeywordData = Parameters<typeof toExpansionCandidates>[0][number];

function keywordData(input: {
  keyword: string;
  volume?: number | null;
  kd?: number | null;
  intent?: string;
}): ExpansionKeywordData {
  return {
    keyword: input.keyword,
    keyword_info: { search_volume: input.volume ?? null },
    keyword_properties: { keyword_difficulty: input.kd ?? null },
    search_intent_info: { main_intent: input.intent ?? null },
  };
}

const billingCustomer = {
  userId: "system",
  userEmail: "system@openseo.so",
  organizationId: "org_1",
  projectId: "project_1",
};

describe("toExpansionCandidates", () => {
  it("carries the measured numbers through and drops the seed itself", () => {
    const candidates = toExpansionCandidates(
      [
        keywordData({
          keyword: "Burr Grinder Settings",
          volume: 480,
          kd: 22,
          intent: "informational",
        }),
        keywordData({ keyword: "burr grinder", volume: 9900 }),
      ],
      "burr grinder",
    );
    expect(candidates).toEqual([
      {
        keyword: "burr grinder settings",
        source: "expansion",
        searchVolume: 480,
        keywordDifficulty: 22,
        intent: "informational",
        seed: "burr grinder",
      },
    ]);
  });
});

describe("expandSeeds", () => {
  it("spends one call per seed, capped at twenty", async () => {
    mocks.related.mockResolvedValue([
      { keyword_data: keywordData({ keyword: "related phrase" }) },
    ]);

    const seeds = Array.from(
      { length: EXPANSION_SEED_LIMIT + 4 },
      (_, index) => `seed ${index}`,
    );
    await expandSeeds({
      seeds,
      locationCode: 2840,
      languageCode: "en",
      billingCustomer,
    });

    expect(mocks.related).toHaveBeenCalledTimes(EXPANSION_SEED_LIMIT);
    expect(mocks.related).toHaveBeenLastCalledWith({
      keyword: `seed ${EXPANSION_SEED_LIMIT - 1}`,
      locationCode: 2840,
      languageCode: "en",
      limit: EXPANSION_ROWS_PER_SEED,
      depth: 2,
    });
  });

  it("loses one seed's neighbourhood to a failed call, not the whole source", async () => {
    mocks.related
      .mockRejectedValueOnce(new Error("provider timeout"))
      .mockResolvedValueOnce([
        { keyword_data: keywordData({ keyword: "second neighbour" }) },
      ]);

    const candidates = await expandSeeds({
      seeds: ["first", "second"],
      locationCode: 2840,
      languageCode: "en",
      billingCustomer,
    });

    expect(candidates.map((candidate) => candidate.keyword)).toEqual([
      "second neighbour",
    ]);
  });

  it("skips related items that carry no keyword payload", async () => {
    mocks.related.mockResolvedValue([
      { keyword_data: null },
      { keyword_data: keywordData({ keyword: "real neighbour" }) },
    ]);

    const candidates = await expandSeeds({
      seeds: ["seed"],
      locationCode: 2840,
      languageCode: "en",
      billingCustomer,
    });

    expect(candidates).toHaveLength(1);
  });
});
