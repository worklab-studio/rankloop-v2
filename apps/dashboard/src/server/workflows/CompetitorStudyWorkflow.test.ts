import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type * as CompetitorCrawlModule from "@/server/features/rankloop/competitors/services/competitorCrawl";

const mocks = vi.hoisted(() => ({
  repo: {
    getStudyRunById: vi.fn(),
    updateStudyRun: vi.fn(),
  },
  studyService: {
    prepare: vi.fn(),
    recordMetrics: vi.fn(),
    studyTopPages: vi.fn(),
    studyReferringDomains: vi.fn(),
    summarize: vi.fn(),
  },
  outreach: {
    recomputeTargets: vi.fn(),
  },
  crawl: {
    studySitemap: vi.fn(),
    crawlFeatureBatch:
      vi.fn<
        (input: {
          competitorId: string;
          batch: Array<{ url: string; cohort: "winner" | "sample" }>;
        }) => Promise<CompetitorCrawlModule.CrawledFeature[]>
      >(),
  },
}));

vi.mock("cloudflare:workers", () => ({
  env: {},
  // oxlint-disable-next-line typescript/no-extraneous-class -- stand-in for the real base class; the workflow only inherits its shape
  WorkflowEntrypoint: class {},
}));
vi.mock("@/db", () => ({
  withPgClient: (fn: () => unknown) => fn(),
}));
vi.mock(
  "@/server/features/rankloop/competitors/repositories/CompetitorsRepository",
  () => ({ CompetitorsRepository: mocks.repo }),
);
vi.mock(
  "@/server/features/rankloop/competitors/services/CompetitorStudyService",
  () => ({ CompetitorStudyService: mocks.studyService }),
);
vi.mock("@/server/features/rankloop/outreach/services/OutreachService", () => ({
  OutreachService: mocks.outreach,
}));
// Partial mock: the two I/O functions are doubled, but CRAWL_BATCH_SIZE and
// isBlockedBatch stay real — the batching arithmetic and the degrade verdict
// are exactly what these tests are checking.
vi.mock(
  "@/server/features/rankloop/competitors/services/competitorCrawl",
  async () => ({
    ...(await vi.importActual<typeof CompetitorCrawlModule>(
      "@/server/features/rankloop/competitors/services/competitorCrawl",
    )),
    studySitemap: mocks.crawl.studySitemap,
    crawlFeatureBatch: mocks.crawl.crawlFeatureBatch,
  }),
);

// Runs every step body inline: the workflow's control flow is what's under
// test, not the engine's checkpointing.
function makeFakeStep(): WorkflowStep {
  const fake = {
    do: (
      _name: string,
      configOrFn: (() => Promise<unknown>) | Record<string, unknown>,
      maybeFn?: () => Promise<unknown>,
    ) => (typeof configOrFn === "function" ? configOrFn() : maybeFn?.()),
    sleep: vi.fn().mockResolvedValue(undefined),
  };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double: only do/sleep are exercised
  return fake as unknown as WorkflowStep;
}

function makeEvent(): WorkflowEvent<{
  runId: string;
  projectId: string;
  competitorId: string;
}> {
  return {
    payload: {
      runId: "run_1",
      projectId: "project_1",
      competitorId: "comp_1",
    },
    timestamp: new Date(),
    instanceId: "run_1",
    workflowName: "competitor-study-workflow",
  };
}

async function makeWorkflow() {
  const { CompetitorStudyWorkflow } = await import("./CompetitorStudyWorkflow");
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double: ctx/env are never touched (every collaborator is mocked)
  return new CompetitorStudyWorkflow({} as ExecutionContext, {} as Env);
}

function sitemapWith(winners: string[], sample: string[] = []) {
  return {
    cadence: [],
    pageTypeMix: [],
    contentPageCount: winners.length + sample.length,
    winnerUrls: winners,
    sampleUrls: sample,
  };
}

function readablePage(url: string, cohort: "winner" | "sample") {
  return {
    url,
    cohort,
    features: {
      wordCount: 900,
      mediaCount: 1,
      dataTable: false,
      faqBlock: false,
      byline: false,
      dateModified: false,
    },
    blocked: false,
  };
}

beforeEach(() => {
  vi.resetModules();
  for (const group of Object.values(mocks)) {
    for (const mock of Object.values(group)) mock.mockReset();
  }
  mocks.repo.getStudyRunById.mockResolvedValue({
    id: "run_1",
    status: "running",
  });
  mocks.studyService.prepare.mockResolvedValue({
    competitorId: "comp_1",
    domain: "acme.com",
    projectId: "project_1",
    organizationId: "org_1",
    locationCode: 2840,
    languageCode: "en",
    prior: [],
  });
  mocks.studyService.recordMetrics.mockResolvedValue(true);
  mocks.studyService.studyTopPages.mockResolvedValue([]);
  mocks.studyService.studyReferringDomains.mockResolvedValue(0);
  mocks.crawl.studySitemap.mockResolvedValue(sitemapWith([]));
  mocks.studyService.summarize.mockResolvedValue({ pagesStudied: 0 });
  mocks.outreach.recomputeTargets.mockResolvedValue({ targets: 0 });
});

describe("CompetitorStudyWorkflow", () => {
  it("marks the run done with the coverage the crawl earned", async () => {
    mocks.studyService.studyTopPages.mockResolvedValue([
      { url: "https://acme.com/blog/a", etv: 500 },
    ]);
    mocks.crawl.studySitemap.mockResolvedValue(
      sitemapWith(["https://acme.com/blog/a"]),
    );
    mocks.crawl.crawlFeatureBatch.mockResolvedValue([
      readablePage("https://acme.com/blog/a", "winner"),
    ]);
    mocks.studyService.summarize.mockResolvedValue({ pagesStudied: 1 });

    await (await makeWorkflow()).run(makeEvent(), makeFakeStep());

    expect(mocks.repo.updateStudyRun).toHaveBeenCalledWith(
      "run_1",
      expect.objectContaining({
        status: "done",
        coverage: "full",
        pagesStudied: 1,
      }),
    );
  });

  it("finishes the study when a metered step throws — the sitemap half is the product", async () => {
    mocks.studyService.recordMetrics.mockRejectedValue(
      new Error("DataForSEO auth failed"),
    );
    mocks.studyService.studyTopPages.mockRejectedValue(
      new Error("DataForSEO auth failed"),
    );

    await (await makeWorkflow()).run(makeEvent(), makeFakeStep());

    expect(mocks.crawl.studySitemap).toHaveBeenCalledWith({
      domain: "acme.com",
      earningUrls: [],
    });
    expect(mocks.repo.updateStudyRun).toHaveBeenCalledWith(
      "run_1",
      expect.objectContaining({ status: "done" }),
    );
  });

  it("recomputes the project's link gap once the study has written its evidence", async () => {
    mocks.studyService.studyReferringDomains.mockResolvedValue(180);

    await (await makeWorkflow()).run(makeEvent(), makeFakeStep());

    expect(mocks.studyService.studyReferringDomains).toHaveBeenCalledTimes(1);
    expect(mocks.outreach.recomputeTargets).toHaveBeenCalledWith({
      projectId: "project_1",
    });
  });

  it("finishes the study when the gap recompute dies — the competitor was still measured", async () => {
    mocks.studyService.studyReferringDomains.mockRejectedValue(
      new Error("DataForSEO auth failed"),
    );
    mocks.outreach.recomputeTargets.mockRejectedValue(new Error("db gone"));

    await (await makeWorkflow()).run(makeEvent(), makeFakeStep());

    expect(mocks.repo.updateStudyRun).toHaveBeenCalledWith(
      "run_1",
      expect.objectContaining({ status: "done" }),
    );
  });

  it("stops crawling after the first blocked batch and degrades to sitemap only", async () => {
    const winners = Array.from(
      { length: 30 },
      (_, index) => `https://acme.com/blog/${index}`,
    );
    mocks.crawl.studySitemap.mockResolvedValue(
      sitemapWith(winners, ["https://acme.com/blog/sample"]),
    );
    // Every page in the first batch turned away by the WAF.
    mocks.crawl.crawlFeatureBatch.mockResolvedValue(
      winners.slice(0, 25).map((url) => ({
        url,
        cohort: "winner" as const,
        features: null,
        blocked: true,
      })),
    );

    await (await makeWorkflow()).run(makeEvent(), makeFakeStep());

    // 31 planned URLs would be two batches; the block ends it after one.
    expect(mocks.crawl.crawlFeatureBatch).toHaveBeenCalledTimes(1);
    expect(mocks.studyService.summarize).toHaveBeenCalledWith(
      expect.objectContaining({ coverage: "sitemap_only" }),
    );
    expect(mocks.repo.updateStudyRun).toHaveBeenCalledWith(
      "run_1",
      expect.objectContaining({ coverage: "sitemap_only" }),
    );
  });

  it("calls a study with nothing crawlable sitemap-only rather than full", async () => {
    await (await makeWorkflow()).run(makeEvent(), makeFakeStep());

    expect(mocks.crawl.crawlFeatureBatch).not.toHaveBeenCalled();
    expect(mocks.studyService.summarize).toHaveBeenCalledWith(
      expect.objectContaining({ coverage: "sitemap_only" }),
    );
  });

  it("splits a 45-page plan into two batches", async () => {
    const winners = Array.from(
      { length: 30 },
      (_, index) => `https://acme.com/blog/w${index}`,
    );
    const sample = Array.from(
      { length: 15 },
      (_, index) => `https://acme.com/blog/s${index}`,
    );
    mocks.crawl.studySitemap.mockResolvedValue(sitemapWith(winners, sample));
    mocks.crawl.crawlFeatureBatch.mockImplementation(
      (input: { batch: Array<{ url: string; cohort: "winner" | "sample" }> }) =>
        Promise.resolve(
          input.batch.map((target) => readablePage(target.url, target.cohort)),
        ),
    );

    await (await makeWorkflow()).run(makeEvent(), makeFakeStep());

    expect(mocks.crawl.crawlFeatureBatch).toHaveBeenCalledTimes(2);
    expect(
      mocks.crawl.crawlFeatureBatch.mock.calls.map(
        ([call]) => call.batch.length,
      ),
    ).toEqual([25, 20]);
  });

  it("flips the run to error with a bounded message when a free step dies", async () => {
    mocks.crawl.studySitemap.mockRejectedValue(
      new Error("sitemap fetch\nexploded"),
    );

    await expect(
      (await makeWorkflow()).run(makeEvent(), makeFakeStep()),
    ).rejects.toThrow("sitemap fetch");

    expect(mocks.repo.updateStudyRun).toHaveBeenCalledWith(
      "run_1",
      // One line, bounded: the message can echo crawled content.
      expect.objectContaining({
        status: "error",
        error: "sitemap fetch exploded",
      }),
    );
  });

  it("leaves a terminal run alone when a late failure arrives", async () => {
    mocks.repo.getStudyRunById.mockResolvedValue({
      id: "run_1",
      status: "error",
    });
    mocks.crawl.studySitemap.mockRejectedValue(new Error("too late"));

    await expect(
      (await makeWorkflow()).run(makeEvent(), makeFakeStep()),
    ).rejects.toThrow("too late");

    expect(mocks.repo.updateStudyRun).not.toHaveBeenCalled();
  });
});
