import { beforeEach, describe, expect, it, vi } from "vitest";

// The sentence above the Publish button is a promise, so what it promises is
// tested here rather than trusted. The GitHub pair is the case that was wrong:
// `publishedUrl` is 'computed' on that target whichever way it writes, so a
// connection set to commit straight to the base branch used to be described as
// opening a pull request the user would then go looking for.

const mocks = vi.hoisted(() => ({
  articles: { getArticleById: vi.fn() },
  pagePlan: { getPageTypeById: vi.fn() },
  settings: { getSettings: vi.fn() },
  publishRepo: { getHubPathsByPageType: vi.fn() },
  links: { planLinks: vi.fn() },
  publish: { describeRun: vi.fn() },
  resolve: { resolvePublishAdapter: vi.fn() },
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock(
  "@/server/features/rankloop/writing/repositories/ArticleRepository",
  () => ({ ArticleRepository: mocks.articles }),
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
  "@/server/features/rankloop/publish/repositories/PublishRepository",
  () => ({ PublishRepository: mocks.publishRepo }),
);
vi.mock(
  "@/server/features/rankloop/publish/services/PublishLinksService",
  () => ({ PublishLinksService: mocks.links }),
);
vi.mock("@/server/features/rankloop/publish/services/PublishService", () => ({
  PublishService: mocks.publish,
}));
vi.mock("@/server/features/rankloop/publish/adapters/resolve", () => ({
  resolvePublishAdapter: mocks.resolve.resolvePublishAdapter,
}));

const githubCapabilities = {
  kind: "github",
  label: "acme/site",
  supportsDraft: true,
  createsHubs: true,
  linkInjection: "edits-pages",
  ownsDerivedArtifacts: true,
  // Both commit modes compute the URL — which is exactly why this field is
  // not what the action reads.
  publishedUrl: "computed",
  contentFormat: "markdown",
};

function resolvedGitHub(directCommit: boolean) {
  return {
    adapter: { capabilities: githubCapabilities },
    settings: {
      defaultPostStatus: "draft",
      linkInjection: false,
      directCommit,
    },
  };
}

async function service() {
  const { PublishPlanService } = await import("./PublishPlanService");
  return PublishPlanService;
}

beforeEach(() => {
  mocks.articles.getArticleById.mockResolvedValue({
    id: "article_1",
    projectId: "project_1",
    pageTypeId: null,
    keyword: "espresso tamper sizes",
    slug: "espresso-tamper-sizes",
    status: "approved",
    content: "# Espresso tamper sizes",
    lawReportJson: null,
    adapter: null,
    publishedUrl: null,
    linksInjectedJson: null,
  });
  mocks.settings.getSettings.mockResolvedValue(null);
  mocks.publish.describeRun.mockResolvedValue({ projectId: "project_1" });
  mocks.links.planLinks.mockResolvedValue([]);
});

describe("getPublishPlan", () => {
  it("says the run opens a pull request when the connection is not set to commit directly", async () => {
    mocks.resolve.resolvePublishAdapter.mockResolvedValue(
      resolvedGitHub(false),
    );

    const plan = await (
      await service()
    ).getPublishPlan({ projectId: "project_1", articleId: "article_1" });

    expect(plan.action).toBe("opens-pull-request");
  });

  it("says the run commits when the GitHub connection commits directly, even though its URL is still computed", async () => {
    mocks.resolve.resolvePublishAdapter.mockResolvedValue(resolvedGitHub(true));

    const plan = await (
      await service()
    ).getPublishPlan({ projectId: "project_1", articleId: "article_1" });

    expect(plan.action).toBe("commits");
  });
});
