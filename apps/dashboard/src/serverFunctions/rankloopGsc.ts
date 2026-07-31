import { createServerFn } from "@tanstack/react-start";
import { waitUntil } from "cloudflare:workers";
import { GscSyncService } from "@/server/features/rankloop/gsc-sync/services/GscSyncService";
import { captureServerEvent } from "@/server/lib/posthog";
import { requireProjectContext } from "@/serverFunctions/middleware";
import {
  getRankloopGscMemorySchema,
  startRankloopGscSyncSchema,
} from "@/types/schemas/rankloopGsc";

// Idempotent: clicking "Sync now" while a run is active returns that run
// (alreadyRunning: true) instead of erroring — the partial unique index on
// gsc_sync_runs is the arbiter, not a client-side disable.
export const startRankloopGscSync = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(startRankloopGscSyncSchema)
  .handler(async ({ context }) => {
    const result = await GscSyncService.startSync(context.projectId);
    if (!result.alreadyRunning) {
      waitUntil(
        captureServerEvent({
          distinctId: context.userId,
          event: "rankloop_gsc:sync_start",
          organizationId: context.organizationId,
          properties: { project_id: context.projectId, mode: result.mode },
        }),
      );
    }
    return result;
  });

export const getRankloopGscMemory = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(getRankloopGscMemorySchema)
  .handler(async ({ context }) => {
    return GscSyncService.getMemory(context.projectId);
  });
