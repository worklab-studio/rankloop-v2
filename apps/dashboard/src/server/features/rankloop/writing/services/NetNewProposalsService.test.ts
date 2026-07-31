import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InferInsertModel } from "drizzle-orm";
import type { proposals } from "@/db/schema";

// Typed so the insert assertions below read `.mock.calls` without an unsafe
// cast (an untyped vi.fn() yields `any` calls).
type TryInsertProposal = (
  data: InferInsertModel<typeof proposals>,
) => Promise<boolean>;

const mocks = vi.hoisted(() => ({
  proposalsRepo: {
    expireStaleProposals: vi.fn(),
    getRecentDecisions: vi.fn(),
    tryInsertProposal: vi.fn<TryInsertProposal>(),
  },
  selectionRepo: {
    getPublishedPostDates: vi.fn(),
    getPlannedCandidates: vi.fn(),
    countOutstandingNetNew: vi.fn(),
    markBacklogProposed: vi.fn(),
    reclaimAbandonedBacklogRows: vi.fn(),
  },
  settingsRepo: {
    getSettings: vi.fn(),
  },
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock(
  "@/server/features/rankloop/proposals/repositories/ProposalsRepository",
  () => ({ ProposalsRepository: mocks.proposalsRepo }),
);
vi.mock(
  "@/server/features/rankloop/writing/repositories/SelectionRepository",
  () => ({ SelectionRepository: mocks.selectionRepo }),
);
vi.mock(
  "@/server/features/rankloop/writing/repositories/WriterSettingsRepository",
  () => ({ WriterSettingsRepository: mocks.settingsRepo }),
);

const plannedRow = {
  backlogId: "kw_1",
  keyword: "espresso grinder burr size",
  source: "expansion" as const,
  score: 4.2,
  searchVolume: 320,
  keywordDifficulty: 24,
  notesJson: null,
  createdAt: "2026-07-01T00:00:00.000Z",
  pageTypeId: "type_specs",
  pageTypeName: "Specs and data",
  pageTypeKind: "blog" as const,
  dataSourceJson: null,
};

function primeHappyPath() {
  mocks.proposalsRepo.expireStaleProposals.mockResolvedValue(0);
  mocks.proposalsRepo.getRecentDecisions.mockResolvedValue([]);
  mocks.proposalsRepo.tryInsertProposal.mockResolvedValue(true);
  mocks.selectionRepo.reclaimAbandonedBacklogRows.mockResolvedValue(0);
  mocks.selectionRepo.getPublishedPostDates.mockResolvedValue([]);
  mocks.selectionRepo.countOutstandingNetNew.mockResolvedValue(0);
  mocks.selectionRepo.getPlannedCandidates.mockResolvedValue([
    plannedRow,
    { ...plannedRow, backlogId: "kw_2", keyword: "portafilter size", score: 3 },
    { ...plannedRow, backlogId: "kw_3", keyword: "tamper weight", score: 2 },
  ]);
  mocks.settingsRepo.getSettings.mockResolvedValue({
    postsPerDay: 2,
    catchupCap: 6,
    quotaStartDate: "2026-08-01",
  });
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-01T09:00:00Z"));
  for (const group of Object.values(mocks)) {
    for (const mock of Object.values(group)) mock.mockReset();
  }
});

describe("NetNewProposalsService.computeNetNewProposals", () => {
  it("proposes exactly what the quota owes and claims the backlog rows", async () => {
    primeHappyPath();
    const { NetNewProposalsService } = await import("./NetNewProposalsService");

    const result =
      await NetNewProposalsService.computeNetNewProposals("project_1");

    expect(result.created).toBe(2);
    expect(mocks.proposalsRepo.tryInsertProposal).toHaveBeenCalledTimes(2);
    const inserted = mocks.proposalsRepo.tryInsertProposal.mock.calls.map(
      ([data]) => data,
    );
    expect(inserted.map((row) => row.target)).toEqual([
      "espresso grinder burr size",
      "portafilter size",
    ]);
    expect(inserted[0]).toMatchObject({
      type: "write_new",
      track: "net_new",
      title: "Espresso grinder burr size",
      pageTypeId: "type_specs",
      keywordBacklogId: "kw_1",
      // Ten days on from the run — the same TTL the optimize track ages on.
      expiresAt: "2026-08-11T09:00:00.000Z",
    });
    expect(mocks.selectionRepo.markBacklogProposed).toHaveBeenCalledWith(
      "project_1",
      ["kw_1", "kw_2"],
    );
  });

  it("does not claim a keyword whose duplicate insert was skipped", async () => {
    primeHappyPath();
    mocks.proposalsRepo.tryInsertProposal
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const { NetNewProposalsService } = await import("./NetNewProposalsService");

    const result =
      await NetNewProposalsService.computeNetNewProposals("project_1");

    expect(result.created).toBe(1);
    expect(mocks.selectionRepo.markBacklogProposed).toHaveBeenCalledWith(
      "project_1",
      ["kw_2"],
    );
  });

  it("reads no candidates at all when the quota is off", async () => {
    primeHappyPath();
    mocks.settingsRepo.getSettings.mockResolvedValue({
      postsPerDay: 2,
      catchupCap: 6,
      quotaStartDate: null,
    });
    const { NetNewProposalsService } = await import("./NetNewProposalsService");

    const result =
      await NetNewProposalsService.computeNetNewProposals("project_1");

    expect(result).toMatchObject({
      created: 0,
      owed: null,
      reason: "quota off — propose manually",
    });
    expect(mocks.selectionRepo.getPlannedCandidates).not.toHaveBeenCalled();
    expect(mocks.proposalsRepo.tryInsertProposal).not.toHaveBeenCalled();
  });

  it("falls back to the shipped defaults when the project has never saved settings", async () => {
    primeHappyPath();
    mocks.settingsRepo.getSettings.mockResolvedValue(null);
    const { NetNewProposalsService } = await import("./NetNewProposalsService");

    const result =
      await NetNewProposalsService.computeNetNewProposals("project_1");

    // Defaults leave quotaStartDate null, so the quota is off until the user
    // picks a date — never "two a day starting whenever they first looked".
    expect(result.owed).toBeNull();
    expect(result.created).toBe(0);
  });

  it("names the missing data source when every approved type is held back", async () => {
    primeHappyPath();
    mocks.selectionRepo.getPlannedCandidates.mockResolvedValue([
      { ...plannedRow, pageTypeKind: "pseo" as const },
    ]);
    const { NetNewProposalsService } = await import("./NetNewProposalsService");

    const result =
      await NetNewProposalsService.computeNetNewProposals("project_1");

    expect(result.created).toBe(0);
    expect(result.reason).toBe(
      "every approved page type is still waiting on a data source",
    );
    expect(result.exclusions).toEqual([
      {
        pageTypeId: "type_specs",
        pageTypeName: "Specs and data",
        keywordCount: 1,
        reason: "needs a data source — see the page plan",
      },
    ]);
  });

  it("reclaims keywords stranded by an expired proposal before it selects", async () => {
    primeHappyPath();
    mocks.proposalsRepo.expireStaleProposals.mockResolvedValue(2);
    mocks.selectionRepo.reclaimAbandonedBacklogRows.mockResolvedValue(2);
    const { NetNewProposalsService } = await import("./NetNewProposalsService");

    const result =
      await NetNewProposalsService.computeNetNewProposals("project_1");

    expect(result).toMatchObject({ expired: 2, reclaimed: 2 });
    const expireOrder =
      mocks.proposalsRepo.expireStaleProposals.mock.invocationCallOrder[0];
    const reclaimOrder =
      mocks.selectionRepo.reclaimAbandonedBacklogRows.mock
        .invocationCallOrder[0];
    expect(expireOrder).toBeLessThan(reclaimOrder);
  });
});

describe("NetNewProposalsService.getWritingQuota", () => {
  it("reports the quota without writing anything", async () => {
    primeHappyPath();
    mocks.selectionRepo.countOutstandingNetNew.mockResolvedValue(1);
    const { NetNewProposalsService } = await import("./NetNewProposalsService");

    const quota = await NetNewProposalsService.getWritingQuota("project_1");

    expect(quota).toMatchObject({ owed: 2, outstanding: 1, slots: 1 });
    expect(mocks.proposalsRepo.tryInsertProposal).not.toHaveBeenCalled();
    expect(mocks.selectionRepo.markBacklogProposed).not.toHaveBeenCalled();
    expect(
      mocks.selectionRepo.reclaimAbandonedBacklogRows,
    ).not.toHaveBeenCalled();
  });

  it("says the backlog is empty rather than leaving the header silent", async () => {
    primeHappyPath();
    mocks.selectionRepo.getPlannedCandidates.mockResolvedValue([]);
    const { NetNewProposalsService } = await import("./NetNewProposalsService");

    const quota = await NetNewProposalsService.getWritingQuota("project_1");

    expect(quota.reason).toBe(
      "no planned keywords are bound to an approved page type",
    );
  });
});
