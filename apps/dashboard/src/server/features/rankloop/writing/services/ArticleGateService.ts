import { parseMdPost, slugify } from "@rankloop/engine";
import { PagePlanRepository } from "@/server/features/rankloop/page-plan/repositories/PagePlanRepository";
import { ProjectRepository } from "@/server/features/projects/repositories/ProjectRepository";
import {
  runGate,
  type LawReport,
} from "@/server/features/rankloop/writing/gate";
import {
  buildRepairPayload,
  type RepairPayload,
} from "@/server/features/rankloop/writing/repair.logic";
import { ArticleRepository } from "@/server/features/rankloop/writing/repositories/ArticleRepository";
import { BriefRepository } from "@/server/features/rankloop/writing/repositories/BriefRepository";
import { WriterSettingsRepository } from "@/server/features/rankloop/writing/repositories/WriterSettingsRepository";
import { AppError } from "@/server/lib/errors";
import { landingStatus } from "@/shared/rankloop-writer";
import { WRITER_SETTINGS_DEFAULTS } from "@/shared/rankloop-writing";
import { parseTemplateContract } from "@/types/schemas/rankloopPagePlan";

// The gate, wired to storage. `gate.ts` is pure and reaches @rankloop/engine
// and nothing else; this file feeds it the site's real pages and page types
// and writes down what it decided. The split is why the grader can be run
// against fixtures, and why nothing provider-shaped can ever reach it.

type GateOutcome = {
  passed: boolean;
  report: LawReport;
  /** The failures as the fix call receives them. Empty when the draft passed. */
  payload: RepairPayload;
};

/**
 * Grade one draft against the same facts its brief promised.
 *
 * The pages, the taxonomy and the contract are re-read here rather than
 * carried from the brief because the gate needs the site as it is now: a link
 * to a post that was deleted this morning does not resolve, and a report that
 * said otherwise would be wrong in the user's favour.
 */
async function gate(input: {
  projectId: string;
  articleId: string;
  markdown: string;
}): Promise<GateOutcome> {
  const article = await ArticleRepository.getArticleById(
    input.projectId,
    input.articleId,
  );
  if (!article) throw new AppError("NOT_FOUND", "Article not found.");

  const [project, pageType, allTypes, pages] = await Promise.all([
    ProjectRepository.getProjectById(input.projectId),
    article.pageTypeId
      ? PagePlanRepository.getPageTypeById(input.projectId, article.pageTypeId)
      : null,
    PagePlanRepository.getPageTypes(input.projectId),
    BriefRepository.getLinkablePages(input.projectId),
  ]);
  if (!project) throw new AppError("NOT_FOUND", "Project not found.");

  // Read the draft through the engine's own parser, so the title stored here
  // is the title the laws measured and the slug is the one the site would
  // serve. Derived from THIS draft rather than from the row: a repair that
  // rewrote the title must not be graded against the last one's slug.
  const post = parseMdPost("draft", input.markdown);
  const slug = slugify(post.title || article.keyword);

  const report = runGate({
    // `validate` builds its resolvable-slug set from the corpus it is handed,
    // so the draft's own slug belongs in it — that is what keeps a self-link
    // from counting as a dead one.
    slug,
    draft: input.markdown,
    site: {
      url: project.domain ? `https://${project.domain}` : "",
      name: project.name,
      description: "",
    },
    pageTypeName: pageType?.name ?? "Blog",
    contract: parseTemplateContract(pageType?.templateContractJson ?? null),
    urlPattern: pageType?.urlPattern ?? null,
    approvedTypeNames: allTypes
      .filter((type) => type.status === "approved")
      .map((type) => type.name),
    pages,
    checkedAt: new Date().toISOString(),
  });

  await ArticleRepository.updateArticle(input.articleId, {
    lawReportJson: JSON.stringify(report),
    title: post.title || null,
    description: post.description || null,
    slug: report.slug,
  });

  return { passed: report.passed, report, payload: buildRepairPayload(report) };
}

/** Statuses a hand edit may act on. Past `publishing` the article is no
 *  longer only ours to change, and re-grading a live post is S8's problem. */
const EDITABLE_STATUSES = new Set<string>(["review", "approved", "failed"]);

/**
 * Save an edited draft and re-run the gate. No model call, ever.
 *
 * This is what makes the `drafts` dial livable: fixing one sentence by hand
 * must not cost another generation, or users learn to accept whatever the
 * model produced rather than pay to improve it. `attempts` does not move and
 * no ledger row is written, because nothing was spent.
 */
async function recheck(input: {
  projectId: string;
  articleId: string;
  content: string;
}): Promise<{
  passed: boolean;
  failedCount: number;
  status: "approved" | "review" | "failed";
}> {
  const article = await ArticleRepository.getArticleById(
    input.projectId,
    input.articleId,
  );
  if (!article) throw new AppError("NOT_FOUND", "Article not found.");
  if (!EDITABLE_STATUSES.has(article.status)) {
    throw new AppError(
      "VALIDATION_ERROR",
      "This article is past the point where the draft can be edited here.",
    );
  }

  await ArticleRepository.updateArticle(input.articleId, {
    content: input.content,
  });
  const outcome = await gate({
    projectId: input.projectId,
    articleId: input.articleId,
    markdown: input.content,
  });

  // The tab an article sits in should match its report, in both directions:
  // an edit that clears the last law moves it out of Failed, and one that
  // breaks a law moves it back. Anything else leaves a green row above a
  // report that says otherwise.
  const settings = await WriterSettingsRepository.getSettings(input.projectId);
  const status = outcome.passed
    ? landingStatus(settings?.trustDial ?? WRITER_SETTINGS_DEFAULTS.trustDial)
    : "failed";
  await ArticleRepository.updateArticle(input.articleId, { status });

  return {
    passed: outcome.passed,
    failedCount: outcome.report.violations,
    status,
  };
}

export const ArticleGateService = {
  gate,
  recheck,
};
