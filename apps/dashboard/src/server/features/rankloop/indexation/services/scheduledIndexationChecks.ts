import type { RoutineBlock } from "@/server/features/rankloop/routines/routineBlock";
import { IndexationRepository } from "@/server/features/rankloop/indexation/repositories/IndexationRepository";
import { IndexationService } from "@/server/features/rankloop/indexation/services/IndexationService";

// Each project's sweep is at most 20 URL Inspection calls, and the due-set is
// ordered least-recently-checked first, so a tick that only reaches ten
// projects hands the next tick the ten it missed. Fifteen minutes later.
const MAX_PROJECTS_PER_TICK = 10;

/**
 * Every connected project is a candidate; the per-project budget and the
 * 7-day recheck window inside `runIndexationChecks` are what make almost
 * every dispatch find nothing to ask about and cost two indexed reads —
 * cheaper than a second scheduler.
 */
async function dueProjects(_now: Date, projectId?: string) {
  const due = await IndexationRepository.getProjectsDueForIndexation(
    projectId ? 1 : MAX_PROJECTS_PER_TICK,
    projectId,
  );
  return due.map((row) => row.projectId);
}

async function runForProject(projectId: string) {
  const result = await IndexationService.runIndexationChecks(projectId);
  // Quiet dispatches stay quiet — the reason only earns a line when a URL was
  // actually refused, not when there was simply nothing to ask about.
  if (result.checked === 0 && result.failed === 0) return;
  console.log(
    `[routines] Indexation checks for ${projectId}: ${result.checked} checked, ` +
      `${result.indexed} indexed, ${result.failed} failed`,
  );
}

/** Ask Google whether it indexed what we published. Ordered after receipts —
 *  both read the same published corpus, and receipts is the one with a
 *  deadline (a measurement window that closes). */
export const indexationBlock: RoutineBlock = {
  name: "indexation",
  dueProjects,
  runForProject,
};
