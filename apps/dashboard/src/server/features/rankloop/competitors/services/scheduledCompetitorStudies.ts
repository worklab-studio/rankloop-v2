import type { RoutineBlock } from "@/server/features/rankloop/routines/routineBlock";
import { CompetitorsRepository } from "@/server/features/rankloop/competitors/repositories/CompetitorsRepository";
import { CompetitorsService } from "@/server/features/rankloop/competitors/services/CompetitorsService";

// Each start costs ~$0.15 of DataForSEO plus up to 45 HTML fetches, so the
// per-dispatch cap is the tightest of the rankloop blocks: 3 studies per
// 15-minute tick still drains 288 competitors a day, far past any real
// backlog. Scoped to one project the cap is per project, which is the same
// spend ceiling seen from the only angle that project's operator cares about.
const MAX_STUDY_STARTS_PER_TICK = 3;

// Monthly, matching the cost sentence the UI shows before the user tracks a
// competitor ("refreshes monthly"). Decay only becomes visible with distance
// between snapshots; a weekly re-study would spend four times as much to
// measure the same noise.
const COMPETITOR_STALE_AFTER_DAYS = 30;

function staleCutoff(now: Date) {
  return new Date(
    now.getTime() - COMPETITOR_STALE_AFTER_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
}

async function dueProjects(now: Date, projectId?: string) {
  const due = await CompetitorsRepository.getCompetitorsDueForRefresh(
    staleCutoff(now),
    MAX_STUDY_STARTS_PER_TICK,
    projectId,
  );
  return [...new Set(due.map((competitor) => competitor.projectId))];
}

// One project can hold several stale competitors, so this loop keeps its own
// per-competitor try/catch: a domain that fails to crawl must not cost its
// siblings their monthly refresh.
async function runForProject(projectId: string, now: Date) {
  const due = await CompetitorsRepository.getCompetitorsDueForRefresh(
    staleCutoff(now),
    MAX_STUDY_STARTS_PER_TICK,
    projectId,
  );
  for (const competitor of due) {
    try {
      const result = await CompetitorsService.startStudy({
        projectId: competitor.projectId,
        competitorId: competitor.id,
      });
      if (result.alreadyRunning) {
        // The due-query excludes active runs, so this only happens when a
        // manual start raced this dispatch — the partial unique settled it.
        console.log(
          `[routines] Skipping competitor study for ${competitor.domain} — run already active`,
        );
      } else {
        console.log(
          `[routines] Started competitor study ${result.runId} for ${competitor.domain}`,
        );
      }
    } catch (err) {
      console.error(
        `[routines] Error starting competitor study for ${competitor.domain}:`,
        err,
      );
    }
  }
}

/** Re-study tracked competitors whose last study is older than a month.
 *  Ordered after receipts so a dispatch that is already busy measuring
 *  published work doesn't queue three crawls in front of it. */
export const competitorsBlock: RoutineBlock = {
  name: "competitors",
  dueProjects,
  runForProject,
};
