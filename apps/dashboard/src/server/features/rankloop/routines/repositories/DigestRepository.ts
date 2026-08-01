import { and, desc, eq, gte, isNotNull, isNull, lt } from "drizzle-orm";
import { db } from "@/db";
import {
  articles,
  contentPages,
  digests,
  projects,
  receipts,
} from "@/db/schema";

// Reads and the one write behind the daily digest. Every read is bounded by
// the reporting day or by a small limit: the digest runs once a morning and
// must never become the query that makes the morning slow.

/**
 * Articles that went live during the reporting day.
 *
 * Bounded by string comparison on the ISO stamp rather than by a date
 * function, because `published_at` is text in both dialects and only one of
 * them would agree about what `date()` means.
 */
async function getShippedBetween(input: {
  projectId: string;
  /** Inclusive ISO lower bound. */
  fromIso: string;
  /** Exclusive ISO upper bound. */
  toIso: string;
}) {
  return db
    .select({
      articleId: articles.id,
      title: articles.title,
      keyword: articles.keyword,
      url: articles.publishedUrl,
    })
    .from(articles)
    .where(
      and(
        eq(articles.projectId, input.projectId),
        eq(articles.status, "published"),
        gte(articles.publishedAt, input.fromIso),
        lt(articles.publishedAt, input.toIso),
      ),
    )
    .orderBy(desc(articles.publishedAt));
}

/** Receipts whose measurement landed during the reporting day. The page path
 *  comes along so the digest can name what was measured; a receipt outlives
 *  its page, and the pinned target query is what is left when it does. */
async function getMeasuredBetween(input: {
  projectId: string;
  fromIso: string;
  toIso: string;
}) {
  return db
    .select({
      receiptId: receipts.id,
      actionType: receipts.actionType,
      targetQuery: receipts.targetQuery,
      pagePath: contentPages.path,
      baselineJson: receipts.baselineJson,
      resultJson: receipts.resultJson,
    })
    .from(receipts)
    .leftJoin(
      contentPages,
      and(
        eq(contentPages.id, receipts.contentPageId),
        eq(contentPages.projectId, receipts.projectId),
      ),
    )
    .where(
      and(
        eq(receipts.projectId, input.projectId),
        eq(receipts.status, "measured"),
        gte(receipts.measuredAt, input.fromIso),
        lt(receipts.measuredAt, input.toIso),
      ),
    );
}

/** How many stuck drafts the digest is willing to name before it stops being
 *  a digest. A project with thirty failing drafts has one problem, not
 *  thirty, and the count in the headline already says so. */
const MAX_GATE_FAILURES_LISTED = 5;

/** Drafts the laws sent back, waiting on a human. Newest first — the ones
 *  someone is most likely to still remember writing. */
async function getGateFailures(projectId: string) {
  return db
    .select({
      title: articles.title,
      keyword: articles.keyword,
      attempts: articles.attempts,
      lawReportJson: articles.lawReportJson,
    })
    .from(articles)
    .where(
      and(
        eq(articles.projectId, projectId),
        eq(articles.status, "failed"),
        isNotNull(articles.lawReportJson),
      ),
    )
    .orderBy(desc(articles.updatedAt))
    .limit(MAX_GATE_FAILURES_LISTED);
}

/**
 * Store the day's digest. Returns false when one already existed.
 *
 * `onConflictDoNothing` on the (project, date) unique is what makes the
 * morning routine safe to run twice — a retry, or both dispatchers waking on
 * the same clock, must not produce two cards or overwrite the first with a
 * later re-read of mutable rows.
 */
async function insertDigest(input: {
  projectId: string;
  forDate: string;
  payloadJson: string;
}): Promise<boolean> {
  const rows = await db
    .insert(digests)
    .values({ id: crypto.randomUUID(), ...input })
    .onConflictDoNothing({
      target: [digests.projectId, digests.forDate],
    })
    .returning({ id: digests.id });
  return rows.length > 0;
}

/**
 * Live projects that have no digest for `forDate` yet.
 *
 * The block's whole admission rule, and it is a single indexed anti-join
 * against the same unique the insert conflicts on — so "already written
 * today" is one fact with one definition rather than a schedule the dispatch
 * layer keeps separately and could disagree with. `projectId` narrows the
 * identical predicate to one project, which is what lets the cron sweep and
 * the Durable Object alarm share it.
 */
async function getProjectsWithoutDigest(input: {
  forDate: string;
  limit: number;
  projectId?: string;
}) {
  return db
    .select({ projectId: projects.id })
    .from(projects)
    .leftJoin(
      digests,
      and(
        eq(digests.projectId, projects.id),
        eq(digests.forDate, input.forDate),
      ),
    )
    .where(
      and(
        isNull(projects.archivedAt),
        isNull(digests.id),
        input.projectId ? eq(projects.id, input.projectId) : undefined,
      ),
    )
    .orderBy(projects.id)
    .limit(input.limit);
}

/** The Dashboard card's week. */
async function getRecentDigests(projectId: string, limit: number) {
  return db
    .select()
    .from(digests)
    .where(eq(digests.projectId, projectId))
    .orderBy(desc(digests.forDate))
    .limit(limit);
}

export const DigestRepository = {
  getShippedBetween,
  getMeasuredBetween,
  getGateFailures,
  insertDigest,
  getProjectsWithoutDigest,
  getRecentDigests,
};
