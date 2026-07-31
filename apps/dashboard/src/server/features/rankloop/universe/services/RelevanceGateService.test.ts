import { relevant } from "@rankloop/engine";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PageQueryAggregate } from "@/server/features/rankloop/proposals/signals.logic";

const mocks = vi.hoisted(() => ({
  projectRepo: { getProjectById: vi.fn() },
  repo: {
    getGate: vi.fn(),
    saveDerivedGate:
      vi.fn<
        (input: {
          projectId: string;
          positivesJson: string;
          negativesJson: string;
          brandTokensJson: string;
        }) => Promise<boolean>
      >(),
    updateKdCeiling:
      vi.fn<
        (input: {
          projectId: string;
          kdCeiling: number;
          kdCeilingUpdatedAt: string | null;
        }) => Promise<void>
      >(),
    getContentPageDocuments: vi.fn(),
    getKeywordDifficulties: vi.fn(),
  },
  read28DayWindow: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/server/features/projects/repositories/ProjectRepository", () => ({
  ProjectRepository: mocks.projectRepo,
}));
vi.mock(
  "@/server/features/rankloop/universe/repositories/UniverseRepository",
  () => ({ UniverseRepository: mocks.repo }),
);
vi.mock("@/server/features/rankloop/universe/services/gscWindow", () => ({
  read28DayWindow: mocks.read28DayWindow,
}));

const { RelevanceGateService } = await import("./RelevanceGateService");

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

function agg(query: string, weightedPosition: number): PageQueryAggregate {
  return {
    pageUrl: "https://acme.com/a/",
    query,
    clicks: 0,
    impressions: 100,
    weightedPosition,
  };
}

beforeEach(() => {
  mocks.projectRepo.getProjectById.mockResolvedValue({
    id: PROJECT_ID,
    name: "Acme Coffee",
    domain: "acme.com",
    locationCode: 2840,
    languageCode: "en",
  });
  mocks.repo.getContentPageDocuments.mockResolvedValue([]);
  mocks.repo.getKeywordDifficulties.mockResolvedValue([]);
  mocks.repo.saveDerivedGate.mockResolvedValue(true);
  mocks.read28DayWindow.mockResolvedValue([]);
});

describe("deriveGate", () => {
  it("derives positives from the project's own pages and earned queries", async () => {
    mocks.repo.getContentPageDocuments.mockResolvedValue([
      { title: "Espresso guide", path: "/a/" },
      { title: "Espresso reviews", path: "/b/" },
      { title: "Espresso pricing", path: "/c/" },
    ]);
    // The same query served by two pages is one piece of evidence about what
    // the site is about, not two.
    mocks.read28DayWindow.mockResolvedValue([
      agg("espresso descaling", 30),
      agg("espresso descaling", 44),
    ]);

    await RelevanceGateService.deriveGate(PROJECT_ID);

    const saved = mocks.repo.saveDerivedGate.mock.calls[0][0];
    expect(JSON.parse(saved.positivesJson)).toEqual(["espresso"]);
    expect(JSON.parse(saved.brandTokensJson)).toContain("acme");
    expect(JSON.parse(saved.negativesJson)).toContain("jobs");
  });

  it("reports the database's refusal to overwrite an edited gate", async () => {
    // The UPDATE's own predicate is the enforcement; this is what the tab
    // shows when something calls Re-derive anyway.
    mocks.repo.saveDerivedGate.mockResolvedValue(false);

    expect(await RelevanceGateService.deriveGate(PROJECT_ID)).toEqual({
      derived: false,
    });
  });

  it("derives nothing for a project that was archived mid-run", async () => {
    mocks.projectRepo.getProjectById.mockResolvedValue(null);

    expect(await RelevanceGateService.deriveGate(PROJECT_ID)).toEqual({
      derived: false,
    });
    expect(mocks.repo.saveDerivedGate).not.toHaveBeenCalled();
  });
});

describe("loadEngineConfig", () => {
  it("derives a gate on first use rather than handing back an open one", async () => {
    mocks.repo.getContentPageDocuments.mockResolvedValue([
      { title: "Espresso guide", path: "/a/" },
      { title: "Espresso reviews", path: "/b/" },
      { title: "Espresso pricing", path: "/c/" },
    ]);
    mocks.repo.getGate.mockResolvedValueOnce(null).mockResolvedValueOnce({
      positivesJson: '["espresso"]',
      negativesJson: '["jobs"]',
      kdCeiling: 20,
    });

    const config = await RelevanceGateService.loadEngineConfig(PROJECT_ID);

    expect(mocks.repo.saveDerivedGate).toHaveBeenCalled();
    expect(config && relevant(config, "espresso descaling")).toBe(true);
    expect(config && relevant(config, "barista jobs")).toBe(false);
  });

  it("survives a gate row whose stored tokens are unreadable", async () => {
    mocks.repo.getGate.mockResolvedValue({
      positivesJson: "not json",
      negativesJson: '["jobs"]',
      kdCeiling: 20,
    });

    const config = await RelevanceGateService.loadEngineConfig(PROJECT_ID);

    // An empty positive list still vetoes the junk orbit; throwing the run
    // away over a malformed blob would be worse.
    expect(config && relevant(config, "anything")).toBe(true);
    expect(config && relevant(config, "barista jobs")).toBe(false);
  });
});

describe("refreshKdCeiling", () => {
  beforeEach(() => {
    mocks.repo.getGate.mockResolvedValue({ kdCeiling: 20 });
  });

  it("stores the fixed floor with no timestamp when nothing was earned", async () => {
    const result = await RelevanceGateService.refreshKdCeiling(PROJECT_ID);

    expect(result?.ceiling).toBe(20);
    expect(mocks.repo.updateKdCeiling).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      kdCeiling: 20,
      // The card needs to tell "earned from 14 rankings" apart from "this is
      // where everyone starts"; a timestamp here would lie about that.
      kdCeilingUpdatedAt: null,
    });
  });

  it("earns a ceiling from top-10 rankings and moves it by at most five", async () => {
    const ranked = Array.from({ length: 12 }, (_, i) => agg(`topic ${i}`, 5));
    mocks.read28DayWindow.mockResolvedValue([
      ...ranked,
      // Position 30 is not a ranking this project earned anything from.
      agg("topic hard", 30),
    ]);
    mocks.repo.getKeywordDifficulties.mockResolvedValue([
      ...ranked.map((row) => ({ keyword: row.query, keywordDifficulty: 40 })),
      { keyword: "topic hard", keywordDifficulty: 90 },
    ]);

    const result = await RelevanceGateService.refreshKdCeiling(PROJECT_ID);

    expect(result?.sampleCount).toBe(12);
    // p75 40 + 10 headroom is 50, clamped to 25 from the stored 20.
    expect(result?.ceiling).toBe(25);
    const stored = mocks.repo.updateKdCeiling.mock.calls[0][0];
    expect(stored.kdCeiling).toBe(25);
    expect(stored.kdCeilingUpdatedAt).not.toBeNull();
  });
});
