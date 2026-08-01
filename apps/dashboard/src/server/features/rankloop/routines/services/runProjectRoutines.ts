import type {
  RoutineBlock,
  RoutineBlockOutcome,
  RoutineRunSummary,
} from "@/server/features/rankloop/routines/routineBlock";
import { ROUTINE_BLOCKS } from "@/server/features/rankloop/routines/routineBlocks";
import {
  ensureRoutinesArmed,
  recordCronTick,
  recordRoutineRun,
  type RoutineEnv,
} from "@/server/features/rankloop/routines/services/routineDispatch";

// The sweep's own ceiling on how many projects one tick will walk. It is not
// a cap on work — each block already caps itself — but a bound on the read
// fan-out when many projects come due at once, and every project the sweep
// skips is still holding its own alarm.
const MAX_PROJECTS_PER_TICK = 25;

/**
 * Run every routine block this project is due for, in order, at `now`.
 *
 * This is the only place routines actually happen. The cron sweep calls it
 * once per due project and the project's Durable Object alarm calls it once
 * for itself, so a routine cannot mean one thing on a Cloudflare deploy and
 * another in Docker — the environment decides *when* it is called, never
 * *what* it does.
 *
 * Blocks are sequential and isolated: the order is a dependency chain (see
 * ROUTINE_BLOCKS), and one block's failure must not cost the rest of the
 * routine its turn.
 */
export async function runProjectRoutines(
  env: RoutineEnv,
  projectId: string,
  now: Date,
): Promise<RoutineRunSummary> {
  const blocks: RoutineBlockOutcome[] = [];
  for (const block of ROUTINE_BLOCKS) {
    blocks.push(await runBlock(block, projectId, now));
  }

  const summary: RoutineRunSummary = {
    projectId,
    at: now.toISOString(),
    blocks,
  };
  // Stamped here rather than in either caller: "when did this project's
  // routine last run" must be one fact with one writer, or the Settings
  // answer would depend on which dispatcher happened to produce it.
  await recordRoutineRun(env, summary);
  return summary;
}

/**
 * Ask this block's admission rule about this one project, then do the work if
 * the answer is yes.
 *
 * The sweep already asked the same rule instance-wide before it got here, and
 * asking again narrowed to one project is the point: the per-project path has
 * to be self-sufficient because the alarm dispatcher has no sweep in front of
 * it. Each re-ask is one indexed read that returns nothing on almost every
 * dispatch.
 */
async function runBlock(
  block: RoutineBlock,
  projectId: string,
  now: Date,
): Promise<RoutineBlockOutcome> {
  try {
    const due = await block.dueProjects(now, projectId);
    if (!due.includes(projectId)) {
      return { block: block.name, status: "not-due" };
    }
    await block.runForProject(projectId, now);
    return { block: block.name, status: "ran" };
  } catch (err) {
    const error = describeError(err);
    console.error(
      `[routines] ${block.name} failed for project ${projectId}: ${error}`,
    );
    return { block: block.name, status: "failed", error };
  }
}

/**
 * The cron path: every project any block owes work to, walked through the
 * same `runProjectRoutines` the alarm uses.
 *
 * The due-set is the union of the blocks' own admission rules rather than
 * "every project", so each block keeps the per-tick budget and the fairness
 * ordering it was written with (least-recently-served first, tightest cap on
 * the block that spends money).
 */
export async function runDueProjectRoutines(
  env: RoutineEnv,
  now: Date,
): Promise<string[]> {
  // Unconditional, and before the work: a tick that found nothing due is
  // still proof the cron is firing here, which is the fact Settings needs.
  await recordCronTick(env, now);

  const projectIds = await collectDueProjectIds(now);
  for (const projectId of projectIds) {
    await runProjectRoutines(env, projectId, now);
    // The sweep re-arms as it goes, so a Cloudflare deploy repairs alarms
    // that were lost without waiting for someone to open the app.
    await ensureRoutinesArmed(env, projectId, now);
  }
  return projectIds;
}

async function collectDueProjectIds(now: Date): Promise<string[]> {
  const perBlock = await Promise.all(
    ROUTINE_BLOCKS.map(async (block) => {
      try {
        return await block.dueProjects(now);
      } catch (err) {
        console.error(
          `[routines] ${block.name} due-check failed: ${describeError(err)}`,
        );
        return [];
      }
    }),
  );
  return [...new Set(perBlock.flat())].slice(0, MAX_PROJECTS_PER_TICK);
}

/** One line, bounded — a provider error body pasted whole into Workers Logs
 *  is how a useful log becomes an unreadable one. */
function describeError(err: unknown): string {
  return err instanceof Error
    ? err.message.replace(/\s+/g, " ").slice(0, 200)
    : "unknown error";
}
