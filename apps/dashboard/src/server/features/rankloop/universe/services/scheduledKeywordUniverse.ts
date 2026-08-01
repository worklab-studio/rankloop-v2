import type { RoutineBlock } from "@/server/features/rankloop/routines/routineBlock";
import { UniverseRunsRepository } from "@/server/features/rankloop/universe/repositories/UniverseRunsRepository";
import { UniverseRunService } from "@/server/features/rankloop/universe/services/UniverseRunService";
import {
  FREE_UNIVERSE_SOURCES,
  hasHarvestSources,
  parseUniverseRunSources,
  type HarvestConfig,
  type UniverseSource,
} from "@/types/schemas/rankloopUniverse";

// A universe run reads three public endpoints and two public feeds, and the
// harvest step alone sleeps for a minute — so the per-dispatch cap sits with
// the competitor block's rather than the sync blocks'. 3 projects per
// 15-minute tick is 288 a day, far past any real backlog.
const MAX_UNIVERSE_STARTS_PER_TICK = 3;

// Weekly. Autocomplete indexes and question feeds move on the scale of weeks,
// and the GSC unserved half only has new answers once the sync has a week of
// new impressions behind it — daily would re-read the same suggestions and
// spend the same minute of pacing to learn nothing.
const UNIVERSE_STALE_AFTER_DAYS = 7;

/** What a scheduled run may ask for: the free sources, and harvest only when
 *  this project has told us where to harvest from. Metered sources are absent
 *  by construction — a schedule that quietly bills someone weekly is how a
 *  tool loses the trust its cost sentences are trying to earn. */
function scheduledSourcesFor(harvest: HarvestConfig | null): UniverseSource[] {
  return FREE_UNIVERSE_SOURCES.filter(
    (source) => source !== "harvest" || hasHarvestSources(harvest),
  );
}

async function dueProjects(now: Date, projectId?: string) {
  const cutoff = new Date(
    now.getTime() - UNIVERSE_STALE_AFTER_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const due = await UniverseRunsRepository.getProjectsDueForFreeSources(
    cutoff,
    projectId ? 1 : MAX_UNIVERSE_STARTS_PER_TICK,
    projectId,
  );
  return due.map((project) => project.projectId);
}

async function runForProject(projectId: string) {
  // The last harvesting run is this project's record of where to harvest
  // from; without one, the block runs the other two free sources and the
  // Collapsible stays the only way to configure a harvest.
  const lastHarvestRun =
    await UniverseRunsRepository.getLatestHarvestRunForProject(projectId);
  const harvest =
    parseUniverseRunSources(lastHarvestRun?.sourcesJson ?? null)?.harvest ??
    null;

  const result = await UniverseRunService.startRun({
    projectId,
    sources: scheduledSourcesFor(harvest),
    ...(harvest ? { harvest } : {}),
  });
  if (result.alreadyRunning) {
    // The due-query excludes projects with a young active run, so this only
    // happens when a manual start raced this dispatch — the partial unique
    // settled it.
    console.log(
      `[routines] Skipping keyword universe for ${projectId} — run already active`,
    );
    return;
  }
  console.log(
    `[routines] Started keyword universe ${result.runId} for ${projectId}`,
  );
}

/** Refill the keyword backlog from the free sources. Ordered after the
 *  competitor block so a dispatch that is already crawling three competitors
 *  doesn't queue three more minutes of feed pacing in front of it. */
export const universeBlock: RoutineBlock = {
  name: "universe",
  dueProjects,
  runForProject,
};
