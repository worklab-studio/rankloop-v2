import {
  and,
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
import {
  auditPages,
  audits,
  contentPages,
  projects,
  siteStudyRuns,
} from "@/db/schema";
import { isYoungActiveRun } from "@/server/features/rankloop/activeRunWedge";
import type { ContentPageKind } from "@/server/features/rankloop/site-study/services/derive.logic";

export type ContentPageUpsert = {
  projectId: string;
  url: string;
  path: string;
  kind: ContentPageKind;
  title: string | null;
  description: string | null;
  publishedAt: string | null;
  modifiedAt: string | null;
  wordCount: number | null;
  inlinkCount: number | null;
  outlinkPathsJson: string | null;
  contentHash: string | null;
  lastCrawledAt: string;
};

// ---------------------------------------------------------------------------
// Study run CRUD
// ---------------------------------------------------------------------------

/**
 * Try to insert a new pending study run. Returns true if inserted, false if
 * blocked by the partial unique index on (project_id) WHERE status IN
 * ('pending', 'running') — i.e. another study is already active for this
 * project. The failed INSERT is the already-running signal.
 */
async function tryCreateRun(data: {
  id: string;
  projectId: string;
}): Promise<boolean> {
  const inserted = await db
    .insert(siteStudyRuns)
    .values({ ...data, status: "pending" })
    .onConflictDoNothing()
    .returning({ id: siteStudyRuns.id });
  return inserted.length > 0;
}

async function updateRun(
  runId: string,
  data: Partial<InferInsertModel<typeof siteStudyRuns>>,
) {
  await db.update(siteStudyRuns).set(data).where(eq(siteStudyRuns.id, runId));
}

async function getRunById(runId: string) {
  const rows = await db
    .select()
    .from(siteStudyRuns)
    .where(eq(siteStudyRuns.id, runId))
    .limit(1);
  return rows[0] ?? null;
}

async function getActiveRunForProject(projectId: string) {
  const rows = await db
    .select()
    .from(siteStudyRuns)
    .where(
      and(
        eq(siteStudyRuns.projectId, projectId),
        inArray(siteStudyRuns.status, ["pending", "running"]),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

async function getLatestRunForProject(projectId: string) {
  const rows = await db
    .select()
    .from(siteStudyRuns)
    .where(eq(siteStudyRuns.projectId, projectId))
    .orderBy(desc(siteStudyRuns.startedAt))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Projects due for the weekly re-study: an unarchived project whose latest
 * *done* study finished before `cutoff`, with no recently started run. A
 * project that has never been studied is not due — the first study is the
 * user's explicit "Study my site", so the cron never crawls a site nobody
 * asked it to. Capped — the 15-minute cron cadence absorbs any backlog.
 */
// `projectId` narrows the same predicate to one project — see the note on
// GscSyncRepository.getProjectsDueForSync: one due-rule, two dispatchers.
async function getProjectsDueForStudy(
  cutoff: string,
  limit: number,
  projectId?: string,
) {
  // Only a young active run suppresses its project — an older one is more
  // likely a stranded row than a live study (see activeRunWedge).
  const activeRuns = db
    .select({ projectId: siteStudyRuns.projectId })
    .from(siteStudyRuns)
    .where(
      and(
        inArray(siteStudyRuns.status, ["pending", "running"]),
        isYoungActiveRun(siteStudyRuns.startedAt),
      ),
    );
  const latestDone = db
    .select({
      projectId: siteStudyRuns.projectId,
      latestFinishedAt: max(siteStudyRuns.finishedAt).as("latest_finished_at"),
    })
    .from(siteStudyRuns)
    .where(eq(siteStudyRuns.status, "done"))
    .groupBy(siteStudyRuns.projectId)
    .as("site_study_latest_done");
  return db
    .select({ projectId: latestDone.projectId })
    .from(latestDone)
    .innerJoin(projects, eq(latestDone.projectId, projects.id))
    .where(
      and(
        isNull(projects.archivedAt),
        projectId ? eq(latestDone.projectId, projectId) : undefined,
        notInArray(latestDone.projectId, activeRuns),
        lt(latestDone.latestFinishedAt, cutoff),
      ),
    )
    .limit(limit);
}

// ---------------------------------------------------------------------------
// Audit reads (the study consumes the audit feature's tables read-only)
// ---------------------------------------------------------------------------

async function getLatestCompletedAuditForProject(projectId: string) {
  const rows = await db
    .select({
      id: audits.id,
      startUrl: audits.startUrl,
      config: audits.config,
      completedAt: audits.completedAt,
    })
    .from(audits)
    .where(and(eq(audits.projectId, projectId), eq(audits.status, "completed")))
    .orderBy(desc(audits.completedAt))
    .limit(1);
  return rows[0] ?? null;
}

/** The slice of audit_pages the derive needs — no images/headings/links JSON,
 *  so a 10k-page run stays comfortably inside the isolate heap. */
async function getPagesForDerive(auditId: string) {
  return db
    .select({
      url: auditPages.url,
      statusCode: auditPages.statusCode,
      fetchClass: auditPages.fetchClass,
      title: auditPages.title,
      metaDescription: auditPages.metaDescription,
      publishedAt: auditPages.publishedAt,
      modifiedAt: auditPages.modifiedAt,
      wordCount: auditPages.wordCount,
      isIndexable: auditPages.isIndexable,
      contentHash: auditPages.contentHash,
      outlinkPathsJson: auditPages.outlinkPathsJson,
    })
    .from(auditPages)
    .where(eq(auditPages.auditId, auditId));
}

// ---------------------------------------------------------------------------
// Content inventory writes
// ---------------------------------------------------------------------------

/**
 * Upsert crawl-derived rows on (projectId, url). The set clause writes only
 * what the crawl measured — category, keyword, and pageTypeId are owned by
 * later phases and survive every re-study. A publish-appended row flips to
 * source='crawl' once a crawl has actually seen the page (its measured
 * fields are real from then on).
 */
async function upsertContentPages(rows: ContentPageUpsert[]): Promise<void> {
  await executeInBatches(rows, (tx, row) =>
    tx
      .insert(contentPages)
      .values({ id: crypto.randomUUID(), source: "crawl", ...row })
      .onConflictDoUpdate({
        target: [contentPages.projectId, contentPages.url],
        set: {
          path: row.path,
          kind: row.kind,
          title: row.title,
          description: row.description,
          publishedAt: row.publishedAt,
          modifiedAt: row.modifiedAt,
          wordCount: row.wordCount,
          inlinkCount: row.inlinkCount,
          outlinkPathsJson: row.outlinkPathsJson,
          contentHash: row.contentHash,
          source: "crawl",
          lastCrawledAt: row.lastCrawledAt,
        },
      }),
  );
}

/**
 * Delete crawl-sourced rows the current derive did not touch — pages that
 * left the site since the previous study. Scope is the lastCrawledAt marker
 * (one value per derive), not a NOT IN url list, which would blow D1's ~100
 * bound-parameter cap on any real site. source='publish' rows are never
 * touched: they were appended by a publish and the next crawl is what
 * confirms or retires them.
 */
async function deleteStaleCrawlPages(
  projectId: string,
  keepMark: string,
): Promise<void> {
  await db
    .delete(contentPages)
    .where(
      and(
        eq(contentPages.projectId, projectId),
        eq(contentPages.source, "crawl"),
        or(
          isNull(contentPages.lastCrawledAt),
          ne(contentPages.lastCrawledAt, keepMark),
        ),
      ),
    );
}

/** The columns the inventory summary is computed from. Median and cadence
 *  need row-level values, so aggregation happens in the service — bounded by
 *  the 10k-page audit ceiling, three small columns per row. */
async function getInventoryRows(projectId: string) {
  return db
    .select({
      kind: contentPages.kind,
      wordCount: contentPages.wordCount,
      publishedAt: contentPages.publishedAt,
    })
    .from(contentPages)
    .where(eq(contentPages.projectId, projectId));
}

/** Live crawl numbers for the audit a running study is waiting on — the
 *  progress spine's "134/214 pages". */
async function getRunningAuditProgress(projectId: string) {
  const rows = await db
    .select({
      pagesCrawled: audits.pagesCrawled,
      pagesTotal: audits.pagesTotal,
    })
    .from(audits)
    .where(and(eq(audits.projectId, projectId), eq(audits.status, "running")))
    .orderBy(desc(audits.startedAt))
    .limit(1);
  return rows[0] ?? null;
}

export const SiteStudyRepository = {
  tryCreateRun,
  updateRun,
  getRunById,
  getActiveRunForProject,
  getLatestRunForProject,
  getProjectsDueForStudy,
  getLatestCompletedAuditForProject,
  getPagesForDerive,
  upsertContentPages,
  deleteStaleCrawlPages,
  getInventoryRows,
  getRunningAuditProgress,
};
