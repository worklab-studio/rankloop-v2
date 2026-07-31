import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  max,
  or,
  sql,
} from "drizzle-orm";
import { db } from "@/db";
import {
  contentPages,
  gscPages,
  gscPerformance,
  projects,
  proposals,
  receipts,
} from "@/db/schema";
import type { RankloopReceipt } from "@/types/schemas/rankloopReceipts";

// ---------------------------------------------------------------------------
// Window reads (baseline + measurement share these)
// ---------------------------------------------------------------------------

/** The receipt's page, resolved to the URL its GSC rows are keyed by. */
async function getContentPageById(projectId: string, contentPageId: string) {
  const rows = await db
    .select({
      id: contentPages.id,
      url: contentPages.url,
      path: contentPages.path,
    })
    .from(contentPages)
    .where(
      and(
        eq(contentPages.id, contentPageId),
        eq(contentPages.projectId, projectId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Day-grain rows for one page over an inclusive day span. Per (query, day),
 * not summed in SQL — the impressions-weighted position rollup is pure logic
 * under test in receipts.logic.ts. The page's own sub-cap long tail is folded
 * into sentinel-page rows by the sync and so is absent here; both windows of
 * a receipt share that treatment, which keeps their deltas comparable.
 */
async function getPageWindowRows(
  projectId: string,
  pageUrl: string,
  firstDay: string,
  lastDay: string,
) {
  return db
    .select({
      clicks: gscPerformance.clicks,
      impressions: gscPerformance.impressions,
      position: gscPerformance.position,
    })
    .from(gscPerformance)
    .innerJoin(gscPages, eq(gscPerformance.pageId, gscPages.id))
    .where(
      and(
        eq(gscPerformance.projectId, projectId),
        eq(gscPerformance.grain, "day"),
        eq(gscPages.url, pageUrl),
        gte(gscPerformance.date, firstDay),
        lte(gscPerformance.date, lastDay),
      ),
    );
}

/** Site-wide totals over an inclusive day span — the diff-in-diff control.
 *  Sentinel remainder rows are real site traffic and belong in these sums,
 *  so there is deliberately no sentinel exclusion here. */
async function getSiteWindowTotals(
  projectId: string,
  firstDay: string,
  lastDay: string,
): Promise<{ clicks: number; impressions: number }> {
  const rows = await db
    .select({
      clicks: sql<number>`coalesce(sum(${gscPerformance.clicks}), 0)`,
      impressions: sql<number>`coalesce(sum(${gscPerformance.impressions}), 0)`,
    })
    .from(gscPerformance)
    .where(
      and(
        eq(gscPerformance.projectId, projectId),
        eq(gscPerformance.grain, "day"),
        gte(gscPerformance.date, firstDay),
        lte(gscPerformance.date, lastDay),
      ),
    );
  return rows[0] ?? { clicks: 0, impressions: 0 };
}

// ---------------------------------------------------------------------------
// Measurement pass
// ---------------------------------------------------------------------------

/** Per-project memory watermark — the newest stored day-grain date. Shared by
 *  the due-check and the lagged count, which must agree on what "the sync has
 *  reached windowEnd" means. */
function latestStoredDates() {
  return db
    .select({
      projectId: gscPerformance.projectId,
      latestDate: max(gscPerformance.date).as("latest_date"),
    })
    .from(gscPerformance)
    .where(eq(gscPerformance.grain, "day"))
    .groupBy(gscPerformance.projectId)
    .as("gsc_latest_dates");
}

/**
 * The cheap due-check, across all projects in one indexed read. A receipt is
 * due when it could transition right now: 'baseline' from windowStart (the
 * measuring flip), and either open status once windowEnd arrives AND the
 * project's memory has reached windowEnd (the measurement itself). Measuring
 * rows between the two dates match neither arm, so for the ~4 weeks a receipt
 * sits mid-window it costs this query nothing. Null-window rows never satisfy
 * the comparisons and fall out.
 *
 * The pass is global, oldest-first and capped, so a row that cannot transition
 * must not occupy a slot: it would hold it on every one of the day's 96 ticks
 * and, at 50 such rows, stop every project on the instance from ever measuring
 * again. Three guards keep the cap honest — the watermark join (a project whose
 * sync has stalled can never satisfy the data-lag rule), the archived-project
 * join (archiveProject is a soft delete and the GSC due-query deliberately
 * skips archived projects, so their watermark freezes permanently), and the
 * nextCheckAt cursor the pass stamps on anything it looked at but could not
 * advance. The baseline arm stays unconditional: the flip to 'measuring' needs
 * no stored data, only the calendar.
 */
async function getDueReceipts(
  today: string,
  limit: number,
): Promise<RankloopReceipt[]> {
  const latestDates = latestStoredDates();
  const rows = await db
    .select({ receipt: receipts })
    .from(receipts)
    .innerJoin(projects, eq(receipts.projectId, projects.id))
    .leftJoin(latestDates, eq(latestDates.projectId, receipts.projectId))
    .where(
      and(
        isNull(projects.archivedAt),
        or(isNull(receipts.nextCheckAt), lte(receipts.nextCheckAt, today)),
        or(
          and(
            eq(receipts.status, "baseline"),
            lte(receipts.windowStart, today),
          ),
          and(
            inArray(receipts.status, ["baseline", "measuring"]),
            lte(receipts.windowEnd, today),
            gte(latestDates.latestDate, receipts.windowEnd),
          ),
        ),
      ),
    )
    .orderBy(asc(receipts.createdAt))
    .limit(limit);
  return rows.map((row) => row.receipt);
}

/** How many open receipts are past their window but waiting on the sync. The
 *  due-check no longer returns them (they cannot transition), so this count is
 *  what keeps "N waiting on data" in the cron line — one indexed aggregate,
 *  not 50 rows that would each be looked at and dropped. */
async function countReceiptsWaitingOnData(today: string): Promise<number> {
  const latestDates = latestStoredDates();
  const rows = await db
    .select({ waiting: count() })
    .from(receipts)
    .innerJoin(projects, eq(receipts.projectId, projects.id))
    .leftJoin(latestDates, eq(latestDates.projectId, receipts.projectId))
    .where(
      and(
        isNull(projects.archivedAt),
        inArray(receipts.status, ["baseline", "measuring"]),
        lte(receipts.windowEnd, today),
        or(
          isNull(latestDates.latestDate),
          lt(latestDates.latestDate, receipts.windowEnd),
        ),
      ),
    );
  return rows[0]?.waiting ?? 0;
}

/** Park a receipt the pass could not advance until `nextCheckAt`. Not a CAS:
 *  the cursor is a scheduling hint, and the worst a lost race costs is one
 *  extra look tomorrow. */
async function deferReceipt(
  receiptId: string,
  nextCheckAt: string,
): Promise<void> {
  await db
    .update(receipts)
    .set({ nextCheckAt })
    .where(eq(receipts.id, receiptId));
}

/** Compare-and-set flip to 'measuring' — only a baseline row transitions, so
 *  two overlapping cron ticks can't both count the flip. */
async function markMeasuring(receiptId: string): Promise<boolean> {
  const rows = await db
    .update(receipts)
    .set({ status: "measuring" })
    .where(and(eq(receipts.id, receiptId), eq(receipts.status, "baseline")))
    .returning({ id: receipts.id });
  return rows.length > 0;
}

/** Compare-and-set close: only an open (baseline/measuring) row measures,
 *  and a measured/contaminated receipt is immutable history after this. */
async function finalizeReceipt(input: {
  receiptId: string;
  status: "measured" | "contaminated";
  resultJson: string;
  measuredAt: string;
}): Promise<boolean> {
  const rows = await db
    .update(receipts)
    .set({
      status: input.status,
      resultJson: input.resultJson,
      measuredAt: input.measuredAt,
    })
    .where(
      and(
        eq(receipts.id, input.receiptId),
        inArray(receipts.status, ["baseline", "measuring"]),
      ),
    )
    .returning({ id: receipts.id });
  return rows.length > 0;
}

/** Executions on one page after `afterIso` — contamination's evidence. Reads
 *  proposals.executedAt, which the execution flow stamps in the same
 *  transaction that opens the receipt. */
async function getExecutedProposalsOnPageAfter(
  projectId: string,
  contentPageId: string,
  afterIso: string,
): Promise<Array<{ contentPageId: string | null; executedAt: string }>> {
  const rows = await db
    .select({
      contentPageId: proposals.contentPageId,
      executedAt: proposals.executedAt,
    })
    .from(proposals)
    .where(
      and(
        eq(proposals.projectId, projectId),
        eq(proposals.contentPageId, contentPageId),
        isNotNull(proposals.executedAt),
        gt(proposals.executedAt, afterIso),
      ),
    );
  return rows.flatMap((row) =>
    row.executedAt === null
      ? []
      : [{ contentPageId: row.contentPageId, executedAt: row.executedAt }],
  );
}

// ---------------------------------------------------------------------------
// List read
// ---------------------------------------------------------------------------

/** Newest execution first — the Receipts screen's one ordering. The left
 *  join resolves contentPageId (a plain id, no FK) to the page's current
 *  path for display; a pruned page simply yields a null path. */
async function getReceiptsForProject(
  projectId: string,
): Promise<Array<{ receipt: RankloopReceipt; pagePath: string | null }>> {
  return db
    .select({ receipt: receipts, pagePath: contentPages.path })
    .from(receipts)
    .leftJoin(
      contentPages,
      and(
        eq(contentPages.id, receipts.contentPageId),
        eq(contentPages.projectId, receipts.projectId),
      ),
    )
    .where(eq(receipts.projectId, projectId))
    .orderBy(desc(receipts.createdAt));
}

export const ReceiptsRepository = {
  getContentPageById,
  getPageWindowRows,
  getSiteWindowTotals,
  getDueReceipts,
  countReceiptsWaitingOnData,
  deferReceipt,
  markMeasuring,
  finalizeReceipt,
  getExecutedProposalsOnPageAfter,
  getReceiptsForProject,
};
