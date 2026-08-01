import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SitemapStudy } from "./competitorCrawl";
import type { StudyContext } from "./CompetitorStudyService";

// What settles a competitor page's status — active, decayed, removed — and,
// more to the point, what is not allowed to settle it. Removal is the claim
// the what-not-to-build panel makes to the founder, so it needs evidence the
// page is gone rather than merely out of the window we looked through.
//
// Split from CompetitorStudyService.test.ts, which owns the four steps; the
// harness below is the same one, duplicated rather than shared because
// `vi.hoisted` mocks have to be declared in the file that mocks with them.

const mocks = vi.hoisted(() => ({
  workersEnv: { DATAFORSEO_API_KEY: "key" } as Record<string, string>,
  repo: {
    getStudyRunById: vi.fn(),
    updateStudyRun: vi.fn(),
    getCompetitorById: vi.fn(),
    getPageSnapshot: vi.fn(),
    updateCompetitor: vi.fn(),
    upsertCompetitorPages: vi.fn(),
    upsertCompetitorLinkDomains: vi.fn(),
    setPageStatuses: vi.fn(),
  },
  projectRepo: { getProjectById: vi.fn() },
  domain: { getOverview: vi.fn() },
  backlinks: { profileOverview: vi.fn() },
  dataforseo: { relevantPages: vi.fn(), referringDomains: vi.fn() },
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

const SITEMAP: SitemapStudy = {
  cadence: [{ month: "2026-07", count: 4 }],
  pageTypeMix: [{ pageType: "post", count: 12 }],
  contentPageCount: 12,
  winnerUrls: [],
  sampleUrls: [],
};

const baseInput = {
  context: context(),
  sitemap: SITEMAP,
  crawled: [],
  coverage: "full" as const,
  current: [],
  windowSaturated: false,
};

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

describe("CompetitorStudyService.summarize — page statuses", () => {
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

  it("removes nothing when the top-pages window was saturated", async () => {
    const { CompetitorStudyService } = await import("./CompetitorStudyService");

    await CompetitorStudyService.summarize({
      ...baseInput,
      windowSaturated: true,
      context: context({
        prior: [
          { url: "https://acme.com/gone", etv: 300 },
          { url: "https://acme.com/fine", etv: 100 },
        ],
      }),
      current: [{ url: "https://acme.com/fine", etv: 140 }],
    });

    // /gone is absent from the top 100 by etv, which is not the same as gone.
    // active and decayed still settle from what this run did measure.
    expect(mocks.repo.setPageStatuses.mock.calls).toEqual([
      ["comp_1", ["https://acme.com/fine"], "active"],
      ["comp_1", [], "decayed"],
    ]);
  });
});
