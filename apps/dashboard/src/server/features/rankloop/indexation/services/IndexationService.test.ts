import { beforeEach, describe, expect, it, vi } from "vitest";

// Typed so the assertions below read `.mock.calls` without unsafe casts (an
// untyped vi.fn() yields `any` calls).
type DueQuery = (input: {
  projectId: string;
  publishedFrom: string;
  publishedBefore: string;
  staleBefore: string;
  limit: number;
}) => Promise<Array<{ url: string }>>;

type CheckInsert = {
  projectId: string;
  url: string;
  verdict: string;
  coverageState: string | null;
  checkedAt: string;
};

type InspectUrls = (input: { projectId: string; urls: string[] }) => Promise<{
  siteUrl: string;
  connectedBy: string | null;
  results: Array<{
    url: string;
    result: {
      indexStatusResult?: { verdict?: string; coverageState?: string };
      mobileUsabilityResult?: { verdict?: string };
    } | null;
    error?: string;
  }>;
}>;

const mocks = vi.hoisted(() => ({
  repo: {
    getPublishedPagesSince: vi.fn(),
    getChecksSince: vi.fn(),
    getPagesDueForCheck: vi.fn<DueQuery>(),
    countChecksSince: vi.fn(),
    insertChecks: vi.fn<(rows: CheckInsert[]) => Promise<void>>(),
  },
  gsc: {
    getConnection: vi.fn(),
    inspectUrls: vi.fn<InspectUrls>(),
  },
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock(
  "@/server/features/rankloop/indexation/repositories/IndexationRepository",
  () => ({ IndexationRepository: mocks.repo }),
);
vi.mock("@/server/features/gsc/services/GscService", () => ({
  GscService: mocks.gsc,
}));

const CONNECTION = { siteUrl: "sc-domain:acme.com" };

/** `n` due URLs, /p1 … /pn. */
function due(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    url: `https://acme.com/p${i + 1}`,
  }));
}

/** An inspectUrls answer where every URL came back indexed. */
function allIndexed(urls: string[]) {
  return {
    siteUrl: CONNECTION.siteUrl,
    connectedBy: "ops@acme.com",
    results: urls.map((url) => ({
      url,
      result: {
        indexStatusResult: {
          verdict: "PASS",
          coverageState: "Submitted and indexed",
        },
      },
    })),
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-01T09:00:00.000Z"));
  for (const group of Object.values(mocks)) {
    for (const mock of Object.values(group)) mock.mockReset();
  }
  mocks.gsc.getConnection.mockResolvedValue(CONNECTION);
  mocks.repo.countChecksSince.mockResolvedValue(0);
  mocks.repo.getPagesDueForCheck.mockResolvedValue([]);
  mocks.repo.insertChecks.mockResolvedValue(undefined);
});

describe("IndexationService.runIndexationChecks", () => {
  it("is a clean no-op with no connected property", async () => {
    mocks.gsc.getConnection.mockResolvedValue(null);
    const { IndexationService } = await import("./IndexationService");

    const result = await IndexationService.runIndexationChecks("project_1");

    expect(result).toEqual({
      checked: 0,
      indexed: 0,
      failed: 0,
      reason: "no Search Console property connected",
    });
    expect(mocks.repo.getPagesDueForCheck).not.toHaveBeenCalled();
    expect(mocks.gsc.inspectUrls).not.toHaveBeenCalled();
  });

  it("asks for the 7–45 day cohort, stale by a week, oldest first", async () => {
    const { IndexationService } = await import("./IndexationService");

    await IndexationService.runIndexationChecks("project_1");

    expect(mocks.repo.getPagesDueForCheck).toHaveBeenCalledWith({
      projectId: "project_1",
      publishedFrom: "2026-06-17",
      // Exclusive, so a post published exactly 7 days ago is still in.
      publishedBefore: "2026-07-26",
      staleBefore: "2026-07-25T09:00:00.000Z",
      limit: 20,
    });
  });

  it("inspects in batches of ten and writes one row per URL", async () => {
    mocks.repo.getPagesDueForCheck.mockResolvedValue(due(20));
    mocks.gsc.inspectUrls.mockImplementation(({ urls }) =>
      Promise.resolve(allIndexed(urls)),
    );
    const { IndexationService } = await import("./IndexationService");

    const result = await IndexationService.runIndexationChecks("project_1");

    expect(mocks.gsc.inspectUrls).toHaveBeenCalledTimes(2);
    const [first, second] = mocks.gsc.inspectUrls.mock.calls.map(
      ([input]) => input.urls,
    );
    expect(first).toHaveLength(10);
    expect(second).toHaveLength(10);
    expect(first[0]).toBe("https://acme.com/p1");
    expect(second[0]).toBe("https://acme.com/p11");
    expect(result).toEqual({
      checked: 20,
      indexed: 20,
      failed: 0,
      reason: null,
    });
  });

  it("persists the verdict and the coverage state as Google worded them", async () => {
    mocks.repo.getPagesDueForCheck.mockResolvedValue(due(1));
    mocks.gsc.inspectUrls.mockResolvedValue({
      siteUrl: CONNECTION.siteUrl,
      connectedBy: null,
      results: [
        {
          url: "https://acme.com/p1",
          result: {
            indexStatusResult: {
              verdict: "FAIL",
              coverageState: "Crawled - currently not indexed",
            },
          },
        },
      ],
    });
    const { IndexationService } = await import("./IndexationService");

    const result = await IndexationService.runIndexationChecks("project_1");

    expect(mocks.repo.insertChecks).toHaveBeenCalledWith([
      {
        projectId: "project_1",
        url: "https://acme.com/p1",
        verdict: "FAIL",
        coverageState: "Crawled - currently not indexed",
        checkedAt: "2026-08-01T09:00:00.000Z",
      },
    ]);
    expect(result).toMatchObject({ checked: 1, indexed: 0 });
  });

  it("counts a refused URL as failed and writes no row for it", async () => {
    mocks.repo.getPagesDueForCheck.mockResolvedValue(due(3));
    mocks.gsc.inspectUrls.mockResolvedValue({
      siteUrl: CONNECTION.siteUrl,
      connectedBy: null,
      results: [
        {
          url: "https://acme.com/p1",
          result: { indexStatusResult: { verdict: "PASS" } },
        },
        // inspectUrls captures the per-URL failure inline rather than failing
        // the batch; a row claiming a verdict we never got would be
        // indistinguishable from Google saying no.
        {
          url: "https://acme.com/p2",
          result: null,
          error: "Search Console rate limit reached. Retry shortly.",
        },
        // Answered, but with nothing about the index — same nothing.
        {
          url: "https://acme.com/p3",
          result: { mobileUsabilityResult: { verdict: "PASS" } },
        },
      ],
    });
    const { IndexationService } = await import("./IndexationService");

    const result = await IndexationService.runIndexationChecks("project_1");

    expect(result).toEqual({ checked: 1, indexed: 1, failed: 2, reason: null });
    const [rows] = mocks.repo.insertChecks.mock.calls[0];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      url: "https://acme.com/p1",
      coverageState: null,
    });
  });

  it("backs off after a batch that answered nothing at all", async () => {
    mocks.repo.getPagesDueForCheck.mockResolvedValue(due(20));
    mocks.gsc.inspectUrls.mockImplementation(({ urls }) =>
      Promise.resolve({
        siteUrl: CONNECTION.siteUrl,
        connectedBy: null,
        results: urls.map((url) => ({
          url,
          result: null,
          error: "Search Console rate limit reached. Retry shortly.",
        })),
      }),
    );
    const { IndexationService } = await import("./IndexationService");

    const result = await IndexationService.runIndexationChecks("project_1");

    // The second batch is never asked for: nothing was written, so the daily
    // budget did not move, and a retrying tick would spend the quota we are
    // protecting.
    expect(mocks.gsc.inspectUrls).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      checked: 0,
      indexed: 0,
      failed: 10,
      reason: "Search Console answered nothing — backing off until next tick",
    });
  });

  it("spends only what is left of today's 20-URL budget", async () => {
    mocks.repo.countChecksSince.mockResolvedValue(15);
    const { IndexationService } = await import("./IndexationService");

    await IndexationService.runIndexationChecks("project_1");

    expect(mocks.repo.countChecksSince).toHaveBeenCalledWith(
      "project_1",
      "2026-08-01T00:00:00.000Z",
    );
    expect(mocks.repo.getPagesDueForCheck).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 5 }),
    );
  });

  it("stops for the day once the budget is gone, however often the cron ticks", async () => {
    mocks.repo.countChecksSince.mockResolvedValue(20);
    const { IndexationService } = await import("./IndexationService");

    const result = await IndexationService.runIndexationChecks("project_1");

    expect(result.reason).toBe("today's inspection budget is spent");
    expect(mocks.repo.getPagesDueForCheck).not.toHaveBeenCalled();
    expect(mocks.gsc.inspectUrls).not.toHaveBeenCalled();
  });

  it("says so when every recent post already has a fresh verdict", async () => {
    const { IndexationService } = await import("./IndexationService");

    const result = await IndexationService.runIndexationChecks("project_1");

    expect(result.reason).toBe("every recent post has a fresh verdict");
    expect(mocks.gsc.inspectUrls).not.toHaveBeenCalled();
  });
});

describe("IndexationService.getIndexationStatus", () => {
  it("reads the cohort window and hands back the rate with its cap", async () => {
    mocks.repo.getPublishedPagesSince.mockResolvedValue(
      Array.from({ length: 10 }, (_, i) => ({
        url: `https://acme.com/p${i + 1}`,
        publishedAt: "2026-07-01",
      })),
    );
    mocks.repo.getChecksSince.mockResolvedValue(
      Array.from({ length: 10 }, (_, i) => ({
        url: `https://acme.com/p${i + 1}`,
        verdict: i < 3 ? "PASS" : "FAIL",
        checkedAt: "2026-07-30T09:00:00.000Z",
      })),
    );
    const { IndexationService } = await import("./IndexationService");

    const status = await IndexationService.getIndexationStatus("project_1");

    expect(mocks.repo.getPublishedPagesSince).toHaveBeenCalledWith(
      "project_1",
      "2026-06-17",
    );
    expect(mocks.repo.getChecksSince).toHaveBeenCalledWith(
      "project_1",
      "2026-06-17",
    );
    expect(status).toEqual({
      rate: 0.3,
      indexed: 3,
      cohort: 10,
      minimumCohort: 5,
      connected: true,
      throttle: {
        cap: 0,
        reason: "net-new paused — 30% of recent posts are indexed",
      },
    });
  });

  it("writes nothing — the header polls it on every visit", async () => {
    mocks.repo.getPublishedPagesSince.mockResolvedValue([]);
    mocks.repo.getChecksSince.mockResolvedValue([]);
    const { IndexationService } = await import("./IndexationService");

    const status = await IndexationService.getIndexationStatus("project_1");

    expect(status).toEqual({
      rate: null,
      indexed: 0,
      cohort: 0,
      minimumCohort: 5,
      connected: true,
      throttle: null,
    });
    expect(mocks.gsc.inspectUrls).not.toHaveBeenCalled();
    expect(mocks.repo.insertChecks).not.toHaveBeenCalled();
  });
});
