import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PageTypeUpsert } from "../repositories/PagePlanRepository";

const mocks = vi.hoisted(() => ({
  workersEnv: { DATAFORSEO_API_KEY: "key" } as Record<string, string>,
  repo: {
    tryCreateRun: vi.fn(),
    updateRun: vi.fn(),
    getRunById: vi.fn(),
    getActiveRunForProject: vi.fn(),
    getLatestRunForProject: vi.fn(),
    getPlannableBacklog: vi.fn(),
    countPlannableBacklog: vi.fn(),
    countBoundKeywords: vi.fn(),
    getBoundKeywords: vi.fn(),
    getEvidenceCompetitors: vi.fn(),
    getAuthorityComparison: vi.fn(),
    getPostWordCounts: vi.fn(),
    getPageTypes: vi.fn(),
    getPageTypeById: vi.fn(),
    upsertPageType: vi.fn<(row: PageTypeUpsert) => Promise<string>>(),
    updatePageType: vi.fn(),
    applySerpCheck: vi.fn(),
    deleteUndetectedPlannerTypes: vi.fn(),
    updateDecision: vi.fn(),
    bindKeywordsToPageType: vi.fn(),
  },
  projectRepo: { getProjectById: vi.fn() },
}));

vi.mock("cloudflare:workers", () => ({ env: mocks.workersEnv }));
vi.mock(
  "@/server/features/rankloop/page-plan/repositories/PagePlanRepository",
  () => ({ PagePlanRepository: mocks.repo }),
);
vi.mock("@/server/features/projects/repositories/ProjectRepository", () => ({
  ProjectRepository: mocks.projectRepo,
}));

const { PagePlanService } = await import("./PagePlanService");

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

/** Four comparison keywords — the pSEO floor, so one candidate survives. */
function comparisonBacklog() {
  return [
    "breville vs delonghi",
    "gaggia vs rancilio",
    "sage vs breville",
    "delonghi vs gaggia",
  ].map((keyword, index) => ({
    id: `kw_${index}`,
    keyword,
    searchVolume: 100 * (index + 1),
    keywordDifficulty: 20,
    notesJson: null,
  }));
}

function pageTypeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "pt_1",
    projectId: PROJECT_ID,
    name: "Comparisons",
    kind: "pseo",
    status: "proposed",
    urlPattern: "/compare/{slug}/",
    keywordPattern: "\\bvs\\b|versus",
    templateContractJson: null,
    dataSourceJson: null,
    hubContentPageId: null,
    evidenceJson: null,
    serpCheckJson: null,
    demand: 1000,
    instanceCount: 4,
    createdAt: "2026-07-01T00:00:00.000Z",
    decidedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  mocks.repo.getPlannableBacklog.mockResolvedValue(comparisonBacklog());
  mocks.repo.getEvidenceCompetitors.mockResolvedValue({
    tracked: [],
    pages: [],
  });
  mocks.repo.getAuthorityComparison.mockResolvedValue({
    ourRank: null,
    competitors: [],
  });
  mocks.repo.getPostWordCounts.mockResolvedValue([]);
  mocks.repo.getLatestRunForProject.mockResolvedValue(null);
  mocks.repo.countPlannableBacklog.mockResolvedValue(4);
  mocks.repo.getPageTypes.mockResolvedValue([]);
  mocks.repo.upsertPageType.mockResolvedValue("pt_1");
  mocks.repo.deleteUndetectedPlannerTypes.mockResolvedValue(undefined);
  mocks.repo.countBoundKeywords.mockResolvedValue(4);
  mocks.projectRepo.getProjectById.mockResolvedValue({
    id: PROJECT_ID,
    organizationId: "org_1",
    locationCode: 2840,
    languageCode: "en",
  });
});

describe("proposeTypes", () => {
  it("writes a proposed type with its evidence, contract and an honest unsampled verdict", async () => {
    const result = await PagePlanService.proposeTypes({
      projectId: PROJECT_ID,
    });

    expect(result.typesProposed).toBe(1);
    const row = mocks.repo.upsertPageType.mock.calls[0][0];
    expect(row).toMatchObject({
      projectId: PROJECT_ID,
      name: "Comparisons",
      kind: "pseo",
      urlPattern: "/compare/{slug}/",
      demand: 1000,
      instanceCount: 4,
    });
    const evidence: unknown = JSON.parse(row.evidenceJson);
    expect(evidence).toMatchObject({
      competitor: { hasCompetitorSignal: false, competitorsChecked: 0 },
      exampleTitles: [
        "delonghi vs gaggia",
        "sage vs breville",
        "gaggia vs rancilio",
      ],
    });
    expect(JSON.parse(row.templateContractJson)).toMatchObject({
      notes: ["defaults — no competitor signal"],
    });
    expect(JSON.parse(row.serpCheckJson)).toMatchObject({
      status: "unsampled",
      sampled: 0,
    });

    expect(result.candidates).toEqual([
      {
        pageTypeId: "pt_1",
        name: "Comparisons",
        kdBandP75: 20,
        sampleKeywords: [
          "delonghi vs gaggia",
          "sage vs breville",
          "gaggia vs rancilio",
          "breville vs delonghi",
        ],
      },
    ]);
  });

  it("never touches an approved type on recompute", async () => {
    mocks.repo.getPageTypes.mockResolvedValue([
      pageTypeRow({
        status: "approved",
        decidedAt: "2026-07-02T00:00:00.000Z",
      }),
    ]);

    const result = await PagePlanService.proposeTypes({
      projectId: PROJECT_ID,
    });

    expect(mocks.repo.upsertPageType).not.toHaveBeenCalled();
    expect(result.typesProposed).toBe(0);
    expect(mocks.repo.deleteUndetectedPlannerTypes).toHaveBeenCalledWith(
      PROJECT_ID,
      [],
    );
  });

  it("leaves a type the user declined declined, however strongly it re-detects", async () => {
    mocks.repo.getPageTypes.mockResolvedValue([
      pageTypeRow({
        status: "declined",
        decidedAt: "2026-07-02T00:00:00.000Z",
      }),
    ]);

    await PagePlanService.proposeTypes({ projectId: PROJECT_ID });

    expect(mocks.repo.upsertPageType).not.toHaveBeenCalled();
  });

  it("refreshes a type the planner declined — a kill is the run's opinion, not the user's", async () => {
    mocks.repo.getPageTypes.mockResolvedValue([
      pageTypeRow({ status: "declined", decidedAt: null }),
    ]);

    await PagePlanService.proposeTypes({ projectId: PROJECT_ID });

    expect(mocks.repo.upsertPageType).toHaveBeenCalledTimes(1);
  });

  it("imputes demand from Search Console impressions when the vendor priced nothing", async () => {
    mocks.repo.getPlannableBacklog.mockResolvedValue(
      comparisonBacklog().map((row) => ({
        ...row,
        searchVolume: null,
        notesJson: JSON.stringify({ impr28: 250 }),
      })),
    );

    await PagePlanService.proposeTypes({ projectId: PROJECT_ID });

    expect(mocks.repo.upsertPageType.mock.calls[0][0].demand).toBe(1000);
  });

  it("survives a notesJson this code doesn't understand", async () => {
    mocks.repo.getPlannableBacklog.mockResolvedValue(
      comparisonBacklog().map((row) => ({ ...row, notesJson: "{not json" })),
    );

    await expect(
      PagePlanService.proposeTypes({ projectId: PROJECT_ID }),
    ).resolves.toMatchObject({ typesProposed: 1 });
  });

  it("reports the whole pool it clustered, not just the rows a type claimed", async () => {
    mocks.repo.getPlannableBacklog.mockResolvedValue([
      ...comparisonBacklog(),
      {
        id: "kw_orphan",
        keyword: "espresso machine descaling schedule",
        searchVolume: 40,
        keywordDifficulty: 12,
        notesJson: null,
      },
    ]);

    const result = await PagePlanService.proposeTypes({
      projectId: PROJECT_ID,
    });

    expect(result.keywordsClustered).toBe(5);
  });
});

describe("getPlan", () => {
  it("compares our stored domain rank against the tracked competitors' spread", async () => {
    mocks.repo.getAuthorityComparison.mockResolvedValue({
      ourRank: 21,
      competitors: [
        { domain: "low.example", rank: 34 },
        { domain: "high.example", rank: 58 },
      ],
    });

    const plan = await PagePlanService.getPlan(PROJECT_ID);

    expect(plan.authority).toEqual({
      ourRank: 21,
      competitorCount: 2,
      lowestRank: 34,
      highestRank: 58,
      topDomain: "high.example",
    });
  });

  it("withholds the comparison when our own rank was never measured", async () => {
    mocks.repo.getAuthorityComparison.mockResolvedValue({
      ourRank: null,
      competitors: [{ domain: "high.example", rank: 58 }],
    });

    await expect(PagePlanService.getPlan(PROJECT_ID)).resolves.toMatchObject({
      authority: null,
    });
  });

  it("withholds the comparison when no tracked competitor carries a rank", async () => {
    mocks.repo.getAuthorityComparison.mockResolvedValue({
      ourRank: 21,
      competitors: [{ domain: "unstudied.example", rank: null }],
    });

    await expect(PagePlanService.getPlan(PROJECT_ID)).resolves.toMatchObject({
      authority: null,
    });
  });
});

describe("decidePageType", () => {
  it("binds the type's keywords and stores the count that actually landed", async () => {
    mocks.repo.updateDecision.mockResolvedValue(pageTypeRow());

    const result = await PagePlanService.decidePageType({
      projectId: PROJECT_ID,
      pageTypeId: "pt_1",
      decision: "approved",
    });

    expect(mocks.repo.bindKeywordsToPageType).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      pageTypeId: "pt_1",
      keywordIds: ["kw_3", "kw_2", "kw_1", "kw_0"],
    });
    expect(mocks.repo.updatePageType).toHaveBeenCalledWith("pt_1", {
      instanceCount: 4,
      demand: 1000,
    });
    expect(result).toEqual({ boundKeywords: 4 });
  });

  it("binds nothing on a decline", async () => {
    mocks.repo.updateDecision.mockResolvedValue(
      pageTypeRow({ status: "declined" }),
    );

    await PagePlanService.decidePageType({
      projectId: PROJECT_ID,
      pageTypeId: "pt_1",
      decision: "declined",
    });

    expect(mocks.repo.bindKeywordsToPageType).not.toHaveBeenCalled();
  });

  it("leaves an approved type intact when the backlog no longer clusters that shape", async () => {
    mocks.repo.updateDecision.mockResolvedValue(pageTypeRow());
    mocks.repo.getPlannableBacklog.mockResolvedValue([]);

    const result = await PagePlanService.decidePageType({
      projectId: PROJECT_ID,
      pageTypeId: "pt_1",
      decision: "approved",
    });

    expect(result).toEqual({ boundKeywords: 0 });
    expect(mocks.repo.bindKeywordsToPageType).not.toHaveBeenCalled();
  });

  it("refuses a second decision on a type somebody already decided", async () => {
    mocks.repo.updateDecision.mockResolvedValue(null);
    mocks.repo.getPageTypeById.mockResolvedValue(
      pageTypeRow({ status: "approved" }),
    );

    await expect(
      PagePlanService.decidePageType({
        projectId: PROJECT_ID,
        pageTypeId: "pt_1",
        decision: "declined",
      }),
    ).rejects.toThrow("already approved");
  });
});

describe("getPageTypeInstances", () => {
  it("reads the bound rows for an approved type", async () => {
    mocks.repo.getPageTypeById.mockResolvedValue(
      pageTypeRow({ status: "approved" }),
    );
    mocks.repo.getBoundKeywords.mockResolvedValue([
      {
        id: "kw_0",
        keyword: "breville vs delonghi",
        searchVolume: 100,
        keywordDifficulty: 20,
      },
    ]);

    const page = await PagePlanService.getPageTypeInstances({
      projectId: PROJECT_ID,
      pageTypeId: "pt_1",
      page: 2,
      pageSize: 10,
    });

    expect(mocks.repo.getBoundKeywords).toHaveBeenCalledWith("pt_1", 10, 10);
    expect(page.totalCount).toBe(4);
    expect(page.rows).toHaveLength(1);
  });

  it("re-clusters the backlog for a type nobody has approved yet", async () => {
    mocks.repo.getPageTypeById.mockResolvedValue(pageTypeRow());

    const page = await PagePlanService.getPageTypeInstances({
      projectId: PROJECT_ID,
      pageTypeId: "pt_1",
      page: 1,
      pageSize: 2,
    });

    expect(mocks.repo.getBoundKeywords).not.toHaveBeenCalled();
    expect(page.totalCount).toBe(4);
    expect(page.rows.map((row) => row.keyword)).toEqual([
      "delonghi vs gaggia",
      "sage vs breville",
    ]);
  });
});
