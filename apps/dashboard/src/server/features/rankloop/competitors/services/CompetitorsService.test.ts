import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  repo: {
    listCompetitors: vi.fn(),
    getCompetitorById: vi.fn(),
    getCompetitorByDomain: vi.fn(),
    createTrackedCompetitor: vi.fn(),
    insertSuggestedCompetitors: vi.fn(),
    updateCompetitor: vi.fn(),
    getCompetitorsDueForRefresh: vi.fn(),
    tryCreateStudyRun: vi.fn(),
    updateStudyRun: vi.fn(),
    getStudyRunById: vi.fn(),
    getActiveStudyRunForCompetitor: vi.fn(),
    getLatestStudyRunsForProject: vi.fn(),
    getLatestStudyRunForCompetitor: vi.fn(),
    upsertCompetitorPages: vi.fn(),
    updateCompetitorPageFeatures: vi.fn(),
    getCompetitorPages: vi.fn(),
    getPageSnapshot: vi.fn(),
    setPageStatuses: vi.fn(),
  },
  workflow: {
    create:
      vi.fn<
        (input: {
          id: string;
          params: { runId: string; projectId: string; competitorId: string };
        }) => Promise<void>
      >(),
    get: vi.fn(),
  },
}));

vi.mock("cloudflare:workers", () => ({
  env: { COMPETITOR_STUDY_WORKFLOW: mocks.workflow },
}));
vi.mock(
  "@/server/features/rankloop/competitors/repositories/CompetitorsRepository",
  () => ({ CompetitorsRepository: mocks.repo }),
);

function competitor(overrides: Record<string, unknown> = {}) {
  return {
    id: "comp_1",
    projectId: "project_1",
    domain: "acme.com",
    status: "suggested",
    discoveredVia: "labs_competitors_domain",
    domainRank: null,
    organicKeywords: 120,
    estTraffic: null,
    backlinks: null,
    referringDomains: null,
    coverage: null,
    studySummaryJson: null,
    lastStudiedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetModules();
  for (const group of Object.values(mocks)) {
    for (const mock of Object.values(group)) mock.mockReset();
  }
  mocks.repo.listCompetitors.mockResolvedValue([]);
  mocks.repo.getLatestStudyRunsForProject.mockResolvedValue([]);
  mocks.repo.getCompetitorPages.mockResolvedValue([]);
  mocks.repo.getLatestStudyRunForCompetitor.mockResolvedValue(null);
});

describe("CompetitorsService.startStudy", () => {
  it("creates the run row and a workflow instance whose id is the run id", async () => {
    mocks.repo.tryCreateStudyRun.mockResolvedValue(true);
    const { CompetitorsService } = await import("./CompetitorsService");

    const result = await CompetitorsService.startStudy({
      projectId: "project_1",
      competitorId: "comp_1",
    });

    expect(result.alreadyRunning).toBe(false);
    const created = mocks.workflow.create.mock.calls[0][0];
    expect(created.id).toBe(result.runId);
    expect(created.params.runId).toBe(result.runId);
  });

  it("returns the active run instead of erroring when a study is underway", async () => {
    mocks.repo.tryCreateStudyRun.mockResolvedValue(false);
    mocks.repo.getActiveStudyRunForCompetitor.mockResolvedValue({
      id: "run_live",
      startedAt: new Date().toISOString(),
    });
    // A live instance: the probe's active-status branch.
    mocks.workflow.get.mockResolvedValue({
      status: () => Promise.resolve({ status: "running" }),
    });
    const { CompetitorsService } = await import("./CompetitorsService");

    const result = await CompetitorsService.startStudy({
      projectId: "project_1",
      competitorId: "comp_1",
    });

    expect(result).toEqual({ runId: "run_live", alreadyRunning: true });
    expect(mocks.workflow.create).not.toHaveBeenCalled();
  });

  it("clears a blocker whose workflow died and takes the freed slot", async () => {
    mocks.repo.tryCreateStudyRun
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    mocks.repo.getActiveStudyRunForCompetitor.mockResolvedValue({
      id: "run_zombie",
      // Past the 60-second startup grace, so a missing instance is death.
      startedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    });
    mocks.workflow.get.mockRejectedValue(new Error("no such instance"));
    const { CompetitorsService } = await import("./CompetitorsService");

    const result = await CompetitorsService.startStudy({
      projectId: "project_1",
      competitorId: "comp_1",
    });

    expect(result.alreadyRunning).toBe(false);
    expect(mocks.repo.updateStudyRun).toHaveBeenCalledWith(
      "run_zombie",
      expect.objectContaining({
        status: "error",
        error: "Workflow instance was not found",
      }),
    );
  });

  it("frees the slot when the workflow refuses to start", async () => {
    mocks.repo.tryCreateStudyRun.mockResolvedValue(true);
    mocks.workflow.create.mockRejectedValue(new Error("engine down"));
    mocks.workflow.get.mockRejectedValue(new Error("no such instance"));
    const { CompetitorsService } = await import("./CompetitorsService");

    await expect(
      CompetitorsService.startStudy({
        projectId: "project_1",
        competitorId: "comp_1",
      }),
    ).rejects.toThrow("engine down");
    expect(mocks.repo.updateStudyRun).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ status: "error" }),
    );
  });
});

describe("CompetitorsService.addCompetitor", () => {
  it("normalizes a pasted URL down to the bare registrable domain", async () => {
    mocks.repo.getCompetitorByDomain.mockResolvedValue(null);
    mocks.repo.tryCreateStudyRun.mockResolvedValue(true);
    const { CompetitorsService } = await import("./CompetitorsService");

    await CompetitorsService.addCompetitor({
      projectId: "project_1",
      domain: "https://www.Acme.com/pricing?x=1",
    });

    expect(mocks.repo.createTrackedCompetitor).toHaveBeenCalledWith(
      expect.objectContaining({ domain: "acme.com", discoveredVia: "manual" }),
    );
  });

  it("rejects a host with no real TLD before it costs a round-trip", async () => {
    const { CompetitorsService } = await import("./CompetitorsService");

    await expect(
      CompetitorsService.addCompetitor({
        projectId: "project_1",
        domain: "example.por",
      }),
    ).rejects.toThrow("Enter a valid domain");
    expect(mocks.repo.createTrackedCompetitor).not.toHaveBeenCalled();
  });

  it("promotes an already-suggested domain in place rather than duplicating it", async () => {
    mocks.repo.getCompetitorByDomain.mockResolvedValue(competitor());
    mocks.repo.tryCreateStudyRun.mockResolvedValue(true);
    const { CompetitorsService } = await import("./CompetitorsService");

    const result = await CompetitorsService.addCompetitor({
      projectId: "project_1",
      domain: "acme.com",
    });

    expect(result.competitorId).toBe("comp_1");
    expect(mocks.repo.createTrackedCompetitor).not.toHaveBeenCalled();
    expect(mocks.repo.updateCompetitor).toHaveBeenCalledWith("comp_1", {
      status: "tracked",
    });
  });
});

describe("CompetitorsService.decide", () => {
  it("kicks a study when tracking, so the row is never tracked-but-unstudied", async () => {
    mocks.repo.getCompetitorById.mockResolvedValue(competitor());
    mocks.repo.tryCreateStudyRun.mockResolvedValue(true);
    const { CompetitorsService } = await import("./CompetitorsService");

    const result = await CompetitorsService.decide({
      projectId: "project_1",
      competitorId: "comp_1",
      decision: "tracked",
    });

    expect(result.runId).toEqual(expect.any(String));
    expect(mocks.workflow.create).toHaveBeenCalledTimes(1);
  });

  it("spends nothing when skipping", async () => {
    mocks.repo.getCompetitorById.mockResolvedValue(competitor());
    const { CompetitorsService } = await import("./CompetitorsService");

    const result = await CompetitorsService.decide({
      projectId: "project_1",
      competitorId: "comp_1",
      decision: "skipped",
    });

    expect(result.runId).toBeNull();
    expect(mocks.workflow.create).not.toHaveBeenCalled();
  });
});

describe("CompetitorsService.getCompetitors", () => {
  it("reports the keyword count as overlap only while a row is still suggested", async () => {
    mocks.repo.listCompetitors.mockResolvedValue([
      competitor({ id: "comp_suggested", status: "suggested" }),
      competitor({
        id: "comp_tracked",
        status: "tracked",
        domain: "beta.com",
        organicKeywords: 9000,
      }),
      competitor({ id: "comp_skipped", status: "skipped", domain: "no.com" }),
    ]);
    mocks.repo.getLatestStudyRunsForProject.mockResolvedValue([
      { competitorId: "comp_tracked", status: "running", pagesStudied: null },
      { competitorId: "comp_tracked", status: "done", pagesStudied: 87 },
    ]);
    const { CompetitorsService } = await import("./CompetitorsService");

    const result = await CompetitorsService.getCompetitors("project_1");

    expect(result.suggested[0].overlapKeywords).toBe(120);
    // Once studied, the column means the domain's own footprint — not overlap.
    expect(result.tracked[0].overlapKeywords).toBeNull();
    // Runs arrive newest first, so the first sighting wins.
    expect(result.tracked[0].studyStatus).toBe("running");
    // Skipped rows are the user saying "stop showing me this".
    expect(result.tracked.concat(result.suggested)).toHaveLength(2);
  });
});

describe("CompetitorsService.getCompetitor", () => {
  it("splits pages into the earners table and the what-not-to-build panel", async () => {
    mocks.repo.getCompetitorById.mockResolvedValue(competitor());
    mocks.repo.getCompetitorPages.mockResolvedValue([
      { id: "p1", status: "active" },
      { id: "p2", status: "decayed" },
      { id: "p3", status: "removed" },
    ]);
    const { CompetitorsService } = await import("./CompetitorsService");

    const detail = await CompetitorsService.getCompetitor({
      projectId: "project_1",
      competitorId: "comp_1",
    });

    expect(detail?.topPages.map((page) => page.id)).toEqual(["p1"]);
    expect(detail?.decayedPages.map((page) => page.id)).toEqual(["p2", "p3"]);
  });

  it("degrades an unreadable stored playbook to 'nothing studied yet'", async () => {
    mocks.repo.getCompetitorById.mockResolvedValue(
      competitor({ studySummaryJson: '{"cadence":"not an array"}' }),
    );
    const { CompetitorsService } = await import("./CompetitorsService");

    const detail = await CompetitorsService.getCompetitor({
      projectId: "project_1",
      competitorId: "comp_1",
    });

    expect(detail?.playbook).toBeNull();
  });

  it("returns null for a competitor that is gone, not a 404 page", async () => {
    mocks.repo.getCompetitorById.mockResolvedValue(null);
    const { CompetitorsService } = await import("./CompetitorsService");

    await expect(
      CompetitorsService.getCompetitor({
        projectId: "project_1",
        competitorId: "comp_gone",
      }),
    ).resolves.toBeNull();
  });
});
