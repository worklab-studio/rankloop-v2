import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  workersEnv: { DATAFORSEO_API_KEY: "key" } as Record<string, string>,
  repo: {
    listCompetitors: vi.fn(),
    insertSuggestedCompetitors: vi.fn(),
  },
  cache: {
    getCached: vi.fn(),
    setCached: vi.fn(),
  },
  dataforseo: {
    competitorsDomain: vi.fn(),
  },
  waitUntil: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  env: mocks.workersEnv,
  waitUntil: mocks.waitUntil,
}));
vi.mock(
  "@/server/features/rankloop/competitors/repositories/CompetitorsRepository",
  () => ({ CompetitorsRepository: mocks.repo }),
);
vi.mock("@/server/lib/r2-cache", () => ({
  buildCacheKey: (prefix: string) => Promise.resolve(`${prefix}:key`),
  getCached: mocks.cache.getCached,
  setCached: mocks.cache.setCached,
}));
vi.mock("@/server/lib/dataforseo", () => ({
  createDataforseoClient: () => ({
    labs: { competitorsDomain: mocks.dataforseo.competitorsDomain },
  }),
}));

const input = {
  projectId: "project_1",
  organizationId: "org_1",
  domain: "acme.com",
  locationCode: 2840,
  languageCode: "en",
  billingCustomer: {
    userId: "user_1",
    userEmail: "u@example.com",
    organizationId: "org_1",
    projectId: "project_1",
  },
};

function labsItem(domain: string, intersections: number) {
  return {
    domain,
    intersections,
    full_domain_metrics: { organic: { etv: 1234 } },
  };
}

beforeEach(() => {
  vi.resetModules();
  mocks.workersEnv.DATAFORSEO_API_KEY = "key";
  for (const group of [mocks.repo, mocks.cache, mocks.dataforseo]) {
    for (const mock of Object.values(group)) mock.mockReset();
  }
  mocks.waitUntil.mockReset();
  mocks.repo.listCompetitors.mockResolvedValue([]);
  mocks.cache.getCached.mockResolvedValue(null);
  mocks.cache.setCached.mockResolvedValue(undefined);
});

describe("CompetitorDiscoveryService.discoverCompetitors", () => {
  it("refuses without a key, and spends nothing doing it", async () => {
    mocks.workersEnv.DATAFORSEO_API_KEY = "";
    const { CompetitorDiscoveryService } =
      await import("./CompetitorDiscoveryService");

    await expect(
      CompetitorDiscoveryService.discoverCompetitors(input),
    ).rejects.toThrow("Add your DataForSEO API key");
    expect(mocks.dataforseo.competitorsDomain).not.toHaveBeenCalled();
  });

  it("files unseen domains as suggestions with their overlap count", async () => {
    mocks.dataforseo.competitorsDomain.mockResolvedValue([
      labsItem("beta.com", 340),
      labsItem("gamma.com", 90),
    ]);
    const { CompetitorDiscoveryService } =
      await import("./CompetitorDiscoveryService");

    const result = await CompetitorDiscoveryService.discoverCompetitors(input);

    expect(result).toEqual({ suggested: 2 });
    expect(mocks.repo.insertSuggestedCompetitors).toHaveBeenCalledWith([
      expect.objectContaining({
        domain: "beta.com",
        organicKeywords: 340,
        estTraffic: 1234,
        discoveredVia: "labs_competitors_domain",
      }),
      expect.objectContaining({ domain: "gamma.com", organicKeywords: 90 }),
    ]);
  });

  it("never touches a domain the user already decided on", async () => {
    mocks.repo.listCompetitors.mockResolvedValue([
      { domain: "beta.com", status: "tracked" },
      { domain: "gamma.com", status: "skipped" },
    ]);
    mocks.dataforseo.competitorsDomain.mockResolvedValue([
      labsItem("beta.com", 999),
      labsItem("gamma.com", 999),
      labsItem("delta.com", 12),
    ]);
    const { CompetitorDiscoveryService } =
      await import("./CompetitorDiscoveryService");

    const result = await CompetitorDiscoveryService.discoverCompetitors(input);

    // A tracked row keeps its studied metrics and its status; a skipped one
    // stays skipped. Only the genuinely new domain is written.
    expect(result).toEqual({ suggested: 1 });
    expect(mocks.repo.insertSuggestedCompetitors).toHaveBeenCalledWith([
      expect.objectContaining({ domain: "delta.com" }),
    ]);
  });

  it("drops the project's own domain out of its own competitor list", async () => {
    mocks.dataforseo.competitorsDomain.mockResolvedValue([
      labsItem("acme.com", 5000),
      labsItem("beta.com", 40),
    ]);
    const { CompetitorDiscoveryService } =
      await import("./CompetitorDiscoveryService");

    await CompetitorDiscoveryService.discoverCompetitors(input);

    expect(mocks.repo.insertSuggestedCompetitors).toHaveBeenCalledWith([
      expect.objectContaining({ domain: "beta.com" }),
    ]);
  });

  it("serves a cached response without paying for the call again", async () => {
    mocks.cache.getCached.mockResolvedValue([
      { domain: "beta.com", overlapKeywords: 12, estTraffic: null },
    ]);
    const { CompetitorDiscoveryService } =
      await import("./CompetitorDiscoveryService");

    const result = await CompetitorDiscoveryService.discoverCompetitors(input);

    expect(result).toEqual({ suggested: 1 });
    expect(mocks.dataforseo.competitorsDomain).not.toHaveBeenCalled();
  });

  it("ignores a cached value whose shape has drifted and re-fetches", async () => {
    mocks.cache.getCached.mockResolvedValue([{ domain: 42 }]);
    mocks.dataforseo.competitorsDomain.mockResolvedValue([
      labsItem("beta.com", 1),
    ]);
    const { CompetitorDiscoveryService } =
      await import("./CompetitorDiscoveryService");

    await CompetitorDiscoveryService.discoverCompetitors(input);

    expect(mocks.dataforseo.competitorsDomain).toHaveBeenCalledTimes(1);
  });

  it("persists the cache write through waitUntil, not a dangling promise", async () => {
    mocks.dataforseo.competitorsDomain.mockResolvedValue([
      labsItem("beta.com", 1),
    ]);
    const { CompetitorDiscoveryService } =
      await import("./CompetitorDiscoveryService");

    await CompetitorDiscoveryService.discoverCompetitors(input);

    expect(mocks.waitUntil).toHaveBeenCalledTimes(1);
  });

  it("writes nothing when the provider knows no competitors", async () => {
    mocks.dataforseo.competitorsDomain.mockResolvedValue([]);
    const { CompetitorDiscoveryService } =
      await import("./CompetitorDiscoveryService");

    const result = await CompetitorDiscoveryService.discoverCompetitors(input);

    expect(result).toEqual({ suggested: 0 });
    expect(mocks.repo.insertSuggestedCompetitors).not.toHaveBeenCalled();
  });
});
