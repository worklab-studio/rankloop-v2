import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/server/lib/errors";

const mocks = vi.hoisted(() => ({
  env: new Map<string, string>(),
  workflow: { create: vi.fn(), get: vi.fn() },
  articleRepo: {
    tryCreateArticle: vi.fn(),
    getActiveArticleForProposal: vi.fn(),
    updateArticle: vi.fn(),
  },
  proposalsRepo: { getProposalById: vi.fn() },
}));

vi.mock("cloudflare:workers", () => ({
  env: { ARTICLE_WRITE_WORKFLOW: mocks.workflow },
}));
vi.mock("@/server/lib/runtime-env", () => ({
  getOptionalEnvValue: (name: string) => Promise.resolve(mocks.env.get(name)),
  getRequiredEnvValue: (name: string) => Promise.resolve(mocks.env.get(name)),
}));
vi.mock(
  "@/server/features/rankloop/writing/repositories/ArticleRepository",
  () => ({ ArticleRepository: mocks.articleRepo }),
);
vi.mock(
  "@/server/features/rankloop/proposals/repositories/ProposalsRepository",
  () => ({ ProposalsRepository: mocks.proposalsRepo }),
);

const { ArticleWriteService } = await import("./ArticleWriteService");

const START = { projectId: "project_1", proposalId: "proposal_1" };

const approvedProposal = {
  id: "proposal_1",
  projectId: "project_1",
  type: "write_new" as const,
  track: "net_new" as const,
  status: "approved" as const,
  target: "burr grinder retention",
  pageTypeId: "type_1",
  keywordBacklogId: "kw_1",
};

beforeEach(() => {
  mocks.env.clear();
  mocks.workflow.create.mockReset();
  for (const mock of Object.values(mocks.articleRepo)) mock.mockReset();
  mocks.proposalsRepo.getProposalById.mockReset();

  mocks.env.set("OPENROUTER_API_KEY", "sk-test");
  mocks.proposalsRepo.getProposalById.mockResolvedValue(approvedProposal);
  mocks.articleRepo.tryCreateArticle.mockResolvedValue(true);
  mocks.workflow.create.mockResolvedValue(undefined);
});

describe("startArticle", () => {
  it("refuses a keyless deployment before creating anything", async () => {
    mocks.env.delete("OPENROUTER_API_KEY");

    await expect(ArticleWriteService.startArticle(START)).rejects.toMatchObject(
      { code: "WRITER_NOT_CONFIGURED" },
    );
    // No half-written article, no workflow, not even a proposal read.
    expect(mocks.articleRepo.tryCreateArticle).not.toHaveBeenCalled();
    expect(mocks.workflow.create).not.toHaveBeenCalled();
  });

  it("claims the article and starts the workflow under the article's own id", async () => {
    const result = await ArticleWriteService.startArticle(START);

    expect(result.alreadyWriting).toBe(false);
    expect(mocks.articleRepo.tryCreateArticle).toHaveBeenCalledWith(
      expect.objectContaining({
        id: result.articleId,
        projectId: "project_1",
        proposalId: "proposal_1",
        pageTypeId: "type_1",
        keyword: "burr grinder retention",
        // 'api' is what makes every call on this row land in llm_spend.
        writerMode: "api",
        status: "briefing",
      }),
    );
    expect(mocks.workflow.create).toHaveBeenCalledWith({
      id: result.articleId,
      params: { articleId: result.articleId, projectId: "project_1" },
    });
  });

  it("hands back the in-flight article when the partial unique refuses a second claim", async () => {
    mocks.articleRepo.tryCreateArticle.mockResolvedValue(false);
    mocks.articleRepo.getActiveArticleForProposal.mockResolvedValue({
      id: "article_existing",
    });

    const result = await ArticleWriteService.startArticle(START);

    expect(result).toEqual({
      articleId: "article_existing",
      alreadyWriting: true,
    });
    // Pressing Write twice must not start a second workflow on one proposal.
    expect(mocks.workflow.create).not.toHaveBeenCalled();
  });

  it("frees the in-flight slot when the workflow will not start", async () => {
    mocks.workflow.create.mockRejectedValue(new Error("workflows unavailable"));

    await expect(ArticleWriteService.startArticle(START)).rejects.toThrow(
      "workflows unavailable",
    );
    // An article stuck in 'briefing' would hold this proposal's slot forever.
    expect(mocks.articleRepo.updateArticle).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ status: "failed" }),
    );
  });

  it("writes only approved net-new proposals", async () => {
    mocks.proposalsRepo.getProposalById.mockResolvedValue({
      ...approvedProposal,
      status: "proposed",
    });
    await expect(ArticleWriteService.startArticle(START)).rejects.toThrow(
      "Approve this proposal before writing it.",
    );

    mocks.proposalsRepo.getProposalById.mockResolvedValue({
      ...approvedProposal,
      track: "optimize",
      type: "retitle",
    });
    await expect(
      ArticleWriteService.startArticle(START),
    ).rejects.toBeInstanceOf(AppError);

    expect(mocks.articleRepo.tryCreateArticle).not.toHaveBeenCalled();
  });
});
