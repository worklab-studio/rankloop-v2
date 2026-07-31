import { and, desc, eq, sql } from "drizzle-orm";
import type { InferInsertModel } from "drizzle-orm";
import { db } from "@/db";
import { articles, llmSpend } from "@/db/schema";

// Every query the writer runs against `articles` and the spend ledger. The
// article row is the durable record a workflow reports into; the ledger is
// append-only and is written in the same step as the call it records, so a
// crashed workflow can never leave a charge unaccounted for.

type ArticleStatus = (typeof articles.status.enumValues)[number];

/**
 * Claim the one in-flight slot for a proposal.
 *
 * The partial unique on `articles(proposal_id) WHERE status NOT IN
 * ('published','failed')` is the lock. A blocked INSERT means somebody is
 * already writing this proposal, which is the answer the caller wants, not an
 * error — so the violation is swallowed and reported as `false` rather than
 * being pre-empted by a count-then-insert that two tabs would both win.
 */
async function tryCreateArticle(
  input: InferInsertModel<typeof articles>,
): Promise<boolean> {
  try {
    await db.insert(articles).values(input);
    return true;
  } catch {
    return false;
  }
}

async function getArticleById(projectId: string, articleId: string) {
  const rows = await db
    .select()
    .from(articles)
    .where(and(eq(articles.id, articleId), eq(articles.projectId, projectId)))
    .limit(1);
  return rows[0] ?? null;
}

/** The in-flight (or most recent non-terminal) article for a proposal, which
 *  is what a blocked create wants to hand back. */
async function getActiveArticleForProposal(
  projectId: string,
  proposalId: string,
) {
  const rows = await db
    .select()
    .from(articles)
    .where(
      and(
        eq(articles.projectId, projectId),
        eq(articles.proposalId, proposalId),
        sql`${articles.status} NOT IN ('published', 'failed')`,
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * The tabs' poll, newest first.
 *
 * Unfiltered by status on purpose: one fetch feeds Writing, Review and Failed,
 * so their counts and their rows can never disagree. `published` is excluded
 * because a shipped post is the Receipts screen's story, and the cap keeps a
 * corpus with three years of history from shipping every row to narrate three
 * tabs.
 */
const ARTICLE_POLL_LIMIT = 200;

async function getArticlesForProject(projectId: string) {
  return db
    .select({
      id: articles.id,
      proposalId: articles.proposalId,
      keyword: articles.keyword,
      title: articles.title,
      status: articles.status,
      attempts: articles.attempts,
      costUsd: articles.costUsd,
      model: articles.model,
      lawReportJson: articles.lawReportJson,
      updatedAt: articles.updatedAt,
    })
    .from(articles)
    .where(
      and(
        eq(articles.projectId, projectId),
        sql`${articles.status} <> 'published'`,
      ),
    )
    .orderBy(desc(articles.updatedAt))
    .limit(ARTICLE_POLL_LIMIT);
}

type ArticleUpdate = Partial<{
  status: ArticleStatus;
  attempts: number;
  briefMd: string;
  content: string;
  lawReportJson: string;
  title: string | null;
  description: string | null;
  slug: string | null;
  costUsd: number;
  model: string;
}>;

/** Every write to an article goes through here so `updated_at` can never be
 *  forgotten — the tabs poll on it, and a row that changed status without
 *  moving its timestamp reads as stalled. */
async function updateArticle(
  articleId: string,
  update: ArticleUpdate,
): Promise<void> {
  await db
    .update(articles)
    .set({ ...update, updatedAt: new Date().toISOString() })
    .where(eq(articles.id, articleId));
}

/**
 * Record one model call.
 *
 * Written in the same workflow step as the call itself: a ledger that lags
 * the spend by a step is a ledger that loses a row every time an isolate
 * dies mid-article, and the number it under-reports is the user's bill.
 */
async function insertSpend(input: {
  projectId: string;
  operation: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  articleId: string;
}): Promise<void> {
  await db.insert(llmSpend).values({ ...input, provider: "openrouter" });
}

/** What this article has cost so far, summed from the ledger rather than
 *  accumulated in a variable — a replayed workflow step must not be able to
 *  double a total. */
async function getSpendForArticle(articleId: string): Promise<number> {
  const rows = await db
    .select({ costUsd: llmSpend.costUsd })
    .from(llmSpend)
    .where(eq(llmSpend.articleId, articleId));
  return rows.reduce((total, row) => total + row.costUsd, 0);
}

export const ArticleRepository = {
  tryCreateArticle,
  getArticleById,
  getActiveArticleForProposal,
  getArticlesForProject,
  updateArticle,
  insertSpend,
  getSpendForArticle,
};
