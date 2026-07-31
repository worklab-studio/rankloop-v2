import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  like,
  lt,
  max,
  ne,
  notInArray,
  or,
} from "drizzle-orm";
import type { InferInsertModel } from "drizzle-orm";
import { db } from "@/db";
import {
  contentPages,
  keywordBacklog,
  keywordUniverseRuns,
  projectGate,
  projects,
} from "@/db/schema";
import { isYoungActiveRun } from "@/server/features/rankloop/activeRunWedge";

// The keyword-universe run ledger, plus the two reads a dispatch needs: what
// to seed the free and paid expanders with, and which projects the weekly
// block owes a run. The gate itself (derivation, tokens, KD ceiling) is not
// read here — every source writes through the shared admit path, which owns
// it.

// ---------------------------------------------------------------------------
// Run CRUD
// ---------------------------------------------------------------------------

/**
 * Try to insert a new pending universe run. Returns true if inserted, false
 * if blocked by the partial unique index on (project_id) WHERE status IN
 * ('pending', 'running') — i.e. a run is already underway for this project.
 * The failed INSERT is the already-running signal (the site_study_runs
 * idiom); two concurrent runs would race the same (project_id, keyword)
 * upsert target and double-count seen/kept.
 */
async function tryCreateRun(data: {
  id: string;
  projectId: string;
  sourcesJson: string;
}): Promise<boolean> {
  const inserted = await db
    .insert(keywordUniverseRuns)
    .values({ ...data, status: "pending" })
    .onConflictDoNothing()
    .returning({ id: keywordUniverseRuns.id });
  return inserted.length > 0;
}

async function updateRun(
  runId: string,
  data: Partial<InferInsertModel<typeof keywordUniverseRuns>>,
): Promise<void> {
  await db
    .update(keywordUniverseRuns)
    .set(data)
    .where(eq(keywordUniverseRuns.id, runId));
}

async function getRunById(runId: string) {
  const rows = await db
    .select()
    .from(keywordUniverseRuns)
    .where(eq(keywordUniverseRuns.id, runId))
    .limit(1);
  return rows[0] ?? null;
}

async function getActiveRunForProject(projectId: string) {
  const rows = await db
    .select()
    .from(keywordUniverseRuns)
    .where(
      and(
        eq(keywordUniverseRuns.projectId, projectId),
        inArray(keywordUniverseRuns.status, ["pending", "running"]),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

async function getLatestRunForProject(projectId: string) {
  const rows = await db
    .select()
    .from(keywordUniverseRuns)
    .where(eq(keywordUniverseRuns.projectId, projectId))
    .orderBy(desc(keywordUniverseRuns.startedAt))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * The most recent run that asked for a harvest, whatever its outcome — this
 * project's record of how harvesting was configured, which is what lets the
 * weekly block repeat it without a settings table the spec doesn't have.
 *
 * Matched with LIKE over the dispatch JSON rather than a column, because
 * which sources a run asked for is a set and a set gets one column here.
 * `"harvest"` appears in that JSON only as a source name, so the match is
 * exact in practice.
 */
async function getLatestHarvestRunForProject(projectId: string) {
  const rows = await db
    .select({ sourcesJson: keywordUniverseRuns.sourcesJson })
    .from(keywordUniverseRuns)
    .where(
      and(
        eq(keywordUniverseRuns.projectId, projectId),
        like(keywordUniverseRuns.sourcesJson, '%"harvest"%'),
      ),
    )
    .orderBy(desc(keywordUniverseRuns.startedAt))
    .limit(1);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Seeds
// ---------------------------------------------------------------------------

/**
 * What the expanders fan out from: the backlog rows this project scored
 * highest and hasn't decided about yet.
 *
 * Falls back to the primary keywords of pages the site already has when the
 * backlog is empty — a first run has nothing scored, and expanding from the
 * site's own published keywords is a better day-one seed set than expanding
 * from nothing. Skipped rows are excluded either way: re-expanding around a
 * keyword the user rejected is how a backlog fills with what they said no to.
 */
async function getSeedKeywords(
  projectId: string,
  limit: number,
): Promise<string[]> {
  const scored = await db
    .select({ keyword: keywordBacklog.keyword })
    .from(keywordBacklog)
    .where(
      and(
        eq(keywordBacklog.projectId, projectId),
        ne(keywordBacklog.status, "skipped"),
      ),
    )
    .orderBy(desc(keywordBacklog.score))
    .limit(limit);
  if (scored.length > 0) return scored.map((row) => row.keyword);

  const published = await db
    .select({ keyword: contentPages.keyword })
    .from(contentPages)
    .where(
      and(
        eq(contentPages.projectId, projectId),
        isNotNull(contentPages.keyword),
      ),
    )
    .limit(limit);
  return published.flatMap((row) => (row.keyword ? [row.keyword] : []));
}

// ---------------------------------------------------------------------------
// The weekly free block
// ---------------------------------------------------------------------------

/**
 * Projects whose free sources are due. A project qualifies once it has a gate
 * row — the gate is what every source writes through, so before it exists
 * there is nothing to admit candidates against and a scheduled run would only
 * produce rejections.
 */
async function getProjectsDueForFreeSources(cutoff: string, limit: number) {
  const activeRuns = db
    .select({ projectId: keywordUniverseRuns.projectId })
    .from(keywordUniverseRuns)
    .where(
      and(
        inArray(keywordUniverseRuns.status, ["pending", "running"]),
        // Only a young active run suppresses its project — an older one is
        // more likely a stranded row than a live run (see activeRunWedge).
        isYoungActiveRun(keywordUniverseRuns.startedAt),
      ),
    );

  // The last time this project finished a run, whatever it asked for: a
  // manual "Find gaps" on Tuesday is still a week of keyword work, and
  // stacking the weekly free block on top of it buys nothing. Aggregated to
  // one row per project — a plain join would return the project once per
  // finished run and blow the per-tick cap on history alone.
  const lastFinished = db
    .select({
      projectId: keywordUniverseRuns.projectId,
      lastFinishedAt: max(keywordUniverseRuns.finishedAt).as(
        "last_finished_at",
      ),
    })
    .from(keywordUniverseRuns)
    .where(eq(keywordUniverseRuns.status, "done"))
    .groupBy(keywordUniverseRuns.projectId)
    .as("last_finished");

  return (
    db
      .select({
        projectId: projects.id,
        lastFinishedAt: lastFinished.lastFinishedAt,
      })
      .from(projectGate)
      .innerJoin(projects, eq(projectGate.projectId, projects.id))
      .leftJoin(lastFinished, eq(lastFinished.projectId, projects.id))
      .where(
        and(
          isNull(projects.archivedAt),
          notInArray(projects.id, activeRuns),
          or(
            isNull(lastFinished.lastFinishedAt),
            lt(lastFinished.lastFinishedAt, cutoff),
          ),
        ),
      )
      // Nulls first in both dialects' default ascending order, which is the
      // ordering this wants anyway: a project that has never run goes first.
      .orderBy(asc(lastFinished.lastFinishedAt))
      .limit(limit)
  );
}

export const UniverseRunsRepository = {
  tryCreateRun,
  updateRun,
  getRunById,
  getActiveRunForProject,
  getLatestRunForProject,
  getLatestHarvestRunForProject,
  getSeedKeywords,
  getProjectsDueForFreeSources,
};
