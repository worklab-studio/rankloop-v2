import type { RoutineBlock } from "@/server/features/rankloop/routines/routineBlock";
import { GscSyncRepository } from "@/server/features/rankloop/gsc-sync/repositories/GscSyncRepository";
import {
  addDays,
  GSC_FINAL_LAG_DAYS,
  GscSyncService,
  todayInPacific,
} from "@/server/features/rankloop/gsc-sync/services/GscSyncService";

// The sweep does not try to drain every stale project in one tick; the
// 15-minute cadence absorbs backlog, and each start is one cheap workflow
// spawn, not the sync itself.
const MAX_SYNC_STARTS_PER_TICK = 10;

// A project is due once its watermark trails the freshest finalized PT day
// (4 days ago) — i.e. a daily delta exists to pull. Never-synced projects are
// due for the 90-day backfill.
async function dueProjects(now: Date, projectId?: string) {
  const cutoff = addDays(todayInPacific(now), -GSC_FINAL_LAG_DAYS);
  const due = await GscSyncRepository.getProjectsDueForSync(
    cutoff,
    projectId ? 1 : MAX_SYNC_STARTS_PER_TICK,
    projectId,
  );
  return due.map((row) => row.projectId);
}

async function runForProject(projectId: string) {
  const result = await GscSyncService.startSync(projectId);
  if (result.alreadyRunning) {
    // The due-query excludes active runs, so this only happens when a manual
    // start raced this dispatch — the partial unique settled it.
    console.log(
      `[routines] Skipping gsc sync for project ${projectId} — run already active`,
    );
    return;
  }
  console.log(
    `[routines] Started gsc sync ${result.runId} for project ${projectId} (${result.mode})`,
  );
}

/** Pull whatever days of Search Console history this project is missing. */
export const gscSyncBlock: RoutineBlock = {
  name: "gsc-sync",
  dueProjects,
  runForProject,
};
