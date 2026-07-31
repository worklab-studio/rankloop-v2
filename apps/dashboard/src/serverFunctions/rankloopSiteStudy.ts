import { createServerFn } from "@tanstack/react-start";
import { waitUntil } from "cloudflare:workers";
import { SiteStudyService } from "@/server/features/rankloop/site-study/services/SiteStudyService";
import { captureServerEvent } from "@/server/lib/posthog";
import { requireProjectContext } from "@/serverFunctions/middleware";
import {
  getRankloopSiteStudySchema,
  startRankloopSiteStudySchema,
} from "@/types/schemas/rankloopSiteStudy";

// Idempotent: clicking "Study my site" while a run is active returns that
// run (alreadyRunning: true) instead of erroring — the partial unique index
// on site_study_runs is the arbiter, not a client-side disable.
export const startRankloopSiteStudy = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(startRankloopSiteStudySchema)
  .handler(async ({ context }) => {
    const result = await SiteStudyService.startStudy(context.projectId);
    if (!result.alreadyRunning) {
      waitUntil(
        captureServerEvent({
          distinctId: context.userId,
          event: "rankloop_site_study:study_start",
          organizationId: context.organizationId,
          properties: { project_id: context.projectId },
        }),
      );
    }
    return result;
  });

export const getRankloopSiteStudy = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(getRankloopSiteStudySchema)
  .handler(async ({ context }) => {
    return SiteStudyService.getStudy(context.projectId);
  });
