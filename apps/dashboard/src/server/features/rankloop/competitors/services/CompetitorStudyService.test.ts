import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SitemapStudy } from "./competitorCrawl";
import type { StudyContext } from "./CompetitorStudyService";

const mocks = vi.hoisted(() => ({
  workersEnv: { DATAFORSEO_API_KEY: "key" } as Record<string, string>,
  repo: {
    getStudyRunById: vi.fn(),
    updateStudyRun: vi.fn(),
    getCompetitorById: vi.fn(),
    getPageSnapshot: vi.fn(),
    updateCompetitor: vi.fn<
      (
        competitorId: string,
        data: {
          coverage?: string;
          studySummaryJson?: string;
          organicKeywords?: number | null;
          domainRank?: number | null;
        },
      ) => Promise<void>
    >(),
    upsertCompetitorPages: vi.fn(),
    upsertCompetitorLinkDomains: vi.fn(),
    setPageStatuses: vi.fn(),
  },
  projectRepo: {
    getProjectById: vi.fn(),
  },
  domain: {
    getOverview: vi.fn(),
  },
  backlinks: {
    profileOverview: vi.fn(),
  },
  dataforseo: {
    relevantPages: vi.fn(),
    referringDomains: vi.fn(),
  },
}));

vi.mock("cloudflare:workers", () => ({ env: mocks.workersEnv }));
vi.mock("cloudflare:workflows", () => ({
  NonRetryableError: class NonRetryableError extends Error {},
}));
vi.mock(
  "@/server/features/rankloop/competitors/repositories/CompetitorsRepository",
  () => ({ CompetitorsRepository: mocks.repo }),
);
vi.mock("@/server/features/projects/repositories/ProjectRepository", () => ({
  ProjectRepository: mocks.projectRepo,
}));
vi.mock("@/server/features/domain/services/DomainService", () => ({
  DomainService: mocks.domain,
}));
vi.mock("@/server/features/backlinks/services/BacklinksService", () => ({
  BacklinksService: mocks.backlinks,
}));
vi.mock("@/server/lib/dataforseo", () => ({
  createDataforseoClient: () => ({
    domain: { relevantPages: mocks.dataforseo.relevantPages },
    backlinks: { referringDomains: mocks.dataforseo.referringDomains },
  }),
}));

function context(overrides: Partial<StudyContext> = {}): StudyContext {
  return {
    competitorId: "comp_1",
    domain: "acme.com",
    projectId: "project_1",
    organizationId: "org_1",
    locationCode: 2840,
    languageCode: "en",
    prior: [],
    ...overrides,
  };
}

function sitemap(overrides: Partial<SitemapStudy> = {}): SitemapStudy {
  return {
    cadence: [{ month: "2026-07", count: 4 }],
    pageTypeMix: [{ pageType: "post", count: 12 }],
    contentPageCount: 12,
    winnerUrls: [],
    sampleUrls: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetModules();
  mocks.workersEnv.DATAFORSEO_API_KEY = "key";
  for (const group of [
    mocks.repo,
    mocks.projectRepo,
    mocks.domain,
    mocks.backlinks,
    mocks.dataforseo,
  ]) {
    for (const mock of Object.values(group)) mock.mockReset();
  }
});

describe("CompetitorStudyService.prepare", () => {
  it("refuses to resume a run someone already finished", async () => {
    mocks.repo.getStudyRunById.mockResolvedValue({ status: "done" });
    const { CompetitorStudyService } = await import("./CompetitorStudyService");

    await expect(
      CompetitorStudyService.prepare({
        runId: "run_1",
        projectId: "project_1",
        competitorId: "comp_1",
      }),
    ).rejects.toThrow("no longer active");
  });

  it("captures the prior snapshot before this run overwrites it", async () => {
    mocks.repo.getStudyRunById.mockResolvedValue({ status: "pending" });
    mocks.repo.getCompetitorById.mockResolvedValue({
      id: "comp_1",
      domain: "acme.com",
    });
    mocks.projectRepo.getProjectById.mockResolvedValue({
      organizationId: "org_1",
      locationCode: 2826,
      languageCode: "en",
    });
    mocks.repo.getPageSnapshot.mockResolvedValue([
      { url: "https://acme.com/a", etv: 100 },
    ]);
    const { CompetitorStudyService } = await import("./CompetitorStudyService");

    const result = await CompetitorStudyService.prepare({
      runId: "run_1",
      projectId: "project_1",
      competitorId: "comp_1",
    });

    expect(result.prior).toEqual([{ url: "https://acme.com/a", etv: 100 }]);
    expect(result.locationCode).toBe(2826);
    expect(mocks.repo.updateStudyRun).toHaveBeenCalledWith("run_1", {
      status: "running",
    });
  });
});

describe("CompetitorStudyService.recordMetrics", () => {
  it("spends nothing and records nothing without a key", async () => {
    mocks.workersEnv.DATAFORSEO_API_KEY = "";
    const { CompetitorStudyService } = await import("./CompetitorStudyService");

    const recorded = await CompetitorStudyService.recordMetrics(context());

    expect(recorded).toBe(false);
    expect(mocks.domain.getOverview).not.toHaveBeenCalled();
    expect(mocks.backlinks.profileOverview).not.toHaveBeenCalled();
  });

  it("keeps the organic numbers when the backlinks subscription refuses", async () => {
    mocks.domain.getOverview.mockResolvedValue({
      organicKeywords: 4200,
      organicTraffic: 51000,
    });
    mocks.backlinks.profileOverview.mockRejectedValue(
      new Error("backlinks billing issue"),
    );
    const { CompetitorStudyService } = await import("./CompetitorStudyService");

    const recorded = await CompetitorStudyService.recordMetrics(context());

    expect(recorded).toBe(true);
    expect(mocks.repo.updateCompetitor).toHaveBeenCalledWith("comp_1", {
      organicKeywords: 4200,
      estTraffic: 51000,
      domainRank: null,
      backlinks: null,
      referringDomains: null,
    });
  });

  it("writes nulls rather than throwing when both providers fail", async () => {
    mocks.domain.getOverview.mockRejectedValue(new Error("labs down"));
    mocks.backlinks.profileOverview.mockRejectedValue(new Error("also down"));
    const { CompetitorStudyService } = await import("./CompetitorStudyService");

    const recorded = await CompetitorStudyService.recordMetrics(context());

    expect(recorded).toBe(false);
    expect(mocks.repo.updateCompetitor).toHaveBeenCalledWith(
      "comp_1",
      expect.objectContaining({ organicKeywords: null, domainRank: null }),
    );
  });
});

describe("CompetitorStudyService.studyTopPages", () => {
  it("has no earning cohort without a key, and does not pretend otherwise", async () => {
    mocks.workersEnv.DATAFORSEO_API_KEY = "";
    const { CompetitorStudyService } = await import("./CompetitorStudyService");

    await expect(
      CompetitorStudyService.studyTopPages(context()),
    ).resolves.toEqual([]);
    expect(mocks.dataforseo.relevantPages).not.toHaveBeenCalled();
  });

  it("keeps content-shaped pages and drops the taxonomy noise", async () => {
    mocks.dataforseo.relevantPages.mockResolvedValue({
      items: [
        {
          page_address: "https://acme.com/blog/guide",
          metrics: { organic: { etv: 900, count: 42 } },
        },
        {
          page_address: "https://acme.com/tag/seo",
          metrics: { organic: { etv: 800, count: 12 } },
        },
        { page_address: "  ", metrics: { organic: { etv: 5 } } },
      ],
      totalCount: 3,
    });
    const { CompetitorStudyService } = await import("./CompetitorStudyService");

    const pages = await CompetitorStudyService.studyTopPages(context());

    expect(pages).toEqual([{ url: "https://acme.com/blog/guide", etv: 900 }]);
    expect(mocks.repo.upsertCompetitorPages).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          url: "https://acme.com/blog/guide",
          pageType: "post",
          keywordCount: 42,
        }),
      ],
      expect.any(String),
    );
  });
});

describe("CompetitorStudyService.studyReferringDomains", () => {
  it("collects nothing without a key, and the study carries on", async () => {
    mocks.workersEnv.DATAFORSEO_API_KEY = "";
    const { CompetitorStudyService } = await import("./CompetitorStudyService");

    await expect(
      CompetitorStudyService.studyReferringDomains(context()),
    ).resolves.toBe(0);
    expect(mocks.dataforseo.referringDomains).not.toHaveBeenCalled();
    expect(mocks.repo.upsertCompetitorLinkDomains).not.toHaveBeenCalled();
  });

  it("asks for the top 200 by rank, not by raw link count", async () => {
    mocks.dataforseo.referringDomains.mockResolvedValue({
      items: [],
      totalCount: 0,
    });
    const { CompetitorStudyService } = await import("./CompetitorStudyService");

    await CompetitorStudyService.studyReferringDomains(context());

    expect(mocks.dataforseo.referringDomains).toHaveBeenCalledWith({
      target: "acme.com",
      limit: 200,
      orderBy: ["rank,desc"],
    });
  });

  it("normalizes, dedupes, and drops the competitor's own subdomains", async () => {
    mocks.dataforseo.referringDomains.mockResolvedValue({
      items: [
        { domain: "Coffee-Journal.example", rank: 61, backlinks: 4 },
        { domain: "www.coffee-journal.example", rank: 61, backlinks: 4 },
        { domain: "blog.acme.com", rank: 90, backlinks: 200 },
        { domain: "acme.com", rank: 95, backlinks: 900 },
        { domain: "  ", rank: 1, backlinks: 1 },
        { domain: "roasters.example", rank: null, backlinks: null },
      ],
      totalCount: 6,
    });
    const { CompetitorStudyService } = await import("./CompetitorStudyService");

    const stored =
      await CompetitorStudyService.studyReferringDomains(context());

    expect(stored).toBe(2);
    expect(mocks.repo.upsertCompetitorLinkDomains).toHaveBeenCalledWith(
      [
        {
          competitorId: "comp_1",
          domain: "coffee-journal.example",
          domainRank: 61,
          backlinks: 4,
        },
        {
          competitorId: "comp_1",
          domain: "roasters.example",
          domainRank: null,
          backlinks: null,
        },
      ],
      expect.any(String),
    );
  });
});

describe("CompetitorStudyService.summarize", () => {
  const baseInput = {
    context: context(),
    sitemap: sitemap(),
    crawled: [],
    coverage: "full" as const,
    current: [],
  };

  it("writes a playbook even when the crawl was blocked, minus the deltas", async () => {
    const { CompetitorStudyService } = await import("./CompetitorStudyService");

    await CompetitorStudyService.summarize({
      ...baseInput,
      coverage: "sitemap_only",
      crawled: [
        {
          url: "https://acme.com/blog/a",
          cohort: "winner",
          features: {
            wordCount: 2000,
            mediaCount: 3,
            dataTable: true,
            faqBlock: false,
            byline: true,
            dateModified: true,
          },
          blocked: false,
        },
      ],
    });

    const written = mocks.repo.updateCompetitor.mock.calls[0][1];
    expect(written.coverage).toBe("sitemap_only");
    const playbook: unknown = JSON.parse(written.studySummaryJson ?? "null");
    expect(playbook).toMatchObject({
      totalContentPages: 12,
      featureDeltas: [],
      cadence: [{ month: "2026-07", count: 4 }],
    });
  });

  it("compares the two cohorts on a full study", async () => {
    const winner = {
      url: "https://acme.com/blog/a",
      cohort: "winner" as const,
      features: {
        wordCount: 2400,
        mediaCount: 4,
        dataTable: true,
        faqBlock: true,
        byline: false,
        dateModified: false,
      },
      blocked: false,
    };
    const ordinary = {
      url: "https://acme.com/blog/b",
      cohort: "sample" as const,
      features: {
        wordCount: 700,
        mediaCount: 1,
        dataTable: false,
        faqBlock: true,
        byline: false,
        dateModified: false,
      },
      blocked: false,
    };
    const { CompetitorStudyService } = await import("./CompetitorStudyService");

    await CompetitorStudyService.summarize({
      ...baseInput,
      crawled: [winner, ordinary],
    });

    const written = mocks.repo.updateCompetitor.mock.calls[0][1];
    expect(JSON.parse(written.studySummaryJson ?? "null")).toMatchObject({
      // faqBlock is 100% in both cohorts, so only the table survives.
      featureDeltas: [{ feature: "Data table", winnersPct: 100, medianPct: 0 }],
      winnersMedianWordCount: 2400,
      medianSampleWordCount: 700,
    });
  });

  it("touches no page status on a keyless run — an empty set is not a deletion", async () => {
    const { CompetitorStudyService } = await import("./CompetitorStudyService");

    await CompetitorStudyService.summarize({
      ...baseInput,
      context: context({ prior: [{ url: "https://acme.com/a", etv: 900 }] }),
      current: [],
    });

    expect(mocks.repo.setPageStatuses).not.toHaveBeenCalled();
    // The sitemap half still lands: cadence and mix need no key.
    expect(mocks.repo.updateCompetitor).toHaveBeenCalled();
  });

  it("settles decayed and removed pages against the prior snapshot", async () => {
    const { CompetitorStudyService } = await import("./CompetitorStudyService");

    const result = await CompetitorStudyService.summarize({
      ...baseInput,
      context: context({
        prior: [
          { url: "https://acme.com/rot", etv: 500 },
          { url: "https://acme.com/gone", etv: 300 },
          { url: "https://acme.com/fine", etv: 100 },
        ],
      }),
      current: [
        { url: "https://acme.com/rot", etv: 50 },
        { url: "https://acme.com/fine", etv: 140 },
      ],
    });

    expect(result.pagesStudied).toBe(2);
    expect(mocks.repo.setPageStatuses.mock.calls).toEqual([
      ["comp_1", ["https://acme.com/fine"], "active"],
      ["comp_1", ["https://acme.com/rot"], "decayed"],
      ["comp_1", ["https://acme.com/gone"], "removed"],
    ]);
  });
});
