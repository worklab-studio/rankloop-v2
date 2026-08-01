import { env } from "cloudflare:workers";
import { slugify } from "@rankloop/engine";
import {
  absoluteUrl,
  hubPathFromUrlPattern,
  slugFromPath,
} from "@/server/features/rankloop/publish/adapters/paths.logic";
import { resolvePublishAdapter } from "@/server/features/rankloop/publish/adapters/resolve";
import { submitIndexNow } from "@/server/features/rankloop/publish/services/indexNow";
import {
  buildContext,
  describeRun,
  type PublishContext,
} from "@/server/features/rankloop/publish/services/publishContext";
import {
  landBlocked,
  landCrashed,
  type PublishBlocked,
} from "@/server/features/rankloop/publish/services/publishLanding";
import { PublishConnectionRepository } from "@/server/features/rankloop/publish/repositories/PublishConnectionRepository";
import { PublishRepository } from "@/server/features/rankloop/publish/repositories/PublishRepository";
import { PagePlanRepository } from "@/server/features/rankloop/page-plan/repositories/PagePlanRepository";
import { ProjectRepository } from "@/server/features/projects/repositories/ProjectRepository";
import {
  resolvePublishClaim,
  resumeClaimStatus,
} from "@/server/features/rankloop/publish/services/unattendedPublish";
import { ReceiptsService } from "@/server/features/rankloop/receipts/services/ReceiptsService";
import { ArticleGateService } from "@/server/features/rankloop/writing/services/ArticleGateService";
import { ArticleRepository } from "@/server/features/rankloop/writing/repositories/ArticleRepository";
import { WriterSettingsRepository } from "@/server/features/rankloop/writing/repositories/WriterSettingsRepository";
import { AppError } from "@/server/lib/errors";
import { WRITER_SETTINGS_DEFAULTS } from "@/shared/rankloop-writing";
import type { LinkTarget } from "@/server/features/rankloop/publish/linkTargets.logic";
import type { RankloopInjectedLink } from "@/types/schemas/rankloopPublish";

// The steps of the publish workflow, one exported function each (spec 0021).
// The workflow file is the order; this file is what each step does, so the
// order can be read in twenty lines and every step can be tested against a
// mocked adapter without a workflow runtime.
//
// Step 5 (links) and step 6 (wire) live in PublishLinksService — they are the
// half of publishing that edits pages rankloop did not create, and keeping
// them behind their own import is how "no adapter writes anywhere outside the
// delimited block except when creating a new post" stays provable by grep.
// The two ways a run ends without publishing — the refusal and the crash —
// live in publishLanding.ts and are re-exported here, so the workflow still
// reads every step off one object.

// ---------------------------------------------------------------------------
// The context every step after preflight reads
// ---------------------------------------------------------------------------

type PreflightResult =
  | { ok: true; context: PublishContext }
  | { ok: false; blocked: PublishBlocked };

/** Somebody else holds this row. The refusal is shared by the two places that
 *  can lose it — the resume's re-take and the dial's claim — because both mean
 *  the same thing and `landBlocked` deliberately does nothing with either. */
const LOST_CLAIM: PreflightResult = {
  ok: false,
  blocked: {
    reason: "lost_claim",
    detail: "Another publish is already running for this article.",
  },
};

// ---------------------------------------------------------------------------
// Step 1 — preflight
// ---------------------------------------------------------------------------

/**
 * Everything that must be true before anything is written to the user's site.
 *
 * The gate is re-run here on the stored content rather than trusted from the
 * draft's own run: laws change, page types get re-approved, and a link to a
 * post that was deleted this morning no longer resolves. A pass from last
 * Tuesday is not a pass today, and the one moment that judgement is worth
 * paying for is the moment before the write.
 *
 * Nothing in this function touches an adapter. Every failure path returns the
 * article to `review` with a reason and leaves the site untouched — which is
 * the whole reason this step exists rather than being folded into the publish.
 */
async function preflight(input: {
  projectId: string;
  articleId: string;
}): Promise<PreflightResult> {
  const article = await ArticleRepository.getArticleById(
    input.projectId,
    input.articleId,
  );
  if (!article) throw new AppError("NOT_FOUND", "Article not found.");

  // An already-published article is not sent back to review — that would
  // un-say something the site has already said. The run simply stops.
  if (article.status === "published") {
    return {
      ok: false,
      blocked: {
        reason: "already_published",
        detail: "This article is already published.",
      },
    };
  }

  const [project, settings] = await Promise.all([
    ProjectRepository.getProjectById(input.projectId),
    WriterSettingsRepository.getSettings(input.projectId),
  ]);
  if (!project) throw new AppError("NOT_FOUND", "Project not found.");

  // The resume path: a post already exists on the target, so the laws and the
  // dial were satisfied on the run that created it and re-judging them now
  // could only strand a live page halfway through its own publish.
  if (article.adapterRef) {
    // A replay of the same instance is already holding `publishing`. A fresh
    // run is not: it picks the article up from wherever the crashed run left
    // it, and the commit's CAS reads `publishing` — without re-taking the row
    // the run would finish with the flip silently missing.
    if (article.status !== "publishing") {
      const from = resumeClaimStatus(article.status);
      const retaken =
        from !== null &&
        (await PublishRepository.claimForPublishing({
          projectId: input.projectId,
          articleId: input.articleId,
          fromStatus: from,
        }));
      if (!retaken) return LOST_CLAIM;
    }
    return {
      ok: true,
      context: await buildContext({ article, project }),
    };
  }

  // The dial, and — on the unattended path only — what the receipts say this
  // action type has earned. See unattendedPublish.ts.
  const claim = await resolvePublishClaim({
    projectId: input.projectId,
    proposalId: article.proposalId,
    trustDial: settings?.trustDial ?? WRITER_SETTINGS_DEFAULTS.trustDial,
    status: article.status,
    now: new Date(),
  });
  if (!claim.ok) {
    return {
      ok: false,
      blocked: { reason: "trust_dial", detail: claim.detail },
    };
  }

  if (!article.content) {
    return {
      ok: false,
      blocked: {
        reason: "no_content",
        detail: "This article has no stored draft to publish.",
      },
    };
  }

  const outcome = await ArticleGateService.gate({
    projectId: input.projectId,
    articleId: input.articleId,
    markdown: article.content,
  });
  if (!outcome.passed) {
    const unmet = outcome.report.violations;
    return {
      ok: false,
      blocked: {
        reason: "laws_unmet",
        detail: `The laws were re-checked against the stored draft and ${unmet} ${unmet === 1 ? "is" : "are"} unmet.`,
      },
    };
  }

  const resolved = await resolvePublishAdapter(input.projectId, {
    slug: article.slug ?? slugify(article.keyword),
  });
  if (!resolved) {
    return {
      ok: false,
      blocked: {
        reason: "not_connected",
        detail: "Connect a publish target before publishing.",
      },
    };
  }

  // The claim is a CAS from the status preflight just judged: two workflows
  // that somehow reached this line for one article cannot both proceed, and
  // the loser stops before the adapter rather than after it.
  const claimed = await PublishRepository.claimForPublishing({
    projectId: input.projectId,
    articleId: input.articleId,
    fromStatus: claim.claimFrom,
  });
  if (!claimed) return LOST_CLAIM;

  return { ok: true, context: await buildContext({ article, project }) };
}

// ---------------------------------------------------------------------------
// Step 2 — the hub, before the instance
// ---------------------------------------------------------------------------

type HubResult = {
  contentPageId: string | null;
  path: string | null;
  url: string | null;
  ref: string | null;
  created: boolean;
  note: string | null;
};

/**
 * Make sure the page type's hub exists before its first instance does.
 *
 * An instance nobody links to is an orphan, and orphans are how programmatic
 * pages die in "Discovered — currently not indexed". The hub is also written
 * into the manifest and pinned on the page type, so the next publish under the
 * same type finds it instead of creating a second one.
 *
 * A page type with no urlPattern has no hub path to derive, and a target that
 * does not create hubs is not asked to: both return a note rather than a
 * failure, because a missing hub is a weaker publish, not a broken one.
 */
async function ensureHub(context: PublishContext): Promise<HubResult> {
  const empty: HubResult = {
    contentPageId: null,
    path: null,
    url: null,
    ref: null,
    created: false,
    note: null,
  };
  const hubPath = hubPathFromUrlPattern(context.urlPattern);
  if (!hubPath) {
    return { ...empty, note: "This page type has no hub path to create." };
  }

  const resolved = await requireAdapter(context);
  if (!resolved.adapter.capabilities.createsHubs) {
    return {
      ...empty,
      note: `${resolved.adapter.capabilities.label} manages its own hub pages.`,
    };
  }

  const hub = await recordingAuthFailure(context.projectId, () =>
    resolved.adapter.ensureHub({
      name: context.pageTypeName,
      path: hubPath,
      slug: slugFromPath(hubPath),
      description: `Everything we have written about ${context.pageTypeName.toLowerCase()}.`,
    }),
  );

  const contentPageId = await PublishRepository.upsertPublishedPage({
    projectId: context.projectId,
    url: hub.url || absoluteUrl(context.siteUrl, hub.path),
    path: hub.path,
    kind: "hub",
    title: context.pageTypeName,
    description: null,
    publishedAt: null,
    category: context.pageTypeName,
    keyword: null,
    pageTypeId: context.pageTypeId,
  });
  if (context.pageTypeId) {
    await PagePlanRepository.updatePageType(context.pageTypeId, {
      hubContentPageId: contentPageId,
    });
  }

  return {
    contentPageId,
    path: hub.path,
    url: hub.url,
    ref: hub.ref,
    created: hub.created,
    note: hub.notes[0] ?? null,
  };
}

// ---------------------------------------------------------------------------
// Step 3 — the post itself
// ---------------------------------------------------------------------------

type PublishedResult = {
  adapter: string;
  adapterRef: string;
  url: string;
  urlVerified: boolean;
  /** True when a previous run had already created this post. */
  resumed: boolean;
  notes: string[];
};

/**
 * Create the post. Exactly once, ever.
 *
 * `articles.adapterRef` is the guard, checked against the row rather than
 * against a workflow's memory: a run that resumes after this step — or a
 * second run started for the same article — finds the ref and returns it
 * instead of creating a duplicate post. This is also why the workflow gives
 * this step zero retries: a retried create is a second post, and no HTTP
 * timeout is worth two of somebody's articles.
 */
async function publishPost(input: {
  context: PublishContext;
  hub: HubResult;
  /** The neighbours this run intends to link from. A delegated target applies
   *  them itself and receives them here; an editing target ignores them and
   *  gets `updatePost` calls in step 5 instead. */
  targets: LinkTarget[];
  anchor: string;
}): Promise<PublishedResult> {
  const { context } = input;
  const article = await ArticleRepository.getArticleById(
    context.projectId,
    context.articleId,
  );
  if (!article) throw new AppError("NOT_FOUND", "Article not found.");
  if (article.adapterRef) {
    return {
      adapter: article.adapter ?? "",
      adapterRef: article.adapterRef,
      url: article.publishedUrl ?? absoluteUrl(context.siteUrl, context.path),
      urlVerified: article.publishedUrl !== null,
      resumed: true,
      notes: [],
    };
  }

  const resolved = await requireAdapter(context);
  const created = await recordingAuthFailure(context.projectId, () =>
    resolved.adapter.createPost({
      article: {
        slug: context.slug,
        title: context.title,
        description: context.description,
        date: context.date,
        category: context.pageTypeName,
        keyword: context.keyword,
        markdown: article.content ?? "",
        path: context.path,
      },
      hub:
        input.hub.ref && input.hub.path
          ? {
              name: context.pageTypeName,
              path: input.hub.path,
              ref: input.hub.ref,
            }
          : null,
      links: input.targets.map((target) => ({
        fromPath: target.path,
        toPath: context.path,
        anchor: input.anchor,
      })),
    }),
  );

  // Stored the moment it exists, in its own write, before anything else can
  // fail: the ref is worthless as an idempotency guard if it only lands at the
  // end of a run that can crash in five more places.
  await ArticleRepository.updateArticle(context.articleId, {
    adapter: resolved.adapter.capabilities.kind,
    adapterRef: created.ref,
    publishedUrl: created.url,
  });

  return {
    adapter: resolved.adapter.capabilities.kind,
    adapterRef: created.ref,
    url: created.url,
    urlVerified: created.urlConfidence === "verified",
    resumed: false,
    notes: created.notes,
  };
}

// ---------------------------------------------------------------------------
// Step 4 — the manifest
// ---------------------------------------------------------------------------

/**
 * Put the new page in the corpus immediately, before any crawl.
 *
 * Everything downstream reads content_pages: the receipt needs a page row to
 * anchor its baseline, the next brief needs the page as a link candidate, and
 * the next site study needs to know this URL is ours rather than pruning it.
 * Waiting for a crawl would mean a published article is invisible to its own
 * product for a day.
 */
async function upsertManifestPage(input: {
  context: PublishContext;
  url: string;
}): Promise<{ contentPageId: string; publishedAt: string }> {
  // The publish instant is minted inside this step, not in the workflow body:
  // a resumed run replays this step's stored result but re-executes the body
  // around it, and a second `new Date()` there would hand the receipt step a
  // stamp the article row never carried — which is exactly the marker the
  // commit's CAS gates on.
  const publishedAt = new Date().toISOString();
  const contentPageId = await PublishRepository.upsertPublishedPage({
    projectId: input.context.projectId,
    url: input.url,
    path: input.context.path,
    kind: "post",
    title: input.context.title,
    description: input.context.description || null,
    publishedAt,
    category: input.context.pageTypeName,
    keyword: input.context.keyword,
    pageTypeId: input.context.pageTypeId,
  });
  return { contentPageId, publishedAt };
}

// ---------------------------------------------------------------------------
// Step 8 — the receipt, in the same transaction as the flip
// ---------------------------------------------------------------------------

/**
 * Close the run: the article publishes, its proposal is done, its keyword
 * leaves the backlog, and a receipt opens with a real baseline — all in one
 * atomic write set.
 *
 * They ride together because any two of them without the third is a lie: a
 * published article with no receipt has no measurement, and a receipt with no
 * published article measures nothing. The baseline is assembled outside the
 * transaction on purpose — stored GSC memory only changes when a sync runs,
 * never when a publish does.
 */
async function commitPublished(input: {
  context: PublishContext;
  contentPageId: string;
  adapterRef: string;
  adapter: string;
  publishedUrl: string;
  links: RankloopInjectedLink[];
  publishedAt: string;
}): Promise<void> {
  const receipt = await ReceiptsService.openReceipt({
    projectId: input.context.projectId,
    actionType: "write_new",
    contentPageId: input.contentPageId,
    targetQuery: input.context.keyword,
    executedAt: input.publishedAt,
  });

  await PublishRepository.markPublishedWithReceipt({
    projectId: input.context.projectId,
    articleId: input.context.articleId,
    proposalId: input.context.proposalId,
    keywordBacklogId: input.context.keywordBacklogId,
    publishedUrl: input.publishedUrl,
    adapter: input.adapter,
    adapterRef: input.adapterRef,
    linksInjectedJson:
      input.links.length > 0 ? JSON.stringify(input.links) : null,
    stamp: input.publishedAt,
    receipt,
  });
}

// ---------------------------------------------------------------------------
// Starting a run
// ---------------------------------------------------------------------------

/**
 * Hand an approved article to the publish workflow.
 *
 * A fresh instance id per attempt, and the article row is the lock. Workflow
 * instance ids are permanent — an id a completed run used is refused for the
 * whole retention period — so reusing the article id would mean that once any
 * publish had ever run for an article, no later one could start: every retry
 * of a draft the preflight sent back to review would report "already
 * publishing" and do nothing. `claimForPublishing`'s CAS is the authoritative
 * guard against two runs anyway, and it is the row this reads.
 *
 * The connection is checked here only to fail fast for the UI — preflight
 * checks it again, because a connection can be deleted between this call and
 * the step that would use it.
 */
async function startPublish(input: {
  projectId: string;
  articleId: string;
}): Promise<{ articleId: string; alreadyPublishing: boolean }> {
  const article = await ArticleRepository.getArticleById(
    input.projectId,
    input.articleId,
  );
  if (!article) throw new AppError("NOT_FOUND", "Article not found.");
  if (article.status === "published") {
    throw new AppError("CONFLICT", "This article is already published.");
  }
  if (article.status === "publishing") {
    return { articleId: input.articleId, alreadyPublishing: true };
  }
  const run = { slug: article.slug ?? slugify(article.keyword) };
  if (!(await resolvePublishAdapter(input.projectId, run))) {
    throw new AppError(
      "PUBLISH_NOT_CONNECTED",
      "Connect a publish target before publishing.",
    );
  }

  // Not caught: a binding error or an engine quota rejection reported as "a
  // publish is already running" is a lie the caller acts on — the panel toasts
  // "Publishing started" and the unattended loop logs a publish that never
  // happened.
  await env.PUBLISH_WORKFLOW.create({
    id: crypto.randomUUID(),
    params: { articleId: input.articleId, projectId: input.projectId },
  });
  return { articleId: input.articleId, alreadyPublishing: false };
}

/** Every step past preflight resolves the adapter for itself: workflow steps
 *  run in their own invocations, and a live client is not something a step
 *  result can carry across one. The run slug is the article's, so the GitHub
 *  target's branch is the same branch in all four steps that touch it. */
async function requireAdapter(context: PublishContext) {
  const resolved = await resolvePublishAdapter(context.projectId, {
    slug: context.slug,
  });
  if (!resolved) {
    throw new AppError(
      "PUBLISH_NOT_CONNECTED",
      "The publish connection was removed while this run was in flight.",
    );
  }
  return resolved;
}

/**
 * One adapter write, with a rejected credential written down where the loop
 * can find it.
 *
 * `publish_connections.status` is the single definition of "this connection is
 * broken": the autopilot kill switch reads it and pauses immediately, and
 * Settings renders it beside `lastCheckedAt`. It used to have exactly one
 * writer — the manual "Test connection" button — so an unattended publish that
 * met a 401 recorded nothing, paused nothing, and the loop went on presenting
 * a revoked credential (spec 0025: "any adapter auth error pauses immediately
 * — a wrong credential retried unattended is how accounts get locked").
 *
 * Inside the step body rather than around it. Workflows replay each step in
 * its own invocation, so an AppError caught outside the step is no longer an
 * AppError, and `asAppError` cannot rebuild one from an adapter message like
 * "WordPress returned 401." Only the auth code is recorded: an unreachable
 * host is a network fact, and marking the connection failed for one timeout
 * would pause a project for its ISP.
 */
async function recordingAuthFailure<T>(
  projectId: string,
  call: () => Promise<T>,
): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof AppError && error.code === "PUBLISH_AUTH_FAILED") {
      await PublishConnectionRepository.setStatus({
        projectId,
        status: "failed",
        lastCheckedAt: new Date().toISOString(),
      });
    }
    throw error;
  }
}

export const PublishService = {
  startPublish,
  describeRun,
  preflight,
  landBlocked,
  landCrashed,
  ensureHub,
  publishPost,
  upsertManifestPage,
  submitIndexNow,
  commitPublished,
};
