import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  APPROVED_PROPOSAL,
  BROKEN_DRAFT,
  COMPLIANT_DRAFT,
  CONTRACT,
  LINKABLE_PAGES,
  PAGE_TYPE,
  PROJECT_ID,
  PROPOSAL_ID,
  parsesAgainstOutputSchema,
  reportOf,
  toolExtra,
  toolText,
} from "./rankloop-agent.fixture";

// rankloop_brief and rankloop_check (spec 0023).
//
// Only the leaf repositories are mocked. `ArticleGateService`, `gate.ts` and
// @rankloop/engine all run for real, because the one thing this file has to
// prove is that `rankloop_check` and the dashboard's own gate return the same
// report for the same bytes — and a mocked grader would prove nothing.

const mocks = vi.hoisted(() => ({
  getProjectForOrganization: vi.fn(),
  getProjectById: vi.fn(),
  getPageTypeById: vi.fn(),
  getPageTypes: vi.fn(),
  getLinkablePages: vi.fn(),
  getProposalById: vi.fn(),
  briefService: { getBriefCost: vi.fn(), buildBrief: vi.fn() },
  articleRepo: {
    tryCreateArticle: vi.fn(),
    getArticleById: vi.fn(),
    getActiveArticleForProposal: vi.fn(),
    updateArticle: vi.fn(),
  },
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: {
    getProjectForOrganization: mocks.getProjectForOrganization,
  },
}));
vi.mock("@/server/features/projects/repositories/ProjectRepository", () => ({
  ProjectRepository: { getProjectById: mocks.getProjectById },
}));
vi.mock(
  "@/server/features/rankloop/page-plan/repositories/PagePlanRepository",
  () => ({
    PagePlanRepository: {
      getPageTypeById: mocks.getPageTypeById,
      getPageTypes: mocks.getPageTypes,
    },
  }),
);
vi.mock(
  "@/server/features/rankloop/writing/repositories/BriefRepository",
  () => ({ BriefRepository: { getLinkablePages: mocks.getLinkablePages } }),
);
vi.mock(
  "@/server/features/rankloop/proposals/repositories/ProposalsRepository",
  () => ({ ProposalsRepository: { getProposalById: mocks.getProposalById } }),
);
vi.mock(
  "@/server/features/rankloop/writing/repositories/ArticleRepository",
  () => ({ ArticleRepository: mocks.articleRepo }),
);
vi.mock(
  "@/server/features/rankloop/writing/repositories/WriterSettingsRepository",
  () => ({ WriterSettingsRepository: { getSettings: vi.fn() } }),
);
vi.mock("@/server/features/rankloop/writing/services/BriefService", () => ({
  BriefService: mocks.briefService,
}));

beforeEach(() => {
  vi.resetModules();
  mocks.getProjectForOrganization.mockReset();
  mocks.getProjectById.mockReset();
  mocks.getPageTypeById.mockReset();
  mocks.getPageTypes.mockReset();
  mocks.getLinkablePages.mockReset();
  mocks.getProposalById.mockReset();
  for (const mock of Object.values(mocks.briefService)) mock.mockReset();
  for (const mock of Object.values(mocks.articleRepo)) mock.mockReset();

  mocks.getProjectForOrganization.mockResolvedValue({
    id: PROJECT_ID,
    locationCode: 2840,
    languageCode: "en",
  });
  mocks.getProjectById.mockResolvedValue({
    id: PROJECT_ID,
    name: "Example",
    domain: "example.com",
  });
  mocks.getPageTypeById.mockResolvedValue(PAGE_TYPE);
  mocks.getPageTypes.mockResolvedValue([PAGE_TYPE]);
  mocks.getLinkablePages.mockResolvedValue(LINKABLE_PAGES);
  mocks.getProposalById.mockResolvedValue(APPROVED_PROPOSAL);
  mocks.articleRepo.updateArticle.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// rankloop_check
// ---------------------------------------------------------------------------

describe("rankloop_check", () => {
  it("returns every law, pass or fail, with thresholds and observations", async () => {
    const { rankloopCheckTool } = await import("./rankloop-writer-tools");

    const result = await rankloopCheckTool.handler(
      {
        projectId: PROJECT_ID,
        proposalId: PROPOSAL_ID,
        draft: COMPLIANT_DRAFT,
      },
      toolExtra,
    );

    expect(result.structuredContent).toMatchObject({
      proposalId: PROPOSAL_ID,
      keyword: "espresso grind size",
      slug: "dialing-in-espresso-on-a-home-machine",
      passed: true,
      violations: 0,
    });
    // The passes are in the report too — a receipt listing only failures
    // proves nothing.
    const report = reportOf(result);
    expect(report.laws.length).toBeGreaterThan(10);
    expect(report.laws.every((law) => law.passed)).toBe(true);
    expect(report.laws.map((law) => law.law)).toContain("word count >= 60");
    const out = toolText(result);
    expect(out).toContain("PASS —");
    expect(out).toContain("law | verdict | threshold | observed | excerpt");
  });

  it("names each failed law and quotes the draft's own words", async () => {
    const { rankloopCheckTool } = await import("./rankloop-writer-tools");

    const result = await rankloopCheckTool.handler(
      { projectId: PROJECT_ID, proposalId: PROPOSAL_ID, draft: BROKEN_DRAFT },
      toolExtra,
    );

    const report = reportOf(result);
    expect(report.passed).toBe(false);
    const failed = report.laws
      .filter((law) => !law.passed)
      .map((law) => law.id);
    expect(failed).toContain("emDash");
    expect(failed).toContain("bannedPhrases");
    expect(failed).toContain("internalLinksMin");
    // Excerpts are the draft's own text, not a law name.
    expect(
      report.laws.find((law) => law.id === "bannedPhrases")?.excerpt,
    ).toContain("In the ever-evolving world of home");
    expect(
      report.laws.find((law) => law.id === "internalLinksMin")?.excerpt,
    ).toBe("/blog/no-such-page/");
    expect(toolText(result)).toContain("FAIL —");
  });

  it("grades against the proposal's page type, so a draft cannot pick easier laws", async () => {
    mocks.getPageTypeById.mockResolvedValue({
      ...PAGE_TYPE,
      templateContractJson: JSON.stringify({
        ...CONTRACT,
        wordBand: [900, 2000],
      }),
    });
    const { rankloopCheckTool } = await import("./rankloop-writer-tools");

    const result = await rankloopCheckTool.handler(
      {
        projectId: PROJECT_ID,
        proposalId: PROPOSAL_ID,
        draft: COMPLIANT_DRAFT,
      },
      toolExtra,
    );

    const wordMin = reportOf(result).laws.find((law) => law.id === "wordMin");
    expect(wordMin?.threshold).toBe("900 words");
    expect(wordMin?.passed).toBe(false);
  });

  it("refuses an optimize-track proposal, which has no page to write", async () => {
    mocks.getProposalById.mockResolvedValue({
      ...APPROVED_PROPOSAL,
      track: "optimize",
      type: "retitle",
    });
    const { rankloopCheckTool } = await import("./rankloop-writer-tools");

    await expect(
      rankloopCheckTool.handler(
        {
          projectId: PROJECT_ID,
          proposalId: PROPOSAL_ID,
          draft: COMPLIANT_DRAFT,
        },
        toolExtra,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("writes nothing — an agent may call it as often as it edits", async () => {
    const { rankloopCheckTool } = await import("./rankloop-writer-tools");

    await rankloopCheckTool.handler(
      { projectId: PROJECT_ID, proposalId: PROPOSAL_ID, draft: BROKEN_DRAFT },
      toolExtra,
    );

    expect(mocks.articleRepo.updateArticle).not.toHaveBeenCalled();
    expect(mocks.articleRepo.tryCreateArticle).not.toHaveBeenCalled();
  });

  it("refuses a project outside the token's organization", async () => {
    mocks.getProjectForOrganization.mockResolvedValue(null);
    const { rankloopCheckTool } = await import("./rankloop-writer-tools");

    await expect(
      rankloopCheckTool.handler(
        { projectId: "someone_elses", proposalId: PROPOSAL_ID, draft: "x" },
        toolExtra,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

// ---------------------------------------------------------------------------
// The reason rankloop_check is a tool and not a second grader
// ---------------------------------------------------------------------------

describe("rankloop_check and the dashboard's gate", () => {
  it.each([
    ["a compliant draft", COMPLIANT_DRAFT],
    ["a draft that breaks three laws", BROKEN_DRAFT],
  ])("produce an identical report for %s", async (_name, draft) => {
    // Both paths mint their own `checkedAt`, so the clock is frozen rather
    // than the field excused: with one instant the two reports have to match
    // byte for byte, which is the whole claim being tested.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T09:00:00.000Z"));
    mocks.articleRepo.getArticleById.mockResolvedValue({
      id: "article_1",
      projectId: PROJECT_ID,
      proposalId: PROPOSAL_ID,
      pageTypeId: APPROVED_PROPOSAL.pageTypeId,
      keyword: APPROVED_PROPOSAL.target,
      status: "review",
    });
    const { rankloopCheckTool } = await import("./rankloop-writer-tools");
    const { ArticleGateService } =
      await import("@/server/features/rankloop/writing/services/ArticleGateService");

    const viaTool = await rankloopCheckTool.handler(
      { projectId: PROJECT_ID, proposalId: PROPOSAL_ID, draft },
      toolExtra,
    );
    const viaDashboard = await ArticleGateService.gate({
      projectId: PROJECT_ID,
      articleId: "article_1",
      markdown: draft,
    });

    expect(reportOf(viaTool)).toEqual(viaDashboard.report);
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// rankloop_brief
// ---------------------------------------------------------------------------

describe("rankloop_brief", () => {
  beforeEach(() => {
    mocks.briefService.getBriefCost.mockResolvedValue({
      keyword: "espresso grind size",
      cachedSerpSource: null,
      cachedSerpFetchedAt: null,
      willFetchSerp: true,
      costUsd: 0.003,
      serpProviderConfigured: true,
    });
    mocks.briefService.buildBrief.mockResolvedValue({
      markdown: "# Brief\n\nWrite the page.",
      keyword: "espresso grind size",
      serpSource: "none",
      serpFetchedAt: null,
      costUsd: 0,
    });
  });

  it("renders the brief on cached grounding and prices the fetch it did not make", async () => {
    const { rankloopBriefTool } = await import("./rankloop-writer-tools");

    const result = await rankloopBriefTool.handler(
      { projectId: PROJECT_ID, proposalId: PROPOSAL_ID },
      toolExtra,
    );

    const call: unknown = mocks.briefService.buildBrief.mock.calls[0]?.[0];
    expect(call).toMatchObject({
      projectId: PROJECT_ID,
      proposalId: PROPOSAL_ID,
      allowSerpFetch: false,
    });
    expect(result.structuredContent).toMatchObject({
      keyword: "espresso grind size",
      costUsd: 0,
      wouldCostUsd: 0.003,
    });
    const out = toolText(result);
    expect(out).toContain("Re-run with allowSerpFetch=true to buy one for $");
    expect(out).toContain("# Brief");
  });

  it("buys the SERP only when asked, and reports what it spent", async () => {
    mocks.briefService.buildBrief.mockResolvedValue({
      markdown: "# Brief",
      keyword: "espresso grind size",
      serpSource: "fetched",
      serpFetchedAt: "2026-08-01T00:00:00.000Z",
      costUsd: 0.003,
    });
    const { rankloopBriefTool } = await import("./rankloop-writer-tools");

    const result = await rankloopBriefTool.handler(
      { projectId: PROJECT_ID, proposalId: PROPOSAL_ID, allowSerpFetch: true },
      toolExtra,
    );

    const call: unknown = mocks.briefService.buildBrief.mock.calls[0]?.[0];
    // The billing customer is the token's, not the caller's claim.
    expect(call).toMatchObject({
      allowSerpFetch: true,
      billingCustomer: {
        userId: "user_1",
        organizationId: "org_1",
        projectId: PROJECT_ID,
      },
    });
    expect(toolText(result)).toContain("This brief bought one SERP: $0.003.");
  });
});

describe("the writing tools' output schemas", () => {
  it("accept the payloads their own handlers produce", async () => {
    mocks.briefService.getBriefCost.mockResolvedValue({
      keyword: "espresso grind size",
      cachedSerpSource: "plan",
      cachedSerpFetchedAt: "2026-07-01T00:00:00.000Z",
      willFetchSerp: false,
      costUsd: 0,
      serpProviderConfigured: true,
    });
    mocks.briefService.buildBrief.mockResolvedValue({
      markdown: "# Brief",
      keyword: "espresso grind size",
      serpSource: "plan",
      serpFetchedAt: "2026-07-01T00:00:00.000Z",
      costUsd: 0,
    });
    const { rankloopBriefTool, rankloopCheckTool } =
      await import("./rankloop-writer-tools");

    const brief = await rankloopBriefTool.handler(
      { projectId: PROJECT_ID, proposalId: PROPOSAL_ID },
      toolExtra,
    );
    expect(
      await parsesAgainstOutputSchema(
        rankloopBriefTool.config.outputSchema,
        brief,
      ),
    ).toBe(true);

    // The broken draft, because a failing report is the one that carries
    // excerpts and a failure block — the shapes a passing report never has.
    const check = await rankloopCheckTool.handler(
      { projectId: PROJECT_ID, proposalId: PROPOSAL_ID, draft: BROKEN_DRAFT },
      toolExtra,
    );
    expect(
      await parsesAgainstOutputSchema(
        rankloopCheckTool.config.outputSchema,
        check,
      ),
    ).toBe(true);
  });
});
