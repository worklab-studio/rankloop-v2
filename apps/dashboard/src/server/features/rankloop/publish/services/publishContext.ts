import { parseMdPost, slugify } from "@rankloop/engine";
import { pathFromUrlPattern } from "@/server/features/rankloop/publish/adapters/paths.logic";
import { PagePlanRepository } from "@/server/features/rankloop/page-plan/repositories/PagePlanRepository";
import { ProjectRepository } from "@/server/features/projects/repositories/ProjectRepository";
import { ProposalsRepository } from "@/server/features/rankloop/proposals/repositories/ProposalsRepository";
import { ArticleRepository } from "@/server/features/rankloop/writing/repositories/ArticleRepository";
import { AppError } from "@/server/lib/errors";

// The facts a publish run works from, assembled once. Its own module because
// two callers need it for opposite reasons: the workflow builds it to act, and
// the Publish panel builds it to describe — and the panel's promise is only
// worth something while both read exactly the same values.

/** Small on purpose: the workflow engine persists and replays step results, so
 *  the article body is re-read where it is needed rather than carried through
 *  eight steps of serialization. */
export type PublishContext = {
  projectId: string;
  articleId: string;
  proposalId: string;
  keywordBacklogId: string | null;
  pageTypeId: string | null;
  pageTypeName: string;
  urlPattern: string | null;
  keyword: string;
  slug: string;
  title: string;
  description: string;
  date: string;
  path: string;
  siteUrl: string;
  /** Set when a previous run already created the post: the guard that stops a
   *  resumed workflow from publishing twice. */
  adapterRef: string | null;
};

type ArticleRow = NonNullable<
  Awaited<ReturnType<typeof ArticleRepository.getArticleById>>
>;

/**
 * The facts the rest of the run needs, read through the engine's own parser.
 *
 * Title, description and date come from the draft's frontmatter rather than
 * from the article row: those columns are written by the gate and are a copy,
 * and the bytes the laws graded are the bytes the site should receive.
 */
export async function buildContext(input: {
  article: ArticleRow;
  project: { id: string; domain: string | null };
}): Promise<PublishContext> {
  const { article } = input;
  const [proposal, pageType] = await Promise.all([
    ProposalsRepository.getProposalById(article.projectId, article.proposalId),
    article.pageTypeId
      ? PagePlanRepository.getPageTypeById(
          article.projectId,
          article.pageTypeId,
        )
      : null,
  ]);
  if (!proposal) throw new AppError("NOT_FOUND", "Proposal not found.");

  const post = parseMdPost("draft", article.content ?? "");
  const slug = article.slug ?? slugify(post.title || article.keyword);

  return {
    projectId: article.projectId,
    articleId: article.id,
    proposalId: article.proposalId,
    keywordBacklogId: proposal.keywordBacklogId,
    pageTypeId: article.pageTypeId,
    pageTypeName: pageType?.name ?? "Blog",
    urlPattern: pageType?.urlPattern ?? null,
    keyword: article.keyword,
    slug,
    title: post.title || article.title || article.keyword,
    description: post.description || article.description || "",
    date: post.date,
    path: pathFromUrlPattern(pageType?.urlPattern ?? null, slug),
    siteUrl: input.project.domain ? `https://${input.project.domain}` : "",
    adapterRef: article.adapterRef,
  };
}

/**
 * The same context the run would build, without touching anything.
 *
 * The Publish panel's promise has to be assembled from the facts the workflow
 * will actually use — the same slug, the same path, the same page type — or it
 * is a description of the feature rather than of the next thirty seconds.
 */
export async function describeRun(input: {
  projectId: string;
  articleId: string;
}): Promise<PublishContext> {
  const [article, project] = await Promise.all([
    ArticleRepository.getArticleById(input.projectId, input.articleId),
    ProjectRepository.getProjectById(input.projectId),
  ]);
  if (!article) throw new AppError("NOT_FOUND", "Article not found.");
  if (!project) throw new AppError("NOT_FOUND", "Project not found.");
  return buildContext({ article, project });
}
