import type { RoutineBlock } from "@/server/features/rankloop/routines/routineBlock";
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

// First studies are never due here — they belong to the user's explicit
// "Study my site". This only re-studies a project whose latest done study has
// gone stale.
async function dueProjects(now: Date, projectId?: string) {
  const cutoff = new Date(
    now.getTime() - STUDY_STALE_AFTER_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const due = await SiteStudyRepository.getProjectsDueForStudy(
    cutoff,
    projectId ? 1 : MAX_STUDY_STARTS_PER_TICK,
    projectId,
  );
  return due.map((row) => row.projectId);
}

async function runForProject(projectId: string) {
  const result = await SiteStudyService.startStudy(projectId);
  if (result.alreadyRunning) {
    // The due-query excludes active runs, so this only happens when a manual
    // start raced this dispatch — the partial unique settled it.
    console.log(
      `[routines] Skipping site study for project ${projectId} — run already active`,
    );
    return;
  }
  console.log(
    `[routines] Started site study ${result.runId} for project ${projectId}`,
  );
}

/** Re-read the site so the inventory the writer selects from is this week's. */
export const siteStudyBlock: RoutineBlock = {
  name: "site-study",
  dueProjects,
  runForProject,
};
