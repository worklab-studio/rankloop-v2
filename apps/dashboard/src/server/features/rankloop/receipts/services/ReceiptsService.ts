import type { InferInsertModel } from "drizzle-orm";
import type { z } from "zod";
import type { receipts } from "@/db/schema";
import { GscSyncRepository } from "@/server/features/rankloop/gsc-sync/repositories/GscSyncRepository";
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
} from "@/server/features/rankloop/receipts/receipts.logic";
import { ReceiptsRepository } from "@/server/features/rankloop/receipts/repositories/ReceiptsRepository";
import { AppError } from "@/server/lib/errors";
import {
  receiptBaselineSchema,
  receiptResultSchema,
} from "@/types/schemas/rankloopReceipts";
import type {
  RankloopReceipt,
  RankloopReceiptListItem,
  ReceiptBaseline,
  ReceiptResult,
} from "@/types/schemas/rankloopReceipts";
import type { RankloopProposal } from "@/types/schemas/rankloopProposals";

/** Per-tick cap. A measurement is ~4 aggregate reads and one write; 50 keeps
 *  the worst catch-up tick bounded while clearing any realistic backlog in
 *  one 15-minute cycle. */
const MAX_DUE_RECEIPTS_PER_PASS = 50;

// ---------------------------------------------------------------------------
// Opening a receipt (called by the execution flows)
// ---------------------------------------------------------------------------

type OpenReceiptInput = {
  projectId: string;
  /** The executed proposal's type — 'retitle' | 'push' today. */
  actionType: RankloopProposal["type"];
  contentPageId: string;
  /** The headline query the action targeted, if it had one. */
  targetQuery: string | null;
  /** The ISO instant of execution. Pass the same value written to
   *  proposals.executedAt — it becomes the receipt's createdAt, and the
   *  contamination check relies on the two being identical to tell the
   *  receipt's own execution apart from a later one. */
  executedAt: string;
};

/**
 * Assemble an insert-ready receipt row with a real baseline: the prior-28d
 * page metrics plus site totals, pinned as of the memory watermark. This
 * deliberately returns values instead of inserting — the execution flow must
 * flip the proposal, touch content_pages, and insert this row in ONE
 * transaction (runBatch), and an insert here would sit outside it. The reads
 * are safe outside the transaction: stored GSC memory only changes when a
 * sync runs, not when a proposal executes.
 */
async function openReceipt(
  input: OpenReceiptInput,
): Promise<InferInsertModel<typeof receipts>> {
  const page = await ReceiptsRepository.getContentPageById(
    input.projectId,
    input.contentPageId,
  );
  if (!page) {
    throw new AppError("NOT_FOUND", "Content page not found.");
  }
  const latestStoredDate = await GscSyncRepository.getLatestStoredDate(
    input.projectId,
  );
  const window = resolveBaselineWindow(input.executedAt, latestStoredDate);
  const [pageRows, siteTotals] = await Promise.all([
    ReceiptsRepository.getPageWindowRows(
      input.projectId,
      page.url,
      window.start,
      window.end,
    ),
    ReceiptsRepository.getSiteWindowTotals(
      input.projectId,
      window.start,
      window.end,
    ),
  ]);
  const metrics = assembleWindowMetrics(pageRows, siteTotals);
  const { windowStart, windowEnd } = evaluationWindow(input.executedAt);
  const baseline: ReceiptBaseline = { ...metrics, window };
  return {
    id: crypto.randomUUID(),
    projectId: input.projectId,
    actionType: input.actionType,
    contentPageId: input.contentPageId,
    targetQuery: input.targetQuery,
    status: "baseline",
    baselineJson: JSON.stringify(baseline),
    windowStart,
    windowEnd,
    createdAt: input.executedAt,
  };
}

// ---------------------------------------------------------------------------
// The measurement pass
// ---------------------------------------------------------------------------

type MeasurementPassResult = {
  flipped: number;
  measured: number;
  contaminated: number;
  lagged: number;
  skipped: number;
};

/** Close one receipt: evaluation-window metrics, trend adjustment against
 *  the pinned baseline, contamination verdict, one CAS write. */
async function measureReceipt(
  receipt: RankloopReceipt,
  windowStart: string,
  windowEnd: string,
  measuredAtIso: string,
): Promise<"measured" | "contaminated" | "skipped"> {
  // A receipt whose page row was pruned from the manifest has no URL to read
  // GSC rows by. Leave it open rather than close it with invented zeros — if
  // the page comes back (recrawl), a later pass measures it for real.
  const page = receipt.contentPageId
    ? await ReceiptsRepository.getContentPageById(
        receipt.projectId,
        receipt.contentPageId,
      )
    : null;
  if (!page) {
    console.info(
      `[rankloop-receipts] receipt ${receipt.id} has no resolvable content page — skipping measurement`,
    );
    return "skipped";
  }

  const window = measuredWindow(windowStart, windowEnd);
  const [pageRows, siteTotals, laterExecutions] = await Promise.all([
    ReceiptsRepository.getPageWindowRows(
      receipt.projectId,
      page.url,
      window.start,
      window.end,
    ),
    ReceiptsRepository.getSiteWindowTotals(
      receipt.projectId,
      window.start,
      window.end,
    ),
    ReceiptsRepository.getExecutedProposalsOnPageAfter(
      receipt.projectId,
      page.id,
      receipt.createdAt,
    ),
  ]);
  const metrics = assembleWindowMetrics(pageRows, siteTotals);
  const baseline = parseJsonColumn(receiptBaselineSchema, receipt.baselineJson);
  // A baseline that fails to parse can't anchor a delta, but the window's raw
  // metrics still land — null deltas, not a vanished receipt.
  const adjustment = baseline
    ? trendAdjust(baseline, metrics)
    : {
        clicksDelta: null,
        siteClicksDeltaRatio: null,
        adjustedClicksDelta: null,
      };
  const contaminated = isContaminated(
    { contentPageId: page.id, createdAt: receipt.createdAt, windowEnd },
    laterExecutions,
  );
  const result: ReceiptResult = { ...metrics, window, ...adjustment };
  await ReceiptsRepository.finalizeReceipt({
    receiptId: receipt.id,
    status: contaminated ? "contaminated" : "measured",
    resultJson: JSON.stringify(result),
    measuredAt: measuredAtIso,
  });
  return contaminated ? "contaminated" : "measured";
}

/**
 * Advance every due receipt one step: baseline → measuring once windowStart
 * passes, and baseline/measuring → measured/contaminated once windowEnd
 * passes AND stored memory reaches it (the data-lag guard — a partial window
 * frozen into resultJson would understate every result forever). The clock is
 * injected so tests can time-travel; the due-check plus the lagged count are
 * two indexed reads that return nothing and zero on almost every tick.
 *
 * Anything the pass looks at but cannot advance is parked until tomorrow. The
 * pass is capped at 50 rows across all projects, so a receipt that returns
 * unchanged tick after tick is not merely wasted work — enough of them and no
 * project on the instance ever measures a receipt again.
 */
async function runMeasurementPass(
  now: () => Date = () => new Date(),
): Promise<MeasurementPassResult> {
  const result: MeasurementPassResult = {
    flipped: 0,
    measured: 0,
    contaminated: 0,
    lagged: 0,
    skipped: 0,
  };
  const today = isoDay(now().toISOString());
  const due = await ReceiptsRepository.getDueReceipts(
    today,
    MAX_DUE_RECEIPTS_PER_PASS,
  );
  // Receipts stuck behind a lagging (or frozen) sync are no longer returned
  // above, so the number is read rather than tallied from the rows — the
  // observability survives, the slot-hogging does not.
  result.lagged = await ReceiptsRepository.countReceiptsWaitingOnData(today);
  if (due.length === 0) return result;
  const tomorrow = shiftDate(today, 1);

  // One watermark read per project, however many of its receipts are due.
  const watermarks = new Map<string, string | null>();
  for (const receipt of due) {
    if (receipt.status !== "baseline" && receipt.status !== "measuring") {
      continue;
    }
    if (receipt.windowStart === null || receipt.windowEnd === null) continue;
    let latestStoredDate = watermarks.get(receipt.projectId);
    if (latestStoredDate === undefined) {
      latestStoredDate = await GscSyncRepository.getLatestStoredDate(
        receipt.projectId,
      );
      watermarks.set(receipt.projectId, latestStoredDate);
    }
    const step = decideMeasurementStep({
      status: receipt.status,
      windowStart: receipt.windowStart,
      windowEnd: receipt.windowEnd,
      latestStoredDate,
      today,
    });
    if (step === "start_measuring") {
      if (await ReceiptsRepository.markMeasuring(receipt.id)) result.flipped++;
    } else if (step === "wait_for_data") {
      // Only a 'baseline' row still reaches this branch (the due-check filters
      // the rest out on the watermark); park it so a project whose sync has
      // stalled cannot re-enter the pass 96 times today.
      await ReceiptsRepository.deferReceipt(receipt.id, tomorrow);
    } else if (step === "measure") {
      const outcome = await measureReceipt(
        receipt,
        receipt.windowStart,
        receipt.windowEnd,
        now().toISOString(),
      );
      // A pruned page stays open by design — but re-resolving it every tick
      // until a recrawl restores it is exactly the row that starves the cap.
      if (outcome === "skipped") {
        await ReceiptsRepository.deferReceipt(receipt.id, tomorrow);
      }
      result[outcome]++;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// List read
// ---------------------------------------------------------------------------

function parseJsonColumn<T>(
  schema: z.ZodType<T>,
  raw: string | null,
): T | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    const validated = schema.safeParse(parsed);
    return validated.success ? validated.data : null;
  } catch {
    return null;
  }
}

/** Receipt rows with baseline/result parsed into typed objects. Malformed
 *  JSON degrades to null instead of failing the list — one bad row must not
 *  blank the Receipts screen. */
async function getReceipts(
  projectId: string,
): Promise<RankloopReceiptListItem[]> {
  const rows = await ReceiptsRepository.getReceiptsForProject(projectId);
  return rows.map(({ receipt, pagePath }) => ({
    ...receipt,
    // The page's live path when the manifest still has it; the pinned query
    // when it doesn't — a receipt outlives the page it measured.
    target: pagePath ?? receipt.targetQuery ?? "",
    baseline: parseJsonColumn(receiptBaselineSchema, receipt.baselineJson),
    result: parseJsonColumn(receiptResultSchema, receipt.resultJson),
  }));
}

export const ReceiptsService = {
  openReceipt,
  runMeasurementPass,
  getReceipts,
};
