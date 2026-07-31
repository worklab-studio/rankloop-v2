import { createServerFn } from "@tanstack/react-start";
import { ReceiptsService } from "@/server/features/rankloop/receipts/services/ReceiptsService";
import { requireProjectContext } from "@/serverFunctions/middleware";
import { getRankloopReceiptsSchema } from "@/types/schemas/rankloopReceipts";

export const getRankloopReceipts = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(getRankloopReceiptsSchema)
  .handler(async ({ context }) => {
    return ReceiptsService.getReceipts(context.projectId);
  });
