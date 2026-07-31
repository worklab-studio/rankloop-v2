import { and, count, eq, gte, isNotNull } from "drizzle-orm";
import type { InferInsertModel } from "drizzle-orm";
import { db } from "@/db";
import { executeInBatches } from "@/db/runBatch";
import {
  contentPages,
  gscPages,
  gscPerformance,
  gscQueries,
  keywordBacklog,
  keywordMetrics,
  projectGate,
} from "@/db/schema";
import { FIXED_KD_CEILING } from "@/server/features/rankloop/universe/kdCeiling.logic";

/** Which step found the keyword. Read off the column rather than restated,
 *  so adding a source to the schema is a compile error here and not a run
 *  that writes a value the enum rejects. */
export type BacklogSource = InferInsertModel<typeof keywordBacklog>["source"];

/** One row destined for keyword_backlog, already gated, classified and
 *  scored. The projectId is passed once, alongside. */
export type BacklogUpsert = {
  keyword: string;
  source: BacklogSource;
  seed: string | null;
  category: string | null;
  format: string | null;
  searchVolume: number | null;
  keywordDifficulty: number | null;
  intent: string | null;
  score: number;
  clusterKey: string | null;
  notesJson: string | null;
};

// ---------------------------------------------------------------------------
// The gate row
// ---------------------------------------------------------------------------

async function getGate(projectId: string) {
  const rows = await db
    .select()
    .from(projectGate)
    .where(eq(projectGate.projectId, projectId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Write a freshly derived gate, and only over a gate nobody has edited.
 *
 * Insert-then-scoped-update rather than an upsert with a conditional SET,
 * because the never-overwrite rule has to survive a caller that forgot about
 * it: the UPDATE's own predicate is the enforcement, so a re-derive fired at
 * an edited row updates zero rows and says so. Returns whether it wrote.
 */
async function saveDerivedGate(input: {
  projectId: string;
  positivesJson: string;
  negativesJson: string;
  brandTokensJson: string;
}): Promise<boolean> {
  const now = new Date().toISOString();
  const inserted = await db
    .insert(projectGate)
    .values({
      id: crypto.randomUUID(),
      ...input,
      derivedAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: projectGate.id });
  if (inserted.length > 0) return true;

  const updated = await db
    .update(projectGate)
    .set({
      positivesJson: input.positivesJson,
      negativesJson: input.negativesJson,
      brandTokensJson: input.brandTokensJson,
      derivedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(projectGate.projectId, input.projectId),
        eq(projectGate.userEdited, false),
      ),
    )
    .returning({ id: projectGate.id });
  return updated.length > 0;
}

/** Store a recomputed ceiling. kdCeilingUpdatedAt is null on the fixed
 *  branch — the card needs to tell "earned from 14 rankings" apart from "this
 *  is where everyone starts", and a timestamp on an unearned number would
 *  lie about that. */
async function updateKdCeiling(input: {
  projectId: string;
  kdCeiling: number;
  kdCeilingUpdatedAt: string | null;
}): Promise<void> {
  await db
    .update(projectGate)
    .set({
      kdCeiling: input.kdCeiling,
      kdCeilingUpdatedAt: input.kdCeilingUpdatedAt,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(projectGate.projectId, input.projectId));
}

/**
 * The project's difficulty ceiling, or the fixed floor when it has no gate
 * row yet. Read by the page plan's caution rule as well as by this feature,
 * which is why it answers with a number instead of a nullable row: a project
 * that has never run the universe step still has a ceiling, it just hasn't
 * earned a different one.
 */
async function getKdCeiling(projectId: string): Promise<number> {
  const rows = await db
    .select({ kdCeiling: projectGate.kdCeiling })
    .from(projectGate)
    .where(eq(projectGate.projectId, projectId))
    .limit(1);
  return rows[0]?.kdCeiling ?? FIXED_KD_CEILING;
}

// ---------------------------------------------------------------------------
// Evidence reads
// ---------------------------------------------------------------------------

/**
 * Day-grain (page, query) rows since `since`, joined to their URL and query
 * text. Raw daily rows, not SQL aggregates — the impressions-weighted rollup
 * and the sentinel exclusion are pure logic under test, and the same read
 * feeds the gate's query evidence, the KD ceiling's samples and the unserved
 * candidates, so it happens once per run rather than three times.
 */
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

/** Titles and paths from the maintained manifest — the published half of the
 *  gate's evidence. Every kind counts, utility rows included: their paths are
 *  where the CMS plumbing lives, and the tokenizer drops that anyway. */
async function getContentPageDocuments(projectId: string) {
  return db
    .select({ title: contentPages.title, path: contentPages.path })
    .from(contentPages)
    .where(eq(contentPages.projectId, projectId));
}

/** Primary keywords the site's pages already target — the unserved step's
 *  "somebody already wrote this" check. */
async function getContentPageKeywords(projectId: string): Promise<string[]> {
  const rows = await db
    .select({ keyword: contentPages.keyword })
    .from(contentPages)
    .where(
      and(
        eq(contentPages.projectId, projectId),
        isNotNull(contentPages.keyword),
      ),
    );
  return rows.flatMap((row) => (row.keyword === null ? [] : [row.keyword]));
}

/** Every backlog keyword with its notes. One read serves two callers: the
 *  unserved step needs the keywords to avoid re-admitting what it already
 *  admitted, and the upsert path needs the notes to merge into rather than
 *  overwrite. */
async function getBacklogKeywordNotes(projectId: string) {
  return db
    .select({
      keyword: keywordBacklog.keyword,
      notesJson: keywordBacklog.notesJson,
    })
    .from(keywordBacklog)
    .where(eq(keywordBacklog.projectId, projectId));
}

/**
 * Difficulties from the project's upstream metrics cache, for the project's
 * own location and language.
 *
 * The whole priced set in one read rather than a chunked IN() over the
 * top-10 query list: D1 caps bound parameters near 100, so matching a few
 * hundred ranked queries would cost several round trips to answer a question
 * that is one small table scan. Rows without a KD are excluded here — the
 * ceiling has no use for them and neither does anything else on this path.
 */
async function getKeywordDifficulties(input: {
  projectId: string;
  locationCode: number;
  languageCode: string;
}) {
  return db
    .select({
      keyword: keywordMetrics.keyword,
      keywordDifficulty: keywordMetrics.keywordDifficulty,
    })
    .from(keywordMetrics)
    .where(
      and(
        eq(keywordMetrics.projectId, input.projectId),
        eq(keywordMetrics.locationCode, input.locationCode),
        eq(keywordMetrics.languageCode, input.languageCode),
        isNotNull(keywordMetrics.keywordDifficulty),
      ),
    );
}

// ---------------------------------------------------------------------------
// The backlog write
// ---------------------------------------------------------------------------

/**
 * Upsert gated rows on (project_id, keyword).
 *
 * The SET clause refreshes what a source can legitimately re-derive and
 * nothing else. `status`, `page_type_id` and `created_at` belong to the plan
 * and to the user — a weekly autocomplete run must not drag a published
 * keyword back to 'discovered'. `source` and `seed` are provenance: the row
 * records where it was FIRST found, so a keyword discovered from Search
 * Console evidence does not quietly become an autocomplete row because a
 * later step saw it too.
 */
async function upsertBacklogRows(
  projectId: string,
  rows: BacklogUpsert[],
): Promise<void> {
  const now = new Date().toISOString();
  await executeInBatches(rows, (tx, row) =>
    tx
      .insert(keywordBacklog)
      .values({ id: crypto.randomUUID(), projectId, ...row, updatedAt: now })
      .onConflictDoUpdate({
        target: [keywordBacklog.projectId, keywordBacklog.keyword],
        set: {
          category: row.category,
          format: row.format,
          searchVolume: row.searchVolume,
          keywordDifficulty: row.keywordDifficulty,
          intent: row.intent,
          score: row.score,
          clusterKey: row.clusterKey,
          notesJson: row.notesJson,
          updatedAt: now,
        },
      }),
  );
}

/** How many rows the backlog holds — the tab's "312 in the backlog" spine
 *  entry and the run stamp's denominator. */
async function countBacklog(projectId: string): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(keywordBacklog)
    .where(eq(keywordBacklog.projectId, projectId));
  return rows[0]?.value ?? 0;
}

export const UniverseRepository = {
  getGate,
  saveDerivedGate,
  updateKdCeiling,
  getKdCeiling,
  getDailyPageQueryRows,
  getContentPageDocuments,
  getContentPageKeywords,
  getBacklogKeywordNotes,
  getKeywordDifficulties,
  upsertBacklogRows,
  countBacklog,
};
