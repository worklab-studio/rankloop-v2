import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

// Preflight and the create, which are the two steps the three rules live in:
// nothing publishes that has not passed the laws, and nothing creates a second
// post. Everything below the service is mocked, so no adapter and no database
// is reachable from here.

const mocks = vi.hoisted(() => ({
  articles: {
    getArticleById: vi.fn(),
    // Typed to the two fields these tests read back off `.mock.calls`: the
    // status an article was returned to, and the report that says why.
    updateArticle:
      vi.fn<
        (
          articleId: string,
          update: { status?: string; lawReportJson?: string },
        ) => Promise<void>
      >(),
  },
  projects: { getProjectById: vi.fn() },
  proposals: { getProposalById: vi.fn() },
  pagePlan: { getPageTypeById: vi.fn(), updatePageType: vi.fn() },
  settings: { getSettings: vi.fn() },
  gate: { gate: vi.fn() },
  publishRepo: {
    claimForPublishing: vi.fn(),
    upsertPublishedPage: vi.fn(),
    markPublishedWithReceipt: vi.fn(),
  },
  receipts: { openReceipt: vi.fn() },
  resolve: { resolvePublishAdapter: vi.fn() },
  autopilot: { getActionBehavior: vi.fn() },
  // Typed to the one field these tests read back: the instance id, which is
  // the whole point of the retry fix.
  workflow: {
    create: vi.fn<(input: { id: string; params: unknown }) => Promise<void>>(),
  },
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock(
  "@/server/features/rankloop/writing/repositories/ArticleRepository",
  () => ({ ArticleRepository: mocks.articles }),
);
vi.mock("@/server/features/projects/repositories/ProjectRepository", () => ({
  ProjectRepository: mocks.projects,
}));
vi.mock(
  "@/server/features/rankloop/proposals/repositories/ProposalsRepository",
  () => ({ ProposalsRepository: mocks.proposals }),
);
vi.mock(
  "@/server/features/rankloop/page-plan/repositories/PagePlanRepository",
  () => ({ PagePlanRepository: mocks.pagePlan }),
);
vi.mock(
  "@/server/features/rankloop/writing/repositories/WriterSettingsRepository",
  () => ({ WriterSettingsRepository: mocks.settings }),
);
vi.mock(
  "@/server/features/rankloop/writing/services/ArticleGateService",
  () => ({ ArticleGateService: mocks.gate }),
);
vi.mock(
  "@/server/features/rankloop/publish/repositories/PublishRepository",
  () => ({ PublishRepository: mocks.publishRepo }),
);
vi.mock("@/server/features/rankloop/receipts/services/ReceiptsService", () => ({
  ReceiptsService: mocks.receipts,
}));
vi.mock("@/server/features/rankloop/publish/adapters/resolve", () => ({
  resolvePublishAdapter: mocks.resolve.resolvePublishAdapter,
}));
vi.mock(
  "@/server/features/rankloop/routines/services/AutopilotService",
  () => ({ AutopilotService: mocks.autopilot }),
);

const DRAFT = [
  "---",
  "title: Espresso tamper sizes",
  "description: Which base fits which basket.",
  "date: 2026-08-01",
  "category: Comparisons",
  "keyword: espresso tamper sizes",
  "---",
  "",
  "The flat base is the whole argument.",
].join("\n");

function article(overrides: Record<string, unknown> = {}) {
  return {
    id: "article_1",
    projectId: "project_1",
    proposalId: "proposal_1",
    proposalType: "write_new",
    pageTypeId: "type_1",
    keyword: "espresso tamper sizes",
    slug: "espresso-tamper-sizes",
    title: "Espresso tamper sizes",
    description: "Which base fits which basket.",
    status: "approved",
    content: DRAFT,
    lawReportJson: JSON.stringify({
      passed: true,
      checkedAt: "2026-07-30T00:00:00.000Z",
      laws: [
        {
          law: "word count >= 850",
          passed: true,
          threshold: null,
          excerpt: null,
        },
      ],
      failure: null,
    }),
    adapter: null,
    adapterRef: null,
    publishedUrl: null,
    ...overrides,
  };
}

function fakeAdapter(overrides: Record<string, unknown> = {}) {
  return {
    adapter: {
      capabilities: {
        kind: "wordpress",
        label: "your WordPress site",
        supportsDraft: true,
        createsHubs: true,
        linkInjection: "edits-pages",
        ownsDerivedArtifacts: false,
        publishedUrl: "returned",
        contentFormat: "html",
      },
      ensureHub: vi.fn(),
      createPost: vi.fn(),
      getPost: vi.fn(),
      updatePost: vi.fn(),
      ...overrides,
    },
    settings: { defaultPostStatus: "draft", linkInjection: true },
  };
}

async function service() {
  const { PublishService } = await import("./PublishService");
  return PublishService;
}

/** Every mock above, reset. A named parameter rather than an inline walk
 *  because the groups are no longer uniform — `workflow.create` is typed to
 *  the field these tests read back — and a union of group shapes widens
 *  `Object.values` to `any`. */
function resetMocks(groups: Record<string, Record<string, Mock>>): void {
  for (const group of Object.values(groups)) {
    for (const mock of Object.values(group)) mock.mockReset();
  }
}

beforeEach(() => {
  vi.resetModules();
  resetMocks(mocks);
  mocks.articles.getArticleById.mockResolvedValue(article());
  mocks.articles.updateArticle.mockResolvedValue(undefined);
  mocks.projects.getProjectById.mockResolvedValue({
    id: "project_1",
    domain: "acme.com",
  });
  mocks.proposals.getProposalById.mockResolvedValue({
    id: "proposal_1",
    type: "write_new",
    keywordBacklogId: "kw_1",
  });
  // The default is the earned answer; the tests below are the ones that take
  // it away, because "autopilot publishes" is the behavior every other test
  // in this file assumes once the dial allows it.
  mocks.autopilot.getActionBehavior.mockResolvedValue({
    behavior: "autopilot",
    fallbackReason: null,
  });
  mocks.pagePlan.getPageTypeById.mockResolvedValue({
    id: "type_1",
    name: "Comparisons",
    urlPattern: "/compare/{slug}/",
    hubContentPageId: null,
  });
  mocks.settings.getSettings.mockResolvedValue({ trustDial: "drafts" });
  mocks.gate.gate.mockResolvedValue({
    passed: true,
    report: { passed: true, violations: 0 },
  });
  mocks.publishRepo.claimForPublishing.mockResolvedValue(true);
  mocks.resolve.resolvePublishAdapter.mockResolvedValue(fakeAdapter());
});

const INPUT = { projectId: "project_1", articleId: "article_1" };

/**
 * The refusal a preflight came back with.
 *
 * Narrowing through a helper rather than an asymmetric matcher on the whole
 * result: what each of these tests is about is the reason, and a test that
 * expected a refusal and got a pass should say that instead of failing on a
 * shape mismatch three lines later. The detail only has to be a sentence — its
 * wording is the product's to change.
 */
function refusal(result: { ok: boolean } | { ok: false; blocked: unknown }): {
  reason: string;
  detail: string;
} {
  if (result.ok || !("blocked" in result)) {
    throw new Error("expected preflight to refuse, and it did not");
  }
  const blocked: unknown = result.blocked;
  if (
    typeof blocked !== "object" ||
    blocked === null ||
    !("reason" in blocked) ||
    !("detail" in blocked)
  ) {
    throw new Error("a refusal must carry a reason and a detail");
  }
  return {
    reason: String(blocked.reason),
    detail: String(blocked.detail),
  };
}

describe("preflight — nothing publishes that has not passed the laws", () => {
  it("re-runs the gate on the stored content rather than trusting the stored pass", async () => {
    await (await service()).preflight(INPUT);

    expect(mocks.gate.gate).toHaveBeenCalledWith({
      projectId: "project_1",
      articleId: "article_1",
      markdown: DRAFT,
    });
  });

  it("refuses when the re-run fails, without claiming the article", async () => {
    mocks.gate.gate.mockResolvedValue({
      passed: false,
      report: { passed: false, violations: 2 },
    });

    const result = await (await service()).preflight(INPUT);

    const blocked = refusal(result);
    expect(blocked.reason).toBe("laws_unmet");
    expect(blocked.detail).toContain("2");
    expect(mocks.publishRepo.claimForPublishing).not.toHaveBeenCalled();
  });

  it("refuses an article with no stored draft", async () => {
    mocks.articles.getArticleById.mockResolvedValue(article({ content: null }));

    const result = await (await service()).preflight(INPUT);

    expect(result.ok).toBe(false);
    expect(mocks.gate.gate).not.toHaveBeenCalled();
  });
});

describe("preflight — the trust dial", () => {
  it("refuses a draft nobody approved when the dial keeps a human in the loop", async () => {
    mocks.articles.getArticleById.mockResolvedValue(
      article({ status: "review" }),
    );

    const result = await (await service()).preflight(INPUT);

    expect(refusal(result).reason).toBe("trust_dial");
    expect(mocks.gate.gate).not.toHaveBeenCalled();
  });

  it("publishes a reviewed draft on autopilot, claiming it from review", async () => {
    mocks.articles.getArticleById.mockResolvedValue(
      article({ status: "review" }),
    );
    mocks.settings.getSettings.mockResolvedValue({ trustDial: "autopilot" });

    const result = await (await service()).preflight(INPUT);

    expect(result.ok).toBe(true);
    expect(mocks.publishRepo.claimForPublishing).toHaveBeenCalledWith(
      expect.objectContaining({ fromStatus: "review" }),
    );
  });

  it("asks about the action type this article's proposal actually is", async () => {
    mocks.articles.getArticleById.mockResolvedValue(
      article({ status: "review" }),
    );
    mocks.settings.getSettings.mockResolvedValue({ trustDial: "autopilot" });

    await (await service()).preflight(INPUT);

    expect(mocks.autopilot.getActionBehavior).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project_1",
        actionType: "write_new",
      }),
    );
  });

  it("refuses an action type autopilot has not earned, and says the number", async () => {
    mocks.articles.getArticleById.mockResolvedValue(
      article({ status: "review" }),
    );
    mocks.settings.getSettings.mockResolvedValue({ trustDial: "autopilot" });
    mocks.autopilot.getActionBehavior.mockResolvedValue({
      behavior: "drafts",
      fallbackReason: "needs 5 measured results, has 2",
    });

    const result = await (await service()).preflight(INPUT);

    expect(refusal(result).reason).toBe("trust_dial");
    expect(refusal(result).detail).toContain("needs 5 measured results, has 2");
    // The dial alone got as far as the eligibility read and no further: no
    // gate was paid for and no claim was taken.
    expect(mocks.gate.gate).not.toHaveBeenCalled();
    expect(mocks.publishRepo.claimForPublishing).not.toHaveBeenCalled();
  });

  it("refuses an action type whose results were poor, with the same shape", async () => {
    mocks.articles.getArticleById.mockResolvedValue(
      article({ status: "review" }),
    );
    mocks.settings.getSettings.mockResolvedValue({ trustDial: "autopilot" });
    mocks.autopilot.getActionBehavior.mockResolvedValue({
      behavior: "drafts",
      fallbackReason:
        "median result is -0.4 positions across 6 measured — autopilot needs an improvement",
    });

    const result = await (await service()).preflight(INPUT);

    expect(refusal(result).detail).toContain("autopilot needs an improvement");
    expect(mocks.publishRepo.claimForPublishing).not.toHaveBeenCalled();
  });

  it("never runs a merge or a prune unattended, whatever the receipts said", async () => {
    mocks.articles.getArticleById.mockResolvedValue(
      article({ status: "review" }),
    );
    mocks.settings.getSettings.mockResolvedValue({ trustDial: "autopilot" });
    mocks.proposals.getProposalById.mockResolvedValue({
      id: "proposal_1",
      type: "merge",
      keywordBacklogId: "kw_1",
    });
    mocks.autopilot.getActionBehavior.mockResolvedValue({
      behavior: "drafts",
      fallbackReason:
        "never unattended — this action removes a page that exists",
    });

    const result = await (await service()).preflight(INPUT);

    expect(refusal(result).detail).toContain("never unattended");
    expect(mocks.publishRepo.claimForPublishing).not.toHaveBeenCalled();
  });

  it("holds every type while the kill switch is tripped", async () => {
    mocks.articles.getArticleById.mockResolvedValue(
      article({ status: "review" }),
    );
    mocks.settings.getSettings.mockResolvedValue({ trustDial: "autopilot" });
    mocks.autopilot.getActionBehavior.mockResolvedValue({
      behavior: "drafts",
      fallbackReason: "autopilot paused — 3 drafts in a row failed the gate",
    });

    const result = await (await service()).preflight(INPUT);

    expect(refusal(result).detail).toContain(
      "3 drafts in a row failed the gate",
    );
    expect(mocks.publishRepo.claimForPublishing).not.toHaveBeenCalled();
  });

  it("leaves an approved draft alone — a human already said yes", async () => {
    mocks.settings.getSettings.mockResolvedValue({ trustDial: "autopilot" });

    const result = await (await service()).preflight(INPUT);

    expect(result.ok).toBe(true);
    expect(mocks.autopilot.getActionBehavior).not.toHaveBeenCalled();
  });

  it("claims from the exact status it judged", async () => {
    await (await service()).preflight(INPUT);

    expect(mocks.publishRepo.claimForPublishing).toHaveBeenCalledWith(
      expect.objectContaining({ fromStatus: "approved" }),
    );
  });

  it("stands down when another run won the claim", async () => {
    mocks.publishRepo.claimForPublishing.mockResolvedValue(false);

    const result = await (await service()).preflight(INPUT);

    expect(refusal(result).reason).toBe("lost_claim");
  });
});

describe("preflight — the connection", () => {
  it("refuses cleanly with no publish connection", async () => {
    mocks.resolve.resolvePublishAdapter.mockResolvedValue(null);

    const result = await (await service()).preflight(INPUT);

    expect(refusal(result).reason).toBe("not_connected");
    expect(mocks.publishRepo.claimForPublishing).not.toHaveBeenCalled();
  });

  it("leaves an already-published article alone", async () => {
    mocks.articles.getArticleById.mockResolvedValue(
      article({ status: "published", adapterRef: "99" }),
    );

    const result = await (await service()).preflight(INPUT);

    expect(refusal(result).reason).toBe("already_published");
  });

  it("skips the laws and the dial on a run resuming behind an adapterRef", async () => {
    mocks.articles.getArticleById.mockResolvedValue(
      article({ status: "publishing", adapterRef: "99" }),
    );

    const result = await (await service()).preflight(INPUT);

    expect(result.ok).toBe(true);
    expect(mocks.gate.gate).not.toHaveBeenCalled();
    expect(mocks.publishRepo.claimForPublishing).not.toHaveBeenCalled();
  });
});
