import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  repo: {
    getShippedBetween: vi.fn(),
    getMeasuredBetween: vi.fn(),
    getGateFailures: vi.fn(),
    insertDigest: vi.fn(),
    getRecentDigests: vi.fn(),
  },
  proposals: {
    getProposals: vi.fn(),
  },
  indexation: {
    getIndexationStatus: vi.fn(),
  },
  autopilot: {
    getStatus: vi.fn(),
  },
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock(
  "@/server/features/rankloop/routines/repositories/DigestRepository",
  () => ({ DigestRepository: mocks.repo }),
);
vi.mock(
  "@/server/features/rankloop/proposals/services/ProposalsService",
  () => ({ ProposalsService: mocks.proposals }),
);
vi.mock(
  "@/server/features/rankloop/indexation/services/IndexationService",
  () => ({ IndexationService: mocks.indexation }),
);
vi.mock(
  "@/server/features/rankloop/routines/services/AutopilotService",
  () => ({ AutopilotService: mocks.autopilot }),
);

const NOW = new Date("2026-08-01T07:00:00.000Z");

beforeEach(() => {
  mocks.proposals.getProposals.mockResolvedValue([]);
  mocks.repo.getShippedBetween.mockResolvedValue([]);
  mocks.repo.getMeasuredBetween.mockResolvedValue([]);
  mocks.repo.getGateFailures.mockResolvedValue([]);
  mocks.repo.insertDigest.mockResolvedValue(true);
  mocks.indexation.getIndexationStatus.mockResolvedValue({ throttle: null });
  mocks.autopilot.getStatus.mockResolvedValue({
    trustDial: "titles",
    pause: null,
    adapterError: null,
    types: [],
  });
});

async function generate() {
  const { DigestService } = await import("./DigestService");
  return DigestService.generateDigest({ projectId: "project_1", now: NOW });
}

describe("DigestService.generateDigest", () => {
  it("writes nothing at all on a quiet day", async () => {
    await expect(generate()).resolves.toBeNull();

    expect(mocks.repo.insertDigest).not.toHaveBeenCalled();
  });

  it("reads yesterday whole, not back to the last run", async () => {
    await generate();

    expect(mocks.repo.getShippedBetween).toHaveBeenCalledWith({
      projectId: "project_1",
      fromIso: "2026-07-31T00:00:00.000Z",
      toIso: "2026-08-01T00:00:00.000Z",
    });
  });

  it("fills every section on a busy day and stores it under the day's date", async () => {
    mocks.proposals.getProposals.mockResolvedValue([
      {
        id: "prop_1",
        type: "retitle",
        target: "/pricing/",
        title: "Pricing",
        score: 8.2,
        createdAt: "2026-07-30T09:00:00.000Z",
        evidence: ["ranks 11th for its own headline query"],
      },
    ]);
    mocks.repo.getShippedBetween.mockResolvedValue([
      {
        articleId: "art_1",
        title: "Best CRM for plumbers",
        keyword: "best crm for plumbers",
        url: "https://acme.com/best-crm-for-plumbers/",
      },
    ]);
    mocks.repo.getMeasuredBetween.mockResolvedValue([
      {
        receiptId: "rec_1",
        actionType: "retitle",
        targetQuery: "crm for plumbers",
        pagePath: "/crm-for-plumbers/",
        baselineJson: JSON.stringify({
          impressions: 1000,
          clicks: 30,
          ctr: 0.03,
          weightedPosition: 9.1,
          siteImpressions: 50000,
          siteClicks: 900,
          window: { start: "2026-06-01", end: "2026-06-28" },
        }),
        resultJson: JSON.stringify({
          impressions: 1400,
          clicks: 70,
          ctr: 0.05,
          weightedPosition: 5.8,
          siteImpressions: 51000,
          siteClicks: 910,
          window: { start: "2026-07-04", end: "2026-07-31" },
          clicksDelta: 40,
          siteClicksDeltaRatio: 0.01,
          adjustedClicksDelta: 39.7,
        }),
      },
    ]);
    mocks.repo.getGateFailures.mockResolvedValue([
      {
        title: "Cheapest CRM",
        keyword: "cheapest crm",
        attempts: 3,
        lawReportJson: JSON.stringify({
          passed: false,
          checkedAt: "2026-07-31T09:00:00.000Z",
          laws: [
            { law: "faq", passed: false, threshold: null, excerpt: null },
            {
              law: "word-count",
              passed: true,
              threshold: "900",
              excerpt: null,
            },
          ],
          failure: { reason: "laws_unmet", detail: "1 law unmet." },
        }),
      },
    ]);
    mocks.indexation.getIndexationStatus.mockResolvedValue({
      throttle: {
        cap: 1,
        reason: "quota held at 1 — 52% of recent posts are indexed",
      },
    });

    const payload = await generate();

    expect(payload?.forDate).toBe("2026-08-01");
    expect(payload?.awaiting.top[0].evidence).toEqual([
      "ranks 11th for its own headline query",
    ]);
    expect(payload?.shipped[0].url).toBe(
      "https://acme.com/best-crm-for-plumbers/",
    );
    expect(payload?.measured[0]).toMatchObject({
      verdict: "win",
      target: "/crm-for-plumbers/",
      positionDelta: 3.3,
    });
    expect(payload?.blocked).toEqual([
      {
        kind: "throttle",
        detail: "quota held at 1 — 52% of recent posts are indexed",
      },
      {
        kind: "gate",
        detail: '"Cheapest CRM" failed the gate 3 times — faq',
      },
    ]);
    expect(mocks.repo.insertDigest).toHaveBeenCalledWith({
      projectId: "project_1",
      forDate: "2026-08-01",
      payloadJson: JSON.stringify(payload),
    });
  });

  it("puts an autopilot pause in the digest", async () => {
    mocks.autopilot.getStatus.mockResolvedValue({
      trustDial: "autopilot",
      pause: {
        reason: "autopilot paused — 3 drafts in a row failed the gate",
        since: "2026-07-30T09:00:00.000Z",
      },
      adapterError: null,
      types: [],
    });

    const payload = await generate();

    expect(payload?.blocked[0]).toEqual({
      kind: "autopilot_paused",
      detail:
        "autopilot paused — 3 drafts in a row failed the gate (since 2026-07-30T09:00:00.000Z)",
    });
    expect(mocks.repo.insertDigest).toHaveBeenCalled();
  });

  it("names a receipt whose page has since been pruned by its pinned query", async () => {
    mocks.repo.getMeasuredBetween.mockResolvedValue([
      {
        receiptId: "rec_1",
        actionType: "push",
        targetQuery: "crm for plumbers",
        pagePath: null,
        baselineJson: null,
        resultJson: null,
      },
    ]);

    const payload = await generate();

    expect(payload?.measured[0]).toMatchObject({
      target: "crm for plumbers",
      verdict: "no_change",
      positionDelta: null,
    });
  });

  it("falls back to the keyword for a draft that failed before its title parsed", async () => {
    mocks.repo.getShippedBetween.mockResolvedValue([
      {
        articleId: "art_1",
        title: null,
        keyword: "best crm for plumbers",
        url: null,
      },
    ]);

    expect((await generate())?.shipped[0].title).toBe("best crm for plumbers");
  });
});

describe("DigestService.getRecentDigests", () => {
  it("drops a row whose payload no longer parses rather than rendering half a card", async () => {
    const payload = {
      forDate: "2026-07-31",
      headline: "1 thing blocked",
      awaiting: { total: 0, top: [] },
      shipped: [],
      measured: [],
      blocked: [{ kind: "throttle", detail: "quota held at 1" }],
    };
    mocks.repo.getRecentDigests.mockResolvedValue([
      {
        id: "dig_1",
        forDate: "2026-08-01",
        createdAt: "2026-08-01T07:00:00.000Z",
        payloadJson: "{not json",
        deliveredJson: null,
      },
      {
        id: "dig_2",
        forDate: "2026-07-31",
        createdAt: "2026-07-31T07:00:00.000Z",
        payloadJson: JSON.stringify(payload),
        deliveredJson: JSON.stringify([
          {
            channel: "email",
            status: "sent",
            at: "2026-07-31T07:01:00.000Z",
            error: null,
          },
        ]),
      },
    ]);
    const { DigestService } = await import("./DigestService");

    const items = await DigestService.getRecentDigests("project_1");

    expect(items.map((item) => item.id)).toEqual(["dig_2"]);
    expect(items[0].deliveries[0].channel).toBe("email");
  });
});
