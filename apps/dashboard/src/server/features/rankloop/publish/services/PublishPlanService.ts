import { slugify } from "@rankloop/engine";
// The latest check per URL — the same read `computeIndexationRate` runs over a
// cohort, called here for exactly one page.
import { IndexationRepository } from "@/server/features/rankloop/indexation/repositories/IndexationRepository";
import { resolvePublishAdapter } from "@/server/features/rankloop/publish/adapters/resolve";
import type { PublishCapabilities } from "@/server/features/rankloop/publish/adapters/types";
import { PublishRepository } from "@/server/features/rankloop/publish/repositories/PublishRepository";
import { PublishLinksService } from "@/server/features/rankloop/publish/services/PublishLinksService";
import { PublishService } from "@/server/features/rankloop/publish/services/PublishService";
import { PagePlanRepository } from "@/server/features/rankloop/page-plan/repositories/PagePlanRepository";
import { ArticleRepository } from "@/server/features/rankloop/writing/repositories/ArticleRepository";
import { WriterSettingsRepository } from "@/server/features/rankloop/writing/repositories/WriterSettingsRepository";
import { AppError } from "@/server/lib/errors";
import { WRITER_SETTINGS_DEFAULTS } from "@/shared/rankloop-writing";
import type { TrustDial } from "@/shared/rankloop-writer";
import { parseInjectedLinks } from "@/types/schemas/rankloopPublish";
import { parseLawReport } from "@/types/schemas/rankloopWriter";

// What the publish surfaces read: the promise made before the button, and the
// Published tab's rows. Nothing here writes, and nothing here decides — the
// plan describes the run the workflow would perform, and the workflow's
// preflight is still the only thing that judges it.

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

/** What the run will physically do to the target. A commit and a pull request
 *  are the same GitHub adapter with a different setting, which is why this is
 *  derived from the capabilities plus the stored config rather than from a
 *  capability flag that would have to exist just for a sentence. */
type PublishAction =
  | "creates-draft"
  | "publishes"
  | "opens-pull-request"
  | "commits"
  | "sends-envelope";

/**
 * Both GitHub branches read the setting that decides them.
 *
 * `publishedUrl` used to stand in for the commit mode here, and it was always
 * wrong: GitHub computes its URLs either way, so a connection set to commit
 * straight to main was described as opening a pull request nobody would ever
 * find. The panel is the last sentence a user reads before rankloop writes to
 * a repository they own, so it reads the flag that actually branches the run.
 */
function actionFor(
  capabilities: PublishCapabilities,
  settings: { defaultPostStatus: "draft" | "publish"; directCommit: boolean },
): PublishAction {
  switch (capabilities.kind) {
    case "wordpress":
      return settings.defaultPostStatus === "draft"
        ? "creates-draft"
        : "publishes";
    case "github":
      return settings.directCommit ? "commits" : "opens-pull-request";
    case "webhook":
      return "sends-envelope";
  }
}

/**
 * Why the button is not there, in the article's own terms.
 *
 * Deliberately narrower than preflight: this is a read, and re-running the
 * gate on every panel render would write a law report nobody asked for. The
 * dial and the missing draft are checkable for free, and a stored report that
 * already says the laws failed is worth repeating — anything subtler is
 * preflight's to discover at the moment it matters.
 */
function blockedReasonFor(input: {
  status: string;
  content: string | null;
  lawReportJson: string | null;
  trustDial: TrustDial;
}): string | null {
  if (input.status === "publishing") return null;
  if (input.status !== "approved") {
    if (!(input.status === "review" && input.trustDial === "autopilot")) {
      return "Approve this draft before publishing it.";
    }
  }
  if (!input.content) return "This article has no stored draft to publish.";
  const report = parseLawReport(input.lawReportJson);
  if (report && !report.passed) {
    return "The laws are not met yet, so this draft cannot publish.";
  }
  return null;
}

/**
 * Everything the Publish panel needs, in one read.
 *
 * The link targets are the same pure selection the workflow will run, called
 * with the same manifest — so "links to it from 2 existing posts" is a
 * description of the next thirty seconds rather than a description of the
 * feature. Once the article is published the panel stops describing and starts
 * reporting, which is what `published` is.
 */
async function getPublishPlan(input: { projectId: string; articleId: string }) {
  const article = await ArticleRepository.getArticleById(
    input.projectId,
    input.articleId,
  );
  if (!article) throw new AppError("NOT_FOUND", "Article not found.");

  const [resolved, settings, pageType] = await Promise.all([
    // The slug is only used to name a GitHub branch on a run; this read starts
    // none, and passing the article's own keeps it consistent with the run
    // this plan describes.
    resolvePublishAdapter(input.projectId, {
      slug: article.slug ?? slugify(article.keyword),
    }),
    WriterSettingsRepository.getSettings(input.projectId),
    article.pageTypeId
      ? PagePlanRepository.getPageTypeById(input.projectId, article.pageTypeId)
      : null,
  ]);

  if (article.status === "published") {
    return {
      ...emptyPlan(),
      published: await publishedSummary({
        projectId: input.projectId,
        pageTypeId: article.pageTypeId,
        publishedUrl: article.publishedUrl,
        adapter: article.adapter,
        linksInjectedJson: article.linksInjectedJson,
        capabilities: resolved?.adapter.capabilities ?? null,
      }),
    };
  }

  if (!resolved) return emptyPlan();

  const context = await PublishService.describeRun({
    projectId: input.projectId,
    articleId: input.articleId,
  });
  const linkTargets = resolved.settings.linkInjection
    ? await PublishLinksService.planLinks(context)
    : [];

  return {
    action: actionFor(resolved.adapter.capabilities, resolved.settings),
    target: resolved.adapter.capabilities.label,
    hub: pageType
      ? { name: pageType.name, exists: pageType.hubContentPageId !== null }
      : null,
    linkTargets,
    linkInjection: resolved.settings.linkInjection,
    capabilities: resolved.adapter.capabilities,
    blockedReason: blockedReasonFor({
      status: article.status,
      content: article.content,
      lawReportJson: article.lawReportJson,
      trustDial: settings?.trustDial ?? WRITER_SETTINGS_DEFAULTS.trustDial,
    }),
    published: null,
  };
}

type PublishPlanShape = {
  action: PublishAction;
  target: string;
  hub: { name: string; exists: boolean } | null;
  linkTargets: { contentPageId: string; path: string; title: string }[];
  linkInjection: boolean;
  capabilities: PublishCapabilities | null;
  blockedReason: string | null;
  published: PublishedSummary | null;
};

/** A project with no connection still renders a panel — the setup pitch — so
 *  the shape is complete and `capabilities: null` is what the surface reads. */
function emptyPlan(): PublishPlanShape {
  return {
    action: "creates-draft",
    target: "",
    hub: null,
    linkTargets: [],
    linkInjection: false,
    capabilities: null,
    blockedReason: null,
    published: null,
  };
}

type PublishedSummary = {
  url: string | null;
  urlConfidence: "verified" | "unverified";
  hubPath: string | null;
  links: { path: string; title: string | null }[];
  /** This URL's own latest inspection, or null while nothing has checked it
   *  yet — no GSC connection, or a post younger than the first daily sweep. */
  indexation: {
    verdict: string;
    coverageState: string | null;
    checkedAt: string;
  } | null;
};

/**
 * The receipt line: the three things rankloop touched.
 *
 * `urlConfidence` is read from the target's capabilities rather than stored,
 * and only when the article's adapter is still the project's adapter. A post
 * published through a connection that has since been replaced keeps its URL
 * unqualified: it has been live for weeks, and calling it unverified now would
 * be a doubt the product invented rather than one it holds.
 *
 * The indexation verdict rides along for the same reason the receipt exists at
 * all: a page Google crawled and declined is the most useful thing this screen
 * can say, and it should be readable where the user already is rather than
 * only in the dashboard's aggregate.
 */
async function publishedSummary(input: {
  projectId: string;
  pageTypeId: string | null;
  publishedUrl: string | null;
  adapter: string | null;
  linksInjectedJson: string | null;
  capabilities: PublishCapabilities | null;
}): Promise<PublishedSummary> {
  const url = input.publishedUrl;
  const [hubPaths, checks] = await Promise.all([
    PublishRepository.getHubPathsByPageType(
      input.projectId,
      input.pageTypeId ? [input.pageTypeId] : [],
    ),
    IndexationRepository.getLatestChecks(input.projectId, url ? [url] : []),
  ]);
  const sameTarget =
    input.capabilities !== null && input.capabilities.kind === input.adapter;
  return {
    url: input.publishedUrl,
    indexation: url ? (checks.get(url) ?? null) : null,
    urlConfidence:
      sameTarget && input.capabilities?.publishedUrl === "computed"
        ? "unverified"
        : "verified",
    hubPath: input.pageTypeId ? (hubPaths.get(input.pageTypeId) ?? null) : null,
    links: parseInjectedLinks(input.linksInjectedJson)
      .filter((link) => link.outcome === "injected")
      .map((link) => ({ path: link.path, title: null })),
  };
}

// ---------------------------------------------------------------------------
// The Published tab
// ---------------------------------------------------------------------------

/**
 * Published rows with their hub and their receipt.
 *
 * `linksInjected` counts only the neighbours that were actually edited — a
 * page whose owned block could not be located was deliberately left alone, and
 * counting it would turn restraint into a number that overstates what rankloop
 * did to somebody's site.
 */
async function getPublishedArticles(projectId: string) {
  const rows = await PublishRepository.getPublishedArticles(projectId);
  const pageTypeIds = [
    ...new Set(rows.flatMap((row) => (row.pageTypeId ? [row.pageTypeId] : []))),
  ];
  const [hubPaths, resolved] = await Promise.all([
    PublishRepository.getHubPathsByPageType(projectId, pageTypeIds),
    resolvePublishAdapter(projectId, { slug: "" }),
  ]);
  const capabilities = resolved?.adapter.capabilities ?? null;

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    keyword: row.keyword,
    url: row.publishedUrl,
    urlConfidence:
      capabilities?.kind === row.adapter &&
      capabilities.publishedUrl === "computed"
        ? ("unverified" as const)
        : ("verified" as const),
    // Never actually empty: the transaction that flips an article to
    // `published` is the one that stamps this, so a published row without one
    // cannot exist. The coalesce is here so the column's nullability does not
    // leak into every screen that renders a date.
    publishedAt: row.publishedAt ?? "",
    hubPath: row.pageTypeId ? (hubPaths.get(row.pageTypeId) ?? null) : null,
    linksInjected: parseInjectedLinks(row.linksInjectedJson).filter(
      (link) => link.outcome === "injected",
    ).length,
    receiptStatus: row.receiptStatus,
  }));
}

export const PublishPlanService = {
  getPublishPlan,
  getPublishedArticles,
};
