import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  repo: {
    getCompetitorsDueForRefresh:
      vi.fn<
        (
          cutoff: string,
          limit: number,
        ) => Promise<Array<{ id: string; projectId: string; domain: string }>>
      >(),
  },
  service: {
    startStudy: vi.fn(),
  },
}));

vi.mock(
  "@/server/features/rankloop/competitors/repositories/CompetitorsRepository",
  () => ({ CompetitorsRepository: mocks.repo }),
);
vi.mock(
  "@/server/features/rankloop/competitors/services/CompetitorsService",
  () => ({ CompetitorsService: mocks.service }),
);

beforeEach(() => {
  vi.resetModules();
  mocks.repo.getCompetitorsDueForRefresh.mockReset();
  mocks.service.startStudy.mockReset();
  mocks.repo.getCompetitorsDueForRefresh.mockResolvedValue([]);
});

describe("runScheduledCompetitorStudies", () => {
  it("asks for a monthly cutoff and at most three starts per tick", async () => {
    const { runScheduledCompetitorStudies } =
      await import("./scheduledCompetitorStudies");

    await runScheduledCompetitorStudies();

    const [cutoff, limit] =
      mocks.repo.getCompetitorsDueForRefresh.mock.calls[0];
    expect(limit).toBe(3);
    const ageDays = (Date.now() - Date.parse(cutoff)) / (24 * 60 * 60 * 1000);
    expect(Math.round(ageDays)).toBe(30);
  });

  it("isolates a failing competitor so the rest of the tick still runs", async () => {
    mocks.repo.getCompetitorsDueForRefresh.mockResolvedValue([
      { id: "comp_1", projectId: "project_1", domain: "one.com" },
      { id: "comp_2", projectId: "project_1", domain: "two.com" },
    ]);
    mocks.service.startStudy
      .mockRejectedValueOnce(new Error("workflow engine down"))
      .mockResolvedValueOnce({ runId: "run_2", alreadyRunning: false });
    const { runScheduledCompetitorStudies } =
      await import("./scheduledCompetitorStudies");

    await runScheduledCompetitorStudies();

    expect(mocks.service.startStudy).toHaveBeenCalledTimes(2);
  });
});
