import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  APPROVED_PROPOSAL,
  BROKEN_DRAFT,
  COMPLIANT_DRAFT,
  LINKABLE_PAGES,
  PAGE_TYPE,
  PROJECT_ID,
  PROPOSAL_ID,
  parsesAgainstOutputSchema,
  reportOf,
  toolExtra,
  toolText,
} from "./rankloop-agent.fixture";

// rankloop_publish_report (spec 0023): how an agent-written page lands.
//
// The assertions are mostly about which of the publish feature's own functions
// were called and with what, because that is the claim: the agent path reuses
// the S8a manifest upsert and the S8a commit transaction rather than getting a
// second way to publish written for it.

const mocks = vi.hoisted(() => ({
  getProjectForOrganization: vi.fn(),
  getProjectById: vi.fn(),
  getPageTypeById: vi.fn(),
  getPageTypes: vi.fn(),
  getLinkablePages: vi.fn(),
  getProposalById: vi.fn(),
  articleRepo: {
    tryCreateArticle: vi.fn(),
    getArticleById: vi.fn(),
    getActiveArticleForProposal: vi.fn(),
    updateArticle: vi.fn(),
  },
  agentRepo: {
    getApprovedNetNewProposals: vi.fn(),
    getPublishedArticleForProposal: vi.fn(),
    claimArticleForReport: vi.fn(),
    getArticleStatusCounts: vi.fn(),
    getProposalStatusCounts: vi.fn(),
    getSpendToDate: vi.fn(),
  },
  publishRepo: {
    upsertPublishedPage: vi.fn(),
    markPublishedWithReceipt: vi.fn(),
  },
  openReceipt: vi.fn(),
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
vi.mock(
  "@/server/features/rankloop/agent/repositories/AgentRepository",
  () => ({
    AgentRepository: mocks.agentRepo,
  }),
);
vi.mock(
  "@/server/features/rankloop/publish/repositories/PublishRepository",
  () => ({ PublishRepository: mocks.publishRepo }),
);
vi.mock("@/server/features/rankloop/receipts/services/ReceiptsService", () => ({
  ReceiptsService: { openReceipt: mocks.openReceipt, getReceipts: vi.fn() },
}));
vi.mock("@/server/features/rankloop/writing/services/BriefService", () => ({
  BriefService: { getBriefCost: vi.fn(), buildBrief: vi.fn() },
}));

const REPORT = {
  projectId: PROJECT_ID,
  proposalId: PROPOSAL_ID,
  url: "https://example.com/blog/espresso-grind-size/",
  commit: "abc1234",
};

beforeEach(() => {
  vi.resetModules();
  mocks.getProjectForOrganization.mockReset();
  mocks.getProjectById.mockReset();
  mocks.getPageTypeById.mockReset();
  mocks.getPageTypes.mockReset();
  mocks.getLinkablePages.mockReset();
  mocks.getProposalById.mockReset();
  mocks.openReceipt.mockReset();
  for (const mock of Object.values(mocks.articleRepo)) mock.mockReset();
  for (const mock of Object.values(mocks.agentRepo)) mock.mockReset();
  for (const mock of Object.values(mocks.publishRepo)) mock.mockReset();

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
  mocks.articleRepo.tryCreateArticle.mockResolvedValue(true);
  mocks.articleRepo.updateArticle.mockResolvedValue(undefined);
  mocks.publishRepo.upsertPublishedPage.mockResolvedValue("page_1");
  mocks.publishRepo.markPublishedWithReceipt.mockResolvedValue(undefined);
  mocks.openReceipt.mockResolvedValue({ id: "receipt_1" });
});

describe("rankloop_publish_report", () => {
  it("upserts the manifest page and lands the article, proposal and receipt together", async () => {
    const { rankloopPublishReportTool } =
      await import("./rankloop-writer-tools");

    const result = await rankloopPublishReportTool.handler(REPORT, toolExtra);

    const upsert: unknown =
      mocks.publishRepo.upsertPublishedPage.mock.calls[0]?.[0];
    expect(upsert).toMatchObject({
      projectId: PROJECT_ID,
      url: REPORT.url,
      path: "/blog/espresso-grind-size/",
      kind: "post",
      category: "Guides",
      keyword: "espresso grind size",
    });
    const receipt: unknown = mocks.openReceipt.mock.calls[0]?.[0];
    expect(receipt).toMatchObject({
      actionType: "write_new",
      contentPageId: "page_1",
      targetQuery: "espresso grind size",
    });
    const commit: unknown =
      mocks.publishRepo.markPublishedWithReceipt.mock.calls[0]?.[0];
    expect(commit).toMatchObject({
      proposalId: PROPOSAL_ID,
      keywordBacklogId: "kw_1",
      publishedUrl: REPORT.url,
      adapter: "agent",
      adapterRef: "abc1234",
      receipt: { id: "receipt_1" },
    });
    expect(result.structuredContent).toMatchObject({
      alreadyReported: false,
      path: "/blog/espresso-grind-size/",
      report: null,
    });
    // The article row it minted is an agent-mode one, claimed at `publishing`
    // so the S8a commit's compare-and-set has something to claim from.
    const created: unknown =
      mocks.articleRepo.tryCreateArticle.mock.calls[0]?.[0];
    expect(created).toMatchObject({
      writerMode: "agent",
      status: "publishing",
      keyword: "espresso grind size",
    });
    expect(toolText(result)).toContain("Manifest updated and a receipt opened");
  });

  it("grades a submitted draft and stores the report with the article", async () => {
    const { rankloopPublishReportTool } =
      await import("./rankloop-writer-tools");

    const result = await rankloopPublishReportTool.handler(
      { ...REPORT, draft: COMPLIANT_DRAFT },
      toolExtra,
    );

    expect(reportOf(result).passed).toBe(true);
    const update: unknown = mocks.articleRepo.updateArticle.mock.calls[0]?.[1];
    expect(update).toMatchObject({
      content: COMPLIANT_DRAFT,
      title: "Dialing in espresso on a home machine",
      slug: "dialing-in-espresso-on-a-home-machine",
    });
    expect(toolText(result)).toContain("meets all");
  });

  it("records a failing draft rather than hiding it — the page is already live", async () => {
    const { rankloopPublishReportTool } =
      await import("./rankloop-writer-tools");

    const result = await rankloopPublishReportTool.handler(
      { ...REPORT, draft: BROKEN_DRAFT },
      toolExtra,
    );

    expect(reportOf(result).passed).toBe(false);
    expect(mocks.publishRepo.markPublishedWithReceipt).toHaveBeenCalled();
    expect(toolText(result)).toContain("unmet law(s)");
  });

  it("prefers the agent's own path, and falls back to the PR when there is no commit", async () => {
    const { rankloopPublishReportTool } =
      await import("./rankloop-writer-tools");

    await rankloopPublishReportTool.handler(
      {
        projectId: PROJECT_ID,
        proposalId: PROPOSAL_ID,
        url: "https://example.com/anything",
        path: "guides/espresso",
        pullRequestUrl: "https://github.com/acme/site/pull/12",
      },
      toolExtra,
    );

    const upsert: unknown =
      mocks.publishRepo.upsertPublishedPage.mock.calls[0]?.[0];
    expect(upsert).toMatchObject({ path: "/guides/espresso/" });
    const commit: unknown =
      mocks.publishRepo.markPublishedWithReceipt.mock.calls[0]?.[0];
    expect(commit).toMatchObject({
      adapterRef: "https://github.com/acme/site/pull/12",
    });
  });

  it("is a no-op on a second report, not a second receipt", async () => {
    mocks.articleRepo.tryCreateArticle.mockResolvedValue(false);
    mocks.articleRepo.getActiveArticleForProposal.mockResolvedValue(null);
    mocks.agentRepo.getPublishedArticleForProposal.mockResolvedValue({
      id: "article_1",
    });
    const { rankloopPublishReportTool } =
      await import("./rankloop-writer-tools");

    const result = await rankloopPublishReportTool.handler(REPORT, toolExtra);

    expect(result.structuredContent).toMatchObject({
      alreadyReported: true,
      articleId: "article_1",
    });
    expect(mocks.openReceipt).not.toHaveBeenCalled();
    expect(mocks.publishRepo.markPublishedWithReceipt).not.toHaveBeenCalled();
    expect(toolText(result)).toContain("Already reported");
  });

  it("claims an in-flight draft instead of minting a second article", async () => {
    mocks.articleRepo.tryCreateArticle.mockResolvedValue(false);
    mocks.articleRepo.getActiveArticleForProposal.mockResolvedValue({
      id: "article_1",
      status: "review",
    });
    mocks.agentRepo.claimArticleForReport.mockResolvedValue(true);
    const { rankloopPublishReportTool } =
      await import("./rankloop-writer-tools");

    const result = await rankloopPublishReportTool.handler(REPORT, toolExtra);

    expect(mocks.agentRepo.claimArticleForReport).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      articleId: "article_1",
      fromStatus: "review",
    });
    expect(result.structuredContent).toMatchObject({
      articleId: "article_1",
      alreadyReported: false,
    });
  });

  it("refuses to report over a publish this app is already running", async () => {
    mocks.articleRepo.tryCreateArticle.mockResolvedValue(false);
    mocks.articleRepo.getActiveArticleForProposal.mockResolvedValue({
      id: "article_1",
      status: "publishing",
    });
    const { rankloopPublishReportTool } =
      await import("./rankloop-writer-tools");

    await expect(
      rankloopPublishReportTool.handler(REPORT, toolExtra),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(mocks.publishRepo.markPublishedWithReceipt).not.toHaveBeenCalled();
  });

  it("refuses a project outside the token's organization", async () => {
    mocks.getProjectForOrganization.mockResolvedValue(null);
    const { rankloopPublishReportTool } =
      await import("./rankloop-writer-tools");

    await expect(
      rankloopPublishReportTool.handler(
        { ...REPORT, projectId: "someone_elses" },
        toolExtra,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.articleRepo.tryCreateArticle).not.toHaveBeenCalled();
  });
});

describe("rankloop_publish_report's output schema", () => {
  it("accepts the payload its own handler produces", async () => {
    const { rankloopPublishReportTool } =
      await import("./rankloop-writer-tools");

    const result = await rankloopPublishReportTool.handler(
      { ...REPORT, draft: COMPLIANT_DRAFT },
      toolExtra,
    );

    expect(
      await parsesAgainstOutputSchema(
        rankloopPublishReportTool.config.outputSchema,
        result,
      ),
    ).toBe(true);
  });
});
