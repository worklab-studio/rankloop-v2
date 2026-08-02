import { createServerFn } from "@tanstack/react-start";
import { ScaffoldService } from "@/server/features/rankloop/theme/services/ScaffoldService";
import { requireProjectContext } from "@/serverFunctions/middleware";
import {
  getRankloopThemeSchema,
  openRankloopScaffoldSchema,
  previewRankloopScaffoldSchema,
} from "@/types/schemas/rankloopTheme";

// Theme extraction works with no repo at all — that is what a Framer or
// Webflow site gets. Only the scaffold endpoints need a GitHub connection.

export const getRankloopTheme = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(getRankloopThemeSchema)
  .handler(async ({ context }) => ScaffoldService.getTheme(context.projectId));

export const previewRankloopScaffold = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(previewRankloopScaffoldSchema)
  .handler(async ({ context }) => ScaffoldService.preview(context.projectId));

// The only endpoint here that writes anything, and it writes to a branch —
// never to the default branch.
export const openRankloopScaffold = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(openRankloopScaffoldSchema)
  .handler(async ({ context }) => ScaffoldService.openScaffoldPull(context.projectId));
