import { GscSyncRepository } from "@/server/features/rankloop/gsc-sync/repositories/GscSyncRepository";
import {
  addDays,
  GSC_FINAL_LAG_DAYS,
  GscSyncService,
  todayInPacific,
} from "@/server/features/rankloop/gsc-sync/services/GscSyncService";

// The cron does not try to drain every stale project in one tick; the
// 15-minute cadence absorbs backlog, and each start is one cheap workflow
// spawn, not the sync itself.
const MAX_SYNC_STARTS_PER_TICK = 10;

// Cron body for the `scheduled` Worker handler: start a GSC memory sync for
// every project whose stored history has fallen behind. Wrapped in
// `withPgClient` at the entrypoint (server.ts).
export async function runScheduledGscSyncs() {
  // A project is due once its watermark trails the freshest finalized PT day
  // (4 days ago) — i.e. a daily delta exists to pull. Never-synced projects
  // are due for the 90-day backfill.
  const cutoff = addDays(todayInPacific(), -GSC_FINAL_LAG_DAYS);
  const due = await GscSyncRepository.getProjectsDueForSync(
    cutoff,
    MAX_SYNC_STARTS_PER_TICK,
  );

  for (const { projectId } of due) {
    try {
      const result = await GscSyncService.startSync(projectId);
      if (result.alreadyRunning) {
        // The due-query excludes active runs, so this only happens when a
        // manual start raced this tick — the partial unique settled it.
        console.log(
          `[cron] Skipping gsc sync for project ${projectId} — run already active`,
        );
      } else {
        console.log(
          `[cron] Started gsc sync ${result.runId} for project ${projectId} (${result.mode})`,
        );
      }
    } catch (err) {
      console.error(
        `[cron] Error starting gsc sync for project ${projectId}:`,
        err,
      );
    }
  }
}
