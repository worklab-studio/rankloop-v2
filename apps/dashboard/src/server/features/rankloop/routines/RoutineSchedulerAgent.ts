import { Agent } from "agents";
import { withPgClient } from "@/db";
import {
  handleRoutineWake,
  nextArmedWake,
} from "@/server/features/rankloop/routines/routineWake";

// The wake cadence, deliberately equal to the cron's. Two dispatchers on two
// different clocks would be two different products; on the same clock the
// second one to arrive simply finds every block not due and costs seven
// indexed reads.
const WAKE_INTERVAL_SECONDS = 15 * 60;

// The schedule row's callback. Named rather than inlined because
// `scheduleEvery` dedupes on (callback, interval, payload) — change this
// string and every armed project quietly grows a second schedule.
const WAKE_CALLBACK = "wake";

/**
 * The Durable Object that makes routines run where cron does not.
 *
 * Cloudflare cron triggers fire only on real Cloudflare — never in miniflare,
 * which is what local dev and the Docker self-host both run — so on the
 * default install every scheduled block silently never ran. DO alarms *do*
 * fire in miniflare, and the `agents` package already ships the alarm-backed
 * scheduler this uses; nothing else in the bundle gives all three
 * environments the same behavior.
 *
 * One instance per project: the DO instance name IS the projectId. Nothing
 * routes to this class over HTTP — it is reached by RPC from trusted server
 * code that has already authorized the project — so unlike the chat agents
 * there is no `onBeforeConnect` in front of it.
 *
 * On a Cloudflare deploy both dispatchers are live and that is fine: the wake
 * runs the same `runProjectRoutines` the sweep ran a moment earlier, finds
 * every block's admission rule already satisfied, and goes back to sleep.
 * Which is exactly what "alarms idle as a backstop" means in practice.
 */
export class RoutineSchedulerAgent extends Agent {
  // Runs on every wake, including the wake caused by an `ensureArmed` RPC. A
  // DO that came back with empty storage re-arms itself here before it does
  // anything else.
  async onStart(): Promise<void> {
    await this.ensureArmed();
  }

  /**
   * Idempotent by construction: `scheduleEvery` dedupes on callback, interval
   * and payload, so this is safe to call from project creation, from a read
   * path, and at the end of every wake.
   */
  async ensureArmed(): Promise<{ nextRunAt: string | null }> {
    const schedule = await this.scheduleEvery(
      WAKE_INTERVAL_SECONDS,
      WAKE_CALLBACK,
    );
    return { nextRunAt: new Date(schedule.time * 1000).toISOString() };
  }

  /** What Settings asks in order to say when the next run is due here. */
  async getStatus(): Promise<{ armed: boolean; nextRunAt: string | null }> {
    const schedules = await this.listSchedules({ type: "interval" });
    return nextArmedWake(schedules, WAKE_CALLBACK);
  }

  /** The alarm callback. */
  async wake(): Promise<void> {
    // Alarms run outside the fetch handler's scope, so the per-invocation
    // Postgres client is opened here — the same wrapper `scheduled()` puts
    // around the sweep (no-op in D1 mode).
    await withPgClient(async () => {
      // The DO instance name IS the projectId; `env` is protected on the base
      // class, so the host is assembled here rather than passing `this`.
      await handleRoutineWake(
        {
          name: this.name,
          env: this.env,
          ensureArmed: () => this.ensureArmed(),
        },
        new Date(),
      );
    });
  }
}
