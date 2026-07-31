import { SiteStudyRepository } from "@/server/features/rankloop/site-study/repositories/SiteStudyRepository";
import { SiteStudyService } from "@/server/features/rankloop/site-study/services/SiteStudyService";

// Each start spawns a full crawl of the project's site, so the per-tick cap
// is tighter than gsc-sync's: 5 crawls per 15-minute tick spreads a big
// backlog without a thundering herd of audits.
const MAX_STUDY_STARTS_PER_TICK = 5;

// Weekly cadence — matches the workflow's own 7-day audit-freshness window,
// so a scheduled re-study never reuses the audit the previous study derived
// from.
const STUDY_STALE_AFTER_DAYS = 7;

// Cron body for the `scheduled` Worker handler: re-study every project whose
// latest done study is older than a week. Wrapped in `withPgClient` at the
// entrypoint (server.ts). First studies are never started here — they belong
// to the user's explicit "Study my site".
export async function runScheduledSiteStudies() {
  const cutoff = new Date(
    Date.now() - STUDY_STALE_AFTER_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const due = await SiteStudyRepository.getProjectsDueForStudy(
    cutoff,
    MAX_STUDY_STARTS_PER_TICK,
  );

  for (const { projectId } of due) {
    try {
      const result = await SiteStudyService.startStudy(projectId);
      if (result.alreadyRunning) {
        // The due-query excludes active runs, so this only happens when a
        // manual start raced this tick — the partial unique settled it.
        console.log(
          `[cron] Skipping site study for project ${projectId} — run already active`,
        );
      } else {
        console.log(
          `[cron] Started site study ${result.runId} for project ${projectId}`,
        );
      }
    } catch (err) {
      console.error(
        `[cron] Error starting site study for project ${projectId}:`,
        err,
      );
    }
  }
}
