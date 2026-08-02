import { createServerFn } from "@tanstack/react-start";
import { CascadeService } from "@/server/features/rankloop/pipeline/services/CascadeService";
import { PipelineService } from "@/server/features/rankloop/pipeline/services/PipelineService";
import { requireProjectContext } from "@/serverFunctions/middleware";
import {
  advanceRankloopPipelineSchema,
  getRankloopPipelineSchema,
} from "@/types/schemas/rankloopPipeline";

// The stage model (spec 0028). One read for the Today spine, the sequence
// gate on every screen, and the Day-0 cascade.

export const getRankloopPipeline = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(getRankloopPipelineSchema)
  .handler(async ({ context }) => {
    return PipelineService.getPipeline(context.projectId);
  });

/**
 * Start everything that can start, then report the new state.
 *
 * Called on arrival at a project and by the spine while it polls, so a
 * project advances without anyone pressing anything. Idempotent: every
 * underlying start is guarded by its own partial unique index, so a second
 * call while a stage is in flight returns that run rather than a duplicate.
 */
export const advanceRankloopPipeline = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(advanceRankloopPipelineSchema)
  .handler(async ({ context }) => {
    return CascadeService.advance({
      projectId: context.projectId,
      userId: context.userId,
      userEmail: context.userEmail,
      organizationId: context.organizationId,
    });
  });
