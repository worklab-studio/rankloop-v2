import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InferInsertModel } from "drizzle-orm";
import type { proposals } from "@/db/schema";

// Typed so the insert assertions below can read `.mock.calls` without unsafe
// casts (an untyped vi.fn() yields `any` calls).
type TryInsertProposal = (
  data: InferInsertModel<typeof proposals>,
) => Promise<boolean>;

const mocks = vi.hoisted(() => ({
  proposalsRepo: {
    getDailyPageQueryRows: vi.fn(),
    getDailyPageTotals: vi.fn(),
    getEarliestStoredDate: vi.fn(),
    getContentPagesForSignals: vi.fn(),
    tryInsertProposal: vi.fn<TryInsertProposal>(),
    expireStaleProposals: vi.fn(),
    getRecentDecisions: vi.fn(),
    updateDecision: vi.fn(),
    getProposalById: vi.fn(),
    getProposalsForProject: vi.fn(),
  },
  gscSyncRepo: {
    getLatestStoredDate: vi.fn(),
  },
  projectRepo: {
    getProjectById: vi.fn(),
  },
  selectionRepo: {
    releaseBacklogRow: vi.fn(),
  },
  indexation: {
    getIndexationStatus: vi.fn(),
  },
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock(
  "@/server/features/rankloop/proposals/repositories/ProposalsRepository",
  () => ({ ProposalsRepository: mocks.proposalsRepo }),
);
vi.mock(
  "@/server/features/rankloop/gsc-sync/repositories/GscSyncRepository",
  () => ({ GscSyncRepository: mocks.gscSyncRepo }),
);
vi.mock("@/server/features/gsc/repositories/GscConnectionRepository", () => ({
  GscConnectionRepository: {},
}));
vi.mock("@/server/features/projects/repositories/ProjectRepository", () => ({
  ProjectRepository: mocks.projectRepo,
}));
vi.mock(
  "@/server/features/rankloop/writing/repositories/SelectionRepository",
  () => ({ SelectionRepository: mocks.selectionRepo }),
);
vi.mock(
  "@/server/features/rankloop/indexation/services/IndexationService",
  () => ({ IndexationService: mocks.indexation }),
);

const project = { id: "project_1", name: "Acme", domain: "acme.com" };

// Two striking-distance pairs on different pages. Page A at the position-11
// peak outscores page B at 15 — insert order asserts on that gap.
const pushDayRows = [
  {
    pageUrl: "https://acme.com/a",
    query: "best espresso grinder",
    clicks: 1,
    impressions: 90,
    position: 11,
  },
  {
    pageUrl: "https://acme.com/b",
    query: "espresso tamper size",
    clicks: 1,
    impressions: 40,
    position: 15,
  },
];

const contentPages = [
  {
    id: "cp_a",
    url: "https://acme.com/a",
    path: "/a",
    title: "A",
    publishedAt: null,
  },
  {
    id: "cp_b",
    url: "https://acme.com/b",
    path: "/b",
    title: "B",
    publishedAt: null,
  },
];

function primeComputeHappyPath() {
  mocks.proposalsRepo.expireStaleProposals.mockResolvedValue(0);
  mocks.projectRepo.getProjectById.mockResolvedValue(project);
  mocks.gscSyncRepo.getLatestStoredDate.mockResolvedValue("2026-07-27");
  mocks.proposalsRepo.getContentPagesForSignals.mockResolvedValue(contentPages);
  mocks.proposalsRepo.getDailyPageQueryRows.mockResolvedValue(pushDayRows);
  mocks.proposalsRepo.getDailyPageTotals.mockResolvedValue([]);
  // No memory depth yet — the refresh signal must stay silent.
  mocks.proposalsRepo.getEarliestStoredDate.mockResolvedValue(null);
  mocks.proposalsRepo.getRecentDecisions.mockResolvedValue([]);
  mocks.proposalsRepo.tryInsertProposal.mockResolvedValue(true);
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-31T12:00:00Z"));
  for (const group of Object.values(mocks)) {
    for (const mock of Object.values(group)) mock.mockReset();
  }
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ProposalsService.computeProposals", () => {
  it("expires the TTL sweep, inserts candidates best-first, and stamps a 10-day expiry", async () => {
    primeComputeHappyPath();
    const { ProposalsService } = await import("./ProposalsService");

    const result = await ProposalsService.computeProposals("project_1");

    expect(result).toEqual({ created: 2, expired: 0 });
    expect(mocks.proposalsRepo.expireStaleProposals).toHaveBeenCalledWith(
      "project_1",
      "2026-07-31T12:00:00.000Z",
    );
    // The 28-day window anchors on the watermark, not on today.
    expect(mocks.proposalsRepo.getDailyPageQueryRows).toHaveBeenCalledWith(
      "project_1",
      "2026-06-30",
    );
    const inserts = mocks.proposalsRepo.tryInsertProposal.mock.calls.map(
      ([data]) => data,
    );
    expect(inserts).toHaveLength(2);
    // Best-first: the partial unique keeps the strongest row per target, so
    // insert order is score order.
    expect(inserts[0].target).toBe("/a");
    expect(inserts[0].score).toBeGreaterThan(inserts[1].score);
    expect(inserts[0]).toMatchObject({
      projectId: "project_1",
      type: "push",
      track: "optimize",
      contentPageId: "cp_a",
      expiresAt: "2026-08-10T12:00:00.000Z",
    });
    // Explainability is a product law: both JSON columns always populated.
    const factors: unknown = JSON.parse(inserts[0].factorsJson ?? "null");
    const evidence: unknown = JSON.parse(inserts[0].evidenceJson ?? "null");
    expect(Array.isArray(factors) && factors.length > 0).toBe(true);
    expect(Array.isArray(evidence) && evidence.length > 0).toBe(true);
  });

  it("counts a blocked INSERT as a skip, not a failure — the duplicate is already active", async () => {
    primeComputeHappyPath();
    mocks.proposalsRepo.tryInsertProposal
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const { ProposalsService } = await import("./ProposalsService");

    const result = await ProposalsService.computeProposals("project_1");

    expect(result.created).toBe(1);
    expect(mocks.proposalsRepo.tryInsertProposal).toHaveBeenCalledTimes(2);
  });

  it("returns after the TTL sweep when no memory is stored yet", async () => {
    mocks.proposalsRepo.expireStaleProposals.mockResolvedValue(3);
    mocks.projectRepo.getProjectById.mockResolvedValue(project);
    mocks.gscSyncRepo.getLatestStoredDate.mockResolvedValue(null);
    const { ProposalsService } = await import("./ProposalsService");

    const result = await ProposalsService.computeProposals("project_1");

    expect(result).toEqual({ created: 0, expired: 3 });
    expect(mocks.proposalsRepo.getDailyPageQueryRows).not.toHaveBeenCalled();
    expect(mocks.proposalsRepo.tryInsertProposal).not.toHaveBeenCalled();
  });

  it("never re-proposes an executed push while its receipt is open, however many syncs run", async () => {
    primeComputeHappyPath();
    const { ProposalsService } = await import("./ProposalsService");

    // Sync 1: both pages qualify, the user approves and executes /a's push.
    await ProposalsService.computeProposals("project_1");
    mocks.proposalsRepo.getRecentDecisions.mockResolvedValue([
      {
        type: "push",
        target: "/a",
        decidedAt: "2026-07-31T11:00:00.000Z",
        executedAt: "2026-07-31T11:30:00.000Z",
      },
    ]);
    mocks.proposalsRepo.tryInsertProposal.mockClear();

    // GSC cannot reflect the link work for ~2 weeks, so the raw signal still
    // fires on /a. Re-proposing it is what lets a second execution land inside
    // the open receipt's window and close it as contaminated.
    await ProposalsService.computeProposals("project_1");
    await ProposalsService.computeProposals("project_1");

    const targets = mocks.proposalsRepo.tryInsertProposal.mock.calls.map(
      ([data]) => data.target,
    );
    expect(targets).not.toContain("/a");
    expect(targets).toEqual(["/b", "/b"]);
  });

  it("does not re-propose a declined push on the very next sync", async () => {
    primeComputeHappyPath();
    // A decline leaves no executedAt and no receipt — only the decision stamp
    // holds it back.
    mocks.proposalsRepo.getRecentDecisions.mockResolvedValue([
      {
        type: "push",
        target: "/a",
        decidedAt: "2026-07-30T09:00:00.000Z",
        executedAt: null,
      },
    ]);
    const { ProposalsService } = await import("./ProposalsService");

    const result = await ProposalsService.computeProposals("project_1");

    expect(result.created).toBe(1);
    const targets = mocks.proposalsRepo.tryInsertProposal.mock.calls.map(
      ([data]) => data.target,
    );
    expect(targets).toEqual(["/b"]);
  });

  it("keeps proposing retitle, push AND refresh at 30% indexation — the optimize track is never throttled", async () => {
    primeComputeHappyPath();
    // All three optimize signals armed at once, so this asserts the whole
    // track and not just the one signal the happy path happens to fire.
    // /c is at position 3 with a CTR far under the band — a retitle, and too
    // high in the results to be a push. /d decayed from 20 clicks a week to 2
    // with impressions falling alongside — a refresh.
    mocks.proposalsRepo.getContentPagesForSignals.mockResolvedValue([
      ...contentPages,
      {
        id: "cp_c",
        url: "https://acme.com/c",
        path: "/c",
        title: "C",
        publishedAt: null,
      },
      {
        id: "cp_d",
        url: "https://acme.com/d",
        path: "/d",
        title: "D",
        publishedAt: "2025-01-01",
      },
    ]);
    mocks.proposalsRepo.getDailyPageQueryRows.mockResolvedValue([
      ...pushDayRows,
      {
        pageUrl: "https://acme.com/c",
        query: "burr grinder settings",
        clicks: 2,
        impressions: 600,
        position: 3,
      },
    ]);
    mocks.proposalsRepo.getDailyPageTotals.mockResolvedValue([
      {
        pageUrl: "https://acme.com/d",
        date: "2026-06-10",
        clicks: 20,
        impressions: 400,
      },
      {
        pageUrl: "https://acme.com/d",
        date: "2026-07-10",
        clicks: 2,
        impressions: 50,
      },
    ]);
    // Memory reaching back past the prior window, so the decay guard opens.
    mocks.proposalsRepo.getEarliestStoredDate.mockResolvedValue("2026-05-01");
    // Net-new is paused at this rate. Optimize is the opposite call: a site
    // Google is refusing to index more of is exactly the site that should be
    // improving the pages it already has, and throttling that would starve
    // the one track that can dig it back out.
    mocks.indexation.getIndexationStatus.mockResolvedValue({
      rate: 0.3,
      indexed: 6,
      cohort: 20,
      minimumCohort: 5,
      connected: true,
      throttle: {
        cap: 0,
        reason: "net-new paused — 30% of recent posts are indexed",
      },
    });
    const { ProposalsService } = await import("./ProposalsService");

    const result = await ProposalsService.computeProposals("project_1");

    expect(result.created).toBe(4);
    const inserts = mocks.proposalsRepo.tryInsertProposal.mock.calls.map(
      ([data]) => data,
    );
    expect(new Set(inserts.map((row) => row.type))).toEqual(
      new Set(["retitle", "push", "refresh"]),
    );
    expect(inserts.every((row) => row.track === "optimize")).toBe(true);
    // Not "it happens to still work" — the optimize path never asks.
    expect(mocks.indexation.getIndexationStatus).not.toHaveBeenCalled();
  });

  it("passes the brand tokens into the refresh series query", async () => {
    primeComputeHappyPath();
    const { ProposalsService } = await import("./ProposalsService");

    await ProposalsService.computeProposals("project_1");

    expect(mocks.proposalsRepo.getDailyPageTotals).toHaveBeenCalledWith(
      "project_1",
      ["acme"],
    );
  });
});

/** The call under test. `decidedBy` has no default in the service, so every
 *  case here has to name who made the decision — which is the point. */
async function decide(
  proposalId: string,
  decision: "approved" | "declined",
  decidedBy: "human" | "autopilot" = "human",
) {
  const { ProposalsService } = await import("./ProposalsService");
  return ProposalsService.decideProposal({
    projectId: "project_1",
    proposalId,
    decision,
    decidedBy,
  });
}

describe("ProposalsService.decideProposal", () => {
  it("returns the decided row when the CAS transition wins", async () => {
    const decided = { id: "prop_1", type: "retitle", target: "/a" };
    mocks.proposalsRepo.updateDecision.mockResolvedValue(decided);

    await expect(decide("prop_1", "approved")).resolves.toEqual(decided);
    expect(mocks.proposalsRepo.updateDecision).toHaveBeenCalledWith({
      projectId: "project_1",
      proposalId: "prop_1",
      status: "approved",
      decidedAt: "2026-07-31T12:00:00.000Z",
      decidedBy: "human",
    });
  });

  it("records a decision no human made as 'autopilot'", async () => {
    mocks.proposalsRepo.updateDecision.mockResolvedValue({ id: "prop_1" });

    await decide("prop_1", "approved", "autopilot");

    expect(mocks.proposalsRepo.updateDecision).toHaveBeenCalledWith(
      expect.objectContaining({ decidedBy: "autopilot" }),
    );
  });

  it("rejects a proposal that is no longer 'proposed' with CONFLICT", async () => {
    mocks.proposalsRepo.updateDecision.mockResolvedValue(null);
    mocks.proposalsRepo.getProposalById.mockResolvedValue({
      id: "prop_1",
      status: "declined",
    });

    await expect(decide("prop_1", "approved")).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("returns a declined net-new keyword to 'planned', keeping its page type binding", async () => {
    mocks.proposalsRepo.updateDecision.mockResolvedValue({
      id: "prop_2",
      type: "write_new",
      track: "net_new",
      target: "burr size",
      keywordBacklogId: "kw_1",
    });

    await decide("prop_2", "declined");

    expect(mocks.selectionRepo.releaseBacklogRow).toHaveBeenCalledWith(
      "project_1",
      "kw_1",
    );
  });

  it("keeps the keyword claimed when a net-new proposal is approved", async () => {
    mocks.proposalsRepo.updateDecision.mockResolvedValue({
      id: "prop_2",
      type: "write_new",
      track: "net_new",
      target: "burr size",
      keywordBacklogId: "kw_1",
    });

    await decide("prop_2", "approved");

    expect(mocks.selectionRepo.releaseBacklogRow).not.toHaveBeenCalled();
  });

  it("leaves the backlog alone when an optimize proposal is declined", async () => {
    mocks.proposalsRepo.updateDecision.mockResolvedValue({
      id: "prop_1",
      type: "retitle",
      track: "optimize",
      target: "/a",
      keywordBacklogId: null,
    });

    await decide("prop_1", "declined");

    expect(mocks.selectionRepo.releaseBacklogRow).not.toHaveBeenCalled();
  });

  it("rejects a missing proposal with NOT_FOUND", async () => {
    mocks.proposalsRepo.updateDecision.mockResolvedValue(null);
    mocks.proposalsRepo.getProposalById.mockResolvedValue(null);

    await expect(decide("prop_missing", "declined")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("ProposalsService.getProposals", () => {
  it("parses the JSON columns and degrades malformed rows to empty arrays", async () => {
    mocks.proposalsRepo.getProposalsForProject.mockResolvedValue([
      {
        id: "prop_1",
        factorsJson: JSON.stringify([
          { name: "Base score", value: 2, note: "engine score" },
        ]),
        evidenceJson: JSON.stringify(["pos 11.0"]),
      },
      { id: "prop_2", factorsJson: "{not json", evidenceJson: null },
    ]);
    const { ProposalsService } = await import("./ProposalsService");

    const rows = await ProposalsService.getProposals("project_1");

    expect(rows[0].factors).toEqual([
      { name: "Base score", value: 2, note: "engine score" },
    ]);
    expect(rows[0].evidence).toEqual(["pos 11.0"]);
    // One bad row must not blank the queue.
    expect(rows[1].factors).toEqual([]);
    expect(rows[1].evidence).toEqual([]);
  });
});
