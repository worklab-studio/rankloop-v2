import {
  and,
  asc,
  count,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  max,
  or,
  sql,
} from "drizzle-orm";
import { db } from "@/db";
import { executeInBatches } from "@/db/runBatch";
import {
  contentPages,
  gscConnections,
  indexationChecks,
  projects,
} from "@/db/schema";

// ---------------------------------------------------------------------------
// The rate's inputs
// ---------------------------------------------------------------------------

/**
 * The site's own posts, back to the far edge of the cohort window.
 *
 * `source: 'publish'` only, unlike the quota's evidence: the throttle is a
 * verdict on what this engine published, and folding in the pages that were on
 * the site before rankloop arrived would let a well-indexed legacy corpus mask
 * a pipeline that is failing on everything it ships.
 *
 * The upper edge is left to the pure function. publishedAt holds a bare date
 * on some rows and a full ISO stamp on others, and a SQL `<=` against a day
 * string quietly drops every stamped row on that day.
 */
async function getPublishedPagesSince(
  projectId: string,
  publishedFrom: string,
) {
  const rows = await db
    .select({
      url: contentPages.url,
      publishedAt: contentPages.publishedAt,
    })
    .from(contentPages)
    .where(
      and(
        eq(contentPages.projectId, projectId),
        eq(contentPages.source, "publish"),
        isNotNull(contentPages.publishedAt),
        gte(contentPages.publishedAt, publishedFrom),
      ),
    );
  return rows.flatMap((row) =>
    row.publishedAt === null
      ? []
      : [{ url: row.url, publishedAt: row.publishedAt }],
  );
}

/**
 * Every check written since `since`, for the pure function to reduce to one
 * per URL.
 *
 * Bounded by the same date the cohort is: a cohort page was published at most
 * 45 days ago, so no check of it can be older than that, and reading the whole
 * history would grow this query without ever changing its answer.
 */
async function getChecksSince(projectId: string, since: string) {
  return db
    .select({
      url: indexationChecks.url,
      verdict: indexationChecks.verdict,
      checkedAt: indexationChecks.checkedAt,
    })
    .from(indexationChecks)
    .where(
      and(
        eq(indexationChecks.projectId, projectId),
        gte(indexationChecks.checkedAt, since),
      ),
    );
}

/** One URL's most recent verdict, as the article screens render it. */
type LatestCheck = {
  verdict: string;
  coverageState: string | null;
  checkedAt: string;
};

/**
 * The latest check for each of the given URLs, keyed by URL.
 *
 * Read whole and reduced in memory rather than with a per-URL correlated
 * subquery: the callers ask about one article or one screenful, the index on
 * (project, url, checked_at) already covers the scan, and a page's history is
 * a handful of rows because the job rechecks weekly.
 */
async function getLatestChecks(
  projectId: string,
  urls: string[],
): Promise<Map<string, LatestCheck>> {
  if (urls.length === 0) return new Map();
  const rows = await db
    .select({
      url: indexationChecks.url,
      verdict: indexationChecks.verdict,
      coverageState: indexationChecks.coverageState,
      checkedAt: indexationChecks.checkedAt,
    })
    .from(indexationChecks)
    .where(
      and(
        eq(indexationChecks.projectId, projectId),
        inArray(indexationChecks.url, urls),
      ),
    );

  const latest = new Map<string, LatestCheck>();
  for (const row of rows) {
    const held = latest.get(row.url);
    if (held === undefined || row.checkedAt > held.checkedAt) {
      latest.set(row.url, {
        verdict: row.verdict,
        coverageState: row.coverageState,
        checkedAt: row.checkedAt,
      });
    }
  }
  return latest;
}

// ---------------------------------------------------------------------------
// The daily job
// ---------------------------------------------------------------------------

/**
 * Cohort pages whose latest check has gone stale, oldest post first.
 *
 * Oldest first is what makes a partial sweep honest rather than flattering: a
 * post approaching the 45-day edge is about to leave the cohort for good, and
 * it is also the one most likely to be a page Google looked at and declined.
 *
 * `publishedBefore` is exclusive for the mixed-format reason above — pass the
 * day after the youngest cohort day, not the day itself.
 */
async function getPagesDueForCheck(input: {
  projectId: string;
  publishedFrom: string;
  publishedBefore: string;
  /** ISO instant; a URL last checked before this is due again. */
  staleBefore: string;
  limit: number;
}) {
  const latestChecks = db
    .select({
      url: indexationChecks.url,
      latestCheckedAt: max(indexationChecks.checkedAt).as("latest_checked_at"),
    })
    .from(indexationChecks)
    .where(eq(indexationChecks.projectId, input.projectId))
    .groupBy(indexationChecks.url)
    .as("latest_checks");

  return db
    .select({ url: contentPages.url })
    .from(contentPages)
    .leftJoin(latestChecks, eq(latestChecks.url, contentPages.url))
    .where(
      and(
        eq(contentPages.projectId, input.projectId),
        eq(contentPages.source, "publish"),
        isNotNull(contentPages.publishedAt),
        gte(contentPages.publishedAt, input.publishedFrom),
        lt(contentPages.publishedAt, input.publishedBefore),
        or(
          isNull(latestChecks.latestCheckedAt),
          lt(latestChecks.latestCheckedAt, input.staleBefore),
        ),
      ),
    )
    .orderBy(asc(contentPages.publishedAt))
    .limit(input.limit);
}

/** How much of today's per-project URL Inspection budget is already spent.
 *  The cron ticks every 15 minutes and a checked page stays fresh for a week,
 *  so without this a single day would sweep the whole cohort 96 times over. */
async function countChecksSince(
  projectId: string,
  since: string,
): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(indexationChecks)
    .where(
      and(
        eq(indexationChecks.projectId, projectId),
        gte(indexationChecks.checkedAt, since),
      ),
    );
  return rows[0]?.value ?? 0;
}

type IndexationCheckInsert = {
  projectId: string;
  url: string;
  verdict: string;
  coverageState: string | null;
  checkedAt: string;
};

/** Append this run's verdicts. History, not state: keeping the old rows is
 *  what lets a later reader tell "not indexed yet" from "dropped out". */
async function insertChecks(rows: IndexationCheckInsert[]): Promise<void> {
  await executeInBatches(rows, (tx, row) =>
    tx.insert(indexationChecks).values(row),
  );
}

/**
 * Connected projects, least recently checked first.
 *
 * The ordering is the whole fairness story: a project that just spent its 20
 * sorts to the back, so a hosted instance with more projects than a tick can
 * serve rotates through them instead of starving the tail. Never-checked
 * projects coalesce to the empty string so they sort first on both dialects —
 * bare `asc()` on a NULL puts them first on SQLite and last on Postgres.
 */
async function getProjectsDueForIndexation(limit: number) {
  const lastChecked = db
    .select({
      projectId: indexationChecks.projectId,
      lastCheckedAt: max(indexationChecks.checkedAt).as("last_checked_at"),
    })
    .from(indexationChecks)
    .groupBy(indexationChecks.projectId)
    .as("last_indexation_checks");

  return db
    .select({ projectId: gscConnections.projectId })
    .from(gscConnections)
    .innerJoin(projects, eq(gscConnections.projectId, projects.id))
    .leftJoin(lastChecked, eq(lastChecked.projectId, gscConnections.projectId))
    .where(isNull(projects.archivedAt))
    .orderBy(asc(sql`coalesce(${lastChecked.lastCheckedAt}, '')`))
    .limit(limit);
}

export const IndexationRepository = {
  getPublishedPagesSince,
  getChecksSince,
  getLatestChecks,
  getPagesDueForCheck,
  countChecksSince,
  insertChecks,
  getProjectsDueForIndexation,
};
