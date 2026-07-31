import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CreatePostInput,
  CreatedPost,
} from "@/server/features/rankloop/publish/adapters/types";

// The two steps that write: the hub that must exist first, and the create that
// must happen exactly once. Split from PublishService.test.ts, which covers the
// step that decides whether either of them runs at all.

const mocks = vi.hoisted(() => ({
  articles: { getArticleById: vi.fn(), updateArticle: vi.fn() },
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
    lawReportJson: null,
    adapter: null,
    adapterRef: null,
    publishedUrl: null,
    ...overrides,
  };
}

function fakeAdapter() {
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
      // Typed so the create assertion below can read the input off
      // `.mock.calls` — what this file is about is the exact shape that
      // reaches the target.
      createPost: vi.fn<(input: CreatePostInput) => Promise<CreatedPost>>(),
      getPost: vi.fn(),
      updatePost: vi.fn(),
    },
    settings: { defaultPostStatus: "draft", linkInjection: true },
  };
}

async function service() {
  const { PublishService } = await import("./PublishService");
  return PublishService;
}

const CONTEXT = {
  projectId: "project_1",
  articleId: "article_1",
  proposalId: "proposal_1",
  keywordBacklogId: "kw_1",
  pageTypeId: "type_1",
  pageTypeName: "Comparisons",
  urlPattern: "/compare/{slug}/",
  keyword: "espresso tamper sizes",
  slug: "espresso-tamper-sizes",
  title: "Espresso tamper sizes",
  description: "Which base fits which basket.",
  date: "2026-08-01",
  path: "/compare/espresso-tamper-sizes/",
  siteUrl: "https://acme.com",
  adapterRef: null,
};

const HUB = {
  contentPageId: "page_hub",
  path: "/compare/",
  url: "https://acme.com/compare/",
  ref: "12",
  created: true,
  note: null,
};
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
  mocks.resolve.resolvePublishAdapter.mockResolvedValue(fakeAdapter());
});

describe("publishPost — the resume guard", () => {
  it("never creates a second post when the row already carries a ref", async () => {
    const resolved = fakeAdapter();
    mocks.resolve.resolvePublishAdapter.mockResolvedValue(resolved);
    mocks.articles.getArticleById.mockResolvedValue(
      article({
        status: "publishing",
        adapterRef: "99",
        publishedUrl: "https://acme.com/compare/espresso-tamper-sizes/",
      }),
    );

    const result = await (
      await service()
    ).publishPost({
      context: CONTEXT,
      hub: HUB,
      targets: [],
      anchor: "Espresso tamper sizes",
    });

    expect(resolved.adapter.createPost).not.toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({ adapterRef: "99", resumed: true }),
    );
  });

  it("stores the ref in its own write, the instant the post exists", async () => {
    const resolved = fakeAdapter();
    resolved.adapter.createPost.mockResolvedValue({
      ref: "99",
      url: "https://acme.com/compare/espresso-tamper-sizes/",
      urlConfidence: "verified",
      notes: [],
    });
    mocks.resolve.resolvePublishAdapter.mockResolvedValue(resolved);

    await (
      await service()
    ).publishPost({
      context: CONTEXT,
      hub: HUB,
      targets: [],
      anchor: "Espresso tamper sizes",
    });

    expect(mocks.articles.updateArticle).toHaveBeenCalledWith("article_1", {
      adapter: "wordpress",
      adapterRef: "99",
      publishedUrl: "https://acme.com/compare/espresso-tamper-sizes/",
    });
  });

  it("sends the draft's own bytes and the hub it was handed", async () => {
    const resolved = fakeAdapter();
    resolved.adapter.createPost.mockResolvedValue({
      ref: "99",
      url: "https://acme.com/compare/espresso-tamper-sizes/",
      urlConfidence: "verified",
      notes: [],
    });
    mocks.resolve.resolvePublishAdapter.mockResolvedValue(resolved);

    await (
      await service()
    ).publishPost({
      context: CONTEXT,
      hub: HUB,
      targets: [{ contentPageId: "page_a", path: "/compare/a/", title: "A" }],
      anchor: "Espresso tamper sizes",
    });

    const [created] = resolved.adapter.createPost.mock.calls[0];
    // The markdown goes out as the laws graded it, at the path the page type's
    // pattern implies, under the hub that was ensured first.
    expect(created.article).toMatchObject({
      markdown: DRAFT,
      slug: "espresso-tamper-sizes",
      path: "/compare/espresso-tamper-sizes/",
    });
    expect(created.hub).toEqual({
      name: "Comparisons",
      path: "/compare/",
      ref: "12",
    });
    expect(created.links).toEqual([
      {
        fromPath: "/compare/a/",
        toPath: "/compare/espresso-tamper-sizes/",
        anchor: "Espresso tamper sizes",
      },
    ]);
  });
});

describe("ensureHub — hub before instance", () => {
  it("pins the hub's manifest row on the page type", async () => {
    const resolved = fakeAdapter();
    resolved.adapter.ensureHub.mockResolvedValue({
      ref: "12",
      path: "/compare/",
      url: "https://acme.com/compare/",
      created: true,
      notes: [],
    });
    mocks.resolve.resolvePublishAdapter.mockResolvedValue(resolved);
    mocks.publishRepo.upsertPublishedPage.mockResolvedValue("page_hub");

    const result = await (await service()).ensureHub(CONTEXT);

    expect(mocks.publishRepo.upsertPublishedPage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "hub", path: "/compare/" }),
    );
    expect(mocks.pagePlan.updatePageType).toHaveBeenCalledWith("type_1", {
      hubContentPageId: "page_hub",
    });
    expect(result.created).toBe(true);
  });

  it("notes rather than fails when the page type has no hub path", async () => {
    const result = await (
      await service()
    ).ensureHub({
      ...CONTEXT,
      urlPattern: null,
    });

    expect(result.contentPageId).toBeNull();
    expect(result.note).toBeTruthy();
  });

  it("notes rather than fails when the target manages its own hubs", async () => {
    const resolved = fakeAdapter();
    resolved.adapter.capabilities.createsHubs = false;
    mocks.resolve.resolvePublishAdapter.mockResolvedValue(resolved);

    const result = await (await service()).ensureHub(CONTEXT);

    expect(resolved.adapter.ensureHub).not.toHaveBeenCalled();
    expect(result.note).toContain("WordPress");
  });
});
