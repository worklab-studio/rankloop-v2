import { createServerFn } from "@tanstack/react-start";
import { IndexationService } from "@/server/features/rankloop/indexation/services/IndexationService";
import { requireProjectContext } from "@/serverFunctions/middleware";
import { getRankloopIndexationSchema } from "@/types/schemas/rankloopIndexation";

export const getRankloopIndexation = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(getRankloopIndexationSchema)
  .handler(async ({ context }) => {
    return IndexationService.getIndexationStatus(context.projectId);
  });
