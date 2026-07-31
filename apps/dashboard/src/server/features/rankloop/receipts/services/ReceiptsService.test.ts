import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  RankloopReceipt,
  ReceiptBaseline,
} from "@/types/schemas/rankloopReceipts";
import {
  receiptBaselineSchema,
  receiptResultSchema,
} from "@/types/schemas/rankloopReceipts";

// Type aliases keep the hoisted mocks' `.mock.calls` inspectable without
// unsafe casts (an untyped vi.fn() yields `any` calls).
type GetContentPageById = (
  projectId: string,
  contentPageId: string,
) => Promise<{ id: string; url: string; path: string } | null>;
type GetPageWindowRows = (
  projectId: string,
  pageUrl: string,
  firstDay: string,
  lastDay: string,
) => Promise<Array<{ clicks: number; impressions: number; position: number }>>;
type GetSiteWindowTotals = (
  projectId: string,
  firstDay: string,
  lastDay: string,
) => Promise<{ clicks: number; impressions: number }>;
type GetDueReceipts = (
  today: string,
  limit: number,
) => Promise<RankloopReceipt[]>;
type CountReceiptsWaitingOnData = (today: string) => Promise<number>;
type DeferReceipt = (receiptId: string, nextCheckAt: string) => Promise<void>;
type MarkMeasuring = (receiptId: string) => Promise<boolean>;
type FinalizeReceipt = (input: {
  receiptId: string;
  status: "measured" | "contaminated";
  resultJson: string;
  measuredAt: string;
}) => Promise<boolean>;
type GetExecutedProposalsOnPageAfter = (
  projectId: string,
  contentPageId: string,
  afterIso: string,
) => Promise<Array<{ contentPageId: string | null; executedAt: string }>>;
type GetLatestStoredDate = (projectId: string) => Promise<string | null>;
type GetReceiptsForProject = (
  projectId: string,
) => Promise<Array<{ receipt: RankloopReceipt; pagePath: string | null }>>;

const mocks = vi.hoisted(() => ({
  repo: {
    getContentPageById: vi.fn<GetContentPageById>(),
    getPageWindowRows: vi.fn<GetPageWindowRows>(),
    getSiteWindowTotals: vi.fn<GetSiteWindowTotals>(),
    getDueReceipts: vi.fn<GetDueReceipts>(),
    countReceiptsWaitingOnData: vi.fn<CountReceiptsWaitingOnData>(),
    deferReceipt: vi.fn<DeferReceipt>(),
    markMeasuring: vi.fn<MarkMeasuring>(),
    finalizeReceipt: vi.fn<FinalizeReceipt>(),
    getExecutedProposalsOnPageAfter: vi.fn<GetExecutedProposalsOnPageAfter>(),
    getReceiptsForProject: vi.fn<GetReceiptsForProject>(),
  },
  gscSyncRepo: {
    getLatestStoredDate: vi.fn<GetLatestStoredDate>(),
  },
}));

vi.mock(
  "@/server/features/rankloop/receipts/repositories/ReceiptsRepository",
  () => ({ ReceiptsRepository: mocks.repo }),
);
vi.mock(
  "@/server/features/rankloop/gsc-sync/repositories/GscSyncRepository",
  () => ({ GscSyncRepository: mocks.gscSyncRepo }),
);

const page = {
  id: "page_1",
  url: "https://acme.com/blog/best-espresso-tampers/",
  path: "/blog/best-espresso-tampers/",
};

const storedBaseline: ReceiptBaseline = {
  impressions: 1000,
  clicks: 50,
  ctr: 0.05,
  weightedPosition: 8.2,
  siteImpressions: 20000,
  siteClicks: 1000,
  window: { start: "2026-06-04", end: "2026-07-01" },
};

// Executed 2026-07-01 → evaluation window opens 2026-07-15, closes 2026-08-12.
function receiptRow(overrides: Partial<RankloopReceipt> = {}): RankloopReceipt {
  return {
    id: "receipt_1",
    projectId: "project_1",
    actionType: "retitle",
    articleId: null,
    contentPageId: "page_1",
    targetQuery: "best espresso tampers",
    status: "baseline",
    baselineJson: JSON.stringify(storedBaseline),
    resultJson: null,
    windowStart: "2026-07-15",
    windowEnd: "2026-08-12",
    measuredAt: null,
    nextCheckAt: null,
    createdAt: "2026-07-01T10:00:00.000Z",
    ...overrides,
  };
}

function clockAt(iso: string): () => Date {
  return () => new Date(iso);
}

beforeEach(() => {
  vi.resetModules();
  const all = [
    ...Object.values(mocks.repo),
    ...Object.values(mocks.gscSyncRepo),
  ];
  for (const mock of all) mock.mockReset();
  // The lagged tally is its own read now, so every pass calls it.
  mocks.repo.countReceiptsWaitingOnData.mockResolvedValue(0);
});

describe("openReceipt", () => {
  it("assembles an insert-ready row with a watermark-anchored baseline", async () => {
    mocks.repo.getContentPageById.mockResolvedValue(page);
    // Execution on the 15th with memory through the 11th: the baseline must
    // end at the watermark, not at execution.
    mocks.gscSyncRepo.getLatestStoredDate.mockResolvedValue("2026-07-11");
    mocks.repo.getPageWindowRows.mockResolvedValue([
      { clicks: 5, impressions: 100, position: 4 },
      { clicks: 0, impressions: 1, position: 90 },
    ]);
    mocks.repo.getSiteWindowTotals.mockResolvedValue({
      clicks: 1000,
      impressions: 20000,
    });
    const { ReceiptsService } = await import("./ReceiptsService");

    const row = await ReceiptsService.openReceipt({
      projectId: "project_1",
      actionType: "retitle",
      contentPageId: "page_1",
      targetQuery: "best espresso tampers",
      executedAt: "2026-07-15T10:00:00.000Z",
    });

    expect(row.status).toBe("baseline");
    expect(row.createdAt).toBe("2026-07-15T10:00:00.000Z");
    expect(row.windowStart).toBe("2026-07-29");
    expect(row.windowEnd).toBe("2026-08-26");
    expect(mocks.repo.getPageWindowRows).toHaveBeenCalledWith(
      "project_1",
      page.url,
      "2026-06-14",
      "2026-07-11",
    );
    const parsed: unknown = JSON.parse(row.baselineJson ?? "null");
    const baseline = receiptBaselineSchema.parse(parsed);
    expect(baseline.window).toEqual({
      start: "2026-06-14",
      end: "2026-07-11",
    });
    expect(baseline.clicks).toBe(5);
    expect(baseline.impressions).toBe(101);
    expect(baseline.weightedPosition).toBeCloseTo(4.85, 2);
    expect(baseline.siteClicks).toBe(1000);
    expect(baseline.siteImpressions).toBe(20000);
  });

  it("refuses to open a receipt for a missing content page", async () => {
    mocks.repo.getContentPageById.mockResolvedValue(null);
    const { ReceiptsService } = await import("./ReceiptsService");
    await expect(
      ReceiptsService.openReceipt({
        projectId: "project_1",
        actionType: "retitle",
        contentPageId: "page_missing",
        targetQuery: null,
        executedAt: "2026-07-15T10:00:00.000Z",
      }),
    ).rejects.toThrow("Content page not found.");
  });
});

describe("runMeasurementPass", () => {
  it("does nothing beyond the due-check when nothing is due", async () => {
    mocks.repo.getDueReceipts.mockResolvedValue([]);
    const { ReceiptsService } = await import("./ReceiptsService");

    const result = await ReceiptsService.runMeasurementPass(
      clockAt("2026-07-05T00:00:00.000Z"),
    );

    expect(result).toEqual({
      flipped: 0,
      measured: 0,
      contaminated: 0,
      lagged: 0,
      skipped: 0,
    });
    // The cheap guard: one indexed read, no per-project watermark fetches.
    expect(mocks.gscSyncRepo.getLatestStoredDate).not.toHaveBeenCalled();
  });

  it("flips baseline to measuring once windowStart passes", async () => {
    mocks.repo.getDueReceipts.mockResolvedValue([receiptRow()]);
    mocks.gscSyncRepo.getLatestStoredDate.mockResolvedValue("2026-07-17");
    mocks.repo.markMeasuring.mockResolvedValue(true);
    const { ReceiptsService } = await import("./ReceiptsService");

    const result = await ReceiptsService.runMeasurementPass(
      clockAt("2026-07-21T04:00:00.000Z"),
    );

    expect(result.flipped).toBe(1);
    expect(mocks.repo.markMeasuring).toHaveBeenCalledWith("receipt_1");
    expect(mocks.repo.finalizeReceipt).not.toHaveBeenCalled();
  });

  it("holds a closed window until stored memory reaches windowEnd, and parks it for a day", async () => {
    mocks.repo.getDueReceipts.mockResolvedValue([
      receiptRow({ status: "measuring" }),
    ]);
    mocks.repo.countReceiptsWaitingOnData.mockResolvedValue(1);
    // Window closed on the 12th but memory only reaches the 9th — GSC lag.
    mocks.gscSyncRepo.getLatestStoredDate.mockResolvedValue("2026-08-09");
    const { ReceiptsService } = await import("./ReceiptsService");

    const result = await ReceiptsService.runMeasurementPass(
      clockAt("2026-08-14T04:00:00.000Z"),
    );

    expect(result.lagged).toBe(1);
    expect(result.measured).toBe(0);
    expect(mocks.repo.finalizeReceipt).not.toHaveBeenCalled();
    // The slot is handed back until tomorrow rather than held on all 96 of
    // today's ticks.
    expect(mocks.repo.deferReceipt).toHaveBeenCalledWith(
      "receipt_1",
      "2026-08-15",
    );
  });

  it("measures a closed window and trend-adjusts against the baseline", async () => {
    mocks.repo.getDueReceipts.mockResolvedValue([
      receiptRow({ status: "measuring" }),
    ]);
    mocks.gscSyncRepo.getLatestStoredDate.mockResolvedValue("2026-08-12");
    mocks.repo.getContentPageById.mockResolvedValue(page);
    mocks.repo.getPageWindowRows.mockResolvedValue([
      { clicks: 80, impressions: 1200, position: 6.1 },
    ]);
    // Site up 20% against the pinned baseline's 1000 clicks.
    mocks.repo.getSiteWindowTotals.mockResolvedValue({
      clicks: 1200,
      impressions: 24000,
    });
    mocks.repo.getExecutedProposalsOnPageAfter.mockResolvedValue([]);
    mocks.repo.finalizeReceipt.mockResolvedValue(true);
    const { ReceiptsService } = await import("./ReceiptsService");

    const result = await ReceiptsService.runMeasurementPass(
      clockAt("2026-08-16T04:00:00.000Z"),
    );

    expect(result.measured).toBe(1);
    const call = mocks.repo.finalizeReceipt.mock.calls[0][0];
    expect(call.receiptId).toBe("receipt_1");
    expect(call.status).toBe("measured");
    expect(call.measuredAt).toBe("2026-08-16T04:00:00.000Z");
    const parsed: unknown = JSON.parse(call.resultJson);
    const measured = receiptResultSchema.parse(parsed);
    // The measured span is windowStart through the day before windowEnd.
    expect(measured.window).toEqual({
      start: "2026-07-15",
      end: "2026-08-11",
    });
    expect(measured.clicksDelta).toBe(30);
    expect(measured.siteClicksDeltaRatio).toBeCloseTo(0.2);
    // 30 raw minus the 10 clicks the site-wide +20% predicted for the page.
    expect(measured.adjustedClicksDelta).toBeCloseTo(20);
    expect(mocks.repo.getPageWindowRows).toHaveBeenCalledWith(
      "project_1",
      page.url,
      "2026-07-15",
      "2026-08-11",
    );
  });

  it("marks the receipt contaminated when another action hit the page mid-window", async () => {
    mocks.repo.getDueReceipts.mockResolvedValue([
      receiptRow({ status: "measuring" }),
    ]);
    mocks.gscSyncRepo.getLatestStoredDate.mockResolvedValue("2026-08-12");
    mocks.repo.getContentPageById.mockResolvedValue(page);
    mocks.repo.getPageWindowRows.mockResolvedValue([
      { clicks: 80, impressions: 1200, position: 6.1 },
    ]);
    mocks.repo.getSiteWindowTotals.mockResolvedValue({
      clicks: 1200,
      impressions: 24000,
    });
    // A push executed on the same page 19 days into the window.
    mocks.repo.getExecutedProposalsOnPageAfter.mockResolvedValue([
      { contentPageId: "page_1", executedAt: "2026-07-20T09:00:00.000Z" },
    ]);
    mocks.repo.finalizeReceipt.mockResolvedValue(true);
    const { ReceiptsService } = await import("./ReceiptsService");

    const result = await ReceiptsService.runMeasurementPass(
      clockAt("2026-08-16T04:00:00.000Z"),
    );

    expect(result.contaminated).toBe(1);
    expect(result.measured).toBe(0);
    const call = mocks.repo.finalizeReceipt.mock.calls[0][0];
    expect(call.status).toBe("contaminated");
    // The result is still computed and stored — flagged, not discarded.
    const measured = receiptResultSchema.parse(JSON.parse(call.resultJson));
    expect(measured.clicksDelta).toBe(30);
  });

  it("leaves a receipt open when its content page row is gone", async () => {
    mocks.repo.getDueReceipts.mockResolvedValue([
      receiptRow({ status: "measuring" }),
    ]);
    mocks.gscSyncRepo.getLatestStoredDate.mockResolvedValue("2026-08-12");
    mocks.repo.getContentPageById.mockResolvedValue(null);
    const { ReceiptsService } = await import("./ReceiptsService");

    const result = await ReceiptsService.runMeasurementPass(
      clockAt("2026-08-16T04:00:00.000Z"),
    );

    expect(result.skipped).toBe(1);
    expect(mocks.repo.finalizeReceipt).not.toHaveBeenCalled();
    // Still open, but parked — a pruned page comes back on a recrawl, not on
    // the next tick.
    expect(mocks.repo.deferReceipt).toHaveBeenCalledWith(
      "receipt_1",
      "2026-08-17",
    );
  });

  it("walks one receipt through its whole life on a travelling clock", async () => {
    const { ReceiptsService } = await import("./ReceiptsService");
    mocks.gscSyncRepo.getLatestStoredDate.mockResolvedValue("2026-07-17");
    mocks.repo.markMeasuring.mockResolvedValue(true);

    // Day 14: the flip.
    mocks.repo.getDueReceipts.mockResolvedValue([receiptRow()]);
    const flip = await ReceiptsService.runMeasurementPass(
      clockAt("2026-07-15T04:00:00.000Z"),
    );
    expect(flip.flipped).toBe(1);

    // Day 44: window closed, memory still two days short.
    mocks.repo.getDueReceipts.mockResolvedValue([
      receiptRow({ status: "measuring" }),
    ]);
    mocks.gscSyncRepo.getLatestStoredDate.mockResolvedValue("2026-08-10");
    mocks.repo.countReceiptsWaitingOnData.mockResolvedValue(1);
    const wait = await ReceiptsService.runMeasurementPass(
      clockAt("2026-08-14T04:00:00.000Z"),
    );
    expect(wait.lagged).toBe(1);

    // Day 47: memory caught up — the receipt closes.
    mocks.repo.countReceiptsWaitingOnData.mockResolvedValue(0);
    mocks.gscSyncRepo.getLatestStoredDate.mockResolvedValue("2026-08-13");
    mocks.repo.getContentPageById.mockResolvedValue(page);
    mocks.repo.getPageWindowRows.mockResolvedValue([
      { clicks: 60, impressions: 1100, position: 7.4 },
    ]);
    mocks.repo.getSiteWindowTotals.mockResolvedValue({
      clicks: 1000,
      impressions: 20000,
    });
    mocks.repo.getExecutedProposalsOnPageAfter.mockResolvedValue([]);
    mocks.repo.finalizeReceipt.mockResolvedValue(true);
    const close = await ReceiptsService.runMeasurementPass(
      clockAt("2026-08-17T04:00:00.000Z"),
    );
    expect(close.measured).toBe(1);
    const call = mocks.repo.finalizeReceipt.mock.calls[0][0];
    const measured = receiptResultSchema.parse(JSON.parse(call.resultJson));
    // Site flat → the raw +10 stands.
    expect(measured.adjustedClicksDelta).toBe(10);
  });
});

describe("getReceipts", () => {
  it("parses JSON columns and degrades malformed ones to null", async () => {
    mocks.repo.getReceiptsForProject.mockResolvedValue([
      { receipt: receiptRow(), pagePath: page.path },
      {
        receipt: receiptRow({ id: "receipt_2", baselineJson: "{not json" }),
        pagePath: page.path,
      },
    ]);
    const { ReceiptsService } = await import("./ReceiptsService");

    const rows = await ReceiptsService.getReceipts("project_1");

    expect(rows[0].target).toBe(page.path);
    expect(rows[0].baseline?.clicks).toBe(50);
    expect(rows[0].result).toBeNull();
    expect(rows[1].baseline).toBeNull();
  });

  it("falls back to the pinned query when the page row is gone", async () => {
    mocks.repo.getReceiptsForProject.mockResolvedValue([
      { receipt: receiptRow(), pagePath: null },
    ]);
    const { ReceiptsService } = await import("./ReceiptsService");

    const rows = await ReceiptsService.getReceipts("project_1");

    expect(rows[0].target).toBe("best espresso tampers");
  });
});
