import { describe, expect, it } from "vitest";
import type { ReceiptBaseline } from "@/types/schemas/rankloopReceipts";
import type { MetricDayRow } from "./receipts.logic";
import {
  assembleWindowMetrics,
  decideMeasurementStep,
  evaluationWindow,
  isContaminated,
  isoDay,
  measuredWindow,
  resolveBaselineWindow,
  shiftDate,
  trendAdjust,
} from "./receipts.logic";

function baseline(overrides: Partial<ReceiptBaseline> = {}): ReceiptBaseline {
  return {
    impressions: 1000,
    clicks: 50,
    ctr: 0.05,
    weightedPosition: 8.2,
    siteImpressions: 20000,
    siteClicks: 1000,
    window: { start: "2026-06-01", end: "2026-06-28" },
    ...overrides,
  };
}

describe("date helpers", () => {
  it("shifts across month and year boundaries", () => {
    expect(shiftDate("2026-12-31", 1)).toBe("2027-01-01");
    expect(shiftDate("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("takes the day of an ISO instant without zone math", () => {
    expect(isoDay("2026-07-15T23:59:59.000Z")).toBe("2026-07-15");
  });
});

describe("resolveBaselineWindow", () => {
  it("ends at the watermark when memory lags execution", () => {
    // GSC finalizes late: executed on the 15th, stored data ends on the 11th.
    const window = resolveBaselineWindow(
      "2026-07-15T10:00:00.000Z",
      "2026-07-11",
    );
    expect(window).toEqual({ start: "2026-06-14", end: "2026-07-11" });
  });

  it("caps at the day before execution when the watermark is ahead", () => {
    // A watermark past execution day would let post-action days leak into
    // the 'before' picture.
    const window = resolveBaselineWindow(
      "2026-07-15T10:00:00.000Z",
      "2026-07-20",
    );
    expect(window).toEqual({ start: "2026-06-17", end: "2026-07-14" });
  });

  it("falls back to the day before execution with no memory at all", () => {
    const window = resolveBaselineWindow("2026-07-15T10:00:00.000Z", null);
    expect(window.end).toBe("2026-07-14");
  });

  it("always spans exactly 28 days", () => {
    const window = resolveBaselineWindow(
      "2026-07-15T10:00:00.000Z",
      "2026-07-11",
    );
    // Inclusive span: end − start + 1 = 28.
    expect(shiftDate(window.start, 27)).toBe(window.end);
  });
});

describe("evaluationWindow", () => {
  it("opens 14 days after execution and closes at day 42", () => {
    expect(evaluationWindow("2026-07-01T09:30:00.000Z")).toEqual({
      windowStart: "2026-07-15",
      windowEnd: "2026-08-12",
    });
  });

  it("measures exactly 28 days — windowEnd is exclusive", () => {
    const { windowStart, windowEnd } = evaluationWindow(
      "2026-07-01T09:30:00.000Z",
    );
    const window = measuredWindow(windowStart, windowEnd);
    expect(window).toEqual({ start: "2026-07-15", end: "2026-08-11" });
    // Same width as the baseline: 28 inclusive days.
    expect(shiftDate(window.start, 27)).toBe(window.end);
  });
});

describe("assembleWindowMetrics", () => {
  it("weights position by impressions and recomputes CTR from sums", () => {
    const rows: MetricDayRow[] = [
      // 100 impressions at pos 4 vs 1 at pos 90: unweighted mean says 47,
      // the weighted one stays near 4.
      { clicks: 5, impressions: 100, position: 4 },
      { clicks: 0, impressions: 1, position: 90 },
    ];
    const metrics = assembleWindowMetrics(rows, {
      clicks: 500,
      impressions: 9000,
    });
    expect(metrics.clicks).toBe(5);
    expect(metrics.impressions).toBe(101);
    expect(metrics.weightedPosition).toBeCloseTo((4 * 100 + 90) / 101, 1);
    expect(metrics.ctr).toBeCloseTo(5 / 101, 3);
    expect(metrics.siteClicks).toBe(500);
    expect(metrics.siteImpressions).toBe(9000);
  });

  it("yields a null position and zero CTR on an empty window", () => {
    const metrics = assembleWindowMetrics([], { clicks: 0, impressions: 0 });
    expect(metrics.weightedPosition).toBeNull();
    expect(metrics.ctr).toBe(0);
    expect(metrics.clicks).toBe(0);
  });
});

describe("trendAdjust", () => {
  it("leaves the raw delta untouched when the site held flat", () => {
    const adjustment = trendAdjust(baseline(), {
      impressions: 1200,
      clicks: 80,
      ctr: 0.0667,
      weightedPosition: 6.1,
      siteImpressions: 20000,
      siteClicks: 1000,
    });
    expect(adjustment.clicksDelta).toBe(30);
    expect(adjustment.siteClicksDeltaRatio).toBe(0);
    expect(adjustment.adjustedClicksDelta).toBe(30);
  });

  it("subtracts the site-wide drift from the page delta", () => {
    // Site up 20% → the page's 50 baseline clicks were expected to become
    // 60 on trend alone; only the remainder is the action's credit.
    const adjustment = trendAdjust(baseline(), {
      impressions: 1200,
      clicks: 80,
      ctr: 0.0667,
      weightedPosition: 6.1,
      siteImpressions: 24000,
      siteClicks: 1200,
    });
    expect(adjustment.siteClicksDeltaRatio).toBeCloseTo(0.2);
    expect(adjustment.adjustedClicksDelta).toBeCloseTo(30 - 50 * 0.2);
  });

  it("credits back a decline the whole site shared", () => {
    // Site down 30%, page down only 10%: the page beat the trend, and the
    // adjusted delta says so even though the raw delta is negative.
    const adjustment = trendAdjust(baseline(), {
      impressions: 900,
      clicks: 45,
      ctr: 0.05,
      weightedPosition: 8.0,
      siteImpressions: 14000,
      siteClicks: 700,
    });
    expect(adjustment.clicksDelta).toBe(-5);
    expect(adjustment.adjustedClicksDelta).toBeCloseTo(-5 - 50 * -0.3);
    expect(adjustment.adjustedClicksDelta).toBeGreaterThan(0);
  });

  it("stands on the raw delta when the site baseline had zero clicks", () => {
    const adjustment = trendAdjust(baseline({ siteClicks: 0 }), {
      impressions: 1200,
      clicks: 80,
      ctr: 0.0667,
      weightedPosition: 6.1,
      siteImpressions: 24000,
      siteClicks: 1200,
    });
    expect(adjustment.siteClicksDeltaRatio).toBeNull();
    expect(adjustment.adjustedClicksDelta).toBe(30);
  });
});

describe("isContaminated", () => {
  const receipt = {
    contentPageId: "page_1",
    createdAt: "2026-07-01T10:00:00.000Z",
    windowEnd: "2026-08-12",
  };

  it("flags a later execution on the same page inside the window", () => {
    expect(
      isContaminated(receipt, [
        { contentPageId: "page_1", executedAt: "2026-07-20T09:00:00.000Z" },
      ]),
    ).toBe(true);
  });

  it("ignores the receipt's own execution instant", () => {
    // The execution flow writes proposal.executedAt and receipt.createdAt in
    // one transaction with one timestamp — strict > keeps it out.
    expect(
      isContaminated(receipt, [
        { contentPageId: "page_1", executedAt: "2026-07-01T10:00:00.000Z" },
      ]),
    ).toBe(false);
  });

  it("ignores executions on other pages", () => {
    expect(
      isContaminated(receipt, [
        { contentPageId: "page_2", executedAt: "2026-07-20T09:00:00.000Z" },
      ]),
    ).toBe(false);
  });

  it("ignores an execution on or after the windowEnd day", () => {
    // The measured days stop the day before windowEnd — an action on the
    // windowEnd day can't have touched any of them.
    expect(
      isContaminated(receipt, [
        { contentPageId: "page_1", executedAt: "2026-08-12T00:00:01.000Z" },
      ]),
    ).toBe(false);
    expect(
      isContaminated(receipt, [
        { contentPageId: "page_1", executedAt: "2026-08-11T23:59:59.000Z" },
      ]),
    ).toBe(true);
  });

  it("never flags a receipt without a content page", () => {
    expect(
      isContaminated({ ...receipt, contentPageId: null }, [
        { contentPageId: "page_1", executedAt: "2026-07-20T09:00:00.000Z" },
      ]),
    ).toBe(false);
  });
});

describe("decideMeasurementStep", () => {
  const windows = { windowStart: "2026-07-15", windowEnd: "2026-08-12" };

  it("waits before the window opens", () => {
    expect(
      decideMeasurementStep({
        status: "baseline",
        ...windows,
        latestStoredDate: "2026-07-10",
        today: "2026-07-14",
      }),
    ).toBe("none");
  });

  it("flips baseline to measuring once windowStart passes", () => {
    expect(
      decideMeasurementStep({
        status: "baseline",
        ...windows,
        latestStoredDate: "2026-07-10",
        today: "2026-07-15",
      }),
    ).toBe("start_measuring");
  });

  it("does nothing for a measuring receipt mid-window", () => {
    expect(
      decideMeasurementStep({
        status: "measuring",
        ...windows,
        latestStoredDate: "2026-07-25",
        today: "2026-08-01",
      }),
    ).toBe("none");
  });

  it("holds measurement while stored memory lags the window", () => {
    // The data-lag guard: no partial measurement, ever.
    expect(
      decideMeasurementStep({
        status: "measuring",
        ...windows,
        latestStoredDate: "2026-08-09",
        today: "2026-08-14",
      }),
    ).toBe("wait_for_data");
    expect(
      decideMeasurementStep({
        status: "measuring",
        ...windows,
        latestStoredDate: null,
        today: "2026-08-14",
      }),
    ).toBe("wait_for_data");
  });

  it("measures once the watermark reaches windowEnd", () => {
    expect(
      decideMeasurementStep({
        status: "measuring",
        ...windows,
        latestStoredDate: "2026-08-12",
        today: "2026-08-16",
      }),
    ).toBe("measure");
  });

  it("measures a baseline receipt directly when its window already closed", () => {
    // Catch-up semantics: if the cron was down through the whole measuring
    // span, the flip is moot — measure in one step.
    expect(
      decideMeasurementStep({
        status: "baseline",
        ...windows,
        latestStoredDate: "2026-08-13",
        today: "2026-08-18",
      }),
    ).toBe("measure");
  });
});
