import { createServerFn } from "@tanstack/react-start";
import { ArmoryService } from "@/server/features/rankloop/outreach/services/ArmoryService";
import { requireProjectContext } from "@/serverFunctions/middleware";
import {
  getRankloopArmorySchema,
  saveRankloopKitSchema,
  seedRankloopArmorySchema,
  verifyRankloopLinksSchema,
} from "@/types/schemas/rankloopArmory";

// The Grow board (spec 0029). Nothing in this file sends a message, fills a
// form, or spends money: seeding reads a shipped file, verification fetches
// public pages the way any crawler does.

export const getRankloopArmory = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(getRankloopArmorySchema)
  .handler(async ({ context }) => ArmoryService.getBoard(context.projectId));

export const seedRankloopArmory = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(seedRankloopArmorySchema)
  .handler(async ({ context }) => {
    await ArmoryService.seedBoard(context.projectId);
    return ArmoryService.getBoard(context.projectId);
  });

export const verifyRankloopLinks = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(verifyRankloopLinksSchema)
  .handler(async ({ context }) => {
    const result = await ArmoryService.verifyLinks(context.projectId);
    return { ...result, board: await ArmoryService.getBoard(context.projectId) };
  });

export const saveRankloopKit = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(saveRankloopKitSchema)
  .handler(async ({ context, data }) => {
    await ArmoryService.saveKit(context.projectId, data.kit);
    return ArmoryService.getBoard(context.projectId);
  });
