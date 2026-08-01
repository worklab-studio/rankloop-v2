import { and, eq, inArray, sql } from "drizzle-orm";
import type { InferInsertModel } from "drizzle-orm";
import { db } from "@/db";
import { runBatch } from "@/db/runBatch";
import {
  articles,
  contentPages,
  keywordBacklog,
  proposals,
  receipts,
} from "@/db/schema";

// Every query publishing runs that the write side did not already own. The
// article, proposal, page-type and settings reads all reuse their features'
// repositories — publishing does not get a second definition of "the article
// row" — so what is left here is the manifest write, the neighbour scan, and
// the one transaction that lands a published article.

type ReceiptInsert = InferInsertModel<typeof receipts>;

// ---------------------------------------------------------------------------
// The manifest
// ---------------------------------------------------------------------------

/**
 * Bounded like the brief's own candidate scan: a pSEO corpus runs to thousands
 * of rows and the selection only ever keeps three, so reading the newest few
 * hundred finds the real neighbours without pulling a whole site into an
 * isolate.
 */
const LINK_CANDIDATE_SCAN_LIMIT = 500;

async function getLinkCandidates(projectId: string) {
  return db
    .select({
      id: contentPages.id,
      path: contentPages.path,
      title: contentPages.title,
      kind: contentPages.kind,
      pageTypeId: contentPages.pageTypeId,
    })
    .from(contentPages)
    .where(
      and(
        eq(contentPages.projectId, projectId),
        inArray(contentPages.kind, ["post", "hub"]),
      ),
    )
    .orderBy(sql`${contentPages.publishedAt} DESC`)
    .limit(LINK_CANDIDATE_SCAN_LIMIT);
}

/**
 * The whole corpus, for the derived artifacts.
 *
 * Unbounded on purpose, and the only unbounded read in this feature: a sitemap
 * that silently stopped at 500 URLs would be worse than no sitemap, because it
 * tells search engines the other pages do not exist. The GitHub adapter is the
 * only caller, and it commits files for sites whose entire corpus rankloop
 * wrote.
 */
async function getManifestForWire(projectId: string) {
  return db
    .select({
      path: contentPages.path,
      kind: contentPages.kind,
      title: contentPages.title,
      description: contentPages.description,
      publishedAt: contentPages.publishedAt,
      category: contentPages.category,
      keyword: contentPages.keyword,
      wordCount: contentPages.wordCount,
    })
    .from(contentPages)
    .where(
      and(
        eq(contentPages.projectId, projectId),
        inArray(contentPages.kind, ["post", "hub"]),
      ),
    );
}

type PublishedPageUpsert = {
  projectId: string;
  url: string;
  path: string;
  kind: "post" | "hub";
  title: string | null;
  description: string | null;
  publishedAt: string | null;
  category: string | null;
  keyword: string | null;
  pageTypeId: string | null;
};

/**
 * Put a page rankloop just created into the corpus, immediately, before any
 * crawl.
 *
 * `source: 'publish'` is what tells the next site study not to prune this row
 * for being absent from a crawl that ran before the page existed. The set
 * clause is deliberately narrow: the measured columns (wordCount, inlinkCount,
 * contentHash) stay untouched because a publish has not measured them, and
 * inventing zeroes would make a fresh post look like an empty one on every
 * screen that reads them.
 */
async function upsertPublishedPage(row: PublishedPageUpsert): Promise<string> {
  const inserted = await db
    .insert(contentPages)
    .values({ id: crypto.randomUUID(), source: "publish", ...row })
    .onConflictDoUpdate({
      target: [contentPages.projectId, contentPages.url],
      set: {
        path: row.path,
        kind: row.kind,
        title: row.title,
        description: row.description,
        publishedAt: row.publishedAt,
        category: row.category,
        keyword: row.keyword,
        pageTypeId: row.pageTypeId,
      },
    })
    .returning({ id: contentPages.id });
  return inserted[0].id;
}

// ---------------------------------------------------------------------------
// The Published tab
// ---------------------------------------------------------------------------

/** Newest first, and capped for the same reason the writer's poll is: a corpus
 *  with three years of history should not ship every row to render one tab. */
const PUBLISHED_POLL_LIMIT = 200;

/**
 * Published articles with their receipt's status.
 *
 * A left join, because a published article with no receipt is a real state
 * rather than a missing row: the post landed on a page Search Console has
 * never reported on, so there is nothing to measure yet and the tab says so.
 */
async function getPublishedArticles(projectId: string) {
  return db
    .select({
      id: articles.id,
      title: articles.title,
      keyword: articles.keyword,
      adapter: articles.adapter,
      publishedUrl: articles.publishedUrl,
      publishedAt: articles.publishedAt,
      pageTypeId: articles.pageTypeId,
      linksInjectedJson: articles.linksInjectedJson,
      receiptStatus: receipts.status,
    })
    .from(articles)
    .leftJoin(receipts, eq(receipts.articleId, articles.id))
    .where(
      and(eq(articles.projectId, projectId), eq(articles.status, "published")),
    )
    .orderBy(sql`${articles.publishedAt} DESC`)
    .limit(PUBLISHED_POLL_LIMIT);
}

/** Hub paths for a set of page types, resolved through the manifest. Kept as
 *  its own read rather than a third join: the hub pointer is a plain id with
 *  no FK behind it (an import cycle forbids one), so a miss is ordinary and a
 *  join would only hide it. */
async function getHubPathsByPageType(
  projectId: string,
  pageTypeIds: string[],
): Promise<Map<string, string>> {
  if (pageTypeIds.length === 0) return new Map();
  const rows = await db
    .select({ pageTypeId: contentPages.pageTypeId, path: contentPages.path })
    .from(contentPages)
    .where(
      and(
        eq(contentPages.projectId, projectId),
        eq(contentPages.kind, "hub"),
        inArray(contentPages.pageTypeId, pageTypeIds),
      ),
    );
  return new Map(
    rows.flatMap((row) => (row.pageTypeId ? [[row.pageTypeId, row.path]] : [])),
  );
}

// ---------------------------------------------------------------------------
// The claim
// ---------------------------------------------------------------------------

/**
 * Take the article for this run, or report that somebody else has it.
 *
 * A compare-and-set on the exact status preflight judged, so the decision and
 * the claim cannot be separated by a second run that changed the row in
 * between. The loser stops before touching an adapter rather than after it,
 * which is the difference between one post and two.
 */
async function claimForPublishing(input: {
  projectId: string;
  articleId: string;
  /** `failed` is the resume case: a run that crashed after creating the post
   *  lands the article there, and the run that finishes it re-takes the row
   *  from exactly that status. */
  fromStatus: "approved" | "review" | "failed";
}): Promise<boolean> {
  const rows = await db
    .update(articles)
    .set({ status: "publishing", updatedAt: new Date().toISOString() })
    .where(
      and(
        eq(articles.id, input.articleId),
        eq(articles.projectId, input.projectId),
        eq(articles.status, input.fromStatus),
      ),
    )
    .returning({ id: articles.id });
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// The commit
// ---------------------------------------------------------------------------

/**
 * The publish commit: the article to `published`, its proposal to `done`, its
 * backlog keyword to `published`, and the opened receipt — ONE atomic write
 * set (runBatch).
 *
 * The article update is a CAS on status='publishing' stamping `stamp` into
 * updated_at, and the receipt insert is gated on reading that stamp back AND on
 * this article having no receipt yet.
 *
 * Both halves are needed. A replayed step 8 arrives carrying the stamp step 4
 * stored the first time, so `updated_at` still matches it — the CAS misses
 * because the article is already published, but the insert-select would happily
 * open a second baseline against the row the first run stamped. The receipt's
 * own absence is the only fact that separates a first commit from its replay,
 * and without it a workflow that resumed on step 8 would leave two baselines
 * measuring one publish, the second one's numbers a lie the Receipts screen
 * reports forever.
 *
 * The projection is positional — drizzle emits the full receipts column list
 * for an insert-select — so these fields must stay in the table's own column
 * order and none may be undefined; an insert-select never applies a column
 * default. Drizzle validates the pairing on every call, so a new receipts
 * column surfaces here as a loud "Insert select error" rather than as silently
 * shifted data.
 */
async function markPublishedWithReceipt(input: {
  projectId: string;
  articleId: string;
  proposalId: string;
  keywordBacklogId: string | null;
  publishedUrl: string;
  adapter: string;
  adapterRef: string;
  linksInjectedJson: string | null;
  /** The publish instant. Doubles as the CAS marker and the receipt's
   *  createdAt, exactly as executedAt does for an executed proposal. */
  stamp: string;
  receipt: ReceiptInsert;
}): Promise<void> {
  const receipt = input.receipt;
  await runBatch((tx) => [
    tx
      .update(articles)
      .set({
        status: "published",
        adapter: input.adapter,
        adapterRef: input.adapterRef,
        publishedUrl: input.publishedUrl,
        publishedAt: input.stamp,
        linksInjectedJson: input.linksInjectedJson,
        updatedAt: input.stamp,
      })
      .where(
        and(
          eq(articles.id, input.articleId),
          eq(articles.projectId, input.projectId),
          eq(articles.status, "publishing"),
        ),
      ),
    tx
      .update(proposals)
      .set({ status: "done", executedAt: input.stamp })
      .where(
        and(
          eq(proposals.id, input.proposalId),
          eq(proposals.projectId, input.projectId),
          eq(proposals.status, "approved"),
        ),
      ),
    // The keyword leaves the backlog for good: 'published' is terminal, and a
    // row that stayed 'queued' would be re-selected for a second article about
    // a page that now exists.
    ...(input.keywordBacklogId
      ? [
          tx
            .update(keywordBacklog)
            .set({ status: "published", updatedAt: input.stamp })
            .where(
              and(
                eq(keywordBacklog.id, input.keywordBacklogId),
                eq(keywordBacklog.projectId, input.projectId),
              ),
            ),
        ]
      : []),
    tx.insert(receipts).select(
      tx
        .select({
          id: sql<string>`${receipt.id}`.as("id"),
          projectId: sql<string>`${receipt.projectId}`.as("projectId"),
          actionType: sql<string>`${receipt.actionType}`.as("actionType"),
          articleId: sql<string | null>`${input.articleId}`.as("articleId"),
          contentPageId: sql<
            string | null
          >`${receipt.contentPageId ?? null}`.as("contentPageId"),
          targetQuery: sql<string | null>`${receipt.targetQuery ?? null}`.as(
            "targetQuery",
          ),
          status: sql<string>`${receipt.status ?? "baseline"}`.as("status"),
          baselineJson: sql<string | null>`${receipt.baselineJson ?? null}`.as(
            "baselineJson",
          ),
          resultJson: sql<string | null>`${receipt.resultJson ?? null}`.as(
            "resultJson",
          ),
          windowStart: sql<string | null>`${receipt.windowStart ?? null}`.as(
            "windowStart",
          ),
          windowEnd: sql<string | null>`${receipt.windowEnd ?? null}`.as(
            "windowEnd",
          ),
          measuredAt: sql<string | null>`${receipt.measuredAt ?? null}`.as(
            "measuredAt",
          ),
          nextCheckAt: sql<string | null>`${receipt.nextCheckAt ?? null}`.as(
            "nextCheckAt",
          ),
          createdAt: sql<string>`${receipt.createdAt ?? input.stamp}`.as(
            "createdAt",
          ),
        })
        .from(articles)
        .where(
          and(
            eq(articles.id, input.articleId),
            eq(articles.updatedAt, input.stamp),
            sql`not exists (select 1 from ${receipts} where ${receipts.articleId} = ${input.articleId})`,
          ),
        ),
    ),
  ]);
}

export const PublishRepository = {
  getLinkCandidates,
  getManifestForWire,
  getPublishedArticles,
  getHubPathsByPageType,
  upsertPublishedPage,
  claimForPublishing,
  markPublishedWithReceipt,
};
