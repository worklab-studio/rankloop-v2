import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  repo: {
    getProjectsDueForIndexation:
      vi.fn<(limit: number) => Promise<Array<{ projectId: string }>>>(),
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

describe("runScheduledIndexationChecks", () => {
  it("takes at most ten projects a tick", async () => {
    const { runScheduledIndexationChecks } =
      await import("./scheduledIndexationChecks");

    await runScheduledIndexationChecks();

    expect(mocks.repo.getProjectsDueForIndexation).toHaveBeenCalledWith(10);
  });

  it("isolates a failing project so the rest of the tick still runs", async () => {
    mocks.repo.getProjectsDueForIndexation.mockResolvedValue([
      { projectId: "project_1" },
      { projectId: "project_2" },
    ]);
    mocks.service.runIndexationChecks
      .mockRejectedValueOnce(new Error("Search Console token expired"))
      .mockResolvedValueOnce({
        checked: 4,
        indexed: 4,
        failed: 0,
        reason: null,
      });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { runScheduledIndexationChecks } =
      await import("./scheduledIndexationChecks");

    await runScheduledIndexationChecks();

    expect(mocks.service.runIndexationChecks).toHaveBeenCalledTimes(2);
    expect(errors).toHaveBeenCalledOnce();
  });
});
