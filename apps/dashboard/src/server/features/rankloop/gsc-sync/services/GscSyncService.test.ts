import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  GscSearchAnalyticsRequest,
  GscSearchAnalyticsRow,
} from "@/server/lib/gscClient";
import type { GscPerformanceUpsert } from "@/server/features/rankloop/gsc-sync/repositories/GscSyncRepository";

// Type aliases keep the hoisted mocks' `.mock.calls` inspectable without
// unsafe casts (an untyped vi.fn() yields `any` calls).
type QuerySearchAnalytics = (
  siteUrl: string,
  body: GscSearchAnalyticsRequest,
) => Promise<GscSearchAnalyticsRow[]>;
type Intern = (
  projectId: string,
  values: string[],
) => Promise<Map<string, string>>;

const mocks = vi.hoisted(() => ({
  repo: {
    tryCreateRun: vi.fn(),
    updateRun: vi.fn(),
    getRunById: vi.fn(),
    getActiveRunForProject: vi.fn(),
    getLatestRunForProject: vi.fn(),
    getLatestStoredDate: vi.fn(),
    getMemoryStats: vi.fn(),
    getProjectsDueForSync: vi.fn(),
    internPages: vi.fn<Intern>(),
    internQueries: vi.fn<Intern>(),
    upsertPerformanceRows:
      vi.fn<(rows: GscPerformanceUpsert[]) => Promise<void>>(),
    deleteStalePerformanceRows: vi.fn(),
  },
  connectionRepo: {
    getByProjectId: vi.fn(),
  },
  workflow: {
    create: vi.fn(),
    get: vi.fn(),
  },
}));

vi.mock("cloudflare:workers", () => ({
  env: { GSC_SYNC_WORKFLOW: mocks.workflow },
}));
vi.mock(
  "@/server/features/rankloop/gsc-sync/repositories/GscSyncRepository",
  () => ({ GscSyncRepository: mocks.repo }),
);
vi.mock("@/server/features/gsc/repositories/GscConnectionRepository", () => ({
  GscConnectionRepository: mocks.connectionRepo,
}));

const connection = {
  projectId: "project_1",
  siteUrl: "sc-domain:acme.com",
  connectedByUserId: "user_1",
  gscAccountId: "acct_1",
};

function gscRow(page: string, query: string, impressions: number) {
  return {
    keys: [page, query],
    clicks: 1,
    impressions,
    ctr: 1 / impressions,
    position: 5,
  };
}

beforeEach(() => {
  vi.resetModules();
  for (const group of Object.values(mocks)) {
    for (const mock of Object.values(group)) mock.mockReset();
  }
});

describe("PT date math", () => {
  it("computes today on GSC's Pacific calendar, not UTC", async () => {
    const { todayInPacific } = await import("./GscSyncService");
    // 05:30 UTC on Aug 5 is still 22:30 PDT on Aug 4.
    expect(todayInPacific(new Date("2026-08-05T05:30:00Z"))).toBe("2026-08-04");
    // By 08:00 UTC (01:00 PDT) the Pacific calendar has rolled over too.
    expect(todayInPacific(new Date("2026-08-05T08:00:00Z"))).toBe("2026-08-05");
  });

  it("backfill covers 93 → 4 days ago (90 dates)", async () => {
    const { computeSyncRange, enumerateDates } =
      await import("./GscSyncService");
    const range = computeSyncRange({
      mode: "backfill",
      lastStoredDate: null,
      todayPt: "2026-08-04",
    });
    expect(range).toEqual({ rangeStart: "2026-05-03", rangeEnd: "2026-07-31" });
    expect(enumerateDates(range.rangeStart, range.rangeEnd)).toHaveLength(90);
  });

  it("daily re-pulls from two days before the watermark", async () => {
    const { computeSyncRange } = await import("./GscSyncService");
    // Watermark is fresh (synced yesterday): the range is exactly the
    // trailing re-pull window, ending at the newest finalized day.
    expect(
      computeSyncRange({
        mode: "daily",
        lastStoredDate: "2026-07-30",
        todayPt: "2026-08-04",
      }),
    ).toEqual({ rangeStart: "2026-07-28", rangeEnd: "2026-07-31" });
  });

  it("caps daily catch-up at 14 dates; the next run continues from the new watermark", async () => {
    const { computeSyncRange } = await import("./GscSyncService");
    // Two months dormant: 63 pending dates must not become one giant run.
    expect(
      computeSyncRange({
        mode: "daily",
        lastStoredDate: "2026-06-01",
        todayPt: "2026-08-04",
      }),
    ).toEqual({ rangeStart: "2026-05-30", rangeEnd: "2026-06-12" });
  });
});

describe("capDayRows", () => {
  it("keeps the top 2500 by impressions and sums the remainder into one aggregate", async () => {
    const { capDayRows } = await import("./GscSyncService");
    const rows = Array.from({ length: 2510 }, (_, i) => ({
      page: `https://acme.com/p${i}`,
      query: `q${i}`,
      clicks: 1,
      impressions: 3000 - i,
      ctr: 1 / (3000 - i),
      position: 5 + (i % 3),
    }));

    const { top, remainder } = capDayRows(rows);
    expect(top).toHaveLength(2500);
    // Rows 2500..2509 (impressions 500..491) fold into the remainder.
    expect(remainder).not.toBeNull();
    expect(remainder?.clicks).toBe(10);
    expect(remainder?.impressions).toBe(4955);
    expect(remainder?.ctr).toBeCloseTo(10 / 4955);
    // Impression-weighted position stays inside the folded rows' 5..7 band.
    expect(remainder?.position).toBeGreaterThanOrEqual(5);
    expect(remainder?.position).toBeLessThanOrEqual(7);
  });

  it("returns no remainder at or under the cap", async () => {
    const { capDayRows } = await import("./GscSyncService");
    const rows = [
      {
        page: "https://acme.com/",
        query: "acme",
        clicks: 3,
        impressions: 40,
        ctr: 0.075,
        position: 2.1,
      },
    ];
    expect(capDayRows(rows)).toEqual({ top: rows, remainder: null });
  });
});

describe("fetchDayRows", () => {
  it("pages with startRow until GSC returns a short page", async () => {
    const { fetchDayRows } = await import("./GscSyncService");
    const querySearchAnalytics = vi
      .fn<QuerySearchAnalytics>()
      .mockResolvedValueOnce(
        Array.from({ length: 1000 }, (_, i) =>
          gscRow(`https://acme.com/p${i}`, `q${i}`, 100),
        ),
      )
      .mockResolvedValueOnce([gscRow("https://acme.com/tail", "tail q", 2)]);

    const rows = await fetchDayRows(
      { querySearchAnalytics },
      "sc-domain:acme.com",
      "2026-07-30",
    );

    expect(rows).toHaveLength(1001);
    expect(querySearchAnalytics).toHaveBeenCalledTimes(2);
    const [, firstBody] = querySearchAnalytics.mock.calls[0];
    const [, secondBody] = querySearchAnalytics.mock.calls[1];
    expect(firstBody).toMatchObject({
      startDate: "2026-07-30",
      endDate: "2026-07-30",
      dimensions: ["page", "query"],
      rowLimit: 1000,
    });
    expect(firstBody.startRow).toBeUndefined();
    expect(secondBody.startRow).toBe(1000);
  });
});

describe("GscSyncService.syncDay", () => {
  it("interns the sentinel and writes the remainder as one attributed row", async () => {
    mocks.repo.internPages.mockImplementation(
      async (_projectId: string, urls: string[]) =>
        new Map(urls.map((url) => [url, `page:${url}`])),
    );
    mocks.repo.internQueries.mockImplementation(
      async (_projectId: string, queries: string[]) =>
        new Map(queries.map((query) => [query, `query:${query}`])),
    );
    mocks.repo.upsertPerformanceRows.mockResolvedValue(undefined);
    mocks.repo.deleteStalePerformanceRows.mockResolvedValue(undefined);
    const { GscSyncService, GSC_SYNC_SENTINEL } =
      await import("./GscSyncService");

    // 2510 rows across three GSC pages: 2500 keep identity, 10 fold into
    // the sentinel remainder.
    const all = Array.from({ length: 2510 }, (_, i) =>
      gscRow(`https://acme.com/p${i}`, `q${i}`, 3000 - i),
    );
    const querySearchAnalytics = vi
      .fn<QuerySearchAnalytics>()
      .mockResolvedValueOnce(all.slice(0, 1000))
      .mockResolvedValueOnce(all.slice(1000, 2000))
      .mockResolvedValueOnce(all.slice(2000));

    const written = await GscSyncService.syncDay({
      projectId: "project_1",
      runId: "run_1",
      siteUrl: "sc-domain:acme.com",
      date: "2026-07-30",
      client: { querySearchAnalytics },
    });

    expect(written).toBe(2501);
    const internedUrls = mocks.repo.internPages.mock.calls[0][1];
    expect(internedUrls).toContain(GSC_SYNC_SENTINEL);
    const upserts = mocks.repo.upsertPerformanceRows.mock.calls[0][0];
    expect(upserts).toHaveLength(2501);
    const sentinelRow = upserts.find(
      (row) => row.pageId === `page:${GSC_SYNC_SENTINEL}`,
    );
    expect(sentinelRow).toMatchObject({
      queryId: `query:${GSC_SYNC_SENTINEL}`,
      clicks: 10,
      impressions: 4955,
    });
    // Every row of the pull carries the same mark, sentinel included, and the
    // sweep deletes on it: a pair that fell below the cap since an earlier
    // pull would otherwise be counted twice — once on its stale row, once
    // inside the remainder that now represents it.
    expect(upserts.every((row) => row.syncMark === "run_1:2026-07-30")).toBe(
      true,
    );
    expect(mocks.repo.deleteStalePerformanceRows).toHaveBeenCalledWith({
      projectId: "project_1",
      date: "2026-07-30",
      keepMark: "run_1:2026-07-30",
    });
  });

  it("writes nothing for a day GSC has no rows for", async () => {
    const { GscSyncService } = await import("./GscSyncService");
    const written = await GscSyncService.syncDay({
      projectId: "project_1",
      runId: "run_1",
      siteUrl: "sc-domain:acme.com",
      date: "2026-07-30",
      client: { querySearchAnalytics: vi.fn().mockResolvedValue([]) },
    });
    expect(written).toBe(0);
    expect(mocks.repo.internPages).not.toHaveBeenCalled();
    expect(mocks.repo.upsertPerformanceRows).not.toHaveBeenCalled();
    // A day GSC reports nothing for is not a day whose stored rows are
    // stale — the sweep would empty it.
    expect(mocks.repo.deleteStalePerformanceRows).not.toHaveBeenCalled();
  });
});

describe("GscSyncService.startSync", () => {
  it("creates the run row and a workflow instance whose id is the run id", async () => {
    mocks.connectionRepo.getByProjectId.mockResolvedValue(connection);
    mocks.repo.getLatestStoredDate.mockResolvedValue(null);
    mocks.repo.tryCreateRun.mockResolvedValue(true);
    mocks.workflow.create.mockResolvedValue(undefined);
    const { GscSyncService } = await import("./GscSyncService");

    const result = await GscSyncService.startSync("project_1");

    expect(result.alreadyRunning).toBe(false);
    // No stored memory yet → first sync is the 90-day backfill.
    expect(result.mode).toBe("backfill");
    expect(mocks.repo.tryCreateRun).toHaveBeenCalledWith(
      expect.objectContaining({ id: result.runId, mode: "backfill" }),
    );
    expect(mocks.workflow.create).toHaveBeenCalledWith({
      id: result.runId,
      params: { runId: result.runId, projectId: "project_1", mode: "backfill" },
    });
  });

  it("returns the existing active run on a duplicate start instead of erroring", async () => {
    mocks.connectionRepo.getByProjectId.mockResolvedValue(connection);
    mocks.repo.getLatestStoredDate.mockResolvedValue("2026-07-28");
    // The partial unique on gsc_sync_runs(project_id) blocked the INSERT —
    // that failed INSERT is the already-running signal.
    mocks.repo.tryCreateRun.mockResolvedValue(false);
    mocks.repo.getActiveRunForProject.mockResolvedValue({
      id: "run_active",
      mode: "daily",
      status: "running",
      startedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    });
    // The blocker's workflow instance is genuinely live, so the stale-run
    // probe must leave it alone.
    mocks.workflow.get.mockResolvedValue({
      status: async () => ({ status: "running" }),
    });
    const { GscSyncService } = await import("./GscSyncService");

    await expect(GscSyncService.startSync("project_1")).resolves.toEqual({
      runId: "run_active",
      mode: "daily",
      alreadyRunning: true,
    });
    expect(mocks.workflow.create).not.toHaveBeenCalled();
    expect(mocks.repo.updateRun).not.toHaveBeenCalled();
  });

  it("heals a zombie run — errored instance past the startup grace — and starts fresh", async () => {
    mocks.connectionRepo.getByProjectId.mockResolvedValue(connection);
    mocks.repo.getLatestStoredDate.mockResolvedValue("2026-07-28");
    mocks.repo.tryCreateRun
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    // The blocker's workflow died without reaching its mark-error step, so
    // the row sat "running" and wedged the partial-index slot.
    mocks.repo.getActiveRunForProject.mockResolvedValue({
      id: "run_stale",
      mode: "daily",
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
    const { GscSyncService } = await import("./GscSyncService");

    const result = await GscSyncService.startSync("project_1");

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

  it("leaves a seconds-old run alone even when its instance is not yet visible", async () => {
    mocks.connectionRepo.getByProjectId.mockResolvedValue(connection);
    mocks.repo.getLatestStoredDate.mockResolvedValue("2026-07-28");
    mocks.repo.tryCreateRun.mockResolvedValue(false);
    // Just created by a racing request: the engine may not report the
    // instance yet, and a missing status inside the 60s startup grace is
    // startup latency, not death.
    mocks.repo.getActiveRunForProject.mockResolvedValue({
      id: "run_young",
      mode: "daily",
      status: "pending",
      startedAt: new Date().toISOString(),
    });
    mocks.workflow.get.mockRejectedValue(new Error("instance not found"));
    const { GscSyncService } = await import("./GscSyncService");

    await expect(GscSyncService.startSync("project_1")).resolves.toEqual({
      runId: "run_young",
      mode: "daily",
      alreadyRunning: true,
    });
    expect(mocks.repo.updateRun).not.toHaveBeenCalled();
  });

  it("retries once when the blocking run finished between insert and select", async () => {
    mocks.connectionRepo.getByProjectId.mockResolvedValue(connection);
    mocks.repo.getLatestStoredDate.mockResolvedValue("2026-07-28");
    mocks.repo.tryCreateRun
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    mocks.repo.getActiveRunForProject.mockResolvedValue(null);
    mocks.workflow.create.mockResolvedValue(undefined);
    const { GscSyncService } = await import("./GscSyncService");

    const result = await GscSyncService.startSync("project_1");

    expect(result.alreadyRunning).toBe(false);
    expect(mocks.repo.tryCreateRun).toHaveBeenCalledTimes(2);
  });

  it("flips the run to error and rethrows when the workflow will not start", async () => {
    mocks.connectionRepo.getByProjectId.mockResolvedValue(connection);
    mocks.repo.getLatestStoredDate.mockResolvedValue(null);
    mocks.repo.tryCreateRun.mockResolvedValue(true);
    mocks.workflow.create.mockRejectedValue(new Error("no capacity"));
    mocks.workflow.get.mockRejectedValue(new Error("not found"));
    const { GscSyncService } = await import("./GscSyncService");

    await expect(GscSyncService.startSync("project_1")).rejects.toThrow(
      "no capacity",
    );
    // The error flip is what releases the partial-index slot.
    expect(mocks.repo.updateRun).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ status: "error" }),
    );
  });

  it("rejects a project without a Search Console connection", async () => {
    mocks.connectionRepo.getByProjectId.mockResolvedValue(null);
    const { GscSyncService } = await import("./GscSyncService");

    await expect(GscSyncService.startSync("project_1")).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(mocks.repo.tryCreateRun).not.toHaveBeenCalled();
  });
});

describe("runScheduledGscSyncs", () => {
  it("starts a sync per due project and isolates per-project failures", async () => {
    mocks.repo.getProjectsDueForSync.mockResolvedValue([
      { projectId: "project_1" },
      { projectId: "project_2" },
    ]);
    // project_1 blows up (revoked grant); project_2 must still start.
    mocks.connectionRepo.getByProjectId
      .mockRejectedValueOnce(new Error("grant revoked"))
      .mockResolvedValueOnce(connection);
    mocks.repo.getLatestStoredDate.mockResolvedValue("2026-07-28");
    mocks.repo.tryCreateRun.mockResolvedValue(true);
    mocks.workflow.create.mockResolvedValue(undefined);
    const { runScheduledGscSyncs } = await import("./scheduledGscSyncs");

    await runScheduledGscSyncs();

    expect(mocks.repo.getProjectsDueForSync).toHaveBeenCalledWith(
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      10,
    );
    expect(mocks.workflow.create).toHaveBeenCalledTimes(1);
  });
});
