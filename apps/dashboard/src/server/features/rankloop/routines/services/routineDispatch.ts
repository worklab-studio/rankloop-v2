import type { RoutineRunSummary } from "@/server/features/rankloop/routines/routineBlock";

/**
 * Which mechanism is actually driving routines on THIS deployment, and when
 * the next run is due.
 *
 * The fork ships one 15-minute cron, and cron triggers only fire on
 * real Cloudflare — neither miniflare nor the Vite plugin schedules them — so
 * on the default Docker self-host and in local dev the cron body has never
 * run and nothing in the app said so. The Durable Object alarm is the answer
 * (alarms *do* fire in miniflare), and this module is the part that refuses
 * to let either mechanism be silent: the sweep stamps every tick, every run
 * stamps its project, and the status read below states what it found rather
 * than what the config implies.
 */

// The cron cadence, restated here because the honest answer to "when is the
// next run due" on a Cloudflare deploy is the next tick boundary, not the
// alarm the DO happens to be holding. Keep in step with wrangler.jsonc's
// `triggers.crons`.
const CRON_INTERVAL_MS = 15 * 60 * 1000;

// Three missed ticks. A single missed tick is a deploy or a busy minute; 45
// minutes of silence means the cron is not firing here, which is exactly the
// case Settings must be able to state out loud.
const CRON_LIVENESS_WINDOW_MS = 45 * 60 * 1000;

// KV, not a table: this is operational metadata about a deployment, it is
// read by one settings screen, and it must survive a restart without a
// migration. The self-host Docker volume carries `.wrangler/state` — KV
// included — so a container restart keeps the answer.
const CRON_TICK_KEY = "rankloop:routines:cron-last-tick";
const lastRunKey = (projectId: string) =>
  `rankloop:routines:last-run:${projectId}`;

// Long enough that a project idle for a month still reports its last run,
// short enough that a deleted project's key ages out on its own.
const LAST_RUN_TTL_SECONDS = 90 * 24 * 60 * 60;

/**
 * Just the bindings the dispatch path touches.
 *
 * The Worker's `scheduled` handler is handed the generated `Env` and a Durable
 * Object's `this.env` is `Cloudflare.Env`; the two disagree about optionality
 * on variables none of this code reads (`AUTH_MODE`, the secrets in
 * `src/env.d.ts`), so neither is assignable to the other. Naming what the
 * shared path actually uses lets both dispatchers pass their own env — and
 * lets a test pass a two-key object.
 */
export type RoutineEnv = Pick<Cloudflare.Env, "KV" | "ROUTINE_SCHEDULER">;

type RoutineDispatchStatus = {
  /** What is driving routines here, decided by evidence, not by config:
   *  'cron' only when a tick actually landed inside the liveness window. */
  mechanism: "cron" | "alarm";
  /** When the next run is due, whichever mechanism gets there first. Null
   *  means nothing is scheduled — which is a real state, not a loading one. */
  nextRunAt: string | null;
  /** The last time the routine actually ran for this project. */
  lastRunAt: string | null;
  /** The last time this deployment's `scheduled()` handler fired at all. */
  cronLastTickAt: string | null;
  /** Whether this project's Durable Object is holding a wake schedule. */
  alarmArmed: boolean;
};

/** The next 15-minute cron boundary after `now`. `now` is threaded rather
 *  than read so the status read stays assertable against a fixed clock. */
function nextCronTickAt(now: Date): string {
  const elapsed = Math.floor(now.getTime() / CRON_INTERVAL_MS);
  return new Date((elapsed + 1) * CRON_INTERVAL_MS).toISOString();
}

/** Whether a cron tick stamped this recently enough to still be driving. */
function isCronDriving(cronLastTickAt: string | null, now: Date): boolean {
  if (cronLastTickAt === null) return false;
  const last = Date.parse(cronLastTickAt);
  return (
    Number.isFinite(last) && now.getTime() - last <= CRON_LIVENESS_WINDOW_MS
  );
}

/** Stamped by the `scheduled()` handler on every tick, whether or not any
 *  project was due — "the cron fired" and "the cron had work" are different
 *  facts and only the first one answers which dispatcher is live. */
export async function recordCronTick(
  env: RoutineEnv,
  now: Date,
): Promise<void> {
  await env.KV.put(CRON_TICK_KEY, now.toISOString(), {
    expirationTtl: Math.ceil(CRON_LIVENESS_WINDOW_MS / 1000),
  });
}

/** Stamped by `runProjectRoutines` itself, so the record is identical however
 *  the run was dispatched. */
export async function recordRoutineRun(
  env: RoutineEnv,
  summary: RoutineRunSummary,
): Promise<void> {
  await env.KV.put(lastRunKey(summary.projectId), summary.at, {
    expirationTtl: LAST_RUN_TTL_SECONDS,
  });
}

/**
 * Resolve the project's scheduler stub.
 *
 * `agents` is imported lazily on purpose: it pulls `cloudflare:workers` in at
 * module scope, and this module is reached from the project-resolution
 * middleware — i.e. from the graph of nearly everything. A dynamic import
 * keeps it out of the worker's startup module graph the same way the audit's
 * HTML parser is kept out of it, and out of the node-environment unit tests
 * that only mean to resolve a project.
 */
async function schedulerFor(env: RoutineEnv, projectId: string) {
  const { getAgentByName } = await import("agents");
  return getAgentByName(env.ROUTINE_SCHEDULER, projectId);
}

/**
 * Arm this project's scheduler DO. Called on project creation and, throttled,
 * from read paths — the DO's own `scheduleEvery` is idempotent, so calling it
 * again is a no-op that costs one wake.
 */
async function armRoutines(
  env: RoutineEnv,
  projectId: string,
): Promise<{ nextRunAt: string | null }> {
  const scheduler = await schedulerFor(env, projectId);
  return scheduler.ensureArmed();
}

// Per-isolate memory of which projects were armed recently, so the read-path
// call is free on the hot path. Same shape as the self-host telemetry
// heartbeat's throttle: an isolate that has just armed a project does not
// need to ask the DO again, and losing the map on eviction only costs one
// extra wake.
const armedAt = new Map<string, number>();
const ARM_RECHECK_INTERVAL_MS = 30 * 60 * 1000;

/**
 * Cheap enough for a read path: at most one Durable Object wake per project
 * per half hour per isolate. This is the recovery route — a project whose
 * alarm was lost (DO storage reset, a deploy that renamed the class) gets it
 * back the next time anyone looks at the project, with no operator action.
 */
export async function ensureRoutinesArmed(
  env: RoutineEnv,
  projectId: string,
  now: Date = new Date(),
): Promise<void> {
  const last = armedAt.get(projectId);
  if (last !== undefined && now.getTime() - last < ARM_RECHECK_INTERVAL_MS) {
    return;
  }
  armedAt.set(projectId, now.getTime());
  try {
    await armRoutines(env, projectId);
  } catch (err) {
    // Never fail a read because the scheduler was unreachable. Drop the
    // throttle stamp so the next request retries instead of waiting out the
    // window.
    armedAt.delete(projectId);
    console.error(`[routines] Could not arm scheduler for ${projectId}:`, err);
  }
}

/**
 * The honesty read. Reports what is driving routines here and when the next
 * one is due — never "scheduled" when nothing is scheduled.
 */
export async function getRoutineDispatchStatus(
  env: RoutineEnv,
  projectId: string,
  now: Date = new Date(),
): Promise<RoutineDispatchStatus> {
  const [cronLastTickAt, lastRunAt, alarm] = await Promise.all([
    env.KV.get(CRON_TICK_KEY),
    env.KV.get(lastRunKey(projectId)),
    schedulerFor(env, projectId)
      .then((scheduler) => scheduler.getStatus())
      // An unreachable scheduler is reported as "nothing scheduled", not as a
      // failed read: the surface exists to say when a run is due, and "we
      // could not ask" is the same news to the operator.
      .catch(() => ({ armed: false, nextRunAt: null })),
  ]);

  const cronDriving = isCronDriving(cronLastTickAt, now);
  return {
    mechanism: cronDriving ? "cron" : "alarm",
    // Both mechanisms can be live at once on Cloudflare; the due time is
    // whichever arrives first, and the caller has the parts if it wants to
    // say more.
    nextRunAt: cronDriving
      ? earliest(nextCronTickAt(now), alarm.nextRunAt)
      : alarm.nextRunAt,
    lastRunAt,
    cronLastTickAt,
    alarmArmed: alarm.armed,
  };
}

function earliest(a: string, b: string | null): string {
  return b !== null && Date.parse(b) < Date.parse(a) ? b : a;
}
