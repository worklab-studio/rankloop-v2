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
// harvest step alone sleeps for a minute — so the per-tick cap sits with the
// competitor block's rather than the sync blocks'. 3 projects per 15-minute
// tick is 288 a day, far past any real backlog.
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

/**
 * Cron body for the `scheduled` Worker handler: refill the keyword backlog
 * from the free sources for every project whose last run is older than a
 * week. Wrapped in `withPgClient` at the entrypoint (server.ts). Runs after
 * the competitor block so a tick that is already crawling three competitors
 * doesn't queue three more minutes of feed pacing in front of it.
 */
export async function runScheduledKeywordUniverse() {
  const cutoff = new Date(
    Date.now() - UNIVERSE_STALE_AFTER_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const due = await UniverseRunsRepository.getProjectsDueForFreeSources(
    cutoff,
    MAX_UNIVERSE_STARTS_PER_TICK,
  );

  for (const project of due) {
    try {
      // The last harvesting run is this project's record of where to harvest
      // from; without one, the block runs the other two free sources and the
      // Collapsible stays the only way to configure a harvest.
      const lastHarvestRun =
        await UniverseRunsRepository.getLatestHarvestRunForProject(
          project.projectId,
        );
      const harvest =
        parseUniverseRunSources(lastHarvestRun?.sourcesJson ?? null)?.harvest ??
        null;

      const result = await UniverseRunService.startRun({
        projectId: project.projectId,
        sources: scheduledSourcesFor(harvest),
        ...(harvest ? { harvest } : {}),
      });
      if (result.alreadyRunning) {
        // The due-query excludes projects with a young active run, so this
        // only happens when a manual start raced this tick — the partial
        // unique settled it.
        console.log(
          `[cron] Skipping keyword universe for ${project.projectId} — run already active`,
        );
      } else {
        console.log(
          `[cron] Started keyword universe ${result.runId} for ${project.projectId}`,
        );
      }
    } catch (err) {
      console.error(
        `[cron] Error starting keyword universe for ${project.projectId}:`,
        err,
      );
    }
  }
}
