import { slugify } from "@rankloop/engine";
import { AgentRepository } from "@/server/features/rankloop/agent/repositories/AgentRepository";
import { normalizePath } from "@/server/features/rankloop/publish/adapters/paths.logic";
import { PublishRepository } from "@/server/features/rankloop/publish/repositories/PublishRepository";
import { PagePlanRepository } from "@/server/features/rankloop/page-plan/repositories/PagePlanRepository";
import { ProjectRepository } from "@/server/features/projects/repositories/ProjectRepository";
import { ProposalsRepository } from "@/server/features/rankloop/proposals/repositories/ProposalsRepository";
import { ReceiptsService } from "@/server/features/rankloop/receipts/services/ReceiptsService";
import { ArticleGateService } from "@/server/features/rankloop/writing/services/ArticleGateService";
import { ArticleRepository } from "@/server/features/rankloop/writing/repositories/ArticleRepository";
import { AppError } from "@/server/lib/errors";
import type { LawReport } from "@/server/features/rankloop/writing/gate";

// rankloop_publish_report: how an agent-written page lands (spec 0023).
//
// The agent already shipped the post — it wrote the page in its own repo, in
// its own stack, and merged it. What is missing is everything downstream that
// only this app can do, and it is exactly what the API writer's publish does
// in its last two steps: put the page in the manifest so the next brief can
// link to it and the next site study does not prune it, and open a receipt so
// the writing gets measured.
//
// So this reuses `upsertPublishedPage` + `openReceipt` +
// `markPublishedWithReceipt` rather than reimplementing them. The transaction
// in particular is not negotiable: article → published, proposal → done,
// keyword → published and the receipt ride together, because any two of them
// without the third is a lie the Receipts screen would report forever.
//
// What this deliberately does NOT do is call an adapter. Nothing is written to
// anybody's site from here; the agent's hands already did that, and a second
// writer touching the same page is how you get two of somebody's articles.

/** How a page reported by an agent identifies itself in `articles.adapter`.
 *  Not a publish adapter — nothing resolves a client from it — but the column
 *  is what every screen reads to say where a post came from, and "agent" is
 *  the true answer. */
const AGENT_ADAPTER = "agent";

type PublishReportInput = {
  projectId: string;
  proposalId: string;
  /** The live URL. The one required field: without it there is no page to
   *  anchor a receipt's baseline to and nothing to measure. */
  url: string;
  /** Site-relative path. Derived from `url` when the agent omits it. */
  path?: string;
  /** The commit that shipped it, if the target is a repo. */
  commit?: string;
  /** The PR it landed in, for the humans reading the article row later. */
  pullRequestUrl?: string;
  /** The markdown that was graded, when the page has a markdown source. Absent
   *  is normal and not a failure: an agent writing a Next route wrote JSX, and
   *  the CI `rankloop check` is where that tree meets the laws. */
  draft?: string;
  /** ISO instant, injected so a report replays identically in a test. */
  reportedAt: string;
};

type PublishReportResult = {
  articleId: string;
  proposalId: string;
  url: string;
  path: string;
  publishedAt: string;
  /** True when this article was already published — the call did nothing, and
   *  saying so is better than opening a second receipt over one page. */
  alreadyReported: boolean;
  /** Null when no draft was submitted with the report. */
  report: LawReport | null;
};

// ---------------------------------------------------------------------------
// The article row
// ---------------------------------------------------------------------------

/** Statuses an agent's report may take an article from. `publishing` is
 *  excluded on purpose: this app's own publish workflow is mid-run on that
 *  row, and two writers finishing one article is the failure the whole claim
 *  machinery exists to prevent. */
const REPORTABLE_STATUSES = new Set<string>([
  "briefing",
  "writing",
  "gate",
  "fixing",
  "review",
  "approved",
  "failed",
]);

/**
 * The row this report lands on: a fresh agent-mode article, or the one already
 * open against this proposal.
 *
 * Both paths end at `publishing`, which is the status the S8a commit's
 * compare-and-set claims from. The create races through the partial unique on
 * `articles(proposal_id) WHERE status NOT IN ('published','failed')` — a
 * blocked INSERT means somebody already has the slot, which is the answer this
 * function wants rather than an error.
 */
async function claimArticle(input: {
  projectId: string;
  proposalId: string;
  keyword: string;
  pageTypeId: string | null;
}): Promise<{ id: string; alreadyPublished: boolean }> {
  const articleId = crypto.randomUUID();
  const created = await ArticleRepository.tryCreateArticle({
    id: articleId,
    projectId: input.projectId,
    proposalId: input.proposalId,
    pageTypeId: input.pageTypeId,
    keyword: input.keyword,
    writerMode: "agent",
    status: "publishing",
  });
  if (created) return { id: articleId, alreadyPublished: false };

  const existing = await ArticleRepository.getActiveArticleForProposal(
    input.projectId,
    input.proposalId,
  );
  if (!existing) {
    // No in-flight row and the INSERT still lost: the only row for this
    // proposal is terminal, and a published one is the ordinary re-report.
    const published = await AgentRepository.getPublishedArticleForProposal(
      input.projectId,
      input.proposalId,
    );
    if (published) return { id: published.id, alreadyPublished: true };
    throw new AppError(
      "CONFLICT",
      "This proposal already has an article that cannot be reported.",
    );
  }
  if (!REPORTABLE_STATUSES.has(existing.status)) {
    throw new AppError(
      "CONFLICT",
      "A publish is already running for this article.",
    );
  }
  const claimed = await AgentRepository.claimArticleForReport({
    projectId: input.projectId,
    articleId: existing.id,
    fromStatus: existing.status,
  });
  if (!claimed) {
    throw new AppError(
      "CONFLICT",
      "This article moved while the report was being recorded.",
    );
  }
  return { id: existing.id, alreadyPublished: false };
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

/** The path the manifest files this page under. The agent's own `path` wins
 *  when it sends one — it knows its router — and the URL's pathname is the
 *  fallback, because a manifest row keyed to a URL with no path would be
 *  unlinkable from every brief that came after. */
function resolvePath(url: string, reported: string | undefined): string {
  if (reported) return normalizePath(reported);
  try {
    return normalizePath(new URL(url).pathname);
  } catch {
    throw new AppError("VALIDATION_ERROR", "The reported URL is not a URL.");
  }
}

async function reportPublished(
  input: PublishReportInput,
): Promise<PublishReportResult> {
  const proposal = await ProposalsRepository.getProposalById(
    input.projectId,
    input.proposalId,
  );
  if (!proposal) throw new AppError("NOT_FOUND", "Proposal not found.");
  if (proposal.track !== "net_new" || proposal.type !== "write_new") {
    throw new AppError(
      "VALIDATION_ERROR",
      "Only net-new proposals publish a new page.",
    );
  }

  const [project, pageType] = await Promise.all([
    ProjectRepository.getProjectById(input.projectId),
    proposal.pageTypeId
      ? PagePlanRepository.getPageTypeById(input.projectId, proposal.pageTypeId)
      : null,
  ]);
  if (!project) throw new AppError("NOT_FOUND", "Project not found.");

  const path = resolvePath(input.url, input.path);
  const article = await claimArticle({
    projectId: input.projectId,
    proposalId: proposal.id,
    keyword: proposal.target,
    pageTypeId: proposal.pageTypeId,
  });
  if (article.alreadyPublished) {
    return {
      articleId: article.id,
      proposalId: proposal.id,
      url: input.url,
      path,
      publishedAt: input.reportedAt,
      alreadyReported: true,
      report: null,
    };
  }

  // Graded before the row is written, not after: the report is the article's
  // quality receipt and it should describe the bytes that shipped. A draft
  // that fails is still recorded — the page is already live, and refusing to
  // file the report would only make the failure invisible to the one screen
  // that would show it.
  const graded = input.draft
    ? await ArticleGateService.gradeDraft({
        projectId: input.projectId,
        pageTypeId: proposal.pageTypeId,
        keyword: proposal.target,
        markdown: input.draft,
        checkedAt: input.reportedAt,
      })
    : null;

  const title = graded?.post.title || proposal.title || proposal.target;
  const description = graded?.post.description ?? "";
  await ArticleRepository.updateArticle(article.id, {
    title,
    description: description || null,
    slug: graded?.slug ?? slugify(title),
    ...(input.draft ? { content: input.draft } : {}),
    ...(graded ? { lawReportJson: JSON.stringify(graded.report) } : {}),
  });

  // The manifest first, then the receipt that anchors to it, then the one
  // transaction that lands both — the API writer's steps 4 and 8, in order,
  // for the same reasons its comments give.
  const contentPageId = await PublishRepository.upsertPublishedPage({
    projectId: input.projectId,
    url: input.url,
    path,
    kind: "post",
    title,
    description: description || null,
    publishedAt: input.reportedAt,
    category: pageType?.name ?? null,
    keyword: proposal.target,
    pageTypeId: proposal.pageTypeId,
  });

  const receipt = await ReceiptsService.openReceipt({
    projectId: input.projectId,
    actionType: "write_new",
    contentPageId,
    targetQuery: proposal.target,
    executedAt: input.reportedAt,
  });

  await PublishRepository.markPublishedWithReceipt({
    projectId: input.projectId,
    articleId: article.id,
    proposalId: proposal.id,
    keywordBacklogId: proposal.keywordBacklogId,
    publishedUrl: input.url,
    adapter: AGENT_ADAPTER,
    // What a human would need to find this page's source again. The commit is
    // the durable one; a PR link is better than nothing; the path is the last
    // resort and is at least true.
    adapterRef: input.commit ?? input.pullRequestUrl ?? path,
    linksInjectedJson: null,
    stamp: input.reportedAt,
    receipt,
  });

  return {
    articleId: article.id,
    proposalId: proposal.id,
    url: input.url,
    path,
    publishedAt: input.reportedAt,
    alreadyReported: false,
    report: graded?.report ?? null,
  };
}

export const AgentReportService = {
  reportPublished,
};
