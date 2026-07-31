import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

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

beforeEach(() => {
  vi.resetModules();
  for (const group of Object.values(mocks)) {
    for (const mock of Object.values(group)) mock.mockReset();
  }
  mocks.articles.getArticleById.mockResolvedValue(article());
  mocks.articles.updateArticle.mockResolvedValue(undefined);
  mocks.projects.getProjectById.mockResolvedValue({
    id: "project_1",
    domain: "acme.com",
  });
  mocks.proposals.getProposalById.mockResolvedValue({
    id: "proposal_1",
    keywordBacklogId: "kw_1",
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

/** The stored law report, parsed. Validated at the boundary so the assertions
 *  below read fields rather than poking at `any`. */
const lawReportShape = z.object({
  passed: z.boolean(),
  laws: z.array(z.unknown()),
  failure: z.unknown(),
});

function lawReport(raw: string | undefined) {
  return lawReportShape.parse(JSON.parse(raw ?? "null"));
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

describe("landBlocked", () => {
  it("returns the article to review with the reason, keeping the green checklist", async () => {
    await (
      await service()
    ).landBlocked({
      ...INPUT,
      blocked: { reason: "not_connected", detail: "Connect a target." },
    });

    const [, update] = mocks.articles.updateArticle.mock.calls[0];
    expect(update.status).toBe("review");
    // The green checklist survives the block: the report keeps its passing
    // laws and gains a failure that names why publishing stopped.
    const report = lawReport(update.lawReportJson);
    expect(report.passed).toBe(true);
    expect(report.laws).toHaveLength(1);
    expect(report.failure).toEqual({
      reason: "publish_blocked",
      detail: "Connect a target.",
    });
  });

  it("does not touch an article that was refused for being published already", async () => {
    await (
      await service()
    ).landBlocked({
      ...INPUT,
      blocked: { reason: "already_published", detail: "Already published." },
    });

    expect(mocks.articles.updateArticle).not.toHaveBeenCalled();
  });
});
