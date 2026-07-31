import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { articles, llmSpend, pageTypes, proposals } from "@/db/schema";

// The reads the agent path needs and no screen does. Everything about an
// article row, a proposal decision or a receipt still goes through the
// feature that owns it — what is left here is the two joins an agent asks for
// that a dashboard never does: "what is mine to write", answered with the
// article state that says whether somebody already started, and the
// status/spend rollups that fit in one tool response instead of five.

type ArticleStatus = (typeof articles.status.enumValues)[number];

// ---------------------------------------------------------------------------
// The queue an agent pulls from
// ---------------------------------------------------------------------------

/** Enough to fill a session's worth of writing. An agent that clears fifty
 *  approved proposals in one run has a quota problem, not a paging problem. */
const AGENT_PROPOSAL_LIMIT = 50;

/**
 * Approved net-new proposals with whatever is already written against them.
 *
 * The article is left-joined rather than filtered out, and that is the whole
 * point of the join: an agent that cannot see a draft is already in flight
 * writes a second one. `articles.status` is what the caller reads to decide,
 * so the raw row travels rather than a boolean somebody would have to trust.
 *
 * Optimize-track rows are excluded here rather than by the caller: they are
 * edits to pages that already exist, they carry no page type and no brief, and
 * an agent handed one would have nothing to write from.
 */
async function getApprovedNetNewProposals(projectId: string) {
  return db
    .select({
      id: proposals.id,
      target: proposals.target,
      title: proposals.title,
      score: proposals.score,
      pageTypeId: proposals.pageTypeId,
      pageTypeName: pageTypes.name,
      pageTypeUrlPattern: pageTypes.urlPattern,
      factorsJson: proposals.factorsJson,
      evidenceJson: proposals.evidenceJson,
      createdAt: proposals.createdAt,
      expiresAt: proposals.expiresAt,
      articleId: articles.id,
      articleStatus: articles.status,
      articleWriterMode: articles.writerMode,
    })
    .from(proposals)
    .leftJoin(pageTypes, eq(proposals.pageTypeId, pageTypes.id))
    .leftJoin(articles, eq(articles.proposalId, proposals.id))
    .where(
      and(
        eq(proposals.projectId, projectId),
        eq(proposals.status, "approved"),
        eq(proposals.track, "net_new"),
        eq(proposals.type, "write_new"),
      ),
    )
    .orderBy(sql`${proposals.score} DESC`, sql`${proposals.createdAt} DESC`)
    .limit(AGENT_PROPOSAL_LIMIT);
}

// ---------------------------------------------------------------------------
// The report's claim
// ---------------------------------------------------------------------------

/**
 * The already-shipped article for a proposal, if there is one.
 *
 * Only reachable when the create lost the partial unique and no in-flight row
 * explains it, which is precisely the re-report: an agent calling
 * `rankloop_publish_report` twice for one page. Returning the row is what lets
 * that second call be a no-op instead of a second receipt.
 */
async function getPublishedArticleForProposal(
  projectId: string,
  proposalId: string,
) {
  const rows = await db
    .select({ id: articles.id })
    .from(articles)
    .where(
      and(
        eq(articles.projectId, projectId),
        eq(articles.proposalId, proposalId),
        eq(articles.status, "published"),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Move an existing article to `publishing` for an agent's report.
 *
 * A compare-and-set on the status the caller just read, so a dashboard publish
 * that started in between loses this claim rather than sharing it. The status
 * matters beyond the race: `publishing` is what the S8a commit's own CAS
 * claims from, so this is what lets an agent report reuse that transaction
 * instead of getting a second one written for it.
 */
async function claimArticleForReport(input: {
  projectId: string;
  articleId: string;
  fromStatus: ArticleStatus;
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
// The status rollups
// ---------------------------------------------------------------------------

/** Grouped in SQL rather than counted over a fetched list: the article table
 *  is the one rankloop table that grows a row per published page forever, and
 *  a status line should not pay for the corpus to render. */
async function getArticleStatusCounts(
  projectId: string,
): Promise<Record<string, number>> {
  const rows = await db
    .select({ status: articles.status, count: sql<number>`count(*)` })
    .from(articles)
    .where(eq(articles.projectId, projectId))
    .groupBy(articles.status);
  return Object.fromEntries(rows.map((row) => [row.status, Number(row.count)]));
}

async function getProposalStatusCounts(
  projectId: string,
): Promise<Record<string, number>> {
  const rows = await db
    .select({ status: proposals.status, count: sql<number>`count(*)` })
    .from(proposals)
    .where(eq(proposals.projectId, projectId))
    .groupBy(proposals.status);
  return Object.fromEntries(rows.map((row) => [row.status, Number(row.count)]));
}

/**
 * Everything this app's own writer has spent on this project.
 *
 * Zero is the honest answer for a project running entirely in agent mode —
 * the ledger records calls this deployment made, and an agent writing in its
 * own repo makes none. Summed in SQL for the same reason the counts are.
 */
async function getSpendToDate(projectId: string): Promise<number> {
  const rows = await db
    .select({ total: sql<number | null>`sum(${llmSpend.costUsd})` })
    .from(llmSpend)
    .where(eq(llmSpend.projectId, projectId));
  return Number(rows[0]?.total ?? 0);
}

export const AgentRepository = {
  getApprovedNetNewProposals,
  getPublishedArticleForProposal,
  claimArticleForReport,
  getArticleStatusCounts,
  getProposalStatusCounts,
  getSpendToDate,
};
