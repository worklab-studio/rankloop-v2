import {
  and,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  notInArray,
} from "drizzle-orm";
import type { InferInsertModel } from "drizzle-orm";
import { db } from "@/db";
import { executeInBatches } from "@/db/runBatch";
import {
  backlinkSnapshots,
  competitorPages,
  competitors,
  contentPages,
  keywordBacklog,
  pagePlanRuns,
  pageTypes,
  serpSnapshots,
} from "@/db/schema";

export type PageTypeUpsert = {
  projectId: string;
  name: string;
  kind: "pseo" | "blog" | "hub";
  urlPattern: string;
  keywordPattern: string;
  templateContractJson: string;
  evidenceJson: string;
  serpCheckJson: string;
  demand: number;
  instanceCount: number;
};

// ---------------------------------------------------------------------------
// Run CRUD
// ---------------------------------------------------------------------------

/**
 * Try to insert a new pending plan run. Returns true if inserted, false if
 * blocked by the partial unique index on (project_id) WHERE status IN
 * ('pending', 'running') — i.e. a plan is already running for this project.
 * The failed INSERT is the already-running signal (the site_study_runs idiom).
 */
async function tryCreateRun(data: {
  id: string;
  projectId: string;
}): Promise<boolean> {
  const inserted = await db
    .insert(pagePlanRuns)
    .values({ ...data, status: "pending" })
    .onConflictDoNothing()
    .returning({ id: pagePlanRuns.id });
  return inserted.length > 0;
}

async function updateRun(
  runId: string,
  data: Partial<InferInsertModel<typeof pagePlanRuns>>,
): Promise<void> {
  await db.update(pagePlanRuns).set(data).where(eq(pagePlanRuns.id, runId));
}

async function getRunById(runId: string) {
  const rows = await db
    .select()
    .from(pagePlanRuns)
    .where(eq(pagePlanRuns.id, runId))
    .limit(1);
  return rows[0] ?? null;
}

async function getActiveRunForProject(projectId: string) {
  const rows = await db
    .select()
    .from(pagePlanRuns)
    .where(
      and(
        eq(pagePlanRuns.projectId, projectId),
        inArray(pagePlanRuns.status, ["pending", "running"]),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

async function getLatestRunForProject(projectId: string) {
  const rows = await db
    .select()
    .from(pagePlanRuns)
    .where(eq(pagePlanRuns.projectId, projectId))
    .orderBy(desc(pagePlanRuns.startedAt))
    .limit(1);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Detection inputs
// ---------------------------------------------------------------------------

/**
 * The gated backlog: rows that passed the relevance gate and nothing has
 * claimed yet. 'discovered' is the schema default every source writes, so
 * this is the pool the plan clusters — planned/queued/published rows already
 * belong to a type or an article.
 */
async function getPlannableBacklog(projectId: string) {
  return db
    .select({
      id: keywordBacklog.id,
      keyword: keywordBacklog.keyword,
      searchVolume: keywordBacklog.searchVolume,
      keywordDifficulty: keywordBacklog.keywordDifficulty,
      notesJson: keywordBacklog.notesJson,
    })
    .from(keywordBacklog)
    .where(
      and(
        eq(keywordBacklog.projectId, projectId),
        eq(keywordBacklog.status, "discovered"),
      ),
    );
}

/** How many rows the plan would cluster — the tab's stamp reads it on every
 *  poll, which is why it is a count and not the rows themselves. */
async function countPlannableBacklog(projectId: string): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(keywordBacklog)
    .where(
      and(
        eq(keywordBacklog.projectId, projectId),
        eq(keywordBacklog.status, "discovered"),
      ),
    );
  return rows[0]?.value ?? 0;
}

/** Keywords actually bound to a type — what instanceCount is set from after
 *  an approval, so the card's page count is a stored fact rather than what
 *  the binding intended. */
async function countBoundKeywords(pageTypeId: string): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(keywordBacklog)
    .where(eq(keywordBacklog.pageTypeId, pageTypeId));
  return rows[0]?.value ?? 0;
}

/** One page of the keywords bound to an approved type, worst-to-best demand
 *  order matching the card's own ranking. */
async function getBoundKeywords(
  pageTypeId: string,
  limit: number,
  offset: number,
) {
  return db
    .select({
      id: keywordBacklog.id,
      keyword: keywordBacklog.keyword,
      searchVolume: keywordBacklog.searchVolume,
      keywordDifficulty: keywordBacklog.keywordDifficulty,
    })
    .from(keywordBacklog)
    .where(eq(keywordBacklog.pageTypeId, pageTypeId))
    .orderBy(desc(keywordBacklog.searchVolume), keywordBacklog.keyword)
    .limit(limit)
    .offset(offset);
}

/** Tracked competitors and the earning pages S4a stored for them. Removed
 *  pages are excluded (they are gone); decayed ones stay — a page that earned
 *  and then slipped still proves the shape earns in this niche. */
async function getEvidenceCompetitors(projectId: string) {
  const [tracked, pages] = await Promise.all([
    db
      .select({
        id: competitors.id,
        domain: competitors.domain,
        studySummaryJson: competitors.studySummaryJson,
      })
      .from(competitors)
      .where(
        and(
          eq(competitors.projectId, projectId),
          eq(competitors.status, "tracked"),
        ),
      ),
    db
      .select({
        competitorId: competitorPages.competitorId,
        url: competitorPages.url,
        etv: competitorPages.etv,
      })
      .from(competitorPages)
      .innerJoin(competitors, eq(competitorPages.competitorId, competitors.id))
      .where(
        and(
          eq(competitors.projectId, projectId),
          eq(competitors.status, "tracked"),
          ne(competitorPages.status, "removed"),
        ),
      ),
  ]);
  return { tracked, pages };
}

/**
 * The only authority comparison rankloop actually holds: our own domain rank
 * from the newest backlink snapshot, against the ranks stored on the tracked
 * competitors. Both sides are stored numbers from the same provider's scale —
 * nothing here is derived from a SERP result, because per-result authority is
 * exactly what the plan does not know.
 *
 * Snapshots are append-only and rank is nullable, so the newest row is not
 * necessarily the newest row that measured a rank; ordering the non-null ones
 * is what makes this the latest rank we have rather than the latest silence.
 */
async function getAuthorityComparison(projectId: string) {
  const [ourRows, competitorRows] = await Promise.all([
    db
      .select({ rank: backlinkSnapshots.rank })
      .from(backlinkSnapshots)
      .where(
        and(
          eq(backlinkSnapshots.projectId, projectId),
          isNotNull(backlinkSnapshots.rank),
        ),
      )
      .orderBy(desc(backlinkSnapshots.capturedAt))
      .limit(1),
    db
      .select({ domain: competitors.domain, rank: competitors.domainRank })
      .from(competitors)
      .where(
        and(
          eq(competitors.projectId, projectId),
          eq(competitors.status, "tracked"),
          isNotNull(competitors.domainRank),
        ),
      ),
  ]);
  return { ourRank: ourRows[0]?.rank ?? null, competitors: competitorRows };
}

/** Word counts of our own posts — the corpus median a contract's word band is
 *  reported against. Crawl-measured rows only; a publish-appended row has no
 *  measurement yet. */
async function getPostWordCounts(projectId: string) {
  return db
    .select({ wordCount: contentPages.wordCount })
    .from(contentPages)
    .where(
      and(eq(contentPages.projectId, projectId), eq(contentPages.kind, "post")),
    );
}

// ---------------------------------------------------------------------------
// page_types writes
// ---------------------------------------------------------------------------

async function getPageTypes(projectId: string) {
  return db
    .select()
    .from(pageTypes)
    .where(eq(pageTypes.projectId, projectId))
    .orderBy(desc(pageTypes.demand));
}

/**
 * Write one proposed type. The conflict target is the (project, name) unique,
 * and the set clause deliberately refreshes only what detection re-derived:
 * `status`, `serpCheckJson` and `decidedAt` are owned by the SERP step and by
 * the user, so a recompute never resurrects a type the last run killed or
 * re-opens one somebody declined.
 */
async function upsertPageType(row: PageTypeUpsert): Promise<string> {
  const inserted = await db
    .insert(pageTypes)
    .values({ id: crypto.randomUUID(), status: "proposed", ...row })
    .onConflictDoUpdate({
      target: [pageTypes.projectId, pageTypes.name],
      set: {
        kind: row.kind,
        urlPattern: row.urlPattern,
        keywordPattern: row.keywordPattern,
        templateContractJson: row.templateContractJson,
        evidenceJson: row.evidenceJson,
        demand: row.demand,
        instanceCount: row.instanceCount,
      },
    })
    .returning({ id: pageTypes.id });
  return inserted[0].id;
}

async function updatePageType(
  pageTypeId: string,
  data: Partial<InferInsertModel<typeof pageTypes>>,
): Promise<void> {
  await db.update(pageTypes).set(data).where(eq(pageTypes.id, pageTypeId));
}

/**
 * Store a sampled verdict and let it move the type between 'proposed' and
 * 'declined'. Scoped to rows the planner still owns (no decidedAt): if the
 * user approved this type while the run's SERP step was in flight, their
 * decision stands and the verdict is dropped — a plan run must never
 * un-approve something a human approved.
 */
async function applySerpCheck(input: {
  pageTypeId: string;
  serpCheckJson: string;
  status: "proposed" | "declined";
}): Promise<void> {
  await db
    .update(pageTypes)
    .set({ serpCheckJson: input.serpCheckJson, status: input.status })
    .where(
      and(
        eq(pageTypes.id, input.pageTypeId),
        isNull(pageTypes.decidedAt),
        inArray(pageTypes.status, ["proposed", "declined"]),
      ),
    );
}

/**
 * Drop planner-owned types this run no longer detects.
 *
 * Scoped to rows the planner owns — proposed or declined with no decidedAt —
 * so an approved type and a user-declined one both survive a recompute that
 * stopped detecting them. Without this, a backlog that shifted would leave
 * yesterday's shapes on the tab forever with counts nobody can reproduce.
 * keyword_backlog.pageTypeId is ON DELETE SET NULL, so any keyword bound to a
 * deleted row simply returns to the pool.
 */
async function deleteUndetectedPlannerTypes(
  projectId: string,
  keepIds: string[],
): Promise<void> {
  const scope = and(
    eq(pageTypes.projectId, projectId),
    inArray(pageTypes.status, ["proposed", "declined"]),
    isNull(pageTypes.decidedAt),
  );
  await db
    .delete(pageTypes)
    .where(
      keepIds.length === 0
        ? scope
        : and(scope, notInArray(pageTypes.id, keepIds)),
    );
}

async function getPageTypeById(projectId: string, pageTypeId: string) {
  const rows = await db
    .select()
    .from(pageTypes)
    .where(
      and(eq(pageTypes.id, pageTypeId), eq(pageTypes.projectId, projectId)),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** Approve or decline, valid only from 'proposed'. The status predicate makes
 *  the update itself the compare-and-set, so two racing decisions can't both
 *  win (the proposals idiom). */
async function updateDecision(input: {
  projectId: string;
  pageTypeId: string;
  status: "approved" | "declined";
  decidedAt: string;
}) {
  const updated = await db
    .update(pageTypes)
    .set({ status: input.status, decidedAt: input.decidedAt })
    .where(
      and(
        eq(pageTypes.id, input.pageTypeId),
        eq(pageTypes.projectId, input.projectId),
        eq(pageTypes.status, "proposed"),
      ),
    )
    .returning();
  return updated[0] ?? null;
}

// ---------------------------------------------------------------------------
// Keyword binding (approval)
// ---------------------------------------------------------------------------

/**
 * Bind the approved type's keywords: pageTypeId set, status flipped to
 * 'planned'.
 *
 * The predicate only takes rows that are still unclaimed and still
 * 'discovered'. A keyword already bound to an approved type keeps that type —
 * two page types can legitimately match the same keyword, and first approval
 * wins rather than the later one silently stealing rows out from under an
 * approved template.
 */
async function bindKeywordsToPageType(input: {
  projectId: string;
  pageTypeId: string;
  keywordIds: string[];
}): Promise<void> {
  await executeInBatches(input.keywordIds, (tx, keywordId) =>
    tx
      .update(keywordBacklog)
      .set({
        pageTypeId: input.pageTypeId,
        status: "planned",
        updatedAt: new Date().toISOString(),
      })
      .where(
        and(
          eq(keywordBacklog.id, keywordId),
          eq(keywordBacklog.projectId, input.projectId),
          eq(keywordBacklog.status, "discovered"),
          isNull(keywordBacklog.pageTypeId),
        ),
      ),
  );
}

// ---------------------------------------------------------------------------
// SERP snapshots
// ---------------------------------------------------------------------------

/** Persist one plan-time SERP. purpose='plan' is what makes S7's briefs able
 *  to reuse it — the sample is paid for once and read twice. */
async function insertSerpSnapshot(row: {
  projectId: string;
  keyword: string;
  organicJson: string;
  paaJson: string | null;
  featuresJson: string;
}): Promise<void> {
  await db.insert(serpSnapshots).values({ ...row, purpose: "plan" });
}

export const PagePlanRepository = {
  tryCreateRun,
  updateRun,
  getRunById,
  getActiveRunForProject,
  getLatestRunForProject,
  getPlannableBacklog,
  countPlannableBacklog,
  countBoundKeywords,
  getBoundKeywords,
  getEvidenceCompetitors,
  getAuthorityComparison,
  getPostWordCounts,
  getPageTypes,
  getPageTypeById,
  upsertPageType,
  updatePageType,
  applySerpCheck,
  deleteUndetectedPlannerTypes,
  updateDecision,
  bindKeywordsToPageType,
  insertSerpSnapshot,
};
