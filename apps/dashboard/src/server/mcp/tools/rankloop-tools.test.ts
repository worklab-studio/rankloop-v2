import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PROJECT_ID,
  toolExtra,
  toolText as text,
  parsesAgainstOutputSchema,
} from "./rankloop-agent.fixture";

// The agent path's read tools (spec 0023), against seeded rows. Each one is
// checked for both halves of an MCP response: the structuredContent an agent
// parses and the text block a client that renders only text would show.

const mocks = vi.hoisted(() => ({
  getProjectForOrganization: vi.fn(),
  getWritingQuota: vi.fn(),
  getSettings: vi.fn(),
  agentRepo: {
    getApprovedNetNewProposals: vi.fn(),
    getPublishedArticleForProposal: vi.fn(),
    claimArticleForReport: vi.fn(),
    getArticleStatusCounts: vi.fn(),
    getProposalStatusCounts: vi.fn(),
    getSpendToDate: vi.fn(),
  },
  getReceipts: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: {
    getProjectForOrganization: mocks.getProjectForOrganization,
  },
}));
vi.mock(
  "@/server/features/rankloop/agent/repositories/AgentRepository",
  () => ({ AgentRepository: mocks.agentRepo }),
);
vi.mock(
  "@/server/features/rankloop/writing/services/NetNewProposalsService",
  () => ({
    NetNewProposalsService: { getWritingQuota: mocks.getWritingQuota },
  }),
);
vi.mock(
  "@/server/features/rankloop/writing/repositories/WriterSettingsRepository",
  () => ({ WriterSettingsRepository: { getSettings: mocks.getSettings } }),
);
vi.mock("@/server/features/rankloop/receipts/services/ReceiptsService", () => ({
  ReceiptsService: { getReceipts: mocks.getReceipts },
}));

const quota = {
  owed: 2,
  outstanding: 1,
  slots: 1,
  reason: null,
  throttle: null,
  exclusions: [],
};

beforeEach(() => {
  vi.resetModules();
  mocks.getProjectForOrganization.mockReset();
  mocks.getWritingQuota.mockReset();
  mocks.getSettings.mockReset();
  mocks.getReceipts.mockReset();
  for (const mock of Object.values(mocks.agentRepo)) mock.mockReset();

  mocks.getProjectForOrganization.mockResolvedValue({
    id: PROJECT_ID,
    locationCode: 2840,
    languageCode: "en",
  });
  mocks.getWritingQuota.mockResolvedValue(quota);
  mocks.getSettings.mockResolvedValue({ writerMode: "agent" });
  mocks.agentRepo.getArticleStatusCounts.mockResolvedValue({
    review: 3,
    published: 12,
  });
  mocks.agentRepo.getProposalStatusCounts.mockResolvedValue({ approved: 2 });
  mocks.agentRepo.getSpendToDate.mockResolvedValue(1.234);
  mocks.agentRepo.getApprovedNetNewProposals.mockResolvedValue([]);
  mocks.getReceipts.mockResolvedValue([]);
});

describe("rankloop_status", () => {
  it("reports the quota, the writer mode, the counts and the spend", async () => {
    const { rankloopStatusTool } = await import("./rankloop-tools");

    const result = await rankloopStatusTool.handler(
      { projectId: PROJECT_ID },
      toolExtra,
    );

    expect(result.structuredContent).toMatchObject({
      projectId: PROJECT_ID,
      writerMode: "agent",
      quota: { owed: 2, outstanding: 1, slots: 1 },
      articles: { review: 3, published: 12 },
      proposals: { approved: 2 },
      spendToDateUsd: 1.234,
    });
    const out = text(result);
    expect(out).toContain("Writer mode: agent");
    expect(out).toContain("Quota: 2 owed today, 1 in flight, 1 slot(s) open.");
    expect(out).toContain("Articles: published 12, review 3");
    expect(out).toContain("Spend to date: $1.23");
  });

  it("falls back to api mode when the project has never saved settings", async () => {
    mocks.getSettings.mockResolvedValue(null);
    const { rankloopStatusTool } = await import("./rankloop-tools");

    const result = await rankloopStatusTool.handler(
      { projectId: PROJECT_ID },
      toolExtra,
    );

    expect(result.structuredContent).toMatchObject({ writerMode: "api" });
  });

  it("states the indexation throttle and its reason, not just a smaller number", async () => {
    mocks.getWritingQuota.mockResolvedValue({
      ...quota,
      slots: 0,
      reason: "indexation is behind — net-new paused",
      throttle: { cap: 0, reason: "indexation is behind — net-new paused" },
      exclusions: [
        {
          pageTypeId: "type_1",
          pageTypeName: "Comparisons",
          keywordCount: 4,
          reason: "needs a data source — see the page plan",
        },
      ],
    });
    const { rankloopStatusTool } = await import("./rankloop-tools");

    const out = text(
      await rankloopStatusTool.handler({ projectId: PROJECT_ID }, toolExtra),
    );

    expect(out).toContain("Blocked: indexation is behind — net-new paused");
    expect(out).toContain("Indexation throttle: cap 0");
    expect(out).toContain("Held back: Comparisons (4 keyword(s))");
  });

  it("refuses a project outside the token's organization", async () => {
    mocks.getProjectForOrganization.mockResolvedValue(null);
    const { rankloopStatusTool } = await import("./rankloop-tools");

    await expect(
      rankloopStatusTool.handler({ projectId: "someone_elses" }, toolExtra),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("rankloop_proposals", () => {
  const row = {
    id: "proposal_1",
    target: "burr grinder retention",
    title: "Burr grinder retention",
    score: 42.5,
    pageTypeId: "type_1",
    pageTypeName: "Guides",
    pageTypeUrlPattern: "/blog/{slug}/",
    factorsJson: null,
    evidenceJson: JSON.stringify(["Guides", "harvested question"]),
    createdAt: "2026-07-01T00:00:00.000Z",
    expiresAt: "2026-07-15T00:00:00.000Z",
    articleId: null,
    articleStatus: null,
    articleWriterMode: null,
  };

  it("renders every approved proposal with its evidence and page type", async () => {
    mocks.agentRepo.getApprovedNetNewProposals.mockResolvedValue([row]);
    const { rankloopProposalsTool } = await import("./rankloop-tools");

    const result = await rankloopProposalsTool.handler(
      { projectId: PROJECT_ID },
      toolExtra,
    );

    expect(result.structuredContent?.proposals).toEqual([
      {
        proposalId: "proposal_1",
        keyword: "burr grinder retention",
        workingTitle: "Burr grinder retention",
        score: 42.5,
        pageTypeId: "type_1",
        pageTypeName: "Guides",
        urlPattern: "/blog/{slug}/",
        evidence: ["Guides", "harvested question"],
        createdAt: "2026-07-01T00:00:00.000Z",
        expiresAt: "2026-07-15T00:00:00.000Z",
        article: null,
      },
    ]);
    const out = text(result);
    expect(out).toContain(
      "proposal | keyword | page type | score | article | evidence",
    );
    expect(out).toContain(
      "proposal_1 | burr grinder retention | Guides | 42.50 | — | Guides; harvested question",
    );
  });

  it("carries the in-flight article so an agent does not write a second draft", async () => {
    mocks.agentRepo.getApprovedNetNewProposals.mockResolvedValue([
      {
        ...row,
        articleId: "article_1",
        articleStatus: "review",
        articleWriterMode: "api",
      },
    ]);
    const { rankloopProposalsTool } = await import("./rankloop-tools");

    const result = await rankloopProposalsTool.handler(
      { projectId: PROJECT_ID },
      toolExtra,
    );

    expect(result.structuredContent?.proposals).toMatchObject([
      { article: { id: "article_1", status: "review", writerMode: "api" } },
    ]);
    expect(text(result)).toContain("| review |");
  });

  it("degrades a malformed evidence column to no chips rather than failing the queue", async () => {
    mocks.agentRepo.getApprovedNetNewProposals.mockResolvedValue([
      { ...row, evidenceJson: "{not json" },
    ]);
    const { rankloopProposalsTool } = await import("./rankloop-tools");

    const result = await rankloopProposalsTool.handler(
      { projectId: PROJECT_ID },
      toolExtra,
    );

    expect(result.structuredContent?.proposals).toMatchObject([
      { evidence: [] },
    ]);
  });

  it("says why an empty queue is empty", async () => {
    const { rankloopProposalsTool } = await import("./rankloop-tools");

    const out = text(
      await rankloopProposalsTool.handler({ projectId: PROJECT_ID }, toolExtra),
    );

    expect(out).toContain("No approved proposals are waiting");
  });
});

describe("rankloop_receipts", () => {
  const measured = {
    id: "receipt_1",
    projectId: PROJECT_ID,
    actionType: "write_new",
    status: "measured",
    target: "/blog/burr-grinder-retention/",
    createdAt: "2026-06-01T00:00:00.000Z",
    baseline: null,
    result: { clicksDelta: 31, adjustedClicksDelta: 27 },
  };
  const open = {
    ...measured,
    id: "receipt_2",
    status: "baseline",
    target: "/blog/descaling/",
    result: null,
  };

  it("renders each receipt's deltas in the text table", async () => {
    mocks.getReceipts.mockResolvedValue([measured, open]);
    const { rankloopReceiptsTool } = await import("./rankloop-tools");

    const result = await rankloopReceiptsTool.handler(
      { projectId: PROJECT_ID },
      toolExtra,
    );

    expect(result.structuredContent?.totalCount).toBe(2);
    const out = text(result);
    expect(out).toContain(
      "target | action | status | opened | clicks Δ | adjusted Δ",
    );
    expect(out).toContain(
      "/blog/burr-grinder-retention/ | write_new | measured | 2026-06-01 | 31 | 27",
    );
    // An open receipt still lists, with em dashes where there is no number yet.
    expect(out).toContain("/blog/descaling/ | write_new | baseline");
  });

  it("drops receipts whose window has not closed when measuredOnly is set", async () => {
    mocks.getReceipts.mockResolvedValue([measured, open]);
    const { rankloopReceiptsTool } = await import("./rankloop-tools");

    const result = await rankloopReceiptsTool.handler(
      { projectId: PROJECT_ID, measuredOnly: true },
      toolExtra,
    );

    expect(result.structuredContent).toMatchObject({ totalCount: 1 });
    expect(text(result)).not.toContain("/blog/descaling/");
  });

  it("caps the response and reports what it capped", async () => {
    mocks.getReceipts.mockResolvedValue([measured, open]);
    const { rankloopReceiptsTool } = await import("./rankloop-tools");

    const result = await rankloopReceiptsTool.handler(
      { projectId: PROJECT_ID, limit: 1 },
      toolExtra,
    );

    expect(text(result)).toContain("Receipts (1 of 2)");
  });
});

describe("the read tools' output schemas", () => {
  it("accept the payloads their own handlers produce", async () => {
    mocks.getWritingQuota.mockResolvedValue({
      ...quota,
      throttle: { cap: 1, reason: "indexation is behind" },
      exclusions: [
        {
          pageTypeId: "type_1",
          pageTypeName: "Comparisons",
          keywordCount: 4,
          reason: "needs a data source — see the page plan",
        },
      ],
    });
    mocks.agentRepo.getApprovedNetNewProposals.mockResolvedValue([
      {
        id: "proposal_1",
        target: "burr grinder retention",
        title: null,
        score: 42.5,
        pageTypeId: null,
        pageTypeName: null,
        pageTypeUrlPattern: null,
        factorsJson: null,
        evidenceJson: null,
        createdAt: "2026-07-01T00:00:00.000Z",
        expiresAt: null,
        articleId: null,
        articleStatus: null,
        articleWriterMode: null,
      },
    ]);
    mocks.getReceipts.mockResolvedValue([
      {
        id: "receipt_1",
        projectId: PROJECT_ID,
        actionType: "write_new",
        status: "measured",
        target: "/blog/x/",
        createdAt: "2026-06-01T00:00:00.000Z",
        baseline: null,
        result: { clicksDelta: 3, adjustedClicksDelta: 2 },
      },
    ]);
    const { rankloopProposalsTool, rankloopReceiptsTool, rankloopStatusTool } =
      await import("./rankloop-tools");

    for (const tool of [
      rankloopStatusTool,
      rankloopProposalsTool,
      rankloopReceiptsTool,
    ]) {
      const result = await tool.handler({ projectId: PROJECT_ID }, toolExtra);
      expect(
        await parsesAgainstOutputSchema(tool.config.outputSchema, result),
        `${tool.name} output schema`,
      ).toBe(true);
    }
  });
});
