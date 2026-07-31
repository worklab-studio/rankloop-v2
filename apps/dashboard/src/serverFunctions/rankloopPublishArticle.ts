import { createServerFn } from "@tanstack/react-start";
import { waitUntil } from "cloudflare:workers";
import { PublishPlanService } from "@/server/features/rankloop/publish/services/PublishPlanService";
import { PublishService } from "@/server/features/rankloop/publish/services/PublishService";
import { captureServerEvent } from "@/server/lib/posthog";
import { requireProjectContext } from "@/serverFunctions/middleware";
import {
  getPublishedArticlesSchema,
  publishRankloopArticleSchema,
} from "@/types/schemas/rankloopPublish";

// The transport layer for publishing an article. Split from rankloopPublish.ts
// the way the repositories split: that file is the connection and the optimize
// track's one-field edits, this one is the run that writes a whole new page.
//
// Exactly one endpoint here changes anything, and it changes it asynchronously:
// `publishRankloopArticle` hands the article to a workflow and returns, because
// publishing is four calls to somebody else's CMS and no button should hold a
// request open across them.

/**
 * What pressing Publish will do, before it is pressed.
 *
 * Everything in the answer is read from the same facts the run will use — the
 * same hub, the same neighbours, the same post status — so the sentence the
 * panel renders is a promise the workflow can keep.
 */
export const getRankloopPublishPlan = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(publishRankloopArticleSchema)
  .handler(async ({ context, data }) => {
    return PublishPlanService.getPublishPlan({
      projectId: context.projectId,
      articleId: data.articleId,
    });
  });

export const getRankloopPublishedArticles = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(getPublishedArticlesSchema)
  .handler(async ({ context }) => {
    return PublishPlanService.getPublishedArticles(context.projectId);
  });

/**
 * Send an approved article to the site.
 *
 * Every check that decides whether anything gets written lives in the
 * workflow's preflight step, not here — this endpoint refusing is only a
 * courtesy so the panel can say why without starting a run that would bounce
 * the article straight back to review.
 */
export const publishRankloopArticle = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(publishRankloopArticleSchema)
  .handler(async ({ context, data }) => {
    const result = await PublishService.startPublish({
      projectId: context.projectId,
      articleId: data.articleId,
    });
    waitUntil(
      captureServerEvent({
        distinctId: context.userId,
        event: "rankloop_publish:article_publish",
        organizationId: context.organizationId,
        properties: {
          project_id: context.projectId,
          article_id: result.articleId,
          already_publishing: result.alreadyPublishing,
        },
      }),
    );
    return result;
  });
