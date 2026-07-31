import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { db } from "@/db";
import { keywordBacklog, projectGate } from "@/db/schema";
import type { KeywordBacklogSource } from "@/types/schemas/rankloopUniverse";

// The human half of the keyword universe: reading the backlog a run produced,
// skipping rows that are somebody else's keywords, and editing the gate by
// hand. Kept apart from UniverseRepository — everything there is written by a
// workflow step, everything here by a person clicking, and the two have
// opposite rules about overwriting each other (a run must never touch an
// edited gate; a person may always touch a derived one).

// ---------------------------------------------------------------------------
// The backlog table
// ---------------------------------------------------------------------------

/**
 * One page of the Keywords table, as the endpoint asks for it.
 *
 * `sort` names a column rather than accepting an expression: these four are
 * the only ones the table offers, score is the one the engine actually orders
 * selection by, and the other three exist because a founder scanning a
 * thousand rows wants "what is the biggest thing in here" without leaving the
 * tab. The union is the whitelist — an unindexed sort can never arrive.
 */
type BacklogQuery = {
  projectId: string;
  sources: KeywordBacklogSource[] | null;
  search: string | null;
  page: number;
  pageSize: number;
  sort: "score" | "keyword" | "searchVolume" | "keywordDifficulty";
  order: "asc" | "desc";
};

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * The filter both the page query and its count read, so the two can never
 * disagree about how many rows the user is looking at.
 *
 * Search is lower()'d on both sides rather than using ILIKE: ILIKE is
 * Postgres-only, and the same query has to run on D1.
 */
function backlogWhere(query: BacklogQuery): SQL | undefined {
  const clauses: SQL[] = [eq(keywordBacklog.projectId, query.projectId)];
  if (query.sources && query.sources.length > 0) {
    clauses.push(inArray(keywordBacklog.source, query.sources));
  }
  const search = query.search?.trim();
  if (search) {
    clauses.push(
      sql`lower(${keywordBacklog.keyword}) like ${`%${escapeLike(
        search.toLowerCase(),
      )}%`} escape '\\'`,
    );
  }
  return and(...clauses);
}

async function listBacklog(query: BacklogQuery) {
  const column = keywordBacklog[query.sort];
  const direction = query.order === "asc" ? asc : desc;
  return (
    db
      .select({
        id: keywordBacklog.id,
        keyword: keywordBacklog.keyword,
        source: keywordBacklog.source,
        searchVolume: keywordBacklog.searchVolume,
        keywordDifficulty: keywordBacklog.keywordDifficulty,
        intent: keywordBacklog.intent,
        score: keywordBacklog.score,
        status: keywordBacklog.status,
        clusterKey: keywordBacklog.clusterKey,
      })
      .from(keywordBacklog)
      .where(backlogWhere(query))
      // The keyword breaks ties: without it, two rows scored identically can
      // swap places between pages and the same row appears twice.
      .orderBy(direction(column), asc(keywordBacklog.keyword))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize)
  );
}

async function countBacklogRows(query: BacklogQuery): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(keywordBacklog)
    .where(backlogWhere(query));
  return rows[0]?.value ?? 0;
}

/** Per-source totals for the filter row, unfiltered on purpose: a source with
 *  zero rows still has to be offerable, or the filter can never be widened
 *  back out once it has been narrowed. */
async function countBacklogBySource(projectId: string) {
  return db
    .select({ source: keywordBacklog.source, value: count() })
    .from(keywordBacklog)
    .where(eq(keywordBacklog.projectId, projectId))
    .groupBy(keywordBacklog.source);
}

/**
 * Mark rows skipped. Project-scoped as well as id-scoped — the ids come from
 * a client, and an id alone would let one project's selection edit another's
 * rows.
 *
 * Rows already bound to a page type are left alone: skipping a keyword an
 * approved type is built on would leave the type claiming pages its backlog
 * no longer offers, and the page plan has no way to notice.
 */
async function skipKeywords(input: {
  projectId: string;
  keywordIds: string[];
}): Promise<number> {
  if (input.keywordIds.length === 0) return 0;
  const updated = await db
    .update(keywordBacklog)
    .set({ status: "skipped", updatedAt: new Date().toISOString() })
    .where(
      and(
        eq(keywordBacklog.projectId, input.projectId),
        inArray(keywordBacklog.id, input.keywordIds),
        eq(keywordBacklog.status, "discovered"),
      ),
    )
    .returning({ id: keywordBacklog.id });
  return updated.length;
}

// ---------------------------------------------------------------------------
// The hand-edited gate
// ---------------------------------------------------------------------------

/**
 * Store tokens a human chose, and flip user_edited.
 *
 * The flag is set in the same statement as the tokens rather than by a second
 * write: it is what stops the next derivation overwriting this edit, and a
 * window where the tokens are saved but the flag is not is a window where a
 * scheduled run erases somebody's work.
 */
async function saveEditedGate(input: {
  projectId: string;
  positivesJson: string;
  negativesJson: string;
}): Promise<boolean> {
  const updated = await db
    .update(projectGate)
    .set({
      positivesJson: input.positivesJson,
      negativesJson: input.negativesJson,
      userEdited: true,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(projectGate.projectId, input.projectId))
    .returning({ id: projectGate.id });
  return updated.length > 0;
}

export const CurationRepository = {
  listBacklog,
  countBacklogRows,
  countBacklogBySource,
  skipKeywords,
  saveEditedGate,
};
