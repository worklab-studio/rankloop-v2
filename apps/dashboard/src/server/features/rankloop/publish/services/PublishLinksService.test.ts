import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DerivedArtifact,
  ExistingPost,
  OwnedBlockUpdate,
} from "@/server/features/rankloop/publish/adapters/types";
import type { PublishContext } from "./publishContext";

// Rule 2 where it meets the network: what actually gets written to a page
// rankloop did not create. The merge itself is proven in
// relatedBlock.logic.test.ts; these tests are about which writes happen at all.

const mocks = vi.hoisted(() => ({
  publishRepo: {
    getLinkCandidates: vi.fn(),
    getManifestForWire: vi.fn(),
  },
  pagePlan: { getPageTypeById: vi.fn() },
  resolve: { resolvePublishAdapter: vi.fn() },
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock(
  "@/server/features/rankloop/publish/repositories/PublishRepository",
  () => ({ PublishRepository: mocks.publishRepo }),
);
vi.mock(
  "@/server/features/rankloop/page-plan/repositories/PagePlanRepository",
  () => ({ PagePlanRepository: mocks.pagePlan }),
);
vi.mock("@/server/features/rankloop/publish/adapters/resolve", () => ({
  resolvePublishAdapter: mocks.resolve.resolvePublishAdapter,
}));

const CONTEXT: PublishContext = {
  projectId: "project_1",
  articleId: "article_1",
  proposalId: "proposal_1",
  proposalType: "write_new",
  keywordBacklogId: "kw_1",
  pageTypeId: "type_1",
  pageTypeName: "Comparisons",
  urlPattern: "/compare/{slug}/",
  keyword: "espresso tamper sizes",
  slug: "espresso-tamper-sizes",
  title: "Espresso tamper sizes",
  description: "",
  date: "2026-08-01",
  path: "/compare/espresso-tamper-sizes/",
  siteUrl: "https://acme.com",
  adapterRef: null,
};

const TARGETS = [{ contentPageId: "page_a", path: "/compare/a/", title: "A" }];

const USER_PROSE = "# A\n\nProse the user wrote and nobody else may touch.\n";

type AdapterOverrides = {
  capabilities?: Record<string, unknown>;
  settings?: Record<string, unknown>;
};

function fakeAdapter(overrides: AdapterOverrides = {}) {
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
        ...overrides.capabilities,
      },
      ensureHub: vi.fn(),
      createPost: vi.fn(),
      // Typed so the assertions below can read `.mock.calls` for the bytes
      // that reached the page — the whole point of these tests — without
      // reaching through `any`.
      getPost: vi.fn<(path: string) => Promise<ExistingPost | null>>(),
      updatePost: vi.fn<(update: OwnedBlockUpdate) => Promise<void>>(),
      commitArtifacts:
        vi.fn<
          (input: {
            ref: string;
            artifacts: DerivedArtifact[];
          }) => Promise<void>
        >(),
    },
    settings: {
      defaultPostStatus: "draft",
      linkInjection: true,
      ...overrides.settings,
    },
  };
}

async function service() {
  const { PublishLinksService } = await import("./PublishLinksService");
  return PublishLinksService;
}

beforeEach(() => {
  vi.resetModules();
  for (const group of Object.values(mocks)) {
    for (const mock of Object.values(group)) mock.mockReset();
  }
  mocks.pagePlan.getPageTypeById.mockResolvedValue({
    id: "type_1",
    hubContentPageId: "page_hub",
  });
  mocks.resolve.resolvePublishAdapter.mockResolvedValue(fakeAdapter());
});

describe("planLinks", () => {
  it("excludes the hub and the article's own row from the manifest scan", async () => {
    mocks.publishRepo.getLinkCandidates.mockResolvedValue([
      {
        id: "page_hub",
        path: "/compare/",
        title: "Comparisons",
        kind: "post",
        pageTypeId: "type_1",
      },
      {
        id: "page_self",
        path: "/compare/espresso-tamper-sizes/",
        title: null,
        kind: "post",
        pageTypeId: "type_1",
      },
      {
        id: "page_a",
        path: "/compare/tamper-bases/",
        title: null,
        kind: "post",
        pageTypeId: "type_1",
      },
    ]);

    const targets = await (await service()).planLinks(CONTEXT);

    expect(targets.map((target) => target.contentPageId)).toEqual(["page_a"]);
  });
});

describe("injectLinks — what gets written", () => {
  it("writes the owned block into a neighbour and leaves the prose alone", async () => {
    const resolved = fakeAdapter();
    resolved.adapter.getPost.mockResolvedValue({
      ref: "7",
      path: "/compare/a/",
      body: USER_PROSE,
    });
    mocks.resolve.resolvePublishAdapter.mockResolvedValue(resolved);

    const { links } = await (
      await service()
    ).injectLinks({
      context: CONTEXT,
      targets: TARGETS,
      anchor: "Espresso tamper sizes",
    });

    expect(links).toEqual([
      { contentPageId: "page_a", path: "/compare/a/", outcome: "injected" },
    ]);
    const [update] = resolved.adapter.updatePost.mock.calls[0];
    expect(update.body.startsWith(USER_PROSE)).toBe(true);
    expect(update.body).toContain("<!-- rankloop:related start -->");
    expect(update.body).toContain('href="/compare/espresso-tamper-sizes/"');
  });

  it("writes nothing at all when the block already says exactly this", async () => {
    const resolved = fakeAdapter();
    resolved.adapter.getPost.mockResolvedValue({
      ref: "7",
      path: "/compare/a/",
      body: USER_PROSE,
    });
    mocks.resolve.resolvePublishAdapter.mockResolvedValue(resolved);

    const first = await (
      await service()
    ).injectLinks({
      context: CONTEXT,
      targets: TARGETS,
      anchor: "Espresso tamper sizes",
    });
    const written = resolved.adapter.updatePost.mock.calls[0][0].body;

    resolved.adapter.getPost.mockResolvedValue({
      ref: "7",
      path: "/compare/a/",
      body: written,
    });
    resolved.adapter.updatePost.mockClear();

    const second = await (
      await service()
    ).injectLinks({
      context: CONTEXT,
      targets: TARGETS,
      anchor: "Espresso tamper sizes",
    });

    expect(first.links[0].outcome).toBe("injected");
    expect(second.links[0].outcome).toBe("unchanged");
    expect(resolved.adapter.updatePost).not.toHaveBeenCalled();
  });

  it("declines to write a page whose delimiters are damaged", async () => {
    const resolved = fakeAdapter();
    resolved.adapter.getPost.mockResolvedValue({
      ref: "7",
      path: "/compare/a/",
      body: `${USER_PROSE}<!-- rankloop:related start -->\n<p>half</p>\n`,
    });
    mocks.resolve.resolvePublishAdapter.mockResolvedValue(resolved);

    const { links } = await (
      await service()
    ).injectLinks({
      context: CONTEXT,
      targets: TARGETS,
      anchor: "Espresso tamper sizes",
    });

    expect(links[0].outcome).toBe("malformed");
    expect(resolved.adapter.updatePost).not.toHaveBeenCalled();
  });

  it("records a neighbour that is no longer on the target", async () => {
    const resolved = fakeAdapter();
    resolved.adapter.getPost.mockResolvedValue(null);
    mocks.resolve.resolvePublishAdapter.mockResolvedValue(resolved);

    const { links } = await (
      await service()
    ).injectLinks({
      context: CONTEXT,
      targets: TARGETS,
      anchor: "Espresso tamper sizes",
    });

    expect(links[0].outcome).toBe("missing");
    expect(resolved.adapter.updatePost).not.toHaveBeenCalled();
  });

  it("keeps going when one neighbour's write is rejected", async () => {
    const resolved = fakeAdapter();
    resolved.adapter.getPost.mockImplementation((path: string) =>
      Promise.resolve({ ref: "7", path, body: USER_PROSE }),
    );
    resolved.adapter.updatePost
      .mockRejectedValueOnce(new Error("wp 500"))
      .mockResolvedValue(undefined);
    mocks.resolve.resolvePublishAdapter.mockResolvedValue(resolved);

    const { links } = await (
      await service()
    ).injectLinks({
      context: CONTEXT,
      targets: [
        ...TARGETS,
        { contentPageId: "page_b", path: "/compare/b/", title: "B" },
      ],
      anchor: "Espresso tamper sizes",
    });

    expect(links.map((link) => link.outcome)).toEqual(["failed", "injected"]);
  });

  it("edits nothing when link injection is switched off", async () => {
    const resolved = fakeAdapter({ settings: { linkInjection: false } });
    mocks.resolve.resolvePublishAdapter.mockResolvedValue(resolved);

    const { links } = await (
      await service()
    ).injectLinks({
      context: CONTEXT,
      targets: TARGETS,
      anchor: "Espresso tamper sizes",
    });

    expect(links).toEqual([]);
    expect(resolved.adapter.getPost).not.toHaveBeenCalled();
  });

  it("does not re-send links a delegated target was already given", async () => {
    const resolved = fakeAdapter({
      capabilities: { linkInjection: "delegated" },
    });
    mocks.resolve.resolvePublishAdapter.mockResolvedValue(resolved);

    const { links } = await (
      await service()
    ).injectLinks({
      context: CONTEXT,
      targets: TARGETS,
      anchor: "Espresso tamper sizes",
    });

    expect(links[0].outcome).toBe("delegated");
    expect(resolved.adapter.getPost).not.toHaveBeenCalled();
    expect(resolved.adapter.updatePost).not.toHaveBeenCalled();
  });

  it("writes the markdown form on a markdown target", async () => {
    const resolved = fakeAdapter({
      capabilities: { contentFormat: "markdown" },
    });
    resolved.adapter.getPost.mockResolvedValue({
      ref: "7",
      path: "/compare/a/",
      body: USER_PROSE,
    });
    mocks.resolve.resolvePublishAdapter.mockResolvedValue(resolved);

    await (
      await service()
    ).injectLinks({
      context: CONTEXT,
      targets: TARGETS,
      anchor: "Espresso tamper sizes",
    });

    const [update] = resolved.adapter.updatePost.mock.calls[0];
    expect(update.body).toContain(
      "- [Espresso tamper sizes](/compare/espresso-tamper-sizes/)",
    );
  });
});

describe("wireDerivedArtifacts — only where they are ours", () => {
  beforeEach(() => {
    mocks.publishRepo.getManifestForWire.mockResolvedValue([
      {
        path: "/compare/",
        kind: "hub",
        title: "Comparisons",
        description: "",
        publishedAt: null,
        category: "Comparisons",
        keyword: null,
        wordCount: null,
      },
      {
        path: "/compare/espresso-tamper-sizes/",
        kind: "post",
        title: "Espresso tamper sizes",
        description: "Which base fits which basket.",
        publishedAt: "2026-08-01T10:00:00.000Z",
        category: "Comparisons",
        keyword: "espresso tamper sizes",
        wordCount: 900,
      },
    ]);
  });

  it("writes nothing on a target whose own build owns the sitemap", async () => {
    const resolved = fakeAdapter();
    mocks.resolve.resolvePublishAdapter.mockResolvedValue(resolved);

    const result = await (
      await service()
    ).wireDerivedArtifacts({
      context: CONTEXT,
      adapterRef: "99",
    });

    expect(result.written).toEqual([]);
    expect(resolved.adapter.commitArtifacts).not.toHaveBeenCalled();
  });

  it("regenerates all four files and commits them with the post", async () => {
    const resolved = fakeAdapter({
      capabilities: { ownsDerivedArtifacts: true, kind: "github" },
    });
    mocks.resolve.resolvePublishAdapter.mockResolvedValue(resolved);

    const result = await (
      await service()
    ).wireDerivedArtifacts({
      context: CONTEXT,
      adapterRef: "99",
    });

    expect(result.written).toEqual([
      "/sitemap.xml",
      "/rss.xml",
      "/llms.txt",
      "/llms-full.txt",
    ]);
    const [call] = resolved.adapter.commitArtifacts.mock.calls[0];
    expect(call.ref).toBe("99");
    const sitemapFile = call.artifacts.find(
      (artifact) => artifact.path === "/sitemap.xml",
    );
    expect(sitemapFile?.content).toContain(
      "https://acme.com/compare/espresso-tamper-sizes/",
    );
  });
});
