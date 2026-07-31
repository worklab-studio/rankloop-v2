import {
  and,
  desc,
  eq,
  getTableColumns,
  gte,
  inArray,
  isNotNull,
  lt,
  min,
  notLike,
  or,
  sql,
} from "drizzle-orm";
import type { InferInsertModel } from "drizzle-orm";
import { db } from "@/db";
import {
  contentPages,
  gscPages,
  gscPerformance,
  gscQueries,
  pageTypes,
  proposals,
} from "@/db/schema";
import type { RankloopProposal } from "@/types/schemas/rankloopProposals";

// ---------------------------------------------------------------------------
// Signal inputs
// ---------------------------------------------------------------------------

/** Day-grain (page, query) rows since `since`, joined to their URL and query
 *  text. Raw daily rows, not SQL aggregates — the impressions-weighted rollup
 *  (and the sentinel exclusion) is pure logic under test in signals.logic.ts.
 *  Volume is bounded by the sync's 2500-rows/day cap × the 28-day window. */
async function getDailyPageQueryRows(projectId: string, since: string) {
  return db
    .select({
      pageUrl: gscPages.url,
      query: gscQueries.query,
      clicks: gscPerformance.clicks,
      impressions: gscPerformance.impressions,
      position: gscPerformance.position,
    })
    .from(gscPerformance)
    .innerJoin(gscPages, eq(gscPerformance.pageId, gscPages.id))
    .innerJoin(gscQueries, eq(gscPerformance.queryId, gscQueries.id))
    .where(
      and(
        eq(gscPerformance.projectId, projectId),
        eq(gscPerformance.grain, "day"),
        gte(gscPerformance.date, since),
      ),
    );
}

/**
 * Per-page daily totals across the whole stored day-grain memory — the
 * refresh signal's series. Branded queries are excluded here, in SQL, because
 * fetching 90 days of raw (page, query) rows just to drop them in code would
 * triple the read for nothing; `excludeQueryTokens` come from brandTokens(),
 * which only emits [a-z0-9] strings, so the LIKE patterns need no escaping.
 */
async function getDailyPageTotals(
  projectId: string,
  excludeQueryTokens: string[],
) {
  return db
    .select({
      pageUrl: gscPages.url,
      date: gscPerformance.date,
      clicks: sql<number>`sum(${gscPerformance.clicks})`,
      impressions: sql<number>`sum(${gscPerformance.impressions})`,
    })
    .from(gscPerformance)
    .innerJoin(gscPages, eq(gscPerformance.pageId, gscPages.id))
    .innerJoin(gscQueries, eq(gscPerformance.queryId, gscQueries.id))
    .where(
      and(
        eq(gscPerformance.projectId, projectId),
        eq(gscPerformance.grain, "day"),
        ...excludeQueryTokens.map((token) =>
          notLike(gscQueries.query, `%${token}%`),
        ),
      ),
    )
    .groupBy(gscPages.url, gscPerformance.date);
}

/** How far back stored memory reaches — the refresh signal's thin-data guard
 *  reads this, not a row count. */
async function getEarliestStoredDate(
  projectId: string,
): Promise<string | null> {
  const rows = await db
    .select({ earliestDate: min(gscPerformance.date) })
    .from(gscPerformance)
    .where(
      and(
        eq(gscPerformance.projectId, projectId),
        eq(gscPerformance.grain, "day"),
      ),
    );
  return rows[0]?.earliestDate ?? null;
}

/** The optimize track only proposes against articles and standalone pages —
 *  hubs and utility rows have no single query intent to optimize toward. */
async function getContentPagesForSignals(projectId: string) {
  return db
    .select({
      id: contentPages.id,
      url: contentPages.url,
      path: contentPages.path,
      title: contentPages.title,
      publishedAt: contentPages.publishedAt,
    })
    .from(contentPages)
    .where(
      and(
        eq(contentPages.projectId, projectId),
        inArray(contentPages.kind, ["post", "page"]),
      ),
    );
}

// ---------------------------------------------------------------------------
// Proposal CRUD
// ---------------------------------------------------------------------------

/**
 * Try to insert a proposal. Returns true if inserted, false when blocked by
 * the partial unique on (project_id, type, target) WHERE status IN
 * ('proposed','approved','executing') — i.e. the same proposal is already
 * active. The failed INSERT is the already-active signal; compute skips it
 * silently.
 */
async function tryInsertProposal(
  data: InferInsertModel<typeof proposals>,
): Promise<boolean> {
  const inserted = await db
    .insert(proposals)
    .values(data)
    .onConflictDoNothing()
    .returning({ id: proposals.id });
  return inserted.length > 0;
}

/** Flip proposed rows past their TTL to expired. Returns how many flipped.
 *  Only 'proposed' expires — approved rows are a human decision waiting on
 *  execution (S3b), and silently expiring one would discard that yes. */
async function expireStaleProposals(
  projectId: string,
  nowIso: string,
): Promise<number> {
  const expired = await db
    .update(proposals)
    .set({ status: "expired" })
    .where(
      and(
        eq(proposals.projectId, projectId),
        eq(proposals.status, "proposed"),
        isNotNull(proposals.expiresAt),
        lt(proposals.expiresAt, nowIso),
      ),
    )
    .returning({ id: proposals.id });
  return expired.length;
}

/**
 * Targets decided or executed since `cutoffIso`, every type — any decision
 * counts: an approved action needs its ~2 GSC-lagged weeks of after-data, and
 * a declined one was a no the engine should not re-litigate next sync.
 *
 * The predicate is an OR over both stamps, and both come back, because a
 * proposal approved before the cutoff and executed after it is exactly the row
 * suppression exists for — a decidedAt-only filter would drop it and let the
 * engine re-propose inside the open receipt's window. Which stamp anchors
 * which window is pure logic in signals.logic.ts.
 */
async function getRecentDecisions(projectId: string, cutoffIso: string) {
  return db
    .select({
      type: proposals.type,
      target: proposals.target,
      decidedAt: proposals.decidedAt,
      executedAt: proposals.executedAt,
    })
    .from(proposals)
    .where(
      and(
        eq(proposals.projectId, projectId),
        or(
          gte(proposals.decidedAt, cutoffIso),
          gte(proposals.executedAt, cutoffIso),
        ),
      ),
    );
}

/**
 * Compare-and-set decision: only a 'proposed' row transitions, and the
 * returned row is the proof it did. Zero rows means the proposal is missing,
 * already decided, or expired — the service tells those apart.
 */
async function updateDecision(input: {
  projectId: string;
  proposalId: string;
  status: "approved" | "declined";
  decidedAt: string;
}): Promise<Pick<
  RankloopProposal,
  "id" | "type" | "track" | "target" | "keywordBacklogId"
> | null> {
  const rows = await db
    .update(proposals)
    .set({ status: input.status, decidedAt: input.decidedAt })
    .where(
      and(
        eq(proposals.id, input.proposalId),
        eq(proposals.projectId, input.projectId),
        eq(proposals.status, "proposed"),
      ),
    )
    .returning({
      id: proposals.id,
      type: proposals.type,
      // The net-new track's decline has a side effect on keyword_backlog, and
      // this row is the only proof the CAS actually won — so both come back
      // rather than being re-read afterwards, where a race could read a row
      // some other decision had already moved.
      track: proposals.track,
      target: proposals.target,
      keywordBacklogId: proposals.keywordBacklogId,
    });
  return rows[0] ?? null;
}

async function getProposalById(projectId: string, proposalId: string) {
  const rows = await db
    .select()
    .from(proposals)
    .where(
      and(eq(proposals.id, proposalId), eq(proposals.projectId, projectId)),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Score-descending — the queue's one ordering; createdAt breaks ties so the
 * list is stable across refetches.
 *
 * The page type is left-joined rather than denormalized onto the proposal:
 * optimize rows have no page type at all, and a net-new row's type can be
 * renamed after the proposal was written, at which point a stored copy would
 * be a chip contradicting the page plan tab beside it.
 */
async function getProposalsForProject(
  projectId: string,
  status?: RankloopProposal["status"],
) {
  return db
    .select({
      ...getTableColumns(proposals),
      pageTypeName: pageTypes.name,
    })
    .from(proposals)
    .leftJoin(pageTypes, eq(proposals.pageTypeId, pageTypes.id))
    .where(
      and(
        eq(proposals.projectId, projectId),
        status ? eq(proposals.status, status) : undefined,
      ),
    )
    .orderBy(desc(proposals.score), desc(proposals.createdAt));
}

export const ProposalsRepository = {
  getDailyPageQueryRows,
  getDailyPageTotals,
  getEarliestStoredDate,
  getContentPagesForSignals,
  tryInsertProposal,
  expireStaleProposals,
  getRecentDecisions,
  updateDecision,
  getProposalById,
  getProposalsForProject,
};
