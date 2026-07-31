import { env } from "cloudflare:workers";
import type {
  GscSearchAnalyticsRequest,
  GscSearchAnalyticsRow,
} from "@/server/lib/gscClient";
import { GscConnectionRepository } from "@/server/features/gsc/repositories/GscConnectionRepository";
import { GscSyncRepository } from "@/server/features/rankloop/gsc-sync/repositories/GscSyncRepository";
import type { GscPerformanceUpsert } from "@/server/features/rankloop/gsc-sync/repositories/GscSyncRepository";
import { getStaleRunReason } from "@/server/features/rankloop/staleRunProbe";
import { AppError } from "@/server/lib/errors";
import type { RankloopGscMemory } from "@/types/schemas/rankloopGsc";

// Sentinel page/query the below-cap remainder is attributed to. Interned per
// project like any real page/query — pageId/queryId stay NOT NULL, and the
// 5-column unique makes re-pulled remainder rows overwrite instead of pile up
// (a NULL in a unique key never conflicts).
export const GSC_SYNC_SENTINEL = "__rankloop:other__";

// Top-N cap per day. 2500 page×query rows keeps a 90-day backfill around
// 225k fact rows per project; everything below the cap is still counted, as
// one aggregated sentinel row per day.
const TOP_ROWS_PER_DAY = 2500;

// GSC caps grouped searchAnalytics.query responses at 1000 rows per call;
// deeper results come from paginating with startRow (the GSC_MAX_ROW_LIMIT
// idiom in searchAnalytics.ts).
const GSC_PAGE_SIZE = 1000;

// Fetch at most 10 pages (10k rows) per day. Beyond that the sentinel
// undercounts the long tail slightly, but a 90-day backfill must stay well
// inside the per-invocation subrequest budget (~1000 on paid Workers).
const MAX_GSC_PAGES_PER_DAY = 10;

// GSC's reporting calendar is Pacific Time, and data for the trailing ~3 days
// is incomplete. Ranges end 4 PT-days ago so every synced day is final-ish;
// daily runs still re-pull from (watermark − 2) to catch late finalization.
export const GSC_FINAL_LAG_DAYS = 4;
const BACKFILL_START_DAYS_AGO = 93;
const DAILY_REPULL_DAYS = 2;
// Catch-up cap: a daily run pulls at most 14 dates. A long-dormant project
// catches up across successive runs via the advancing watermark instead of
// one giant run — eager watermark, no retry storms.
const MAX_DATES_PER_DAILY_RUN = 14;

/** Structural subset of the gscClient so tests can hand in a plain object. */
type GscSyncClient = {
  querySearchAnalytics(
    siteUrl: string,
    body: GscSearchAnalyticsRequest,
  ): Promise<GscSearchAnalyticsRow[]>;
};

type GscDayRow = {
  page: string;
  query: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
};

// ---------------------------------------------------------------------------
// PT date math (pure, exported for tests and the scheduled dispatcher)
// ---------------------------------------------------------------------------

/** Today's date in GSC's calendar (America/Los_Angeles), as YYYY-MM-DD.
 *  en-CA is the locale whose short date format IS YYYY-MM-DD. */
export function todayInPacific(now: Date = new Date()): string {
  return now.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
}

/** Calendar-day arithmetic on YYYY-MM-DD strings, no timezone involved. */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * The inclusive PT date range a run should pull. Backfill covers 93 → 4 days
 * ago (90 dates). Daily resumes from (watermark − 2) — GSC finalizes late, so
 * consecutive ranges overlap by design and the fact upsert absorbs it — and
 * is capped at 14 dates so a long gap catches up over several runs.
 */
export function computeSyncRange(input: {
  mode: "backfill" | "daily";
  lastStoredDate: string | null;
  todayPt: string;
}): { rangeStart: string; rangeEnd: string } {
  const rangeEnd = addDays(input.todayPt, -GSC_FINAL_LAG_DAYS);
  if (input.mode === "backfill" || input.lastStoredDate === null) {
    return {
      rangeStart: addDays(input.todayPt, -BACKFILL_START_DAYS_AGO),
      rangeEnd,
    };
  }
  let rangeStart = addDays(input.lastStoredDate, -DAILY_REPULL_DAYS);
  // The watermark can't pass rangeEnd in normal operation (both derive from
  // PT days), but a clock oddity must not produce an inverted range.
  if (rangeStart > rangeEnd) rangeStart = rangeEnd;
  const cappedEnd = addDays(rangeStart, MAX_DATES_PER_DAILY_RUN - 1);
  return { rangeStart, rangeEnd: rangeEnd < cappedEnd ? rangeEnd : cappedEnd };
}

/** Every date in [rangeStart, rangeEnd], inclusive. */
export function enumerateDates(rangeStart: string, rangeEnd: string): string[] {
  const dates: string[] = [];
  for (let d = rangeStart; d <= rangeEnd; d = addDays(d, 1)) {
    dates.push(d);
  }
  return dates;
}

// ---------------------------------------------------------------------------
// Per-day fetch, cap, and write
// ---------------------------------------------------------------------------

/** Page through one day of [page, query] rows. Stops on a short page or at
 *  the fetch ceiling — GSC reads are free, but subrequests are not unlimited. */
export async function fetchDayRows(
  client: GscSyncClient,
  siteUrl: string,
  date: string,
): Promise<GscDayRow[]> {
  const rows: GscDayRow[] = [];
  for (let page = 0; page < MAX_GSC_PAGES_PER_DAY; page++) {
    const batch = await client.querySearchAnalytics(siteUrl, {
      startDate: date,
      endDate: date,
      dimensions: ["page", "query"],
      rowLimit: GSC_PAGE_SIZE,
      ...(page > 0 ? { startRow: page * GSC_PAGE_SIZE } : {}),
      type: "web",
    });
    for (const row of batch) {
      const [pageUrl, query] = row.keys ?? [];
      if (!pageUrl || query === undefined) continue;
      rows.push({
        page: pageUrl,
        query,
        clicks: row.clicks,
        impressions: row.impressions,
        ctr: row.ctr,
        position: row.position,
      });
    }
    if (batch.length < GSC_PAGE_SIZE) break;
  }
  return rows;
}

/**
 * Keep the top 2500 rows by impressions; sum everything below the cap into
 * one remainder. The remainder keeps day totals honest — clicks and
 * impressions add up even though the long tail loses page/query identity.
 */
export function capDayRows(rows: GscDayRow[]): {
  top: GscDayRow[];
  remainder: Omit<GscDayRow, "page" | "query"> | null;
} {
  if (rows.length <= TOP_ROWS_PER_DAY) {
    return { top: rows, remainder: null };
  }
  const sorted = rows.toSorted((a, b) => b.impressions - a.impressions);
  const top = sorted.slice(0, TOP_ROWS_PER_DAY);
  let clicks = 0;
  let impressions = 0;
  let weightedPosition = 0;
  for (const row of sorted.slice(TOP_ROWS_PER_DAY)) {
    clicks += row.clicks;
    impressions += row.impressions;
    weightedPosition += row.position * row.impressions;
  }
  return {
    top,
    remainder: {
      clicks,
      impressions,
      ctr: impressions > 0 ? clicks / impressions : 0,
      // Impression-weighted: an unweighted mean would let one-impression
      // position-90 rows drag the sentinel's position off a cliff.
      position: impressions > 0 ? weightedPosition / impressions : 0,
    },
  };
}

/** Sync one PT date: fetch, cap, intern, upsert, sweep. Returns rows written.
 *  Idempotent — every write is an upsert on the 5-column unique and the sweep
 *  is scoped to a mark derived from (runId, date) — so the workflow step
 *  wrapping this is safe to retry. */
async function syncDay(input: {
  projectId: string;
  runId: string;
  siteUrl: string;
  date: string;
  client: GscSyncClient;
}): Promise<number> {
  const rows = await fetchDayRows(input.client, input.siteUrl, input.date);
  if (rows.length === 0) return 0;

  // The marker every row of this pull carries. Derived from the run rather
  // than the wall clock so a retried step re-writes the same mark instead of
  // orphaning the rows its first attempt already landed.
  const syncMark = `${input.runId}:${input.date}`;

  const { top, remainder } = capDayRows(rows);
  const pageUrls = top.map((row) => row.page);
  const queryTexts = top.map((row) => row.query);
  if (remainder) {
    pageUrls.push(GSC_SYNC_SENTINEL);
    queryTexts.push(GSC_SYNC_SENTINEL);
  }
  const [pageIds, queryIds] = await Promise.all([
    GscSyncRepository.internPages(input.projectId, pageUrls),
    GscSyncRepository.internQueries(input.projectId, queryTexts),
  ]);

  const upserts: GscPerformanceUpsert[] = [];
  for (const row of top) {
    const pageId = pageIds.get(row.page);
    const queryId = queryIds.get(row.query);
    if (!pageId || !queryId) continue;
    upserts.push({
      projectId: input.projectId,
      pageId,
      queryId,
      date: input.date,
      clicks: row.clicks,
      impressions: row.impressions,
      ctr: row.ctr,
      position: row.position,
      syncMark,
    });
  }
  if (remainder) {
    const pageId = pageIds.get(GSC_SYNC_SENTINEL);
    const queryId = queryIds.get(GSC_SYNC_SENTINEL);
    if (pageId && queryId) {
      upserts.push({
        projectId: input.projectId,
        pageId,
        queryId,
        date: input.date,
        ...remainder,
        syncMark,
      });
    }
  }
  await GscSyncRepository.upsertPerformanceRows(upserts);
  // Retire what this pull didn't write. Only once the writes have landed, and
  // only when some did: an empty upsert set means interning returned no ids,
  // not that the day is empty, and sweeping on that would delete the day.
  if (upserts.length > 0) {
    await GscSyncRepository.deleteStalePerformanceRows({
      projectId: input.projectId,
      date: input.date,
      keepMark: syncMark,
    });
  }
  return upserts.length;
}

// ---------------------------------------------------------------------------
// Run lifecycle
// ---------------------------------------------------------------------------

type GscSyncStartResult = {
  runId: string;
  mode: "backfill" | "daily";
  alreadyRunning: boolean;
};

/**
 * Start a sync run for a project, or return the run that's already active.
 * Coordination mirrors rank checks: workflow instance id === run row id, and
 * the partial unique on gsc_sync_runs(project_id) WHERE status IN
 * ('pending','running') is the only lock — a blocked INSERT means a sync is
 * underway, which callers treat as success, not an error. A blocker whose
 * workflow instance is missing or terminally failed (past the startup grace)
 * is a zombie: it flips to error and the retry claims the freed slot.
 */
async function startSync(projectId: string): Promise<GscSyncStartResult> {
  const connection = await GscConnectionRepository.getByProjectId(projectId);
  if (!connection) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Connect Search Console before syncing rankloop memory.",
    );
  }

  // At most two attempts: the retry fires when the blocking run finished
  // between our INSERT and the follow-up SELECT, or after a stale blocker
  // was flipped to error below.
  for (let attempt = 0; attempt < 2; attempt++) {
    const lastStoredDate =
      await GscSyncRepository.getLatestStoredDate(projectId);
    const mode = lastStoredDate === null ? "backfill" : "daily";
    const range = computeSyncRange({
      mode,
      lastStoredDate,
      todayPt: todayInPacific(),
    });
    const runId = crypto.randomUUID();
    const inserted = await GscSyncRepository.tryCreateRun({
      id: runId,
      projectId,
      mode,
      rangeStart: range.rangeStart,
      rangeEnd: range.rangeEnd,
    });

    if (!inserted) {
      const active = await GscSyncRepository.getActiveRunForProject(projectId);
      if (!active) continue;
      if (attempt === 0) {
        // A workflow that died before its mark-error step (deploy reset,
        // crashed mid-run) leaves this row active forever and the
        // partial-index slot wedged. Probe the instance; a zombie flips to
        // error and the retry inserts into the freed slot.
        const staleReason = await getStaleRunReason({
          workflow: env.GSC_SYNC_WORKFLOW,
          runId: active.id,
          ageMs: Date.now() - new Date(active.startedAt).getTime(),
        });
        if (staleReason) {
          await GscSyncRepository.updateRun(active.id, {
            status: "error",
            error: staleReason,
            finishedAt: new Date().toISOString(),
          });
          continue;
        }
      }
      return { runId: active.id, mode: active.mode, alreadyRunning: true };
    }

    try {
      await env.GSC_SYNC_WORKFLOW.create({
        id: runId,
        params: { runId, projectId, mode },
      });
    } catch (error) {
      // Workflow couldn't start — flip the run to error so the partial-index
      // slot is released. Best-effort cleanup of any zombie instance.
      await GscSyncRepository.updateRun(runId, {
        status: "error",
        error: "Failed to start sync workflow",
        finishedAt: new Date().toISOString(),
      });
      try {
        const instance = await env.GSC_SYNC_WORKFLOW.get(runId);
        await instance.terminate();
      } catch {
        // Workflow may not have been created.
      }
      throw error;
    }
    return { runId, mode, alreadyRunning: false };
  }

  throw new AppError(
    "CONFLICT",
    "Could not start the Search Console sync. Try again.",
  );
}

/** The provenance stamp + polling payload: last run, watermark, and how much
 *  memory is stored. */
async function getMemory(projectId: string): Promise<RankloopGscMemory> {
  const [lastRun, stats] = await Promise.all([
    GscSyncRepository.getLatestRunForProject(projectId),
    GscSyncRepository.getMemoryStats(projectId),
  ]);
  return {
    lastRun,
    latestDate: stats.latestDate,
    dayCount: stats.dayCount,
    rowCount: stats.rowCount,
  };
}

export const GscSyncService = {
  startSync,
  getMemory,
  syncDay,
};
