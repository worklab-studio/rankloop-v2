import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  repo: {
    getCompetitorsDueForRefresh:
      vi.fn<
        (
          cutoff: string,
          limit: number,
          projectId?: string,
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

const now = new Date("2026-08-01T09:00:00.000Z");

describe("competitorsBlock", () => {
  it("asks for a monthly cutoff and at most three starts per dispatch", async () => {
    const { competitorsBlock } = await import("./scheduledCompetitorStudies");

    await competitorsBlock.dueProjects(now);

    const [cutoff, limit] =
      mocks.repo.getCompetitorsDueForRefresh.mock.calls[0];
    expect(limit).toBe(3);
    const ageDays =
      (now.getTime() - Date.parse(cutoff)) / (24 * 60 * 60 * 1000);
    expect(Math.round(ageDays)).toBe(30);
  });

  it("reports each due competitor's project once", async () => {
    mocks.repo.getCompetitorsDueForRefresh.mockResolvedValue([
      { id: "comp_1", projectId: "project_1", domain: "one.com" },
      { id: "comp_2", projectId: "project_1", domain: "two.com" },
    ]);
    const { competitorsBlock } = await import("./scheduledCompetitorStudies");

    expect(await competitorsBlock.dueProjects(now)).toEqual(["project_1"]);
  });

  it("isolates a failing competitor so the rest of the project still runs", async () => {
    mocks.repo.getCompetitorsDueForRefresh.mockResolvedValue([
      { id: "comp_1", projectId: "project_1", domain: "one.com" },
      { id: "comp_2", projectId: "project_1", domain: "two.com" },
    ]);
    mocks.service.startStudy
      .mockRejectedValueOnce(new Error("workflow engine down"))
      .mockResolvedValueOnce({ runId: "run_2", alreadyRunning: false });
    const { competitorsBlock } = await import("./scheduledCompetitorStudies");

    await competitorsBlock.runForProject("project_1", now);

    expect(mocks.service.startStudy).toHaveBeenCalledTimes(2);
  });
});
