import { CompetitorsRepository } from "@/server/features/rankloop/competitors/repositories/CompetitorsRepository";
import { CompetitorsService } from "@/server/features/rankloop/competitors/services/CompetitorsService";

// Each start costs ~$0.15 of DataForSEO plus up to 45 HTML fetches, so the
// per-tick cap is the tightest of the rankloop blocks: 3 studies per
// 15-minute tick still drains 288 competitors a day, far past any real
// backlog.
const MAX_STUDY_STARTS_PER_TICK = 3;

// Monthly, matching the cost sentence the UI shows before the user tracks a
// competitor ("refreshes monthly"). Decay only becomes visible with distance
// between snapshots; a weekly re-study would spend four times as much to
// measure the same noise.
const COMPETITOR_STALE_AFTER_DAYS = 30;

// Cron body for the `scheduled` Worker handler: re-study every tracked
// competitor whose last study is older than a month. Wrapped in
// `withPgClient` at the entrypoint (server.ts). Runs after the receipts block
// so a tick that is already busy measuring published work doesn't queue three
// crawls in front of it.
export async function runScheduledCompetitorStudies() {
  const cutoff = new Date(
    Date.now() - COMPETITOR_STALE_AFTER_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const due = await CompetitorsRepository.getCompetitorsDueForRefresh(
    cutoff,
    MAX_STUDY_STARTS_PER_TICK,
  );

  for (const competitor of due) {
    try {
      const result = await CompetitorsService.startStudy({
        projectId: competitor.projectId,
        competitorId: competitor.id,
      });
      if (result.alreadyRunning) {
        // The due-query excludes active runs, so this only happens when a
        // manual start raced this tick — the partial unique settled it.
        console.log(
          `[cron] Skipping competitor study for ${competitor.domain} — run already active`,
        );
      } else {
        console.log(
          `[cron] Started competitor study ${result.runId} for ${competitor.domain}`,
        );
      }
    } catch (err) {
      console.error(
        `[cron] Error starting competitor study for ${competitor.domain}:`,
        err,
      );
    }
  }
}
