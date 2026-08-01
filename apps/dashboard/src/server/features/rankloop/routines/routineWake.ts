import type { RoutineRunSummary } from "@/server/features/rankloop/routines/routineBlock";
import { runProjectRoutines } from "@/server/features/rankloop/routines/services/runProjectRoutines";
import type { RoutineEnv } from "@/server/features/rankloop/routines/services/routineDispatch";

/**
 * What the alarm dispatcher needs from the Durable Object holding it: the
 * project it belongs to, the bindings, and a way to re-arm. Naming it is what
 * lets the wake be exercised without workerd.
 */
type RoutineAlarmHost = {
  /** The DO instance name, which IS the projectId. */
  name: string;
  env: RoutineEnv;
  ensureArmed(): Promise<{ nextRunAt: string | null }>;
};

/**
 * One wake: run the project's routines, then re-arm — even if the run threw.
 *
 * The re-arm is deliberately in `finally`. An interval schedule already
 * reschedules itself, but the wake that throws is precisely the wake after
 * which a project must not go quiet, and "the alarm stopped because a block
 * failed once" is the silent failure this whole mechanism exists to prevent.
 */
export async function handleRoutineWake(
  host: RoutineAlarmHost,
  now: Date,
): Promise<RoutineRunSummary> {
  try {
    return await runProjectRoutines(host.env, host.name, now);
  } finally {
    await host.ensureArmed();
  }
}

/**
 * The next wake a set of schedule rows implies, or "not armed" when the set
 * holds none for this callback. Epoch seconds in, ISO out.
 *
 * An empty answer is the honest one: a project whose schedule row was lost
 * has no next run, and saying so is what lets the Settings surface show the
 * problem instead of an invented time.
 */
export function nextArmedWake(
  schedules: readonly { callback: string; time: number }[],
  callback: string,
): { armed: boolean; nextRunAt: string | null } {
  const next = schedules
    .filter((schedule) => schedule.callback === callback)
    .map((schedule) => schedule.time)
    .toSorted((a, b) => a - b)[0];
  return {
    armed: next !== undefined,
    nextRunAt: next === undefined ? null : new Date(next * 1000).toISOString(),
  };
}
