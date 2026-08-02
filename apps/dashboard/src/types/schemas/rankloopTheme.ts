import { z } from "zod";

// Repo mode inputs (spec 0030).

export const getRankloopThemeSchema = z.object({
  projectId: z.string().uuid(),
});

export const previewRankloopScaffoldSchema = z.object({
  projectId: z.string().uuid(),
});

export const openRankloopScaffoldSchema = z.object({
  projectId: z.string().uuid(),
});
