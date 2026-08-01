import {
  and,
  count,
  eq,
  inArray,
  isNotNull,
  max,
  notInArray,
} from "drizzle-orm";
import { db } from "@/db";
import { executeInBatches } from "@/db/runBatch";
import {
  contentPages,
  keywordBacklog,
  pageTypes,
  proposals,
} from "@/db/schema";

/** Proposal states that still hold a backlog row: the queue is waiting on a
 *  human, or the article they spawned is alive. Everything outside this set
 *  has let its keyword go. */
const HOLDING_STATUSES = [
  "proposed",
  "approved",
  "executing",
  "done",
  "measured",
] as const;

/** The subset of HOLDING_STATUSES that counts against today's quota — work
 *  proposed but not yet turned into an article. */
const OUTSTANDING_STATUSES = ["proposed", "approved", "executing"] as const;

// ---------------------------------------------------------------------------
// Selection inputs
// ---------------------------------------------------------------------------

/**
 * Publish dates of the site's own posts — the quota's evidence.
 *
 * Both sources count. A crawl-derived row is a post the site published before
 * rankloop existed and a publish-derived row is one it published itself, and
 * the catch-up arithmetic is about what the site has actually shipped, not
 * about which pipeline shipped it. That is also what makes the quota survive
 * a database reset: the corpus is the ledger.
 */
async function getPublishedPostDates(projectId: string): Promise<string[]> {
  const rows = await db
    .select({ publishedAt: contentPages.publishedAt })
    .from(contentPages)
    .where(
      and(
        eq(contentPages.projectId, projectId),
        eq(contentPages.kind, "post"),
        isNotNull(contentPages.publishedAt),
      ),
    );
  return rows.flatMap((row) =>
    row.publishedAt === null ? [] : [row.publishedAt],
  );
}

/**
 * Planned keywords bound to an approved page type — every net-new candidate
 * there is.
 *
 * Read whole, like the page planner's own backlog read: a project's planned
 * rows are the keywords a human already approved a template for, so the set
 * is bounded by decisions rather than by discovery, and selection needs all
 * of them (score order for the batch, recency order for the pool slot).
 */
async function getPlannedCandidates(projectId: string) {
  return db
    .select({
      backlogId: keywordBacklog.id,
      keyword: keywordBacklog.keyword,
      source: keywordBacklog.source,
      score: keywordBacklog.score,
      searchVolume: keywordBacklog.searchVolume,
      keywordDifficulty: keywordBacklog.keywordDifficulty,
      notesJson: keywordBacklog.notesJson,
      createdAt: keywordBacklog.createdAt,
      pageTypeId: pageTypes.id,
      pageTypeName: pageTypes.name,
      pageTypeKind: pageTypes.kind,
      dataSourceJson: pageTypes.dataSourceJson,
    })
    .from(keywordBacklog)
    .innerJoin(pageTypes, eq(keywordBacklog.pageTypeId, pageTypes.id))
    .where(
      and(
        eq(keywordBacklog.projectId, projectId),
        eq(keywordBacklog.status, "planned"),
        eq(pageTypes.status, "approved"),
      ),
    );
}

/** Net-new proposals still holding a slot in today's debt. */
async function countOutstandingNetNew(projectId: string): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(proposals)
    .where(
      and(
        eq(proposals.projectId, projectId),
        eq(proposals.track, "net_new"),
        inArray(proposals.status, [...OUTSTANDING_STATUSES]),
      ),
    );
  return rows[0]?.value ?? 0;
}

// ---------------------------------------------------------------------------
// Backlog status transitions
// ---------------------------------------------------------------------------

/** Claim the picked rows. Scoped to 'planned' so a row something else moved
 *  while this run was computing is left alone rather than dragged backwards. */
async function markBacklogProposed(
  projectId: string,
  backlogIds: string[],
): Promise<void> {
  const now = new Date().toISOString();
  await executeInBatches(backlogIds, (tx, backlogId) =>
    tx
      .update(keywordBacklog)
      .set({ status: "proposed", updatedAt: now })
      .where(
        and(
          eq(keywordBacklog.id, backlogId),
          eq(keywordBacklog.projectId, projectId),
          eq(keywordBacklog.status, "planned"),
        ),
      ),
  );
}

/**
 * Return one keyword to the pool after its proposal was declined.
 *
 * 'planned', never 'discovered': the page type binding is a decision a human
 * made about this keyword and it survives a no about one particular batch.
 * Sending it back to 'discovered' would hand it to the next page-plan run to
 * re-cluster, quietly undoing an approval.
 */
async function releaseBacklogRow(
  projectId: string,
  backlogId: string,
): Promise<void> {
  await db
    .update(keywordBacklog)
    .set({ status: "planned", updatedAt: new Date().toISOString() })
    .where(
      and(
        eq(keywordBacklog.id, backlogId),
        eq(keywordBacklog.projectId, projectId),
        eq(keywordBacklog.status, "proposed"),
      ),
    );
}

/**
 * Return every keyword whose proposal is gone. The backstop for the TTL: a
 * proposal that expires unread flips to 'expired' without anyone deciding
 * anything, and without this sweep its keyword would sit at 'proposed'
 * forever — invisible to selection, which only reads 'planned'. One keyword
 * lost per expiry is a leak that ends with an empty queue and a full backlog.
 *
 * Returns how many it reclaimed, so the run can say so.
 */
async function reclaimAbandonedBacklogRows(projectId: string): Promise<number> {
  const held = db
    .select({ keywordBacklogId: proposals.keywordBacklogId })
    .from(proposals)
    .where(
      and(
        eq(proposals.projectId, projectId),
        eq(proposals.track, "net_new"),
        inArray(proposals.status, [...HOLDING_STATUSES]),
        isNotNull(proposals.keywordBacklogId),
      ),
    );
  const reclaimed = await db
    .update(keywordBacklog)
    .set({ status: "planned", updatedAt: new Date().toISOString() })
    .where(
      and(
        eq(keywordBacklog.projectId, projectId),
        eq(keywordBacklog.status, "proposed"),
        // The subquery excludes NULL keywordBacklogIds above, which is what
        // makes NOT IN safe here — a single NULL inside it would make the
        // predicate unknown for every row and reclaim nothing.
        notInArray(keywordBacklog.id, held),
      ),
    )
    .returning({ id: keywordBacklog.id });
  return reclaimed.length;
}

// ---------------------------------------------------------------------------
// The daily block's due set
// ---------------------------------------------------------------------------

/**
 * Per-project net-new state in one grouped read: how many proposals are
 * outstanding, and when the newest one was created.
 *
 * The newest createdAt IS the last-run stamp — there is no net-new run table,
 * and adding one to record "we looked and owed nothing" would be a ledger
 * whose only reader is a cron. The outstanding count is deliberately over the
 * same grouping so the block costs two scans of one small table per tick, not
 * two queries per project.
 */
async function getNetNewProjectStats(projectId?: string) {
  const scoped = projectId ? eq(proposals.projectId, projectId) : undefined;
  const [outstanding, lastProposed] = await Promise.all([
    db
      .select({
        projectId: proposals.projectId,
        outstanding: count(),
      })
      .from(proposals)
      .where(
        and(
          eq(proposals.track, "net_new"),
          scoped,
          inArray(proposals.status, [...OUTSTANDING_STATUSES]),
        ),
      )
      .groupBy(proposals.projectId),
    db
      .select({
        projectId: proposals.projectId,
        lastProposedAt: max(proposals.createdAt),
      })
      .from(proposals)
      .where(and(eq(proposals.track, "net_new"), scoped))
      .groupBy(proposals.projectId),
  ]);

  const byProject = new Map(
    outstanding.map((row) => [
      row.projectId,
      {
        projectId: row.projectId,
        outstanding: row.outstanding,
        lastProposedAt: null as string | null,
      },
    ]),
  );
  for (const row of lastProposed) {
    const entry = byProject.get(row.projectId) ?? {
      projectId: row.projectId,
      outstanding: 0,
      lastProposedAt: null,
    };
    entry.lastProposedAt = row.lastProposedAt;
    byProject.set(row.projectId, entry);
  }
  return [...byProject.values()];
}

export const SelectionRepository = {
  getPublishedPostDates,
  getPlannedCandidates,
  countOutstandingNetNew,
  markBacklogProposed,
  releaseBacklogRow,
  reclaimAbandonedBacklogRows,
  getNetNewProjectStats,
};
