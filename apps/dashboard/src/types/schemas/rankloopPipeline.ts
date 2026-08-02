import { z } from "zod";

// Inputs for the pipeline endpoints (spec 0028). The project is re-derived
// from `requireProjectContext`; these only carry which project is meant.

export const getRankloopPipelineSchema = z.object({
  projectId: z.string().uuid(),
});

export const advanceRankloopPipelineSchema = z.object({
  projectId: z.string().uuid(),
});
