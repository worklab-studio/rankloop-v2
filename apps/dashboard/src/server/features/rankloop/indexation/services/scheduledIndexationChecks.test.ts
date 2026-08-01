import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  repo: {
    getProjectsDueForIndexation:
      vi.fn<
        (
          limit: number,
          projectId?: string,
        ) => Promise<Array<{ projectId: string }>>
      >(),
  },
  service: {
    runIndexationChecks: vi.fn(),
  },
}));

vi.mock(
  "@/server/features/rankloop/indexation/repositories/IndexationRepository",
  () => ({ IndexationRepository: mocks.repo }),
);
vi.mock(
  "@/server/features/rankloop/indexation/services/IndexationService",
  () => ({ IndexationService: mocks.service }),
);

beforeEach(() => {
  vi.resetModules();
  mocks.repo.getProjectsDueForIndexation.mockReset();
  mocks.service.runIndexationChecks.mockReset();
  mocks.repo.getProjectsDueForIndexation.mockResolvedValue([]);
  mocks.service.runIndexationChecks.mockResolvedValue({
    checked: 0,
    indexed: 0,
    failed: 0,
    reason: null,
  });
});

const now = new Date("2026-08-01T09:00:00.000Z");

describe("indexationBlock", () => {
  it("takes at most ten projects a sweep", async () => {
    const { indexationBlock } = await import("./scheduledIndexationChecks");

    await indexationBlock.dueProjects(now);

    expect(mocks.repo.getProjectsDueForIndexation).toHaveBeenCalledWith(
      10,
      undefined,
    );
  });

  it("asks the same question about one project when the alarm dispatches", async () => {
    const { indexationBlock } = await import("./scheduledIndexationChecks");

    await indexationBlock.dueProjects(now, "project_1");

    expect(mocks.repo.getProjectsDueForIndexation).toHaveBeenCalledWith(
      1,
      "project_1",
    );
  });
});
