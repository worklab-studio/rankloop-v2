import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";

const mocks = vi.hoisted(() => ({
  studyRepo: {
    getRunById: vi.fn(),
    updateRun: vi.fn(),
    getLatestCompletedAuditForProject: vi.fn(),
  },
  studyService: {
    deriveFromAudit: vi.fn(),
  },
  auditService: {
    resolveAuditLimitTier: vi.fn(),
    startAudit: vi.fn(),
    getStatus: vi.fn(),
  },
  projectRepo: {
    getProjectById: vi.fn(),
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
  "@/server/features/rankloop/site-study/repositories/SiteStudyRepository",
  () => ({ SiteStudyRepository: mocks.studyRepo }),
);
vi.mock(
  "@/server/features/rankloop/site-study/services/SiteStudyService",
  () => ({ SiteStudyService: mocks.studyService }),
);
vi.mock("@/server/features/audit/services/AuditService", () => ({
  AuditService: mocks.auditService,
}));
vi.mock("@/server/features/projects/repositories/ProjectRepository", () => ({
  ProjectRepository: mocks.projectRepo,
}));

// Runs every step body inline: the workflow's control flow is what's under
// test, not the engine's checkpointing.
function makeFakeStep(): {
  step: WorkflowStep;
  sleep: ReturnType<typeof vi.fn>;
} {
  const sleep = vi.fn().mockResolvedValue(undefined);
  const fake = {
    do: (
      _name: string,
      configOrFn: (() => Promise<unknown>) | Record<string, unknown>,
      maybeFn?: () => Promise<unknown>,
    ) => (typeof configOrFn === "function" ? configOrFn() : maybeFn?.()),
    sleep,
  };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double: only do/sleep are exercised
  return { step: fake as unknown as WorkflowStep, sleep };
}

function makeEvent(): WorkflowEvent<{ runId: string; projectId: string }> {
  return {
    payload: { runId: "run_1", projectId: "project_1" },
    timestamp: new Date(),
    instanceId: "run_1",
    workflowName: "site-study-workflow",
  };
}

async function makeWorkflow() {
  const { SiteStudyWorkflow } = await import("./SiteStudyWorkflow");
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double: ctx/env are never touched (every collaborator is mocked)
  return new SiteStudyWorkflow({} as ExecutionContext, {} as Env);
}

beforeEach(() => {
  vi.resetModules();
  for (const group of Object.values(mocks)) {
    for (const mock of Object.values(group)) mock.mockReset();
  }
  mocks.studyRepo.getRunById.mockResolvedValue({
    id: "run_1",
    status: "pending",
  });
});

describe("SiteStudyWorkflow", () => {
  it("reuses a completed audit under 7 days old instead of starting a crawl", async () => {
    const completedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    mocks.studyRepo.getLatestCompletedAuditForProject.mockResolvedValue({
      id: "audit_1",
      startUrl: "https://acme.com",
      config: "{}",
      completedAt,
    });
    mocks.studyService.deriveFromAudit.mockResolvedValue(42);
    const workflow = await makeWorkflow();
    const { step, sleep } = makeFakeStep();

    await workflow.run(makeEvent(), step);

    expect(mocks.auditService.startAudit).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
    // The audit's completedAt is the derive's lastCrawledAt marker.
    expect(mocks.studyService.deriveFromAudit).toHaveBeenCalledWith({
      projectId: "project_1",
      auditId: "audit_1",
      crawlMark: completedAt,
    });
    expect(mocks.studyRepo.updateRun).toHaveBeenCalledWith(
      "run_1",
      expect.objectContaining({
        status: "done",
        auditRunId: "audit_1",
        pagesDerived: 42,
      }),
    );
  });

  it("starts an audit when none is fresh and derives once it completes", async () => {
    mocks.studyRepo.getLatestCompletedAuditForProject.mockResolvedValue(null);
    mocks.projectRepo.getProjectById.mockResolvedValue({
      id: "project_1",
      organizationId: "org_1",
      domain: "acme.com",
    });
    mocks.auditService.resolveAuditLimitTier.mockResolvedValue("paid");
    mocks.auditService.startAudit.mockResolvedValue({ auditId: "audit_2" });
    mocks.auditService.getStatus
      .mockResolvedValueOnce({ status: "running", completedAt: null })
      .mockResolvedValueOnce({
        status: "completed",
        completedAt: "2026-07-31T09:00:00.000Z",
      });
    mocks.studyService.deriveFromAudit.mockResolvedValue(7);
    const workflow = await makeWorkflow();
    const { step, sleep } = makeFakeStep();

    await workflow.run(makeEvent(), step);

    expect(mocks.auditService.startAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project_1",
        startUrl: "https://acme.com",
        lighthouseStrategy: "none",
      }),
    );
    // One running poll → one sleep → completed on the second check.
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(mocks.studyService.deriveFromAudit).toHaveBeenCalledWith({
      projectId: "project_1",
      auditId: "audit_2",
      crawlMark: "2026-07-31T09:00:00.000Z",
    });
  });

  it("gives up after 30 minutes of polling and flips the run to error", async () => {
    mocks.studyRepo.getLatestCompletedAuditForProject.mockResolvedValue(null);
    mocks.projectRepo.getProjectById.mockResolvedValue({
      id: "project_1",
      organizationId: "org_1",
      domain: "acme.com",
    });
    mocks.auditService.resolveAuditLimitTier.mockResolvedValue("paid");
    mocks.auditService.startAudit.mockResolvedValue({ auditId: "audit_2" });
    // The audit never finishes — a wedged crawl must not sleep forever.
    mocks.auditService.getStatus.mockResolvedValue({
      status: "running",
      completedAt: null,
    });
    const workflow = await makeWorkflow();
    const { step, sleep } = makeFakeStep();

    await expect(workflow.run(makeEvent(), step)).rejects.toThrow(
      "did not complete within 30 minutes",
    );
    // 60 polls at 30 seconds = the 30-minute budget.
    expect(sleep).toHaveBeenCalledTimes(60);
    expect(mocks.studyService.deriveFromAudit).not.toHaveBeenCalled();
    expect(mocks.studyRepo.updateRun).toHaveBeenCalledWith(
      "run_1",
      expect.objectContaining({
        status: "error",
        error: "Audit audit_2 did not complete within 30 minutes",
      }),
    );
  });

  it("fails the run when the ensured audit fails", async () => {
    mocks.studyRepo.getLatestCompletedAuditForProject.mockResolvedValue(null);
    mocks.projectRepo.getProjectById.mockResolvedValue({
      id: "project_1",
      organizationId: "org_1",
      domain: "acme.com",
    });
    mocks.auditService.resolveAuditLimitTier.mockResolvedValue("paid");
    mocks.auditService.startAudit.mockResolvedValue({ auditId: "audit_2" });
    mocks.auditService.getStatus.mockResolvedValue({
      status: "failed",
      completedAt: null,
    });
    const workflow = await makeWorkflow();
    const { step } = makeFakeStep();

    await expect(workflow.run(makeEvent(), step)).rejects.toThrow(
      "Audit audit_2 failed",
    );
    expect(mocks.studyRepo.updateRun).toHaveBeenCalledWith(
      "run_1",
      expect.objectContaining({ status: "error" }),
    );
  });
});
