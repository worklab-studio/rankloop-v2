import { createServerFn } from "@tanstack/react-start";
import { waitUntil } from "cloudflare:workers";
import { PagePlanService } from "@/server/features/rankloop/page-plan/services/PagePlanService";
import { captureServerEvent } from "@/server/lib/posthog";
import { requireProjectContext } from "@/serverFunctions/middleware";
import {
  decideRankloopPageTypeSchema,
  getRankloopPagePlanSchema,
  getRankloopPageTypeInstancesSchema,
  startRankloopPagePlanSchema,
} from "@/types/schemas/rankloopPagePlan";

export const getRankloopPagePlan = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(getRankloopPagePlanSchema)
  .handler(async ({ context }) => {
    return PagePlanService.getPlan(context.projectId);
  });

// Paged on its own rather than folded into the plan payload: a pSEO type can
// carry hundreds of keywords, and the tab renders every card at once.
export const getRankloopPageTypeInstances = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(getRankloopPageTypeInstancesSchema)
  .handler(async ({ context, data }) => {
    return PagePlanService.getPageTypeInstances({
      projectId: context.projectId,
      pageTypeId: data.pageTypeId,
      page: data.page,
      pageSize: data.pageSize,
    });
  });

// Idempotent, and the same endpoint for "plan" and "recompute": clicking it
// while a run is active returns that run (alreadyRunning: true) instead of
// erroring — the partial unique index on page_plan_runs is the arbiter, not a
// client-side disable.
export const startRankloopPagePlan = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(startRankloopPagePlanSchema)
  .handler(async ({ context }) => {
    const result = await PagePlanService.startPlan(context.projectId);
    if (!result.alreadyRunning) {
      waitUntil(
        captureServerEvent({
          distinctId: context.userId,
          event: "rankloop_page_plan:plan_start",
          organizationId: context.organizationId,
          properties: { project_id: context.projectId },
        }),
      );
    }
    return result;
  });

// Gate 1 of the product: the one strategy decision the user makes. Approval
// binds the type's keywords to it in the same call, so the tab can never show
// an approved type with nothing behind it.
export const decideRankloopPageType = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(decideRankloopPageTypeSchema)
  .handler(async ({ context, data }) => {
    const result = await PagePlanService.decidePageType({
      projectId: context.projectId,
      pageTypeId: data.pageTypeId,
      decision: data.decision,
    });

    waitUntil(
      captureServerEvent({
        distinctId: context.userId,
        event: "rankloop_page_plan:type_decide",
        organizationId: context.organizationId,
        properties: {
          project_id: context.projectId,
          decision: data.decision,
          bound_keywords: result.boundKeywords,
        },
      }),
    );
    return { decision: data.decision, boundKeywords: result.boundKeywords };
  });
