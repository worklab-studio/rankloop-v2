import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  workersEnv: { DATAFORSEO_API_KEY: "key" } as Record<string, string>,
  repo: {
    insertSerpSnapshot:
      vi.fn<
        (row: {
          projectId: string;
          keyword: string;
          organicJson: string;
          paaJson: string | null;
          featuresJson: string;
        }) => Promise<void>
      >(),
    applySerpCheck:
      vi.fn<
        (input: {
          pageTypeId: string;
          serpCheckJson: string;
          status: "proposed" | "declined";
        }) => Promise<void>
      >(),
  },
  universeRepo: {
    getKdCeiling: vi.fn<(projectId: string) => Promise<number>>(),
  },
  projectRepo: { getProjectById: vi.fn() },
  serpLive: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: mocks.workersEnv }));
vi.mock(
  "@/server/features/rankloop/page-plan/repositories/PagePlanRepository",
  () => ({ PagePlanRepository: mocks.repo }),
);
vi.mock(
  "@/server/features/rankloop/universe/repositories/UniverseRepository",
  () => ({ UniverseRepository: mocks.universeRepo }),
);
vi.mock("@/server/features/projects/repositories/ProjectRepository", () => ({
  ProjectRepository: mocks.projectRepo,
}));
vi.mock("@/server/lib/dataforseo", () => ({
  createDataforseoClient: () => ({ serp: { live: mocks.serpLive } }),
}));

const { hasSerpProvider, markUnsampled, sampleCandidate, toSerpSample } =
  await import("./planSerpSampling");

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

const entry = {
  pageTypeId: "pt_1",
  name: "Comparisons",
  sampleKeywords: ["breville vs delonghi"],
  kdBandP75: null,
};

const billingCustomer = {
  userId: "system",
  userEmail: "system@openseo.so",
  organizationId: "org_1",
  projectId: PROJECT_ID,
};

beforeEach(() => {
  mocks.workersEnv.DATAFORSEO_API_KEY = "key";
  mocks.universeRepo.getKdCeiling.mockResolvedValue(20);
  mocks.projectRepo.getProjectById.mockResolvedValue({
    id: PROJECT_ID,
    organizationId: "org_1",
    locationCode: 2840,
    languageCode: "en",
  });
});

describe("hasSerpProvider", () => {
  it("is false for a blank key, so a keyless run skips the metered half", () => {
    mocks.workersEnv.DATAFORSEO_API_KEY = "  ";
    expect(hasSerpProvider()).toBe(false);
    mocks.workersEnv.DATAFORSEO_API_KEY = "key";
    expect(hasSerpProvider()).toBe(true);
  });
});

describe("sampleCandidate", () => {
  it("stores the SERP it paid for and declines a type Reddit already owns", async () => {
    mocks.serpLive.mockResolvedValue([
      { type: "ai_overview" },
      {
        type: "organic",
        rank_group: 1,
        url: "https://reddit.com/r/espresso/comments/1/",
        domain: "reddit.com",
        title: "Breville or DeLonghi?",
        description: "A long thread about which machine to buy, with opinions.",
      },
      {
        type: "organic",
        rank_group: 2,
        url: "https://quora.com/q/breville",
        domain: "quora.com",
        title: "Breville vs DeLonghi",
        description: "Answers from people who own both machines, at length.",
      },
      {
        type: "people_also_ask",
        items: [{ title: "Is Breville better than DeLonghi?" }],
      },
    ]);

    const result = await sampleCandidate({
      projectId: PROJECT_ID,
      entry,
      billingCustomer,
    });

    // One page of ten, not the research screens' hundred: the verdict is
    // decided inside the top 10 and the extra pages would cost 8x.
    expect(mocks.serpLive).toHaveBeenCalledWith({
      keyword: "breville vs delonghi",
      locationCode: 2840,
      languageCode: "en",
      depth: 10,
    });

    const snapshot = mocks.repo.insertSerpSnapshot.mock.calls[0][0];
    expect(snapshot.keyword).toBe("breville vs delonghi");
    expect(snapshot.paaJson).toBe(
      JSON.stringify(["Is Breville better than DeLonghi?"]),
    );
    expect(snapshot.featuresJson).toBe(
      JSON.stringify({ aiOverview: true, featuredSnippet: false }),
    );

    const applied = mocks.repo.applySerpCheck.mock.calls[0][0];
    expect(applied.status).toBe("declined");
    expect(applied.serpCheckJson).toContain('"status":"kill"');
    expect(result).toEqual({ sampled: 1, costUsd: 0.002 });
  });

  it("leaves a winnable type proposed", async () => {
    mocks.serpLive.mockResolvedValue([
      {
        type: "organic",
        rank_group: 4,
        url: "https://espresso-obsession.example/breville-vs-delonghi/",
        domain: "espresso-obsession.example",
        title: "Breville vs DeLonghi, measured",
        description:
          "A long, specific comparison of both machines with numbers from a real kitchen.",
      },
    ]);

    await sampleCandidate({ projectId: PROJECT_ID, entry, billingCustomer });

    expect(mocks.repo.applySerpCheck.mock.calls[0][0].status).toBe("proposed");
  });

  it("judges difficulty against the gate's earned ceiling, not the fixed 20", async () => {
    mocks.serpLive.mockResolvedValue([
      {
        type: "organic",
        rank_group: 4,
        url: "https://espresso-obsession.example/breville-vs-delonghi/",
        domain: "espresso-obsession.example",
        title: "Breville vs DeLonghi, measured",
        description:
          "A long, specific comparison of both machines with numbers from a real kitchen.",
      },
    ]);
    // KD 34 is over the starting 20 and under a ceiling this site earned:
    // without the gate read, a project that already ranks for harder terms
    // would keep seeing caution on shapes it can win.
    mocks.universeRepo.getKdCeiling.mockResolvedValue(45);

    await sampleCandidate({
      projectId: PROJECT_ID,
      entry: { ...entry, kdBandP75: 34 },
      billingCustomer,
    });

    expect(mocks.repo.applySerpCheck.mock.calls[0][0].serpCheckJson).toContain(
      '"status":"ok"',
    );
  });

  it("uses the fixed floor a project with no gate row still answers with", async () => {
    mocks.serpLive.mockResolvedValue([
      {
        type: "organic",
        rank_group: 4,
        url: "https://espresso-obsession.example/breville-vs-delonghi/",
        domain: "espresso-obsession.example",
        title: "Breville vs DeLonghi, measured",
        description:
          "A long, specific comparison of both machines with numbers from a real kitchen.",
      },
    ]);

    await sampleCandidate({
      projectId: PROJECT_ID,
      entry: { ...entry, kdBandP75: 34 },
      billingCustomer,
    });

    const applied = mocks.repo.applySerpCheck.mock.calls[0][0];
    expect(applied.serpCheckJson).toContain('"status":"caution"');
    expect(applied.serpCheckJson).toContain("(20)");
  });

  it("stores no snapshot at all when the project vanished mid-run", async () => {
    mocks.projectRepo.getProjectById.mockResolvedValue(null);

    const result = await sampleCandidate({
      projectId: PROJECT_ID,
      entry,
      billingCustomer,
    });

    expect(mocks.serpLive).not.toHaveBeenCalled();
    expect(result).toEqual({ sampled: 0, costUsd: 0 });
  });
});

describe("markUnsampled", () => {
  it("writes the reason the card will show, and leaves the type proposed", async () => {
    await markUnsampled("pt_1", "Not sampled — no SERP provider is connected.");

    const applied = mocks.repo.applySerpCheck.mock.calls[0][0];
    expect(applied.status).toBe("proposed");
    expect(applied.serpCheckJson).toContain(
      "Not sampled — no SERP provider is connected.",
    );
  });
});

describe("toSerpSample", () => {
  it("reads organic rank, drops non-organic rows, and only flags features the response carried", () => {
    const sample = toSerpSample("k", [
      { type: "featured_snippet", rank_group: 1 },
      {
        type: "organic",
        rank_group: 1,
        rank_absolute: 3,
        url: "https://a.example/x/",
        domain: "a.example",
        title: "A",
        description: null,
      },
      { type: "organic", rank_group: 2, url: null, domain: "b.example" },
    ]);

    expect(sample.organic).toEqual([
      {
        position: 1,
        url: "https://a.example/x/",
        domain: "a.example",
        title: "A",
        description: null,
      },
    ]);
    expect(sample.featuredSnippet).toBe(true);
    expect(sample.aiOverview).toBe(false);
  });
});
