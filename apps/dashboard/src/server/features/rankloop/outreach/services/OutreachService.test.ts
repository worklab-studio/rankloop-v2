import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OutreachTargetUpsert } from "../repositories/OutreachRepository";

const mocks = vi.hoisted(() => ({
  workersEnv: { DATAFORSEO_API_KEY: "key" } as Record<string, string>,
  repo: {
    listGapSourceRows: vi.fn(),
    countGapSourceRows: vi.fn(),
    countTrackedCompetitors: vi.fn(),
    listAssetPages: vi.fn(),
    listTargets: vi.fn(),
    listTargetStates: vi.fn(),
    upsertTargets:
      vi.fn<(rows: OutreachTargetUpsert[], now: string) => Promise<void>>(),
    setTargetsStale:
      vi.fn<
        (
          projectId: string,
          ids: string[],
          staleAsOf: string | null,
        ) => Promise<void>
      >(),
    deleteTargets: vi.fn<(projectId: string, ids: string[]) => Promise<void>>(),
    updateTargetStatus:
      vi.fn<
        (input: {
          projectId: string;
          targetId: string;
          status: string;
          updatedAt: string;
        }) => Promise<string[]>
      >(),
    updateTargetDraft: vi.fn(),
  },
  projectRepo: {
    getProjectById: vi.fn(),
  },
  backlinks: {
    profileReferringDomainsPage: vi.fn(),
  },
}));

vi.mock("cloudflare:workers", () => ({ env: mocks.workersEnv }));
vi.mock(
  "@/server/features/rankloop/outreach/repositories/OutreachRepository",
  () => ({ OutreachRepository: mocks.repo }),
);
vi.mock("@/server/features/projects/repositories/ProjectRepository", () => ({
  ProjectRepository: mocks.projectRepo,
}));
vi.mock("@/server/features/backlinks/services/BacklinksService", () => ({
  BacklinksService: mocks.backlinks,
}));

function sourceRow(competitorId: string, domain: string) {
  return {
    competitorId,
    competitorDomain: `${competitorId}.example`,
    domain,
    domainRank: 40,
    backlinks: 2,
  };
}

/** The minimum that makes one target: two competitors linking to one domain. */
function twoCompetitorGap(domain = "espresso-journal.example") {
  return [sourceRow("comp_1", domain), sourceRow("comp_2", domain)];
}

beforeEach(() => {
  vi.resetModules();
  mocks.workersEnv.DATAFORSEO_API_KEY = "key";
  for (const group of [mocks.repo, mocks.projectRepo, mocks.backlinks]) {
    for (const mock of Object.values(group)) mock.mockReset();
  }
  mocks.projectRepo.getProjectById.mockResolvedValue({
    id: "project_1",
    name: "Our Site",
    domain: "our-site.example",
    organizationId: "org_1",
  });
  mocks.repo.listGapSourceRows.mockResolvedValue([]);
  mocks.repo.listAssetPages.mockResolvedValue([]);
  mocks.repo.listTargetStates.mockResolvedValue([]);
  mocks.repo.upsertTargets.mockResolvedValue(undefined);
  mocks.repo.setTargetsStale.mockResolvedValue(undefined);
  mocks.repo.deleteTargets.mockResolvedValue(undefined);
  mocks.backlinks.profileReferringDomainsPage.mockResolvedValue({ rows: [] });
});

async function service() {
  const { OutreachService } = await import("./OutreachService");
  return OutreachService;
}

describe("OutreachService.recomputeTargets", () => {
  it("writes a target with its evidence, matched asset and first draft", async () => {
    mocks.repo.listGapSourceRows.mockResolvedValue(twoCompetitorGap());
    mocks.repo.listAssetPages.mockResolvedValue([
      {
        id: "page_1",
        url: "https://our-site.example/blog/espresso-tamper-guide",
        path: "/blog/espresso-tamper-guide",
        title: "How to choose an espresso tamper",
      },
    ]);

    const result = await (
      await service()
    ).recomputeTargets({
      projectId: "project_1",
    });

    expect(result).toEqual({ targets: 1 });
    const [rows] = mocks.repo.upsertTargets.mock.calls[0];
    expect(rows[0].domain).toBe("espresso-journal.example");
    expect(rows[0].competitorCount).toBe(2);
    expect(rows[0].matchedAssetPageId).toBe("page_1");
    expect(rows[0].templateKind).toBe("resource_page");
    expect(rows[0].draftMessage).toContain("espresso-journal.example");
    expect(JSON.parse(rows[0].evidenceJson)).toHaveLength(2);
  });

  it("lists a target with no matching asset rather than dropping it", async () => {
    mocks.repo.listGapSourceRows.mockResolvedValue(twoCompetitorGap());
    mocks.repo.listAssetPages.mockResolvedValue([
      {
        id: "page_1",
        url: "https://our-site.example/pricing",
        path: "/pricing",
        title: "Pricing",
      },
    ]);

    await (await service()).recomputeTargets({ projectId: "project_1" });

    const [rows] = mocks.repo.upsertTargets.mock.calls[0];
    expect(rows).toHaveLength(1);
    expect(rows[0].matchedAssetPageId).toBeNull();
    expect(rows[0].matchTypeJson).toBeNull();
    expect(rows[0].templateKind).toBeNull();
    expect(rows[0].draftMessage).toBeNull();
  });

  it("never carries a human-owned column into the write, and leaves a stored draft alone", async () => {
    mocks.repo.listGapSourceRows.mockResolvedValue(twoCompetitorGap());
    mocks.repo.listAssetPages.mockResolvedValue([
      {
        id: "page_1",
        url: "https://our-site.example/blog/espresso-tamper-guide",
        path: "/blog/espresso-tamper-guide",
        title: "How to choose an espresso tamper",
      },
    ]);
    mocks.repo.listTargetStates.mockResolvedValue([
      {
        id: "target_1",
        domain: "espresso-journal.example",
        status: "replied",
        notes: "asked me to follow up in March",
        draftMessage: "my own words",
        staleAsOf: null,
      },
    ]);

    await (await service()).recomputeTargets({ projectId: "project_1" });

    const [rows] = mocks.repo.upsertTargets.mock.calls[0];
    // A null draft is the signal to the repository that this row keeps the
    // one it already has.
    expect(rows[0].draftMessage).toBeNull();
    expect(Object.keys(rows[0])).not.toContain("status");
    expect(Object.keys(rows[0])).not.toContain("notes");
    expect(Object.keys(rows[0])).not.toContain("contactUrl");
    // The row a human replied to is still in the gap, so nothing is swept.
    expect(mocks.repo.deleteTargets).toHaveBeenCalledWith("project_1", []);
  });

  it("sweeps targets that left the gap only while nobody has touched them", async () => {
    mocks.repo.listGapSourceRows.mockResolvedValue(twoCompetitorGap());
    mocks.repo.listTargetStates.mockResolvedValue([
      {
        id: "target_untouched",
        domain: "gone.example",
        status: "to_contact",
        notes: null,
        draftMessage: null,
        staleAsOf: null,
      },
      {
        id: "target_contacted",
        domain: "also-gone.example",
        status: "sent",
        notes: null,
        draftMessage: null,
        staleAsOf: null,
      },
      {
        id: "target_annotated",
        domain: "noted.example",
        status: "to_contact",
        notes: "editor said try again in Q4",
        draftMessage: null,
        staleAsOf: null,
      },
    ]);

    await (await service()).recomputeTargets({ projectId: "project_1" });

    expect(mocks.repo.deleteTargets).toHaveBeenCalledWith("project_1", [
      "target_untouched",
    ]);
  });

  it("stamps a human-owned target that left the gap instead of freezing its computed columns", async () => {
    mocks.repo.listGapSourceRows.mockResolvedValue(twoCompetitorGap());
    mocks.repo.listTargetStates.mockResolvedValue([
      {
        id: "target_contacted",
        domain: "also-gone.example",
        status: "sent",
        notes: null,
        draftMessage: null,
        staleAsOf: null,
      },
      {
        id: "target_annotated",
        domain: "noted.example",
        status: "to_contact",
        notes: "editor said try again in Q4",
        draftMessage: null,
        staleAsOf: null,
      },
      // Already stamped by an earlier refresh and still absent: the date it
      // left the gap must not move.
      {
        id: "target_long_gone",
        domain: "old-news.example",
        status: "declined",
        notes: null,
        draftMessage: null,
        staleAsOf: "2026-01-04T00:00:00.000Z",
      },
    ]);

    await (await service()).recomputeTargets({ projectId: "project_1" });

    const [projectId, ids, staleAsOf] =
      mocks.repo.setTargetsStale.mock.calls[0];
    expect(projectId).toBe("project_1");
    expect(ids).toEqual(["target_contacted", "target_annotated"]);
    expect(Number.isNaN(Date.parse(staleAsOf ?? ""))).toBe(false);
    // The human's work is the record; nothing they touched is deleted.
    expect(mocks.repo.deleteTargets).toHaveBeenCalledWith("project_1", []);
  });

  it("clears the stamp on a target whose domain is back in the gap", async () => {
    mocks.repo.listGapSourceRows.mockResolvedValue(twoCompetitorGap());
    mocks.repo.listTargetStates.mockResolvedValue([
      {
        id: "target_returned",
        domain: "espresso-journal.example",
        status: "sent",
        notes: null,
        draftMessage: null,
        staleAsOf: "2026-01-04T00:00:00.000Z",
      },
    ]);

    await (await service()).recomputeTargets({ projectId: "project_1" });

    expect(mocks.repo.setTargetsStale).toHaveBeenCalledWith(
      "project_1",
      ["target_returned"],
      null,
    );
    // Its computed columns are rewritten in the same pass, which is the whole
    // reason the stamp can come off.
    const [rows] = mocks.repo.upsertTargets.mock.calls[0];
    expect(rows[0].domain).toBe("espresso-journal.example");
    expect(rows[0].competitorCount).toBe(2);
  });

  it("subtracts the domains that already link to us", async () => {
    mocks.repo.listGapSourceRows.mockResolvedValue(twoCompetitorGap());
    mocks.backlinks.profileReferringDomainsPage.mockResolvedValue({
      rows: [{ domain: "espresso-journal.example" }],
    });

    await (await service()).recomputeTargets({ projectId: "project_1" });

    expect(mocks.repo.upsertTargets.mock.calls[0][0]).toEqual([]);
  });

  it("computes the gap keyless instead of refusing to, and pays for nothing", async () => {
    mocks.workersEnv.DATAFORSEO_API_KEY = "";
    mocks.repo.listGapSourceRows.mockResolvedValue(twoCompetitorGap());

    const result = await (
      await service()
    ).recomputeTargets({
      projectId: "project_1",
    });

    expect(mocks.backlinks.profileReferringDomainsPage).not.toHaveBeenCalled();
    expect(result).toEqual({ targets: 1 });
  });

  it("keeps the gap when our own backlinks read fails", async () => {
    mocks.repo.listGapSourceRows.mockResolvedValue(twoCompetitorGap());
    mocks.backlinks.profileReferringDomainsPage.mockRejectedValue(
      new Error("DataForSEO auth failed"),
    );

    const result = await (
      await service()
    ).recomputeTargets({
      projectId: "project_1",
    });

    expect(result).toEqual({ targets: 1 });
  });

  it("does nothing for a project that has since been archived", async () => {
    mocks.projectRepo.getProjectById.mockResolvedValue(null);

    const result = await (
      await service()
    ).recomputeTargets({
      projectId: "project_1",
    });

    expect(result).toEqual({ targets: 0 });
    expect(mocks.repo.upsertTargets).not.toHaveBeenCalled();
  });
});

describe("OutreachService human-owned writes", () => {
  it("rejects a status change for a target in another project", async () => {
    mocks.repo.updateTargetStatus.mockResolvedValue([]);

    await expect(
      (await service()).updateStatus({
        projectId: "project_1",
        targetId: "target_1",
        status: "sent",
      }),
    ).rejects.toThrow("Outreach target not found");
  });

  it("rejects a draft save for a target in another project", async () => {
    mocks.repo.updateTargetDraft.mockResolvedValue([]);

    await expect(
      (await service()).saveDraft({
        projectId: "project_1",
        targetId: "target_1",
        draftMessage: "hello",
      }),
    ).rejects.toThrow("Outreach target not found");
  });

  it("stamps updatedAt on the row it moves", async () => {
    mocks.repo.updateTargetStatus.mockResolvedValue(["target_1"]);

    await (
      await service()
    ).updateStatus({
      projectId: "project_1",
      targetId: "target_1",
      status: "linked",
    });

    const [written] = mocks.repo.updateTargetStatus.mock.calls[0];
    expect(written).toMatchObject({
      projectId: "project_1",
      targetId: "target_1",
      status: "linked",
    });
    expect(Number.isNaN(Date.parse(written.updatedAt))).toBe(false);
  });
});

describe("OutreachService.getOutreach", () => {
  it("parses the stored JSON columns and carries the asset through", async () => {
    mocks.repo.countTrackedCompetitors.mockResolvedValue(2);
    mocks.repo.countGapSourceRows.mockResolvedValue(340);
    mocks.repo.listTargets.mockResolvedValue([
      {
        target: {
          id: "target_1",
          domain: "espresso-journal.example",
          evidenceJson: JSON.stringify([
            {
              competitorId: "comp_1",
              competitorDomain: "rival-one.example",
              backlinks: 2,
              targetUrl: null,
              anchor: null,
            },
          ]),
          matchTypeJson: JSON.stringify({
            reason: "domain_tokens",
            shape: "guide",
            tokens: ["espresso"],
          }),
        },
        assetPath: "/blog/espresso-tamper-guide",
        assetUrl: "https://our-site.example/blog/espresso-tamper-guide",
        assetTitle: "How to choose an espresso tamper",
      },
    ]);

    const payload = await (await service()).getOutreach("project_1");

    expect(payload.trackedCompetitors).toBe(2);
    expect(payload.linkDomainsKnown).toBe(340);
    expect(payload.targets[0].evidence[0].competitorDomain).toBe(
      "rival-one.example",
    );
    expect(payload.targets[0].matchType?.tokens).toEqual(["espresso"]);
    expect(payload.targets[0].assetPath).toBe("/blog/espresso-tamper-guide");
  });

  it("degrades an unreadable evidence column to an empty list", async () => {
    mocks.repo.countTrackedCompetitors.mockResolvedValue(1);
    mocks.repo.countGapSourceRows.mockResolvedValue(0);
    mocks.repo.listTargets.mockResolvedValue([
      {
        target: {
          id: "target_1",
          domain: "espresso-journal.example",
          evidenceJson: "{ not json",
          matchTypeJson: null,
        },
        assetPath: null,
        assetUrl: null,
        assetTitle: null,
      },
    ]);

    const payload = await (await service()).getOutreach("project_1");

    expect(payload.targets[0].evidence).toEqual([]);
    expect(payload.targets[0].matchType).toBeNull();
  });
});
