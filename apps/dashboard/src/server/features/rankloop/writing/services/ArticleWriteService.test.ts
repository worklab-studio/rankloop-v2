import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as DraftModule from "@/server/features/rankloop/writing/draft";
import { AppError } from "@/server/lib/errors";

const mocks = vi.hoisted(() => ({
  env: new Map<string, string>(),
  hosted: { value: false },
  workflow: { create: vi.fn(), get: vi.fn() },
  articleRepo: {
    tryCreateArticle: vi.fn(),
    getActiveArticleForProposal: vi.fn(),
    updateArticle: vi.fn(),
    insertSpend: vi.fn(),
    getSpendForArticle: vi.fn(),
  },
  proposalsRepo: { getProposalById: vi.fn() },
  projectRepo: { getProjectById: vi.fn() },
  billing: {
    checkUsageCreditsDepleted: vi.fn(),
    trackUsageCreditSpend: vi.fn(),
  },
  runWriterCall: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  env: { ARTICLE_WRITE_WORKFLOW: mocks.workflow },
}));
vi.mock("@/server/lib/runtime-env", () => ({
  getOptionalEnvValue: (name: string) => Promise.resolve(mocks.env.get(name)),
  getRequiredEnvValue: (name: string) => Promise.resolve(mocks.env.get(name)),
  isHostedServerAuthMode: () => Promise.resolve(mocks.hosted.value),
}));
vi.mock(
  "@/server/features/rankloop/writing/repositories/ArticleRepository",
  () => ({ ArticleRepository: mocks.articleRepo }),
);
vi.mock(
  "@/server/features/rankloop/proposals/repositories/ProposalsRepository",
  () => ({ ProposalsRepository: mocks.proposalsRepo }),
);
vi.mock("@/server/features/projects/repositories/ProjectRepository", () => ({
  ProjectRepository: mocks.projectRepo,
}));
vi.mock("@/server/billing/subscription", () => mocks.billing);
// Only the call is doubled: `hasWriterProvider` stays real so the keyless
// refusal below still proves what it says it does.
vi.mock("@/server/features/rankloop/writing/draft", async (importActual) => ({
  ...(await importActual<typeof DraftModule>()),
  runWriterCall: mocks.runWriterCall,
}));

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
  mocks.hosted.value = false;
  mocks.workflow.create.mockReset();
  mocks.workflow.get.mockReset();
  for (const mock of Object.values(mocks.articleRepo)) mock.mockReset();
  mocks.proposalsRepo.getProposalById.mockReset();
  mocks.projectRepo.getProjectById.mockReset();
  mocks.billing.checkUsageCreditsDepleted.mockReset();
  mocks.billing.trackUsageCreditSpend.mockReset();
  mocks.runWriterCall.mockReset();

  mocks.env.set("OPENROUTER_API_KEY", "sk-test");
  mocks.proposalsRepo.getProposalById.mockResolvedValue(approvedProposal);
  mocks.articleRepo.tryCreateArticle.mockResolvedValue(true);
  mocks.articleRepo.getSpendForArticle.mockResolvedValue(0.12);
  mocks.workflow.create.mockResolvedValue(undefined);
  mocks.projectRepo.getProjectById.mockResolvedValue({
    id: "project_1",
    organizationId: "org_1",
  });
  mocks.billing.checkUsageCreditsDepleted.mockResolvedValue({
    depleted: false,
    monthlyRemaining: 5000,
  });
  mocks.billing.trackUsageCreditSpend.mockResolvedValue(undefined);
  mocks.runWriterCall.mockResolvedValue({
    spend: {
      model: "house/default",
      inputTokens: 1000,
      outputTokens: 800,
      costUsd: 0.12,
    },
    result: { ok: true, markdown: "# draft" },
  });
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

  it("heals a blocker whose workflow died, and claims again", async () => {
    // The article the fixture's partial unique is refusing: mid-write, api
    // mode, three hours old, and behind an instance the engine has no record
    // of. Nothing in the product can clear that row — recheck refuses every
    // status outside review/approved/failed, and the panel renders a step
    // gerund instead of a button — so the proposal is wedged forever.
    mocks.articleRepo.tryCreateArticle
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    mocks.articleRepo.getActiveArticleForProposal.mockResolvedValue({
      id: "article_wedged",
      status: "briefing",
      writerMode: "api",
      createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    });
    mocks.workflow.get.mockRejectedValue(new Error("no such instance"));

    const result = await ArticleWriteService.startArticle(START);

    expect(result.alreadyWriting).toBe(false);
    expect(result.articleId).not.toBe("article_wedged");
    // The corpse lands terminally, which is what frees the partial unique.
    expect(mocks.articleRepo.updateArticle).toHaveBeenCalledWith(
      "article_wedged",
      expect.objectContaining({ status: "failed" }),
    );
    expect(mocks.articleRepo.tryCreateArticle).toHaveBeenCalledTimes(2);
  });

  it("never probes a draft that is waiting for a human", async () => {
    // `review` outlives the workflow by design: the instance completed, so a
    // probe would call it stale and fail a draft somebody already paid for.
    mocks.articleRepo.tryCreateArticle.mockResolvedValue(false);
    mocks.articleRepo.getActiveArticleForProposal.mockResolvedValue({
      id: "article_reviewable",
      status: "review",
      writerMode: "api",
      createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    });

    const result = await ArticleWriteService.startArticle(START);

    expect(result).toEqual({
      articleId: "article_reviewable",
      alreadyWriting: true,
    });
    expect(mocks.workflow.get).not.toHaveBeenCalled();
    expect(mocks.articleRepo.updateArticle).not.toHaveBeenCalled();
  });

  it("never probes an agent-mode article, which has no workflow at all", async () => {
    mocks.articleRepo.tryCreateArticle.mockResolvedValue(false);
    mocks.articleRepo.getActiveArticleForProposal.mockResolvedValue({
      id: "article_agent",
      status: "writing",
      writerMode: "agent",
      createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    });

    const result = await ArticleWriteService.startArticle(START);

    expect(result.alreadyWriting).toBe(true);
    // The MCP path's row id was never handed to a workflow, so every probe
    // would report it missing and destroy a report mid-flight.
    expect(mocks.workflow.get).not.toHaveBeenCalled();
    expect(mocks.articleRepo.updateArticle).not.toHaveBeenCalled();
  });

  it("concedes to a blocker whose workflow is genuinely running", async () => {
    mocks.articleRepo.tryCreateArticle.mockResolvedValue(false);
    mocks.articleRepo.getActiveArticleForProposal.mockResolvedValue({
      id: "article_live",
      status: "writing",
      writerMode: "api",
      createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    });
    mocks.workflow.get.mockResolvedValue({
      status: () => Promise.resolve({ status: "running" }),
    });

    const result = await ArticleWriteService.startArticle(START);

    expect(result).toEqual({ articleId: "article_live", alreadyWriting: true });
    expect(mocks.articleRepo.updateArticle).not.toHaveBeenCalled();
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

// ---------------------------------------------------------------------------
// Metering
// ---------------------------------------------------------------------------

/** The frozen context one attempt runs against, with the organization the
 *  spend is billed to. */
const CONTEXT = {
  articleId: "article_1",
  projectId: "project_1",
  organizationId: "org_1",
  briefMd: "# brief",
  modelOverride: null,
  trustDial: "autopilot" as const,
  contract: {
    pageTypeName: "Guides",
    contract: null,
    laws: { wordMin: 850, wordMax: 2000 },
    voiceCardMd: null,
    keyword: "burr grinder retention",
    today: "2026-08-01",
  },
};

async function attempt() {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the double only exercises the fields runAttempt reads
  const context = CONTEXT as unknown as Parameters<
    typeof ArticleWriteService.runAttempt
  >[0]["context"];
  return ArticleWriteService.runAttempt({ context, attempt: 1, repair: null });
}

describe("hosted metering", () => {
  it("draws the generation from the same credit pool as every other paid call", async () => {
    mocks.hosted.value = true;

    await attempt();

    expect(mocks.billing.trackUsageCreditSpend).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: "org_1",
        creditFeature: "writer",
        costUsd: 0.12,
        monthlyRemaining: 5000,
      }),
    );
    // The local ledger is not replaced by the pool — it is what the article's
    // cost stamp reads.
    expect(mocks.articleRepo.insertSpend).toHaveBeenCalledWith(
      expect.objectContaining({ costUsd: 0.12, articleId: "article_1" }),
    );
  });

  it("refuses the next attempt once the balance is gone, without calling the model", async () => {
    mocks.hosted.value = true;
    mocks.billing.checkUsageCreditsDepleted.mockResolvedValue({
      depleted: true,
      monthlyRemaining: 0,
    });

    await expect(attempt()).resolves.toMatchObject({
      ok: false,
      failure: { reason: "insufficient_credits" },
    });
    expect(mocks.runWriterCall).not.toHaveBeenCalled();
  });

  it("refuses to start a draft a hosted organization cannot pay for", async () => {
    mocks.hosted.value = true;
    mocks.billing.checkUsageCreditsDepleted.mockResolvedValue({
      depleted: true,
      monthlyRemaining: 0,
    });

    await expect(ArticleWriteService.startArticle(START)).rejects.toMatchObject(
      { code: "INSUFFICIENT_CREDITS" },
    );
    expect(mocks.articleRepo.tryCreateArticle).not.toHaveBeenCalled();
    expect(mocks.workflow.create).not.toHaveBeenCalled();
  });

  it("leaves a self-hosted deployment ungated — it brings its own key", async () => {
    await ArticleWriteService.startArticle(START);
    await attempt();

    expect(mocks.billing.checkUsageCreditsDepleted).not.toHaveBeenCalled();
    expect(mocks.billing.trackUsageCreditSpend).not.toHaveBeenCalled();
    expect(mocks.articleRepo.insertSpend).toHaveBeenCalledTimes(1);
  });
});
