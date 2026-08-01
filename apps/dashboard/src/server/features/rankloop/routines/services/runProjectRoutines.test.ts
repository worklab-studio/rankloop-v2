import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RoutineBlock } from "@/server/features/rankloop/routines/routineBlock";
import type { RoutineEnv } from "@/server/features/rankloop/routines/services/routineDispatch";

// Stands in for the DB: every block records what it did, so "identical DB
// effects" is an array comparison rather than a fixture diff.
const effects: string[] = [];

// A block whose admission rule is a fixed set of project ids — the same
// answer whether it is asked instance-wide or about one project, which is
// what the two dispatchers rely on.
function fakeBlock(
  name: RoutineBlock["name"],
  dueIds: string[],
  onRun?: () => void,
): RoutineBlock {
  return {
    name,
    dueProjects: (_now, projectId) =>
      Promise.resolve(
        projectId === undefined
          ? dueIds
          : dueIds.filter((id) => id === projectId),
      ),
    runForProject: (projectId) => {
      onRun?.();
      effects.push(`${name}:${projectId}`);
      return Promise.resolve();
    },
  };
}

const blocks = vi.hoisted(() => ({ list: [] as unknown[] }));
const mocks = vi.hoisted(() => ({
  getAgentByName: vi.fn(),
  ensureArmed: vi.fn(),
}));

vi.mock("@/server/features/rankloop/routines/routineBlocks", () => ({
  get ROUTINE_BLOCKS() {
    return blocks.list;
  },
}));
vi.mock("agents", () => ({ getAgentByName: mocks.getAgentByName }));

const kvPuts: { key: string; value: string }[] = [];
const env = {
  KV: {
    put: (key: string, value: string) => {
      kvPuts.push({ key, value });
      return Promise.resolve();
    },
    get: () => Promise.resolve(null),
  },
  ROUTINE_SCHEDULER: {},
  // A two-key stand-in for the bindings RoutineEnv names; the rest of the KV
  // and Durable Object surface is not what these assertions are about.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above
} as unknown as RoutineEnv;

const now = new Date("2026-08-01T09:07:00.000Z");

beforeEach(() => {
  vi.resetModules();
  effects.length = 0;
  kvPuts.length = 0;
  mocks.ensureArmed.mockReset();
  mocks.ensureArmed.mockResolvedValue({ nextRunAt: null });
  mocks.getAgentByName.mockReset();
  mocks.getAgentByName.mockResolvedValue({ ensureArmed: mocks.ensureArmed });
  blocks.list = [
    fakeBlock("gsc-sync", ["project_1"]),
    fakeBlock("receipts", ["project_1", "project_2"]),
    fakeBlock("net-new", ["project_2"]),
  ];
});

describe("dispatch convergence", () => {
  it("produces identical effects from the cron sweep and the alarm wake", async () => {
    const { runDueProjectRoutines } = await import("./runProjectRoutines");
    const { handleRoutineWake } =
      await import("@/server/features/rankloop/routines/routineWake");

    await runDueProjectRoutines(env, now);
    const viaCron = [...effects];

    effects.length = 0;
    // The alarm owns one project at a time, so the two projects the sweep
    // walked are two wakes — with the same clock.
    await handleRoutineWake(
      { name: "project_1", env, ensureArmed: mocks.ensureArmed },
      now,
    );
    await handleRoutineWake(
      { name: "project_2", env, ensureArmed: mocks.ensureArmed },
      now,
    );

    expect(effects).toEqual(viaCron);
    expect(viaCron).toEqual([
      "gsc-sync:project_1",
      "receipts:project_1",
      "receipts:project_2",
      "net-new:project_2",
    ]);
  });

  it("runs blocks in registry order and skips the ones that are not due", async () => {
    const { runProjectRoutines } = await import("./runProjectRoutines");

    const summary = await runProjectRoutines(env, "project_2", now);

    expect(summary.at).toBe(now.toISOString());
    expect(summary.blocks).toEqual([
      { block: "gsc-sync", status: "not-due" },
      { block: "receipts", status: "ran" },
      { block: "net-new", status: "ran" },
    ]);
  });

  it("isolates a failing block so the rest of the routine still runs", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    blocks.list = [
      fakeBlock("gsc-sync", ["project_1"], () => {
        throw new Error("grant revoked");
      }),
      fakeBlock("receipts", ["project_1"]),
    ];
    const { runProjectRoutines } = await import("./runProjectRoutines");

    const summary = await runProjectRoutines(env, "project_1", now);

    expect(effects).toEqual(["receipts:project_1"]);
    expect(summary.blocks[0]).toEqual({
      block: "gsc-sync",
      status: "failed",
      error: "grant revoked",
    });
    expect(errors).toHaveBeenCalledOnce();
  });

  it("stamps the tick even when no project is due, so a quiet cron is still provably alive", async () => {
    blocks.list = [fakeBlock("gsc-sync", [])];
    const { runDueProjectRoutines } = await import("./runProjectRoutines");

    expect(await runDueProjectRoutines(env, now)).toEqual([]);
    expect(kvPuts).toEqual([
      { key: "rankloop:routines:cron-last-tick", value: now.toISOString() },
    ]);
  });

  it("records the run under the clock it was given, whichever dispatcher ran it", async () => {
    const { runProjectRoutines } = await import("./runProjectRoutines");

    await runProjectRoutines(env, "project_1", now);

    expect(kvPuts).toEqual([
      {
        key: "rankloop:routines:last-run:project_1",
        value: now.toISOString(),
      },
    ]);
  });
});

describe("alarm wake", () => {
  it("reports the earliest wake for the callback, and a lost schedule as unarmed", async () => {
    const { nextArmedWake } =
      await import("@/server/features/rankloop/routines/routineWake");

    expect(
      nextArmedWake(
        [
          { callback: "wake", time: 1_785_575_400 },
          { callback: "wake", time: 1_785_574_500 },
          { callback: "other", time: 1 },
        ],
        "wake",
      ),
    ).toEqual({ armed: true, nextRunAt: "2026-08-01T08:55:00.000Z" });
    // Not "a run that never comes": the Settings surface has to be able to
    // show the problem rather than an invented time.
    expect(nextArmedWake([{ callback: "other", time: 1 }], "wake")).toEqual({
      armed: false,
      nextRunAt: null,
    });
  });

  it("re-arms after a wake", async () => {
    const { handleRoutineWake } =
      await import("@/server/features/rankloop/routines/routineWake");

    await handleRoutineWake(
      { name: "project_1", env, ensureArmed: mocks.ensureArmed },
      now,
    );

    expect(mocks.ensureArmed).toHaveBeenCalledOnce();
  });

  it("re-arms even when the run throws — a failed wake must not end the schedule", async () => {
    const { handleRoutineWake } =
      await import("@/server/features/rankloop/routines/routineWake");
    const brokenEnv = {
      ...env,
      KV: {
        ...env.KV,
        put: () => Promise.reject(new Error("KV unavailable")),
      },
    } as typeof env;

    await expect(
      handleRoutineWake(
        { name: "project_1", env: brokenEnv, ensureArmed: mocks.ensureArmed },
        now,
      ),
    ).rejects.toThrow("KV unavailable");
    expect(mocks.ensureArmed).toHaveBeenCalledOnce();
  });
});
