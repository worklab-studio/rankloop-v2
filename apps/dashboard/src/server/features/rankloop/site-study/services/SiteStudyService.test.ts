import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ContentPageUpsert } from "@/server/features/rankloop/site-study/repositories/SiteStudyRepository";

type PageForDerive = {
  url: string;
  statusCode: number | null;
  fetchClass: "ok" | "blocked" | "error";
  title: string | null;
  metaDescription: string | null;
  publishedAt: string | null;
  modifiedAt: string | null;
  wordCount: number;
  isIndexable: boolean;
  contentHash: string | null;
  outlinkPathsJson: string | null;
};

const mocks = vi.hoisted(() => ({
  repo: {
    tryCreateRun: vi.fn(),
    updateRun: vi.fn(),
    getRunById: vi.fn(),
    getActiveRunForProject: vi.fn(),
    getLatestRunForProject: vi.fn(),
    getProjectsDueForStudy: vi.fn(),
    getLatestCompletedAuditForProject: vi.fn(),
    getPagesForDerive: vi.fn(),
    upsertContentPages: vi.fn<(rows: ContentPageUpsert[]) => Promise<void>>(),
    deleteStaleCrawlPages: vi.fn(),
    getInventoryRows: vi.fn(),
    getRunningAuditProgress: vi.fn(),
  },
  workflow: {
    create: vi.fn(),
    get: vi.fn(),
  },
}));

vi.mock("cloudflare:workers", () => ({
  env: { SITE_STUDY_WORKFLOW: mocks.workflow },
}));
vi.mock(
  "@/server/features/rankloop/site-study/repositories/SiteStudyRepository",
  () => ({ SiteStudyRepository: mocks.repo }),
);

function pageForDerive(overrides: Partial<PageForDerive>): PageForDerive {
  return {
    url: "https://acme.com/somewhere",
    statusCode: 200,
    fetchClass: "ok",
    title: "A title",
    metaDescription: "A description",
    publishedAt: null,
    modifiedAt: null,
    wordCount: 800,
    isIndexable: true,
    contentHash: "hash",
    outlinkPathsJson: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetModules();
  for (const group of Object.values(mocks)) {
    for (const mock of Object.values(group)) mock.mockReset();
  }
});

describe("SiteStudyService.startStudy", () => {
  it("creates the run row and a workflow instance whose id is the run id", async () => {
    mocks.repo.tryCreateRun.mockResolvedValue(true);
    mocks.workflow.create.mockResolvedValue(undefined);
    const { SiteStudyService } = await import("./SiteStudyService");

    const result = await SiteStudyService.startStudy("project_1");

    expect(result.alreadyRunning).toBe(false);
    expect(mocks.repo.tryCreateRun).toHaveBeenCalledWith({
      id: result.runId,
      projectId: "project_1",
    });
    expect(mocks.workflow.create).toHaveBeenCalledWith({
      id: result.runId,
      params: { runId: result.runId, projectId: "project_1" },
    });
  });

  it("returns the existing active run on a duplicate start instead of erroring", async () => {
    mocks.repo.tryCreateRun.mockResolvedValue(false);
    mocks.repo.getActiveRunForProject.mockResolvedValue({
      id: "run_active",
      status: "running",
      startedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    });
    // The blocker's workflow instance is genuinely live, so the stale-run
    // probe must leave it alone.
    mocks.workflow.get.mockResolvedValue({
      status: async () => ({ status: "running" }),
    });
    const { SiteStudyService } = await import("./SiteStudyService");

    await expect(SiteStudyService.startStudy("project_1")).resolves.toEqual({
      runId: "run_active",
      alreadyRunning: true,
    });
    expect(mocks.workflow.create).not.toHaveBeenCalled();
    expect(mocks.repo.updateRun).not.toHaveBeenCalled();
  });

  it("heals a zombie run — errored instance past the startup grace — and starts fresh", async () => {
    mocks.repo.tryCreateRun
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    // The blocker's workflow died without reaching its mark-error step, so
    // the row sat "running" and wedged the partial-index slot.
    mocks.repo.getActiveRunForProject.mockResolvedValue({
      id: "run_stale",
      status: "running",
      startedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    });
    mocks.workflow.get.mockResolvedValue({
      status: async () => ({
        status: "errored",
        error: { message: "engine crashed" },
      }),
    });
    mocks.workflow.create.mockResolvedValue(undefined);
    const { SiteStudyService } = await import("./SiteStudyService");

    const result = await SiteStudyService.startStudy("project_1");

    expect(result.alreadyRunning).toBe(false);
    // The zombie flips to error — that flip is what frees the slot the
    // retry inserts into.
    expect(mocks.repo.updateRun).toHaveBeenCalledWith(
      "run_stale",
      expect.objectContaining({ status: "error", error: "engine crashed" }),
    );
    expect(mocks.repo.tryCreateRun).toHaveBeenCalledTimes(2);
    expect(mocks.workflow.create).toHaveBeenCalledTimes(1);
  });

  it("flips the run to error and rethrows when the workflow will not start", async () => {
    mocks.repo.tryCreateRun.mockResolvedValue(true);
    mocks.workflow.create.mockRejectedValue(new Error("no capacity"));
    mocks.workflow.get.mockRejectedValue(new Error("not found"));
    const { SiteStudyService } = await import("./SiteStudyService");

    await expect(SiteStudyService.startStudy("project_1")).rejects.toThrow(
      "no capacity",
    );
    // The error flip is what releases the partial-index slot.
    expect(mocks.repo.updateRun).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ status: "error" }),
    );
  });
});

describe("SiteStudyService.deriveFromAudit", () => {
  it("promotes only loadable pages and scopes the stale-delete to this derive's marker", async () => {
    mocks.repo.getPagesForDerive.mockResolvedValue([
      pageForDerive({
        url: "https://acme.com/blog/a",
        publishedAt: "2026-05-01T00:00:00.000Z",
        outlinkPathsJson: JSON.stringify(["/blog/b"]),
      }),
      pageForDerive({ url: "https://acme.com/blog/b" }),
      // Crawl artifacts, not content: a redirect hop and a 404.
      pageForDerive({ url: "https://acme.com/old", statusCode: 301 }),
      pageForDerive({ url: "https://acme.com/gone", statusCode: 404 }),
    ]);
    mocks.repo.upsertContentPages.mockResolvedValue(undefined);
    mocks.repo.deleteStaleCrawlPages.mockResolvedValue(undefined);
    const { SiteStudyService } = await import("./SiteStudyService");

    const derived = await SiteStudyService.deriveFromAudit({
      projectId: "project_1",
      auditId: "audit_1",
      crawlMark: "2026-07-30T12:00:00.000Z",
    });

    expect(derived).toBe(2);
    const upserts = mocks.repo.upsertContentPages.mock.calls[0][0];
    expect(upserts.map((row) => row.url)).toEqual([
      "https://acme.com/blog/a",
      "https://acme.com/blog/b",
    ]);
    // Every derived row carries this derive's marker; the delete then scopes
    // on it, which is what keeps source='publish' rows untouchable.
    expect(
      upserts.every((row) => row.lastCrawledAt === "2026-07-30T12:00:00.000Z"),
    ).toBe(true);
    expect(mocks.repo.deleteStaleCrawlPages).toHaveBeenCalledWith(
      "project_1",
      "2026-07-30T12:00:00.000Z",
    );
  });

  it("refuses to empty the manifest when a crawl loaded nothing", async () => {
    // A WAF challenge day: every page was crawled, none was loadable. Zero
    // eligible pages must not be read as "the site has no content".
    mocks.repo.getPagesForDerive.mockResolvedValue([
      pageForDerive({
        url: "https://acme.com/blog/a",
        statusCode: 403,
        fetchClass: "blocked",
      }),
      pageForDerive({
        url: "https://acme.com/blog/b",
        statusCode: 503,
        fetchClass: "error",
      }),
      pageForDerive({
        url: "https://acme.com/pricing",
        statusCode: 503,
        fetchClass: "error",
      }),
    ]);
    mocks.repo.upsertContentPages.mockResolvedValue(undefined);
    mocks.repo.deleteStaleCrawlPages.mockResolvedValue(undefined);
    const { SiteStudyService } = await import("./SiteStudyService");

    await expect(
      SiteStudyService.deriveFromAudit({
        projectId: "project_1",
        auditId: "audit_1",
        crawlMark: "2026-07-30T12:00:00.000Z",
      }),
    ).rejects.toThrow(/audit_1.*3 crawled.*0 eligible/);
    // The stale-delete is what would have taken the manifest — and with it
    // the category/keyword/pageTypeId columns the upsert preserves.
    expect(mocks.repo.deleteStaleCrawlPages).not.toHaveBeenCalled();
  });

  it("classifies kinds and inverts inlinks across the run", async () => {
    mocks.repo.getPagesForDerive.mockResolvedValue([
      pageForDerive({
        url: "https://acme.com/blog/a",
        outlinkPathsJson: JSON.stringify(["/blog/b", "/pricing"]),
      }),
      pageForDerive({
        url: "https://acme.com/blog/b",
        outlinkPathsJson: JSON.stringify(["/pricing"]),
      }),
      pageForDerive({ url: "https://acme.com/pricing" }),
      pageForDerive({ url: "https://acme.com/tag/seo" }),
    ]);
    mocks.repo.upsertContentPages.mockResolvedValue(undefined);
    mocks.repo.deleteStaleCrawlPages.mockResolvedValue(undefined);
    const { SiteStudyService } = await import("./SiteStudyService");

    await SiteStudyService.deriveFromAudit({
      projectId: "project_1",
      auditId: "audit_1",
      crawlMark: "2026-07-30T12:00:00.000Z",
    });

    const upserts = mocks.repo.upsertContentPages.mock.calls[0][0];
    const byPath = new Map(upserts.map((row) => [row.path, row]));
    expect(byPath.get("/blog/a")).toMatchObject({
      kind: "post",
      inlinkCount: 0,
    });
    expect(byPath.get("/blog/b")).toMatchObject({
      kind: "post",
      inlinkCount: 1,
    });
    expect(byPath.get("/pricing")).toMatchObject({
      kind: "page",
      inlinkCount: 2,
    });
    expect(byPath.get("/tag/seo")).toMatchObject({ kind: "other" });
  });
});

describe("summarizeInventory", () => {
  it("counts kinds, computes the median, and builds the trailing 12-month cadence", async () => {
    const { summarizeInventory } = await import("./SiteStudyService");
    const now = new Date("2026-07-31T12:00:00Z");

    const summary = summarizeInventory(
      [
        {
          kind: "post",
          wordCount: 1200,
          publishedAt: "2026-07-02T00:00:00.000Z",
        },
        {
          kind: "post",
          wordCount: 900,
          publishedAt: "2026-07-15T00:00:00.000Z",
        },
        {
          kind: "post",
          wordCount: 600,
          publishedAt: "2026-01-10T00:00:00.000Z",
        },
        { kind: "page", wordCount: 300, publishedAt: null },
        { kind: "other", wordCount: null, publishedAt: null },
      ],
      now,
    );

    expect(summary.totalPages).toBe(5);
    expect(summary.kindCounts).toEqual({ post: 3, page: 1, hub: 0, other: 1 });
    // Even count of measured pages → the two middles average: (600+900)/2.
    expect(summary.medianWordCount).toBe(750);
    expect(summary.lastPublishedAt).toBe("2026-07-15T00:00:00.000Z");
    expect(summary.monthlyPosts).toHaveLength(12);
    expect(summary.monthlyPosts[0]).toEqual({ month: "2025-08", count: 0 });
    expect(summary.monthlyPosts[5]).toEqual({ month: "2026-01", count: 1 });
    expect(summary.monthlyPosts[11]).toEqual({ month: "2026-07", count: 2 });
  });
});

describe("SiteStudyService.getStudy", () => {
  it("returns a null inventory before any study and live audit progress while studying", async () => {
    mocks.repo.getLatestRunForProject.mockResolvedValue({
      id: "run_1",
      status: "running",
      startedAt: new Date().toISOString(),
    });
    mocks.repo.getInventoryRows.mockResolvedValue([]);
    mocks.repo.getRunningAuditProgress.mockResolvedValue({
      pagesCrawled: 134,
      pagesTotal: 214,
    });
    const { SiteStudyService } = await import("./SiteStudyService");

    const study = await SiteStudyService.getStudy("project_1");

    expect(study.inventory).toBeNull();
    expect(study.auditProgress).toEqual({ pagesCrawled: 134, pagesTotal: 214 });
  });

  it("skips the audit-progress read once the run is terminal", async () => {
    mocks.repo.getLatestRunForProject.mockResolvedValue({
      id: "run_1",
      status: "done",
      startedAt: new Date().toISOString(),
    });
    mocks.repo.getInventoryRows.mockResolvedValue([
      { kind: "post", wordCount: 500, publishedAt: "2026-07-01T00:00:00.000Z" },
    ]);
    const { SiteStudyService } = await import("./SiteStudyService");

    const study = await SiteStudyService.getStudy("project_1");

    expect(study.inventory?.totalPages).toBe(1);
    expect(study.auditProgress).toBeNull();
    expect(mocks.repo.getRunningAuditProgress).not.toHaveBeenCalled();
  });
});

describe("siteStudyBlock", () => {
  const now = new Date("2026-08-01T09:00:00.000Z");

  it("sweeps at most five stale projects a dispatch", async () => {
    mocks.repo.getProjectsDueForStudy.mockResolvedValue([
      { projectId: "project_1" },
      { projectId: "project_2" },
    ]);
    const { siteStudyBlock } = await import("./scheduledSiteStudies");

    expect(await siteStudyBlock.dueProjects(now)).toEqual([
      "project_1",
      "project_2",
    ]);
    expect(mocks.repo.getProjectsDueForStudy).toHaveBeenCalledWith(
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      5,
      undefined,
    );
  });

  it("asks the same question about one project when the alarm dispatches", async () => {
    mocks.repo.getProjectsDueForStudy.mockResolvedValue([]);
    const { siteStudyBlock } = await import("./scheduledSiteStudies");

    expect(await siteStudyBlock.dueProjects(now, "project_1")).toEqual([]);
    expect(mocks.repo.getProjectsDueForStudy).toHaveBeenCalledWith(
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      1,
      "project_1",
    );
  });

  it("starts the study for a due project", async () => {
    mocks.repo.tryCreateRun.mockResolvedValue(true);
    mocks.workflow.create.mockResolvedValue(undefined);
    const { siteStudyBlock } = await import("./scheduledSiteStudies");

    await siteStudyBlock.runForProject("project_1", now);

    expect(mocks.workflow.create).toHaveBeenCalledTimes(1);
  });
});
