import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
  contentPages,
  keywordBacklog,
  serpSnapshots,
  writerSettings,
} from "@/db/schema";

// Everything a brief reads that no other rankloop repository already owns.
// The proposal, the page type and the approved-type list come from
// ProposalsRepository and PagePlanRepository — a brief is assembled from
// stored facts, and re-querying them here would be a second definition of
// what those facts are.

/**
 * Pages the brief may offer as internal links, newest first.
 *
 * Posts and hubs only: a manifest 'page' row is the site's product surface
 * (pricing, docs, about), and spending an article's link budget there is a
 * sales decision the brief has no business making. Bounded because the engine
 * offers at most fourteen candidates and a pSEO corpus can run to thousands of
 * rows — reading the newest few hundred finds the same-category neighbors
 * without pulling the whole manifest into memory for every drawer open.
 */
const LINK_CANDIDATE_SCAN_LIMIT = 500;

async function getLinkablePages(projectId: string) {
  return db
    .select({
      path: contentPages.path,
      title: contentPages.title,
      category: contentPages.category,
    })
    .from(contentPages)
    .where(
      and(
        eq(contentPages.projectId, projectId),
        inArray(contentPages.kind, ["post", "hub"]),
      ),
    )
    .orderBy(desc(contentPages.publishedAt))
    .limit(LINK_CANDIDATE_SCAN_LIMIT);
}

async function getKeywordRow(projectId: string, keywordBacklogId: string) {
  const rows = await db
    .select({
      keyword: keywordBacklog.keyword,
      category: keywordBacklog.category,
      format: keywordBacklog.format,
      searchVolume: keywordBacklog.searchVolume,
      keywordDifficulty: keywordBacklog.keywordDifficulty,
      intent: keywordBacklog.intent,
      score: keywordBacklog.score,
      source: keywordBacklog.source,
      notesJson: keywordBacklog.notesJson,
    })
    .from(keywordBacklog)
    .where(
      and(
        eq(keywordBacklog.id, keywordBacklogId),
        eq(keywordBacklog.projectId, projectId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * The newest snapshot of one purpose for a keyword.
 *
 * serp_snapshots is a history table with no unique, so "the snapshot" is
 * always the newest row — which is what lets a brief reuse the sample the page
 * plan already paid for instead of buying the same SERP twice.
 */
async function getLatestSerpSnapshot(
  projectId: string,
  keyword: string,
  purpose: "plan" | "grounding",
) {
  const rows = await db
    .select({
      organicJson: serpSnapshots.organicJson,
      paaJson: serpSnapshots.paaJson,
      fetchedAt: serpSnapshots.fetchedAt,
    })
    .from(serpSnapshots)
    .where(
      and(
        eq(serpSnapshots.projectId, projectId),
        eq(serpSnapshots.keyword, keyword),
        eq(serpSnapshots.purpose, purpose),
      ),
    )
    .orderBy(desc(serpSnapshots.fetchedAt))
    .limit(1);
  return rows[0] ?? null;
}

/** Persist a SERP this brief paid for. purpose='grounding' is what tells the
 *  next reader it was bought for a writer, not for a plan verdict. */
async function insertGroundingSerpSnapshot(row: {
  projectId: string;
  keyword: string;
  organicJson: string;
  paaJson: string | null;
  featuresJson: string;
}): Promise<void> {
  await db.insert(serpSnapshots).values({ ...row, purpose: "grounding" });
}

/** Null when the project has never saved any — the caller runs on defaults
 *  and, for the voice card, says so in the brief. */
async function getWriterSettings(projectId: string) {
  const rows = await db
    .select()
    .from(writerSettings)
    .where(eq(writerSettings.projectId, projectId))
    .limit(1);
  return rows[0] ?? null;
}

export const BriefRepository = {
  getLinkablePages,
  getKeywordRow,
  getLatestSerpSnapshot,
  insertGroundingSerpSnapshot,
  getWriterSettings,
};
