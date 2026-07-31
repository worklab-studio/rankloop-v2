import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  proposals: { getProposalById: vi.fn() },
  plan: { getPageTypeById: vi.fn(), getPageTypes: vi.fn() },
  projects: { getProjectById: vi.fn() },
  brief: {
    getLinkablePages: vi.fn(),
    getKeywordRow: vi.fn(),
    getLatestSerpSnapshot: vi.fn(),
    insertGroundingSerpSnapshot: vi.fn(),
    getWriterSettings: vi.fn(),
  },
  hasSerpProvider: vi.fn(),
  serpLive: vi.fn(),
}));

vi.mock(
  "@/server/features/rankloop/proposals/repositories/ProposalsRepository",
  () => ({ ProposalsRepository: mocks.proposals }),
);
vi.mock(
  "@/server/features/rankloop/page-plan/repositories/PagePlanRepository",
  () => ({ PagePlanRepository: mocks.plan }),
);
vi.mock("@/server/features/projects/repositories/ProjectRepository", () => ({
  ProjectRepository: mocks.projects,
}));
vi.mock(
  "@/server/features/rankloop/writing/repositories/BriefRepository",
  () => ({ BriefRepository: mocks.brief }),
);
// The page plan's sampler owns the response readers; mocked here so this test
// stays a test of what the brief spends rather than of the DataForSEO shape.
vi.mock(
  "@/server/features/rankloop/page-plan/services/planSerpSampling",
  () => ({
    hasSerpProvider: mocks.hasSerpProvider,
    toSerpSample: (keyword: string, items: { title?: string }[]) => ({
      keyword,
      organic: items.map((item, index) => ({
        position: index + 1,
        url: `https://rival.com/${index}`,
        domain: "rival.com",
        title: item.title ?? "",
        description: null,
      })),
      aiOverview: false,
      featuredSnippet: false,
    }),
    readPaaQuestions: () => ["Does it fit under a cabinet?"],
  }),
);
vi.mock("@/server/lib/dataforseo", () => ({
  createDataforseoClient: () => ({ serp: { live: mocks.serpLive } }),
}));

const { BriefService } = await import("./BriefService");

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const PROPOSAL_ID = "22222222-2222-4222-8222-222222222222";
const KEYWORD = "best espresso machine for small kitchens";

const billingCustomer = {
  userId: "user_1",
  userEmail: "user@example.com",
  organizationId: "org_1",
  projectId: PROJECT_ID,
};

function planSnapshot() {
  return {
    organicJson: JSON.stringify([
      {
        position: 1,
        url: "https://rival.com/best",
        domain: "rival.com",
        title: "The 7 best espresso machines",
        description: null,
      },
    ]),
    paaJson: JSON.stringify(["Do they need a water softener?"]),
    fetchedAt: "2026-07-30T10:00:00.000Z",
  };
}

/** No snapshot of either purpose — the only state that can reach a provider. */
function noCachedSerp() {
  mocks.brief.getLatestSerpSnapshot.mockResolvedValue(null);
}

function cachedSerp(purpose: "plan" | "grounding") {
  mocks.brief.getLatestSerpSnapshot.mockImplementation(
    (_projectId: string, _keyword: string, wanted: string) =>
      Promise.resolve(wanted === purpose ? planSnapshot() : null),
  );
}

beforeEach(() => {
  mocks.proposals.getProposalById.mockResolvedValue({
    id: PROPOSAL_ID,
    type: "write_new",
    track: "net_new",
    keywordBacklogId: "kw_1",
    pageTypeId: "pt_1",
  });
  mocks.projects.getProjectById.mockResolvedValue({
    id: PROJECT_ID,
    name: "Example",
    domain: "example.com",
    locationCode: 2840,
    languageCode: "en",
  });
  mocks.plan.getPageTypeById.mockResolvedValue({
    id: "pt_1",
    name: "Best-of lists",
    status: "approved",
    urlPattern: "/best/{slug}/",
    templateContractJson: JSON.stringify({
      requiredBlocks: ["dataTable"],
      wordBand: [1200, 1800],
      h2Min: 6,
      faqMin: 5,
      internalLinksMin: 3,
      schemaType: "ItemList",
      notes: [],
    }),
  });
  mocks.plan.getPageTypes.mockResolvedValue([
    { name: "Best-of lists", status: "approved" },
    { name: "Comparisons", status: "approved" },
    { name: "Glossary", status: "proposed" },
  ]);
  mocks.brief.getKeywordRow.mockResolvedValue({
    keyword: KEYWORD,
    category: "Best-of lists",
    format: "listicle",
    searchVolume: 320,
    keywordDifficulty: 24,
    intent: "commercial",
    score: 41.5,
    source: "expansion",
    notesJson: null,
  });
  mocks.brief.getLinkablePages.mockResolvedValue([
    {
      path: "/blog/burr-grinders/",
      title: "Burr grinders",
      category: "Best-of lists",
    },
    { path: "/blog/descaling/", title: "Descaling", category: "Guides" },
  ]);
  mocks.brief.getWriterSettings.mockResolvedValue(null);
  mocks.hasSerpProvider.mockReturnValue(true);
});

describe("buildBrief", () => {
  it("reuses the page plan's snapshot instead of buying the SERP again", async () => {
    cachedSerp("plan");

    const result = await BriefService.buildBrief({
      projectId: PROJECT_ID,
      proposalId: PROPOSAL_ID,
      billingCustomer,
      allowSerpFetch: true,
    });

    expect(mocks.serpLive).not.toHaveBeenCalled();
    expect(result.serpSource).toBe("plan");
    expect(result.costUsd).toBe(0);
    expect(result.serpFetchedAt).toBe("2026-07-30T10:00:00.000Z");
    expect(result.markdown).toContain("The 7 best espresso machines");
  });

  it("reuses a grounding snapshot an earlier brief already paid for", async () => {
    cachedSerp("grounding");

    const result = await BriefService.buildBrief({
      projectId: PROJECT_ID,
      proposalId: PROPOSAL_ID,
      billingCustomer,
      allowSerpFetch: true,
    });

    expect(mocks.serpLive).not.toHaveBeenCalled();
    expect(result.serpSource).toBe("grounding");
    expect(result.costUsd).toBe(0);
  });

  it("fetches once, as grounding, when no snapshot exists and the caller allowed it", async () => {
    noCachedSerp();
    mocks.serpLive.mockResolvedValue([
      { type: "organic", title: "Somebody else's list" },
    ]);

    const result = await BriefService.buildBrief({
      projectId: PROJECT_ID,
      proposalId: PROPOSAL_ID,
      billingCustomer,
      allowSerpFetch: true,
    });

    expect(mocks.serpLive).toHaveBeenCalledTimes(1);
    expect(mocks.serpLive).toHaveBeenCalledWith({
      keyword: KEYWORD,
      locationCode: 2840,
      languageCode: "en",
      depth: 10,
    });
    expect(mocks.brief.insertGroundingSerpSnapshot).toHaveBeenCalledTimes(1);
    expect(result.serpSource).toBe("fetched");
    expect(result.costUsd).toBe(0.002);
    expect(result.markdown).toContain("Somebody else's list");
    expect(result.markdown).toContain("Does it fit under a cabinet?");
  });

  it("spends nothing when the caller has not agreed to the fetch", async () => {
    noCachedSerp();

    const result = await BriefService.buildBrief({
      projectId: PROJECT_ID,
      proposalId: PROPOSAL_ID,
      billingCustomer,
      allowSerpFetch: false,
    });

    expect(mocks.serpLive).not.toHaveBeenCalled();
    expect(result.costUsd).toBe(0);
    expect(result.serpSource).toBe("none");
    expect(result.markdown).toContain("No cached SERP for this keyword");
  });

  it("still renders a brief on a keyless deployment", async () => {
    noCachedSerp();
    mocks.hasSerpProvider.mockReturnValue(false);

    const result = await BriefService.buildBrief({
      projectId: PROJECT_ID,
      proposalId: PROPOSAL_ID,
      billingCustomer,
      allowSerpFetch: true,
    });

    expect(mocks.serpLive).not.toHaveBeenCalled();
    expect(result.serpSource).toBe("none");
    expect(result.markdown).toContain("# Writer brief:");
  });

  it("does not retry, and charges nothing, when the provider fails", async () => {
    noCachedSerp();
    mocks.serpLive.mockRejectedValue(new Error("upstream down"));

    const result = await BriefService.buildBrief({
      projectId: PROJECT_ID,
      proposalId: PROPOSAL_ID,
      billingCustomer,
      allowSerpFetch: true,
    });

    expect(mocks.serpLive).toHaveBeenCalledTimes(1);
    expect(result.costUsd).toBe(0);
    expect(result.serpSource).toBe("none");
    expect(result.markdown).toContain("No cached SERP for this keyword");
  });

  it("says there is no voice card when the project has never saved one", async () => {
    cachedSerp("plan");

    const result = await BriefService.buildBrief({
      projectId: PROJECT_ID,
      proposalId: PROPOSAL_ID,
      billingCustomer,
      allowSerpFetch: false,
    });

    expect(result.markdown).toMatch(/no voice card yet/i);
  });

  it("uses the project's stored voice card when there is one", async () => {
    cachedSerp("plan");
    mocks.brief.getWriterSettings.mockResolvedValue({
      voiceCardMd: "I run a two-person roastery and I weigh everything.",
    });

    const result = await BriefService.buildBrief({
      projectId: PROJECT_ID,
      proposalId: PROPOSAL_ID,
      billingCustomer,
      allowSerpFetch: false,
    });

    expect(result.markdown).toContain("I weigh everything");
    expect(result.markdown).not.toMatch(/no voice card yet/i);
  });

  it("merges the page type's contract over the engine defaults", async () => {
    cachedSerp("plan");

    const result = await BriefService.buildBrief({
      projectId: PROJECT_ID,
      proposalId: PROPOSAL_ID,
      billingCustomer,
      allowSerpFetch: false,
    });

    expect(result.markdown).toContain("1200 to 1800 words in the article body");
    expect(result.markdown).toContain("At least 3 internal links");
    expect(result.markdown).toContain("## Page type contract: Best-of lists");
    expect(result.markdown).toContain("Schema type: ItemList");
  });

  it("offers only approved types as the taxonomy", async () => {
    cachedSerp("plan");

    const result = await BriefService.buildBrief({
      projectId: PROJECT_ID,
      proposalId: PROPOSAL_ID,
      billingCustomer,
      allowSerpFetch: false,
    });

    expect(result.markdown).toContain("- Comparisons -> ");
    expect(result.markdown).not.toContain("Glossary");
  });

  it("refuses to brief an optimize-track proposal", async () => {
    mocks.proposals.getProposalById.mockResolvedValue({
      id: PROPOSAL_ID,
      type: "retitle",
      track: "optimize",
      keywordBacklogId: null,
      pageTypeId: null,
    });

    await expect(
      BriefService.buildBrief({
        projectId: PROJECT_ID,
        proposalId: PROPOSAL_ID,
        billingCustomer,
        allowSerpFetch: false,
      }),
    ).rejects.toThrow("Only net-new proposals have a writer brief.");
  });
});

describe("getBriefCost", () => {
  it("quotes the fetch before anything is fetched", async () => {
    noCachedSerp();

    const preview = await BriefService.getBriefCost({
      projectId: PROJECT_ID,
      proposalId: PROPOSAL_ID,
    });

    expect(preview).toEqual({
      keyword: KEYWORD,
      cachedSerpSource: null,
      cachedSerpFetchedAt: null,
      willFetchSerp: true,
      costUsd: 0.002,
      serpProviderConfigured: true,
    });
    expect(mocks.serpLive).not.toHaveBeenCalled();
  });

  it("quotes nothing when the page plan already paid for this keyword", async () => {
    cachedSerp("plan");

    const preview = await BriefService.getBriefCost({
      projectId: PROJECT_ID,
      proposalId: PROPOSAL_ID,
    });

    expect(preview.cachedSerpSource).toBe("plan");
    expect(preview.willFetchSerp).toBe(false);
    expect(preview.costUsd).toBe(0);
  });

  it("quotes nothing when there is no provider to call", async () => {
    noCachedSerp();
    mocks.hasSerpProvider.mockReturnValue(false);

    const preview = await BriefService.getBriefCost({
      projectId: PROJECT_ID,
      proposalId: PROPOSAL_ID,
    });

    expect(preview.willFetchSerp).toBe(false);
    expect(preview.costUsd).toBe(0);
    expect(preview.serpProviderConfigured).toBe(false);
  });
});
