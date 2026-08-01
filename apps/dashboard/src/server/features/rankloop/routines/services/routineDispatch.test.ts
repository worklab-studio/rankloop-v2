import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RoutineEnv } from "@/server/features/rankloop/routines/services/routineDispatch";

const mocks = vi.hoisted(() => ({
  getAgentByName: vi.fn(),
  ensureArmed: vi.fn(),
  getStatus: vi.fn(),
}));

vi.mock("agents", () => ({ getAgentByName: mocks.getAgentByName }));

const kv = { get: vi.fn(), put: vi.fn() };
// A two-key stand-in for the bindings RoutineEnv names; the rest of the KV and
// Durable Object surface is not what these assertions are about.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above
const env = { KV: kv, ROUTINE_SCHEDULER: {} } as unknown as RoutineEnv;

const now = new Date("2026-08-01T09:07:00.000Z");

beforeEach(() => {
  vi.resetModules();
  kv.get.mockReset();
  kv.put.mockReset();
  kv.get.mockResolvedValue(null);
  kv.put.mockResolvedValue(undefined);
  mocks.ensureArmed.mockReset();
  mocks.ensureArmed.mockResolvedValue({ nextRunAt: null });
  mocks.getStatus.mockReset();
  mocks.getStatus.mockResolvedValue({ armed: false, nextRunAt: null });
  mocks.getAgentByName.mockReset();
  mocks.getAgentByName.mockResolvedValue({
    ensureArmed: mocks.ensureArmed,
    getStatus: mocks.getStatus,
  });
});

describe("ensureRoutinesArmed", () => {
  it("arms a project whose alarm was lost, without an operator", async () => {
    const { ensureRoutinesArmed } = await import("./routineDispatch");

    await ensureRoutinesArmed(env, "project_1", now);

    expect(mocks.ensureArmed).toHaveBeenCalledOnce();
  });

  it("costs nothing on the hot path once a project is armed in this isolate", async () => {
    const { ensureRoutinesArmed } = await import("./routineDispatch");

    await ensureRoutinesArmed(env, "project_1", now);
    await ensureRoutinesArmed(
      env,
      "project_1",
      new Date(now.getTime() + 60_000),
    );

    expect(mocks.ensureArmed).toHaveBeenCalledOnce();
  });

  it("retries on the next request when the scheduler was unreachable", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.ensureArmed.mockRejectedValueOnce(new Error("DO unreachable"));
    const { ensureRoutinesArmed } = await import("./routineDispatch");

    // A read must never fail because the scheduler was down...
    await ensureRoutinesArmed(env, "project_1", now);
    // ...and the failure must not buy the throttle a free half hour.
    await ensureRoutinesArmed(env, "project_1", new Date(now.getTime() + 1000));

    expect(mocks.ensureArmed).toHaveBeenCalledTimes(2);
    expect(errors).toHaveBeenCalledOnce();
  });
});

describe("getRoutineDispatchStatus", () => {
  it("names the alarm when no cron tick has landed", async () => {
    mocks.getStatus.mockResolvedValue({
      armed: true,
      nextRunAt: "2026-08-01T09:20:00.000Z",
    });
    const { getRoutineDispatchStatus } = await import("./routineDispatch");

    const status = await getRoutineDispatchStatus(env, "project_1", now);

    expect(status).toEqual({
      mechanism: "alarm",
      nextRunAt: "2026-08-01T09:20:00.000Z",
      lastRunAt: null,
      cronLastTickAt: null,
      alarmArmed: true,
    });
  });

  it("names cron only while ticks are still landing, and dates the next one", async () => {
    kv.get.mockImplementation((key: string) =>
      Promise.resolve(
        key === "rankloop:routines:cron-last-tick"
          ? "2026-08-01T09:00:00.000Z"
          : null,
      ),
    );
    mocks.getStatus.mockResolvedValue({
      armed: true,
      nextRunAt: "2026-08-01T09:30:00.000Z",
    });
    const { getRoutineDispatchStatus } = await import("./routineDispatch");

    const status = await getRoutineDispatchStatus(env, "project_1", now);

    expect(status.mechanism).toBe("cron");
    // The next */15 boundary, not the alarm sitting behind it.
    expect(status.nextRunAt).toBe("2026-08-01T09:15:00.000Z");
  });

  it("stops claiming cron after three missed ticks", async () => {
    kv.get.mockImplementation((key: string) =>
      Promise.resolve(
        key === "rankloop:routines:cron-last-tick"
          ? "2026-08-01T08:00:00.000Z"
          : null,
      ),
    );
    const { getRoutineDispatchStatus } = await import("./routineDispatch");

    const status = await getRoutineDispatchStatus(env, "project_1", now);

    expect(status.mechanism).toBe("alarm");
    expect(status.cronLastTickAt).toBe("2026-08-01T08:00:00.000Z");
  });

  it("says nothing is scheduled rather than inventing a time", async () => {
    mocks.getAgentByName.mockRejectedValue(new Error("DO unreachable"));
    const { getRoutineDispatchStatus } = await import("./routineDispatch");

    const status = await getRoutineDispatchStatus(env, "project_1", now);

    expect(status.alarmArmed).toBe(false);
    expect(status.nextRunAt).toBeNull();
  });
});
