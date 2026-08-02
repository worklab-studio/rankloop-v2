import { createServerFn } from "@tanstack/react-start";
import { ArmoryMiningService } from "@/server/features/rankloop/outreach/services/ArmoryMiningService";
import { ArmoryService } from "@/server/features/rankloop/outreach/services/ArmoryService";
import { requireProjectContext } from "@/serverFunctions/middleware";
import {
  getRankloopArmorySchema,
  mineRankloopArmorySchema,
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

// The one metered endpoint in the armory. The quote comes back with the
// board so the cost is on screen before anybody commits to it.
export const mineRankloopArmory = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(mineRankloopArmorySchema)
  .handler(async ({ context, data }) => {
    const result = await ArmoryMiningService.mine({
      projectId: context.projectId,
      billingCustomer: {
        userId: context.userId,
        userEmail: context.userEmail,
        organizationId: context.organizationId,
        projectId: context.projectId,
      },
      // Passed in rather than read from the clock inside the query builder,
      // so "{noun} tools 2026" is decided by the caller and stays testable.
      year: data.year,
    });
    return { ...result, board: await ArmoryService.getBoard(context.projectId) };
  });
