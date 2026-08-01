import { AutopilotRepository } from "@/server/features/rankloop/routines/repositories/AutopilotRepository";
import { runAutopilot } from "@/server/features/rankloop/routines/services/AutopilotRunService";
import type { RoutineBlock } from "@/server/features/rankloop/routines/routineBlock";

// The block that acts. Everything above it in ROUTINE_BLOCKS produces state —
// memory, receipts, indexation verdicts, proposals — and this one is the only
// place in the product where a decision is made and executed without a human
// having clicked anything.
//
// It is a RoutineBlock like the rest, which is the point: the same dispatcher
// runs it on Cloudflare cron and on a self-host's Durable Object alarm, so
// "the loop closed itself overnight" cannot mean two different things on two
// deployments.

// One run is at most one quota's worth of approvals, two model calls and two
// publishes, so ten projects is a bounded tick even when every one of them has
// work. The ordering is least-recently-reconciled first, which is what keeps
// the eleventh project from starving behind the same ten.
const MAX_PROJECTS_PER_TICK = 10;

/**
 * Projects whose dial is set to autopilot.
 *
 * The dial is the only one of the five preconditions that belongs in the
 * due-set: it is a stored user choice and it is what makes the read cheap. The
 * other four are per-project facts (a pause, a cohort of receipts, an
 * indexation rate, a connected target) that the run itself checks and records
 * a reason for — a project filtered out here would be a project that silently
 * did nothing, which is the failure mode this spec exists to remove.
 */
async function dueProjects(_now: Date, projectId?: string) {
  const rows = await AutopilotRepository.getAutopilotProjects(
    projectId ? 1 : MAX_PROJECTS_PER_TICK,
    projectId,
  );
  return rows.map((row) => row.projectId);
}

async function runForProject(projectId: string, now: Date) {
  const result = await runAutopilot({ projectId, now });
  for (const decision of result.decisions) {
    console.log(
      `[routines] autopilot ${decision.phase} for ${projectId}: ${decision.detail} (${decision.id})`,
    );
  }
  // Refusals are logged at the same volume as decisions, deliberately. A run
  // that did nothing is the run most likely to be misread as a broken cron,
  // and the reason is the difference between "waiting for evidence" and
  // "paused since Tuesday because a credential expired".
  for (const refusal of result.refusals) {
    console.log(
      `[routines] autopilot ${refusal.phase} skipped for ${projectId}: ${refusal.reason}`,
    );
  }
}

/** Last, and after the digest: every producer above has already run, so the
 *  machine acts on the freshest state the routine can offer rather than on
 *  whatever was true fifteen minutes ago. */
export const autopilotBlock: RoutineBlock = {
  name: "autopilot",
  dueProjects,
  runForProject,
};
