import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  notInArray,
  or,
} from "drizzle-orm";
import type { InferInsertModel } from "drizzle-orm";
import { db } from "@/db";
import { executeInBatches } from "@/db/runBatch";
import {
  competitorLinkDomains,
  competitorPages,
  competitors,
  competitorStudyRuns,
  projects,
} from "@/db/schema";
import { isYoungActiveRun } from "@/server/features/rankloop/activeRunWedge";

export type SuggestedCompetitorInsert = {
  projectId: string;
  domain: string;
  discoveredVia: string;
  /** Keywords the competitor shares with the project — the overlap number the
   *  suggested table ranks on. Overwritten by the study's own rank-overview
   *  reading once the competitor is tracked. */
  organicKeywords: number | null;
  estTraffic: number | null;
};

export type CompetitorLinkDomainUpsert = {
  competitorId: string;
  domain: string;
  domainRank: number | null;
  backlinks: number | null;
};

export type CompetitorPageUpsert = {
  competitorId: string;
  url: string;
  title: string | null;
  pageType: string | null;
  etv: number | null;
  keywordCount: number | null;
};

// ---------------------------------------------------------------------------
// Competitor rows
// ---------------------------------------------------------------------------

async function listCompetitors(projectId: string) {
  return db
    .select()
    .from(competitors)
    .where(eq(competitors.projectId, projectId))
    .orderBy(desc(competitors.organicKeywords), asc(competitors.domain));
}

async function getCompetitorById(competitorId: string, projectId: string) {
  const rows = await db
    .select()
    .from(competitors)
    .where(
      and(
        eq(competitors.id, competitorId),
        eq(competitors.projectId, projectId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

async function getCompetitorByDomain(projectId: string, domain: string) {
  const rows = await db
    .select()
    .from(competitors)
    .where(
      and(eq(competitors.projectId, projectId), eq(competitors.domain, domain)),
    )
    .limit(1);
  return rows[0] ?? null;
}

async function createTrackedCompetitor(data: {
  id: string;
  projectId: string;
  domain: string;
  discoveredVia: string;
}): Promise<void> {
  await db.insert(competitors).values({ ...data, status: "tracked" });
}

/**
 * Insert discovery's suggestions. onConflictDoNothing rather than an upsert:
 * the (project, domain) row already existing means the user has already
 * decided about that domain — tracked, or skipped — and a later discovery run
 * must never overwrite that decision or the metrics a study measured. The
 * service filters known domains out first; this is the race backstop.
 */
async function insertSuggestedCompetitors(
  rows: SuggestedCompetitorInsert[],
): Promise<void> {
  await executeInBatches(rows, (tx, row) =>
    tx
      .insert(competitors)
      .values({ id: crypto.randomUUID(), status: "suggested", ...row })
      .onConflictDoNothing(),
  );
}

async function updateCompetitor(
  competitorId: string,
  data: Partial<InferInsertModel<typeof competitors>>,
): Promise<void> {
  await db
    .update(competitors)
    .set(data)
    .where(eq(competitors.id, competitorId));
}

/**
 * Tracked competitors whose last study finished before `cutoff`, oldest
 * first, with no recently started study. A never-studied tracked row is due
 * too — unlike site studies, tracking a competitor IS the request to study
 * it, so a study that failed to start must be retried by the scheduler.
 *
 * The two dialects sort NULL lastStudiedAt to opposite ends (SQLite first,
 * Postgres last), which only changes which never-studied competitor a busy
 * tick picks up first — every one of them is still due on the next tick.
 */
// `projectId` narrows the same predicate to one project — see the note on
// GscSyncRepository.getProjectsDueForSync: one due-rule, two dispatchers.
async function getCompetitorsDueForRefresh(
  cutoff: string,
  limit: number,
  projectId?: string,
) {
  // Only a young active run suppresses its competitor — an older one is more
  // likely a stranded row than a live study (see activeRunWedge).
  const activeRuns = db
    .select({ competitorId: competitorStudyRuns.competitorId })
    .from(competitorStudyRuns)
    .where(
      and(
        inArray(competitorStudyRuns.status, ["pending", "running"]),
        isYoungActiveRun(competitorStudyRuns.startedAt),
      ),
    );

  return db
    .select({
      id: competitors.id,
      projectId: competitors.projectId,
      domain: competitors.domain,
    })
    .from(competitors)
    .innerJoin(projects, eq(competitors.projectId, projects.id))
    .where(
      and(
        eq(competitors.status, "tracked"),
        isNull(projects.archivedAt),
        projectId ? eq(competitors.projectId, projectId) : undefined,
        or(
          isNull(competitors.lastStudiedAt),
          lt(competitors.lastStudiedAt, cutoff),
        ),
        notInArray(competitors.id, activeRuns),
      ),
    )
    .orderBy(asc(competitors.lastStudiedAt))
    .limit(limit);
}

// ---------------------------------------------------------------------------
// Study run CRUD
// ---------------------------------------------------------------------------

/**
 * Try to insert a new pending study run. Returns true if inserted, false if
 * blocked by the partial unique index on (competitor_id) WHERE status IN
 * ('pending', 'running') — i.e. a study is already active for this
 * competitor. The failed INSERT is the already-running signal.
 */
async function tryCreateStudyRun(data: {
  id: string;
  projectId: string;
  competitorId: string;
}): Promise<boolean> {
  const inserted = await db
    .insert(competitorStudyRuns)
    .values({ ...data, status: "pending" })
    .onConflictDoNothing()
    .returning({ id: competitorStudyRuns.id });
  return inserted.length > 0;
}

async function updateStudyRun(
  runId: string,
  data: Partial<InferInsertModel<typeof competitorStudyRuns>>,
): Promise<void> {
  await db
    .update(competitorStudyRuns)
    .set(data)
    .where(eq(competitorStudyRuns.id, runId));
}

async function getStudyRunById(runId: string) {
  const rows = await db
    .select()
    .from(competitorStudyRuns)
    .where(eq(competitorStudyRuns.id, runId))
    .limit(1);
  return rows[0] ?? null;
}

async function getActiveStudyRunForCompetitor(competitorId: string) {
  const rows = await db
    .select()
    .from(competitorStudyRuns)
    .where(
      and(
        eq(competitorStudyRuns.competitorId, competitorId),
        inArray(competitorStudyRuns.status, ["pending", "running"]),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** The latest run per competitor for a project, newest first — the caller
 *  keeps the first sighting of each competitor id. One query beats N. */
async function getLatestStudyRunsForProject(projectId: string) {
  return db
    .select()
    .from(competitorStudyRuns)
    .where(eq(competitorStudyRuns.projectId, projectId))
    .orderBy(desc(competitorStudyRuns.startedAt));
}

async function getLatestStudyRunForCompetitor(competitorId: string) {
  const rows = await db
    .select()
    .from(competitorStudyRuns)
    .where(eq(competitorStudyRuns.competitorId, competitorId))
    .orderBy(desc(competitorStudyRuns.startedAt))
    .limit(1);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Competitor pages
// ---------------------------------------------------------------------------

/** Upsert on (competitorId, url) — the monthly refresh updates in place so
 *  firstSeenAt keeps saying when the page was first observed. */
async function upsertCompetitorPages(
  rows: CompetitorPageUpsert[],
  seenAt: string,
): Promise<void> {
  await executeInBatches(rows, (tx, row) =>
    tx
      .insert(competitorPages)
      .values({
        id: crypto.randomUUID(),
        ...row,
        status: "active",
        lastSeenAt: seenAt,
      })
      .onConflictDoUpdate({
        target: [competitorPages.competitorId, competitorPages.url],
        set: {
          title: row.title,
          pageType: row.pageType,
          etv: row.etv,
          keywordCount: row.keywordCount,
          lastSeenAt: seenAt,
        },
      }),
  );
}

/** Crawl findings, written per page so a blocked batch keeps whatever the
 *  earlier batches measured. */
async function updateCompetitorPageFeatures(
  rows: Array<{
    competitorId: string;
    url: string;
    wordCount: number;
    structuralFeaturesJson: string;
  }>,
): Promise<void> {
  await executeInBatches(rows, (tx, row) =>
    tx
      .update(competitorPages)
      .set({
        wordCount: row.wordCount,
        structuralFeaturesJson: row.structuralFeaturesJson,
      })
      .where(
        and(
          eq(competitorPages.competitorId, row.competitorId),
          eq(competitorPages.url, row.url),
        ),
      ),
  );
}

async function getCompetitorPages(competitorId: string) {
  return db
    .select()
    .from(competitorPages)
    .where(eq(competitorPages.competitorId, competitorId))
    .orderBy(desc(competitorPages.etv));
}

/** The two columns the snapshot diff runs on. */
async function getPageSnapshot(competitorId: string) {
  return db
    .select({ url: competitorPages.url, etv: competitorPages.etv })
    .from(competitorPages)
    .where(eq(competitorPages.competitorId, competitorId));
}

/** Apply one status to a set of URLs. Batched by URL rather than issued as a
 *  single IN (...) — a 100-page snapshot would blow D1's ~100 bound-parameter
 *  cap on the first refresh. */
async function setPageStatuses(
  competitorId: string,
  urls: string[],
  status: "active" | "decayed" | "removed",
): Promise<void> {
  await executeInBatches(urls, (tx, url) =>
    tx
      .update(competitorPages)
      .set({ status })
      .where(
        and(
          eq(competitorPages.competitorId, competitorId),
          eq(competitorPages.url, url),
        ),
      ),
  );
}

// ---------------------------------------------------------------------------
// Referring domains (the link gap's raw material)
// ---------------------------------------------------------------------------

/**
 * Upsert on (competitorId, domain), refreshing rank, link count and
 * lastSeenAt. Nothing is deleted here and there is no sweep afterwards: a
 * domain that has since dropped its link still proves it links out in this
 * niche, and the gap is about who is reachable, not who is linking this
 * month. firstSeenAt therefore keeps meaning "first observed".
 */
async function upsertCompetitorLinkDomains(
  rows: CompetitorLinkDomainUpsert[],
  seenAt: string,
): Promise<void> {
  await executeInBatches(rows, (tx, row) =>
    tx
      .insert(competitorLinkDomains)
      .values({
        id: crypto.randomUUID(),
        ...row,
        firstSeenAt: seenAt,
        lastSeenAt: seenAt,
      })
      .onConflictDoUpdate({
        target: [
          competitorLinkDomains.competitorId,
          competitorLinkDomains.domain,
        ],
        set: {
          domainRank: row.domainRank,
          backlinks: row.backlinks,
          lastSeenAt: seenAt,
        },
      }),
  );
}

export const CompetitorsRepository = {
  listCompetitors,
  getCompetitorById,
  getCompetitorByDomain,
  createTrackedCompetitor,
  insertSuggestedCompetitors,
  updateCompetitor,
  getCompetitorsDueForRefresh,
  tryCreateStudyRun,
  updateStudyRun,
  getStudyRunById,
  getActiveStudyRunForCompetitor,
  getLatestStudyRunsForProject,
  getLatestStudyRunForCompetitor,
  upsertCompetitorPages,
  updateCompetitorPageFeatures,
  getCompetitorPages,
  getPageSnapshot,
  setPageStatuses,
  upsertCompetitorLinkDomains,
};
