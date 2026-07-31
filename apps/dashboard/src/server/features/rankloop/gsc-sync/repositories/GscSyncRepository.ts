import {
  and,
  count,
  countDistinct,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  max,
  ne,
  notInArray,
  or,
} from "drizzle-orm";
import type { InferInsertModel } from "drizzle-orm";
import { db } from "@/db";
import { executeInBatches } from "@/db/runBatch";
import { isYoungActiveRun } from "@/server/features/rankloop/activeRunWedge";
import {
  gscConnections,
  gscPages,
  gscPerformance,
  gscQueries,
  gscSyncRuns,
  projects,
} from "@/db/schema";

// D1 caps bound parameters at ~100 per statement. The interning SELECTs spend
// one on projectId, so the IN() list is chunked at 99.
const INTERN_SELECT_CHUNK = 99;

export type GscPerformanceUpsert = {
  projectId: string;
  pageId: string;
  queryId: string;
  date: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  /** One stable value per (sync run, date) — the scope the stale sweep below
   *  deletes on. */
  syncMark: string;
};

// ---------------------------------------------------------------------------
// Sync run CRUD
// ---------------------------------------------------------------------------

/**
 * Try to insert a new pending sync run. Returns true if inserted, false if
 * blocked by the partial unique index on (project_id) WHERE status IN
 * ('pending', 'running') — i.e. another sync is already active for this
 * project. The failed INSERT is the already-running signal.
 */
async function tryCreateRun(data: {
  id: string;
  projectId: string;
  mode: "backfill" | "daily";
  rangeStart: string;
  rangeEnd: string;
}): Promise<boolean> {
  const inserted = await db
    .insert(gscSyncRuns)
    .values({ ...data, status: "pending" })
    .onConflictDoNothing()
    .returning({ id: gscSyncRuns.id });
  return inserted.length > 0;
}

async function updateRun(
  runId: string,
  data: Partial<InferInsertModel<typeof gscSyncRuns>>,
) {
  await db.update(gscSyncRuns).set(data).where(eq(gscSyncRuns.id, runId));
}

async function getRunById(runId: string) {
  const rows = await db
    .select()
    .from(gscSyncRuns)
    .where(eq(gscSyncRuns.id, runId))
    .limit(1);
  return rows[0] ?? null;
}

async function getActiveRunForProject(projectId: string) {
  const rows = await db
    .select()
    .from(gscSyncRuns)
    .where(
      and(
        eq(gscSyncRuns.projectId, projectId),
        inArray(gscSyncRuns.status, ["pending", "running"]),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

async function getLatestRunForProject(projectId: string) {
  const rows = await db
    .select()
    .from(gscSyncRuns)
    .where(eq(gscSyncRuns.projectId, projectId))
    .orderBy(desc(gscSyncRuns.startedAt))
    .limit(1);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Memory reads
// ---------------------------------------------------------------------------

/** The daily watermark: the most recent stored day-grain date, or null before
 *  the first backfill. Daily syncs resume from (watermark − 2). */
async function getLatestStoredDate(projectId: string): Promise<string | null> {
  const rows = await db
    .select({ latestDate: max(gscPerformance.date) })
    .from(gscPerformance)
    .where(
      and(
        eq(gscPerformance.projectId, projectId),
        eq(gscPerformance.grain, "day"),
      ),
    );
  return rows[0]?.latestDate ?? null;
}

async function getMemoryStats(projectId: string): Promise<{
  latestDate: string | null;
  dayCount: number;
  rowCount: number;
}> {
  const rows = await db
    .select({
      latestDate: max(gscPerformance.date),
      dayCount: countDistinct(gscPerformance.date),
      rowCount: count(),
    })
    .from(gscPerformance)
    .where(
      and(
        eq(gscPerformance.projectId, projectId),
        eq(gscPerformance.grain, "day"),
      ),
    );
  const row = rows[0];
  return {
    latestDate: row?.latestDate ?? null,
    dayCount: row?.dayCount ?? 0,
    rowCount: row?.rowCount ?? 0,
  };
}

/**
 * Projects due for a scheduled sync: an unarchived project with a GSC
 * connection whose stored memory (if any) has fallen behind `cutoffDate`, and
 * no recently started sync run. Capped — the 15-minute cron cadence absorbs
 * any backlog beyond `limit`.
 */
async function getProjectsDueForSync(cutoffDate: string, limit: number) {
  // Only a young active run suppresses its project — an older one is more
  // likely a stranded row than a live sync (see activeRunWedge).
  const activeRuns = db
    .select({ projectId: gscSyncRuns.projectId })
    .from(gscSyncRuns)
    .where(
      and(
        inArray(gscSyncRuns.status, ["pending", "running"]),
        isYoungActiveRun(gscSyncRuns.startedAt),
      ),
    );
  const latestDates = db
    .select({
      projectId: gscPerformance.projectId,
      latestDate: max(gscPerformance.date).as("latest_date"),
    })
    .from(gscPerformance)
    .where(eq(gscPerformance.grain, "day"))
    .groupBy(gscPerformance.projectId)
    .as("gsc_latest_dates");
  return db
    .select({ projectId: gscConnections.projectId })
    .from(gscConnections)
    .innerJoin(projects, eq(gscConnections.projectId, projects.id))
    .leftJoin(latestDates, eq(latestDates.projectId, gscConnections.projectId))
    .where(
      and(
        isNull(projects.archivedAt),
        notInArray(gscConnections.projectId, activeRuns),
        // Null latest date = never synced = due for the 90-day backfill.
        or(
          isNull(latestDates.latestDate),
          lt(latestDates.latestDate, cutoffDate),
        ),
      ),
    )
    .limit(limit);
}

// ---------------------------------------------------------------------------
// Interning + fact writes
// ---------------------------------------------------------------------------

/** Intern page URLs for a project, returning url → id. Insert-if-absent via
 *  batched upserts, then read the ids back — concurrent interners converge on
 *  the same rows through the (project_id, url) unique. */
async function internPages(
  projectId: string,
  urls: string[],
): Promise<Map<string, string>> {
  const unique = [...new Set(urls)];
  await executeInBatches(unique, (tx, url) =>
    tx
      .insert(gscPages)
      .values({ id: crypto.randomUUID(), projectId, url })
      .onConflictDoNothing(),
  );
  const ids = new Map<string, string>();
  for (let i = 0; i < unique.length; i += INTERN_SELECT_CHUNK) {
    const chunk = unique.slice(i, i + INTERN_SELECT_CHUNK);
    const rows = await db
      .select({ id: gscPages.id, url: gscPages.url })
      .from(gscPages)
      .where(
        and(eq(gscPages.projectId, projectId), inArray(gscPages.url, chunk)),
      );
    for (const row of rows) ids.set(row.url, row.id);
  }
  return ids;
}

/** Intern query strings — same contract as internPages. */
async function internQueries(
  projectId: string,
  queries: string[],
): Promise<Map<string, string>> {
  const unique = [...new Set(queries)];
  await executeInBatches(unique, (tx, query) =>
    tx
      .insert(gscQueries)
      .values({ id: crypto.randomUUID(), projectId, query })
      .onConflictDoNothing(),
  );
  const ids = new Map<string, string>();
  for (let i = 0; i < unique.length; i += INTERN_SELECT_CHUNK) {
    const chunk = unique.slice(i, i + INTERN_SELECT_CHUNK);
    const rows = await db
      .select({ id: gscQueries.id, query: gscQueries.query })
      .from(gscQueries)
      .where(
        and(
          eq(gscQueries.projectId, projectId),
          inArray(gscQueries.query, chunk),
        ),
      );
    for (const row of rows) ids.set(row.query, row.id);
  }
  return ids;
}

/** Upsert day-grain fact rows. Update-on-conflict, not ignore: daily syncs
 *  re-pull the trailing 3 days because GSC finalizes late, so the re-pulled
 *  metrics must overwrite what an earlier sync stored — last write wins. */
async function upsertPerformanceRows(
  rows: GscPerformanceUpsert[],
): Promise<void> {
  await executeInBatches(rows, (tx, row) =>
    tx
      .insert(gscPerformance)
      .values({ ...row, grain: "day" })
      .onConflictDoUpdate({
        target: [
          gscPerformance.projectId,
          gscPerformance.pageId,
          gscPerformance.queryId,
          gscPerformance.date,
          gscPerformance.grain,
        ],
        set: {
          clicks: row.clicks,
          impressions: row.impressions,
          ctr: row.ctr,
          position: row.position,
          syncMark: row.syncMark,
        },
      }),
  );
}

/**
 * Delete the day's rows this pull did not write — (page, query) pairs that
 * have since dropped below the daily cap and are now represented by the
 * sentinel remainder, so leaving them counts their traffic twice. Scope is
 * the syncMark marker (one value per run+date), not a NOT IN list of the
 * 2500 ids just written, which would blow D1's ~100 bound-parameter cap —
 * the deleteStaleCrawlPages idiom. Month-grain rollups are never touched.
 */
async function deleteStalePerformanceRows(input: {
  projectId: string;
  date: string;
  keepMark: string;
}): Promise<void> {
  await db
    .delete(gscPerformance)
    .where(
      and(
        eq(gscPerformance.projectId, input.projectId),
        eq(gscPerformance.date, input.date),
        eq(gscPerformance.grain, "day"),
        or(
          isNull(gscPerformance.syncMark),
          ne(gscPerformance.syncMark, input.keepMark),
        ),
      ),
    );
}

export const GscSyncRepository = {
  tryCreateRun,
  updateRun,
  getRunById,
  getActiveRunForProject,
  getLatestRunForProject,
  getLatestStoredDate,
  getMemoryStats,
  getProjectsDueForSync,
  internPages,
  internQueries,
  upsertPerformanceRows,
  deleteStalePerformanceRows,
};
