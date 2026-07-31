import { IndexationRepository } from "@/server/features/rankloop/indexation/repositories/IndexationRepository";
import { IndexationService } from "@/server/features/rankloop/indexation/services/IndexationService";

// Each project's sweep is at most 20 URL Inspection calls, and the due-set is
// ordered least-recently-checked first, so a tick that only reaches ten
// projects hands the next tick the ten it missed. Fifteen minutes later.
const MAX_PROJECTS_PER_TICK = 10;

/**
 * Cron body for the `scheduled` Worker handler: ask Google whether it indexed
 * what we published. Runs after the receipts block — both read the same
 * published corpus, and receipts is the one with a deadline (a measurement
 * window that closes). Wrapped in `withPgClient` at the entrypoint
 * (server.ts).
 *
 * Daily work riding the 15-minute cron, like receipts: the per-project budget
 * and the 7-day recheck window mean almost every tick finds nothing due and
 * costs two indexed reads, which is cheaper than a second scheduler.
 */
export async function runScheduledIndexationChecks() {
  const due = await IndexationRepository.getProjectsDueForIndexation(
    MAX_PROJECTS_PER_TICK,
  );

  for (const { projectId } of due) {
    try {
      const result = await IndexationService.runIndexationChecks(projectId);
      // Quiet ticks stay quiet — the reason only earns a line when a URL was
      // actually refused, not when there was simply nothing to ask about.
      if (result.checked > 0 || result.failed > 0) {
        console.log(
          `[cron] Indexation checks for ${projectId}: ${result.checked} checked, ` +
            `${result.indexed} indexed, ${result.failed} failed`,
        );
      }
    } catch (err) {
      console.error(
        `[cron] Error running indexation checks for project ${projectId}:`,
        err,
      );
    }
  }
}
