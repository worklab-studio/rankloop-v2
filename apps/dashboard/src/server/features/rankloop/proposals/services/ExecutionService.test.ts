import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReceiptInsert } from "@/server/features/rankloop/proposals/repositories/ExecutionRepository";
import { AppError } from "@/server/lib/errors";

type MarkDoneInput = {
  projectId: string;
  proposalId: string;
  executedAt: string;
  receipt: ReceiptInsert;
  retitle?: { contentPageId: string; title: string };
};

type OpenReceiptInput = {
  projectId: string;
  actionType: string;
  contentPageId: string;
  targetQuery: string | null;
  executedAt: string;
};

// Typed so the transition assertions below can read `.mock.calls` without
// unsafe casts.
const mocks = vi.hoisted(() => ({
  proposalsRepo: {
    getProposalById: vi.fn(),
    getProposalsForProject: vi.fn(),
    updateDecision: vi.fn(),
    expireStaleProposals: vi.fn(),
    tryInsertProposal: vi.fn(),
    getDailyPageQueryRows: vi.fn(),
    getDailyPageTotals: vi.fn(),
    getEarliestStoredDate: vi.fn(),
    getContentPagesForSignals: vi.fn(),
    getRecentDecisions: vi.fn(),
  },
  executionRepo: {
    getContentPageById: vi.fn(),
    getInlinkSourcePages: vi.fn(),
    markDoneWithReceipt: vi.fn<(input: MarkDoneInput) => Promise<void>>(),
  },
  receiptsService: {
    openReceipt: vi.fn<(input: OpenReceiptInput) => Promise<ReceiptInsert>>(),
    runMeasurementPass: vi.fn(),
    getReceipts: vi.fn(),
  },
  publishService: {
    getDecryptedConfig: vi.fn(),
    getMaskedConnection: vi.fn(),
    saveConnection: vi.fn(),
    testConnection: vi.fn(),
  },
  wp: {
    testConnection: vi.fn(),
    findPostBySlug: vi.fn(),
    updatePost: vi.fn(),
  },
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock(
  "@/server/features/rankloop/proposals/repositories/ProposalsRepository",
  () => ({ ProposalsRepository: mocks.proposalsRepo }),
);
vi.mock(
  "@/server/features/rankloop/proposals/repositories/ExecutionRepository",
  () => ({ ExecutionRepository: mocks.executionRepo }),
);
vi.mock("@/server/features/rankloop/receipts/services/ReceiptsService", () => ({
  ReceiptsService: mocks.receiptsService,
}));
vi.mock(
  "@/server/features/rankloop/publish/services/PublishConnectionService",
  () => ({ PublishConnectionService: mocks.publishService }),
);
vi.mock("@/server/features/rankloop/publish/services/wordpressClient", () => ({
  WordPressClient: mocks.wp,
}));

const wordpressConfig = {
  baseUrl: "https://acme.com",
  username: "beans",
  applicationPassword: "abcd efgh",
};

const approvedRetitle = {
  id: "prop_1",
  projectId: "project_1",
  type: "retitle",
  status: "approved",
  target: "/blog/best-espresso-tampers/",
  title: 'Rewrite the title for "best espresso tampers"',
  contentPageId: "cp_1",
};

const approvedPush = {
  ...approvedRetitle,
  id: "prop_2",
  type: "push",
  title: 'Push "espresso tamper size" from position 11.2',
};

const page = {
  id: "cp_1",
  url: "https://acme.com/blog/best-espresso-tampers/",
  path: "/blog/best-espresso-tampers/",
  title: "Old title",
  description: "Old description",
  category: "gear",
};

const openedReceipt: ReceiptInsert = {
  id: "receipt_1",
  projectId: "project_1",
  actionType: "retitle",
  contentPageId: "cp_1",
  targetQuery: "best espresso tampers",
  status: "baseline",
  baselineJson: '{"clicks":40}',
  windowStart: "2026-08-14",
  windowEnd: "2026-09-11",
  createdAt: "2026-07-31T12:00:00.000Z",
};

function primeExecuteHappyPath() {
  mocks.proposalsRepo.getProposalById.mockResolvedValue(approvedRetitle);
  mocks.executionRepo.getContentPageById.mockResolvedValue(page);
  mocks.publishService.getDecryptedConfig.mockResolvedValue(wordpressConfig);
  mocks.wp.findPostBySlug.mockResolvedValue({
    id: 42,
    slug: "best-espresso-tampers",
    title: "Old title",
    metaDescriptionField: "rank_math_description",
    metaDescription: null,
  });
  mocks.wp.updatePost.mockResolvedValue({ metaDescriptionApplied: true });
  mocks.receiptsService.openReceipt.mockResolvedValue(openedReceipt);
  mocks.executionRepo.markDoneWithReceipt.mockResolvedValue(undefined);
}

function lastMarkDone(): MarkDoneInput {
  const call = mocks.executionRepo.markDoneWithReceipt.mock.calls.at(-1)?.[0];
  if (!call) throw new Error("expected a markDoneWithReceipt call");
  return call;
}

// No vi.resetModules here: the mocked AppError-throwing paths assert with
// instanceof inside the service, which only holds while the test file and
// the service resolve @/server/lib/errors to the same module instance.
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-31T12:00:00Z"));
  for (const group of Object.values(mocks)) {
    for (const mock of Object.values(group)) mock.mockReset();
  }
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ExecutionService.executeRetitleProposal", () => {
  it("updates WordPress, then commits done + manifest title + receipt in one write set", async () => {
    primeExecuteHappyPath();
    const { ExecutionService } = await import("./ExecutionService");

    const result = await ExecutionService.executeRetitleProposal({
      projectId: "project_1",
      proposalId: "prop_1",
      newTitle: "The Best Espresso Tampers, Ranked",
      newMetaDescription: "Every tamper we tested.",
    });

    expect(result.metaDescriptionApplied).toBe(true);
    expect(mocks.wp.findPostBySlug).toHaveBeenCalledWith(
      wordpressConfig,
      "best-espresso-tampers",
    );
    expect(mocks.wp.updatePost).toHaveBeenCalledWith(wordpressConfig, {
      postId: 42,
      title: "The Best Espresso Tampers, Ranked",
      metaDescription: "Every tamper we tested.",
      metaDescriptionField: "rank_math_description",
    });

    // The receipt opens against the executed proposal's page and headline
    // query, stamped with the same instant the proposal transition records.
    expect(mocks.receiptsService.openReceipt).toHaveBeenCalledWith({
      projectId: "project_1",
      actionType: "retitle",
      contentPageId: "cp_1",
      targetQuery: "best espresso tampers",
      executedAt: "2026-07-31T12:00:00.000Z",
    });

    expect(mocks.executionRepo.markDoneWithReceipt).toHaveBeenCalledTimes(1);
    const commit = lastMarkDone();
    expect(commit.proposalId).toBe("prop_1");
    expect(commit.executedAt).toBe("2026-07-31T12:00:00.000Z");
    expect(commit.retitle).toEqual({
      contentPageId: "cp_1",
      title: "The Best Espresso Tampers, Ranked",
    });
    // The opened receipt row rides into the batch untouched.
    expect(commit.receipt).toBe(openedReceipt);
  });

  it("refuses any status but 'approved' before touching the adapter", async () => {
    primeExecuteHappyPath();
    mocks.proposalsRepo.getProposalById.mockResolvedValue({
      ...approvedRetitle,
      status: "proposed",
    });
    const { ExecutionService } = await import("./ExecutionService");

    await expect(
      ExecutionService.executeRetitleProposal({
        projectId: "project_1",
        proposalId: "prop_1",
        newTitle: "New",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(mocks.wp.updatePost).not.toHaveBeenCalled();
    expect(mocks.executionRepo.markDoneWithReceipt).not.toHaveBeenCalled();
  });

  it("leaves the proposal approved when the adapter write fails", async () => {
    primeExecuteHappyPath();
    mocks.wp.updatePost.mockRejectedValue(
      new AppError("PUBLISH_AUTH_FAILED", "WordPress returned 401."),
    );
    const { ExecutionService } = await import("./ExecutionService");

    await expect(
      ExecutionService.executeRetitleProposal({
        projectId: "project_1",
        proposalId: "prop_1",
        newTitle: "New",
      }),
    ).rejects.toMatchObject({ code: "PUBLISH_AUTH_FAILED" });
    // No row was touched — the user fixes credentials and retries.
    expect(mocks.receiptsService.openReceipt).not.toHaveBeenCalled();
    expect(mocks.executionRepo.markDoneWithReceipt).not.toHaveBeenCalled();
  });

  it("requires a publish connection", async () => {
    primeExecuteHappyPath();
    mocks.publishService.getDecryptedConfig.mockResolvedValue(null);
    const { ExecutionService } = await import("./ExecutionService");

    await expect(
      ExecutionService.executeRetitleProposal({
        projectId: "project_1",
        proposalId: "prop_1",
        newTitle: "New",
      }),
    ).rejects.toMatchObject({ code: "PUBLISH_NOT_CONNECTED" });
  });

  it("fails cleanly when no WordPress post matches the slug", async () => {
    primeExecuteHappyPath();
    mocks.wp.findPostBySlug.mockResolvedValue(null);
    const { ExecutionService } = await import("./ExecutionService");

    await expect(
      ExecutionService.executeRetitleProposal({
        projectId: "project_1",
        proposalId: "prop_1",
        newTitle: "New",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(mocks.executionRepo.markDoneWithReceipt).not.toHaveBeenCalled();
  });
});

describe("ExecutionService attestation", () => {
  it("attestPushProposal flips the proposal and opens a push receipt, no manifest write", async () => {
    primeExecuteHappyPath();
    mocks.proposalsRepo.getProposalById.mockResolvedValue(approvedPush);
    const { ExecutionService } = await import("./ExecutionService");

    const result = await ExecutionService.attestPushProposal({
      projectId: "project_1",
      proposalId: "prop_2",
    });

    expect(result).toEqual({
      id: "prop_2",
      type: "push",
      target: "/blog/best-espresso-tampers/",
    });
    expect(mocks.receiptsService.openReceipt).toHaveBeenCalledWith({
      projectId: "project_1",
      actionType: "push",
      contentPageId: "cp_1",
      targetQuery: "espresso tamper size",
      executedAt: "2026-07-31T12:00:00.000Z",
    });
    const commit = lastMarkDone();
    expect(commit.retitle).toBeUndefined();
    expect(commit.receipt).toBe(openedReceipt);
    // The adapter is never involved in an attestation.
    expect(mocks.wp.updatePost).not.toHaveBeenCalled();
  });

  it("attestRetitleProposal (manual apply) opens the receipt without updating the manifest title", async () => {
    primeExecuteHappyPath();
    const { ExecutionService } = await import("./ExecutionService");

    await ExecutionService.attestRetitleProposal({
      projectId: "project_1",
      proposalId: "prop_1",
    });

    const commit = lastMarkDone();
    expect(commit.retitle).toBeUndefined();
    expect(mocks.receiptsService.openReceipt).toHaveBeenCalledWith(
      expect.objectContaining({ actionType: "retitle" }),
    );
  });

  it("rejects an attestation against the wrong proposal type", async () => {
    primeExecuteHappyPath();
    mocks.proposalsRepo.getProposalById.mockResolvedValue(approvedPush);
    const { ExecutionService } = await import("./ExecutionService");

    await expect(
      ExecutionService.attestRetitleProposal({
        projectId: "project_1",
        proposalId: "prop_2",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(mocks.receiptsService.openReceipt).not.toHaveBeenCalled();
  });

  it("rejects a proposal that lost its content page pointer", async () => {
    primeExecuteHappyPath();
    mocks.proposalsRepo.getProposalById.mockResolvedValue({
      ...approvedPush,
      contentPageId: null,
    });
    const { ExecutionService } = await import("./ExecutionService");

    await expect(
      ExecutionService.attestPushProposal({
        projectId: "project_1",
        proposalId: "prop_2",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});

describe("ExecutionService.getPushGuidance", () => {
  it("returns the anchor query and the scored inlink candidates", async () => {
    primeExecuteHappyPath();
    mocks.proposalsRepo.getProposalById.mockResolvedValue(approvedPush);
    mocks.executionRepo.getInlinkSourcePages.mockResolvedValue([
      { path: "/blog/best-espresso-grinders/", title: "G", category: "gear" },
      { path: "/blog/decaf-myths/", title: "D", category: "science" },
    ]);
    const { ExecutionService } = await import("./ExecutionService");

    const guidance = await ExecutionService.getPushGuidance({
      projectId: "project_1",
      proposalId: "prop_2",
    });

    expect(guidance.anchorQuery).toBe("espresso tamper size");
    expect(guidance.candidates.map((c) => c.path)).toEqual([
      "/blog/best-espresso-grinders/",
    ]);
  });
});

describe("ExecutionService.getRetitleContext", () => {
  it("prefers the live WordPress title when connected", async () => {
    primeExecuteHappyPath();
    mocks.wp.findPostBySlug.mockResolvedValue({
      id: 42,
      slug: "best-espresso-tampers",
      title: "Live title",
      metaDescriptionField: null,
      metaDescription: "Live description",
    });
    const { ExecutionService } = await import("./ExecutionService");

    const context = await ExecutionService.getRetitleContext({
      projectId: "project_1",
      proposalId: "prop_1",
    });

    expect(context).toEqual({
      path: "/blog/best-espresso-tampers/",
      currentTitle: "Live title",
      currentDescription: "Live description",
      source: "wordpress",
      connected: true,
    });
  });

  it("falls back to the manifest title when the adapter errors — the modal must open", async () => {
    primeExecuteHappyPath();
    mocks.wp.findPostBySlug.mockRejectedValue(
      new AppError("PUBLISH_UNREACHABLE", "Could not reach the site."),
    );
    const { ExecutionService } = await import("./ExecutionService");

    const context = await ExecutionService.getRetitleContext({
      projectId: "project_1",
      proposalId: "prop_1",
    });

    expect(context.currentTitle).toBe("Old title");
    expect(context.currentDescription).toBe("Old description");
    expect(context.source).toBe("manifest");
  });
});
