import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { InferInsertModel } from "drizzle-orm";
import type { gscSyncRuns } from "@/db/schema";

// Typed so the error-record assertions below can read `.mock.calls` without
// unsafe casts (an untyped vi.fn() yields `any` calls).
type UpdateRun = (
  runId: string,
  data: Partial<InferInsertModel<typeof gscSyncRuns>>,
) => Promise<void>;

const mocks = vi.hoisted(() => ({
  syncRepo: {
    getRunById: vi.fn(),
    updateRun: vi.fn<UpdateRun>(),
  },
  syncService: {
    syncDay: vi.fn(),
  },
  connectionRepo: {
    getByProjectId: vi.fn(),
  },
  proposalsService: {
    computeProposals: vi.fn(),
  },
}));

vi.mock("cloudflare:workers", () => ({
  env: {},
  // oxlint-disable-next-line typescript/no-extraneous-class -- stand-in for the real base class; the workflow only inherits its shape
  WorkflowEntrypoint: class {},
}));
vi.mock("cloudflare:workflows", () => ({
  NonRetryableError: class NonRetryableError extends Error {},
}));
vi.mock("@/db", () => ({
  withPgClient: (fn: () => unknown) => fn(),
}));
vi.mock(
  "@/server/features/rankloop/gsc-sync/repositories/GscSyncRepository",
  () => ({ GscSyncRepository: mocks.syncRepo }),
);
vi.mock("@/server/features/rankloop/gsc-sync/services/GscSyncService", () => ({
  GscSyncService: mocks.syncService,
  enumerateDates: (rangeStart: string) => [rangeStart],
}));
vi.mock("@/server/features/gsc/repositories/GscConnectionRepository", () => ({
  GscConnectionRepository: mocks.connectionRepo,
}));
vi.mock(
  "@/server/features/rankloop/proposals/services/ProposalsService",
  () => ({ ProposalsService: mocks.proposalsService }),
);
vi.mock("@/server/lib/gscClient", () => ({
  createGscClient: () => ({}),
}));

// Runs every step body inline: the workflow's control flow is what's under
// test, not the engine's checkpointing.
function makeFakeStep(): WorkflowStep {
  const fake = {
    do: (
      _name: string,
      configOrFn: (() => Promise<unknown>) | Record<string, unknown>,
      maybeFn?: () => Promise<unknown>,
    ) => (typeof configOrFn === "function" ? configOrFn() : maybeFn?.()),
    sleep: vi.fn(),
  };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double: only do/sleep are exercised
  return fake as unknown as WorkflowStep;
}

function makeEvent(): WorkflowEvent<{
  runId: string;
  projectId: string;
  mode: "backfill" | "daily";
}> {
  return {
    payload: { runId: "run_1", projectId: "project_1", mode: "daily" },
    timestamp: new Date(),
    instanceId: "run_1",
    workflowName: "gsc-sync-workflow",
  };
}

async function makeWorkflow() {
  const { GscSyncWorkflow } = await import("./GscSyncWorkflow");
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double: ctx/env are never touched (every collaborator is mocked)
  return new GscSyncWorkflow({} as ExecutionContext, {} as Env);
}

beforeEach(() => {
  vi.resetModules();
  for (const group of Object.values(mocks)) {
    for (const mock of Object.values(group)) mock.mockReset();
  }
  mocks.syncRepo.getRunById.mockResolvedValue({
    id: "run_1",
    status: "pending",
    rangeStart: "2026-07-27",
    rangeEnd: "2026-07-27",
  });
  mocks.connectionRepo.getByProjectId.mockResolvedValue({
    projectId: "project_1",
    siteUrl: "sc-domain:acme.com",
    connectedByUserId: "user_1",
    gscAccountId: "acct_1",
  });
  mocks.syncService.syncDay.mockResolvedValue(42);
});

describe("GscSyncWorkflow", () => {
  it("computes proposals after the run is marked done", async () => {
    mocks.proposalsService.computeProposals.mockResolvedValue({
      created: 3,
      expired: 1,
    });
    const workflow = await makeWorkflow();

    await workflow.run(makeEvent(), makeFakeStep());

    expect(mocks.proposalsService.computeProposals).toHaveBeenCalledWith(
      "project_1",
    );
    expect(mocks.syncRepo.updateRun).toHaveBeenCalledWith(
      "run_1",
      expect.objectContaining({ status: "done", rowsWritten: 42 }),
    );
  });

  it("keeps the run 'done' when compute fails — the error lands in the run's error text only", async () => {
    mocks.proposalsService.computeProposals.mockRejectedValue(
      new Error("signal exploded\nacross lines"),
    );
    const workflow = await makeWorkflow();

    // A compute failure must never fail the sync run — the memory it synced
    // is already durable.
    await expect(
      workflow.run(makeEvent(), makeFakeStep()),
    ).resolves.toBeUndefined();

    const errorRecord = mocks.syncRepo.updateRun.mock.calls.find(
      ([, data]) => typeof data.error === "string",
    );
    expect(errorRecord).toBeDefined();
    const recorded = errorRecord?.[1] ?? {};
    // One bounded line, and no status flip riding along with it.
    expect(recorded.error).toBe(
      "Proposal compute failed: signal exploded across lines",
    );
    expect("status" in recorded).toBe(false);
  });

  it("does not compute proposals when the sync itself fails", async () => {
    mocks.syncService.syncDay.mockRejectedValue(new Error("GSC 500"));
    const workflow = await makeWorkflow();

    await expect(workflow.run(makeEvent(), makeFakeStep())).rejects.toThrow(
      "GSC 500",
    );

    expect(mocks.proposalsService.computeProposals).not.toHaveBeenCalled();
    expect(mocks.syncRepo.updateRun).toHaveBeenCalledWith(
      "run_1",
      expect.objectContaining({ status: "error" }),
    );
  });
});
