import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { z } from "zod";

// Where a publish run ends when it does not publish: the refusal, the crash,
// and the start that has to be able to happen again afterwards. Split from
// PublishService.test.ts, which covers the step that decides whether a run
// proceeds at all.

const mocks = vi.hoisted(() => ({
  articles: {
    getArticleById: vi.fn(),
    // Typed to the two fields these tests read back off `.mock.calls`: the
    // status an article was landed in, and the report that says why.
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
  // what makes a second publish possible at all.
  workflow: {
    create: vi.fn<(input: { id: string; params: unknown }) => Promise<void>>(),
  },
}));

vi.mock("cloudflare:workers", () => ({
  env: { PUBLISH_WORKFLOW: mocks.workflow },
}));
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

function article(overrides: Record<string, unknown> = {}) {
  return {
    id: "article_1",
    projectId: "project_1",
    proposalId: "proposal_1",
    pageTypeId: "type_1",
    keyword: "espresso tamper sizes",
    slug: "espresso-tamper-sizes",
    title: "Espresso tamper sizes",
    status: "approved",
    content: "# draft",
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
  mocks.resolve.resolvePublishAdapter.mockResolvedValue({
    adapter: { capabilities: { kind: "wordpress" } },
    settings: { linkInjection: true },
  });
  mocks.workflow.create.mockResolvedValue(undefined);
});

/**
 * The engine's actual rule, which is what makes the id choice load-bearing:
 * "if a provided id exists, an error will be thrown" — and a completed
 * instance keeps its id for the account's whole retention period.
 */
function workflowRejectingReusedIds() {
  const used = new Set<string>();
  return (input: { id: string }) => {
    if (used.has(input.id)) {
      return Promise.reject(new Error("instance.already_exists"));
    }
    used.add(input.id);
    return Promise.resolve(undefined);
  };
}

const INPUT = { projectId: "project_1", articleId: "article_1" };

/** The stored law report, parsed at the boundary so the assertions below read
 *  fields rather than poking at `any`. */
const lawReportShape = z.object({
  passed: z.boolean(),
  laws: z.array(z.unknown()),
  failure: z.unknown(),
});

function lawReport(raw: string | undefined) {
  return lawReportShape.parse(JSON.parse(raw ?? "null"));
}

const failureShape = z.object({ reason: z.string(), detail: z.string() });

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

  it("leaves a row another run holds at publishing exactly where it is", async () => {
    await (
      await service()
    ).landBlocked({
      ...INPUT,
      blocked: { reason: "lost_claim", detail: "Another publish is running." },
    });

    // The loser of the claim writing `review` would make the winner's commit
    // CAS miss, and a live post would never be recorded as published.
    expect(mocks.articles.updateArticle).not.toHaveBeenCalled();
  });
});

describe("landCrashed — a run that threw past the claim", () => {
  it("lands the article terminally instead of leaving it in publishing", async () => {
    mocks.articles.getArticleById.mockResolvedValue(
      article({ status: "publishing" }),
    );

    const result = await (
      await service()
    ).landCrashed({ ...INPUT, detail: "wp 502" });

    expect(result).toEqual({ landed: true });
    const [, update] = mocks.articles.updateArticle.mock.calls[0];
    expect(update.status).toBe("failed");
    const report = lawReport(update.lawReportJson);
    // The checklist the gate wrote survives; only the failure is added.
    expect(report.laws).toHaveLength(1);
    const failure = failureShape.parse(report.failure);
    expect(failure.reason).toBe("internal_error");
    expect(failure.detail).toContain("wp 502");
  });

  it("says the post is live when the create had already stored its ref", async () => {
    mocks.articles.getArticleById.mockResolvedValue(
      article({ status: "publishing", adapterRef: "99" }),
    );

    await (await service()).landCrashed({ ...INPUT, detail: "db gone" });

    const [, update] = mocks.articles.updateArticle.mock.calls[0];
    const report = lawReport(update.lawReportJson);
    expect(failureShape.parse(report.failure).detail).toContain(
      "The post exists on your site",
    );
  });

  it("never un-publishes an article the commit already landed", async () => {
    mocks.articles.getArticleById.mockResolvedValue(
      article({ status: "published", adapterRef: "99" }),
    );

    const result = await (
      await service()
    ).landCrashed({ ...INPUT, detail: "db gone" });

    expect(result).toEqual({ landed: false });
    expect(mocks.articles.updateArticle).not.toHaveBeenCalled();
  });
});

describe("startPublish — a publish that can be retried", () => {
  const START = { projectId: "project_1", articleId: "article_1" };

  it("starts a second run for an article whose first run is over", async () => {
    mocks.workflow.create.mockImplementation(workflowRejectingReusedIds());

    const first = await (await service()).startPublish(START);
    // What preflight does on a refusal: the article is back in review and the
    // instance completed. Pressing Publish again has to actually publish.
    mocks.articles.getArticleById.mockResolvedValue(
      article({ status: "review" }),
    );
    const second = await (await service()).startPublish(START);

    expect(first.alreadyPublishing).toBe(false);
    expect(second.alreadyPublishing).toBe(false);
    expect(mocks.workflow.create).toHaveBeenCalledTimes(2);
    const ids = mocks.workflow.create.mock.calls.map((call) => call[0].id);
    expect(ids[0]).not.toBe(ids[1]);
    // The article id is the payload, never the instance id — instance ids are
    // permanent, and the article id is not.
    expect(ids).not.toContain("article_1");
  });

  it("reads 'already publishing' off the row, which is the real lock", async () => {
    mocks.articles.getArticleById.mockResolvedValue(
      article({ status: "publishing" }),
    );

    const result = await (await service()).startPublish(START);

    expect(result.alreadyPublishing).toBe(true);
    expect(mocks.workflow.create).not.toHaveBeenCalled();
  });

  it("surfaces a create failure rather than reporting a run that never started", async () => {
    mocks.workflow.create.mockRejectedValue(new Error("no such binding"));

    await expect((await service()).startPublish(START)).rejects.toThrow(
      "no such binding",
    );
  });
});
