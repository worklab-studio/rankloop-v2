import { beforeEach, describe, expect, it, vi } from "vitest";

// The dispatch half of the digest: whether the routine asks for one, and
// whether it can ask twice on the same day. What a digest *contains* is
// DigestService.test.ts's subject.

const mocks = vi.hoisted(() => ({
  repo: { getProjectsWithoutDigest: vi.fn() },
  service: { generateDigest: vi.fn() },
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock(
  "@/server/features/rankloop/routines/repositories/DigestRepository",
  () => ({ DigestRepository: mocks.repo }),
);
vi.mock("@/server/features/rankloop/routines/services/DigestService", () => ({
  DigestService: mocks.service,
}));

const NOW = new Date("2026-08-01T07:00:00.000Z");

beforeEach(() => {
  mocks.repo.getProjectsWithoutDigest.mockResolvedValue([]);
  mocks.service.generateDigest.mockResolvedValue(null);
});

async function block() {
  const { digestBlock } = await import("./scheduledDigests");
  return digestBlock;
}

describe("digestBlock.dueProjects", () => {
  it("asks for the projects with no digest for today", async () => {
    mocks.repo.getProjectsWithoutDigest.mockResolvedValue([
      { projectId: "project_1" },
      { projectId: "project_2" },
    ]);

    await expect((await block()).dueProjects(NOW)).resolves.toEqual([
      "project_1",
      "project_2",
    ]);
    expect(mocks.repo.getProjectsWithoutDigest).toHaveBeenCalledWith({
      forDate: "2026-08-01",
      limit: 50,
      projectId: undefined,
    });
  });

  it("narrows the identical predicate to one project for the alarm path", async () => {
    mocks.repo.getProjectsWithoutDigest.mockResolvedValue([
      { projectId: "project_2" },
    ]);

    await expect(
      (await block()).dueProjects(NOW, "project_2"),
    ).resolves.toEqual(["project_2"]);
    expect(mocks.repo.getProjectsWithoutDigest).toHaveBeenCalledWith({
      forDate: "2026-08-01",
      limit: 1,
      projectId: "project_2",
    });
  });

  it("is not due once today's digest exists, whichever dispatcher wrote it", async () => {
    await expect(
      (await block()).dueProjects(NOW, "project_1"),
    ).resolves.toEqual([]);
  });
});

describe("digestBlock.runForProject", () => {
  it("generates under the clock the dispatcher handed it", async () => {
    await (await block()).runForProject("project_1", NOW);

    expect(mocks.service.generateDigest).toHaveBeenCalledWith({
      projectId: "project_1",
      now: NOW,
    });
  });

  it("says nothing on a quiet day", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await (await block()).runForProject("project_1", NOW);

    expect(log).not.toHaveBeenCalled();
  });

  it("names the digest it wrote", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    mocks.service.generateDigest.mockResolvedValue({
      forDate: "2026-08-01",
      headline: "2 waiting on you · 1 shipped",
      awaiting: { total: 2, top: [] },
      shipped: [],
      measured: [],
      blocked: [],
    });

    await (await block()).runForProject("project_1", NOW);

    expect(log).toHaveBeenCalledWith(
      "[routines] Digest for project_1: 2 waiting on you · 1 shipped",
    );
  });
});
