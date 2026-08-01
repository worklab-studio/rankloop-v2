import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrustDial } from "@/shared/rankloop-writer";

// The unattended run, with every collaborator mocked: what it decides, what it
// refuses, and — the point of spec 0025 — that nothing it decides is missing
// `decidedBy: 'autopilot'`.

const mocks = vi.hoisted(() => ({
  autopilot: {
    reconcile: vi.fn(),
    getStatus: vi.fn(),
  },
  repo: {
    countCommittedNetNew: vi.fn(),
    getWritableNetNewProposals: vi.fn(),
    getReviewArticles: vi.fn(),
  },
  proposals: {
    getProposals: vi.fn(),
    decideProposal: vi.fn(),
  },
  netNew: {
    getWritingQuota: vi.fn(),
  },
  writer: {
    hasWriterProvider: vi.fn(),
  },
  write: {
    startArticle: vi.fn(),
  },
  publish: {
    startPublish: vi.fn(),
  },
  connection: {
    getForProject: vi.fn(),
  },
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock(
  "@/server/features/rankloop/routines/services/AutopilotService",
  () => ({ AutopilotService: mocks.autopilot }),
);
vi.mock(
  "@/server/features/rankloop/routines/repositories/AutopilotRepository",
  () => ({ AutopilotRepository: mocks.repo }),
);
vi.mock(
  "@/server/features/rankloop/proposals/services/ProposalsService",
  () => ({
    ProposalsService: mocks.proposals,
  }),
);
vi.mock(
  "@/server/features/rankloop/writing/services/NetNewProposalsService",
  () => ({ NetNewProposalsService: mocks.netNew }),
);
vi.mock("@/server/features/rankloop/writing/draft", () => ({
  hasWriterProvider: mocks.writer.hasWriterProvider,
}));
vi.mock(
  "@/server/features/rankloop/writing/services/ArticleWriteService",
  () => ({
    ArticleWriteService: mocks.write,
  }),
);
vi.mock("@/server/features/rankloop/publish/services/PublishService", () => ({
  PublishService: mocks.publish,
}));
vi.mock(
  "@/server/features/rankloop/publish/repositories/PublishConnectionRepository",
  () => ({ PublishConnectionRepository: mocks.connection }),
);

const NOW = new Date("2026-08-01T07:00:00.000Z");
const PROJECT = "project_1";

/** One row of AutopilotService.getStatus().types, as the run reads it. */
type ActionStatus = {
  actionType: string;
  eligible: boolean;
  reason: string;
  measured: number;
  medianPositionDelta: number | null;
  worse: number;
  behavior: TrustDial;
  fallbackReason: string | null;
};

/** Every action type earned, which is the state the refusal tests then break
 *  one precondition at a time. */
function allEarned(types: string[] = ["write_new", "retitle"]): ActionStatus[] {
  return types.map((actionType) => ({
    actionType,
    eligible: true,
    reason: "eligible (7 measured, median +3.1 positions)",
    measured: 7,
    medianPositionDelta: 3.1,
    worse: 1,
    behavior: "autopilot",
    fallbackReason: null,
  }));
}

function statusOf(
  overrides: Partial<{ trustDial: TrustDial; types: ActionStatus[] }> = {},
) {
  return {
    trustDial: "autopilot",
    pause: null,
    consecutiveGateFailures: 0,
    adapterError: null,
    types: allEarned(),
    ...overrides,
  };
}

/** A proposal as the queue hands it over — only the fields the run reads. */
function proposal(
  id: string,
  type: string,
  track: "net_new" | "optimize" = "net_new",
) {
  return { id, type, track, target: `target of ${id}` };
}

/** A draft in review whose stored verdict passed. */
function reviewArticle(id: string, passed = true) {
  return {
    id,
    keyword: `keyword ${id}`,
    lawReportJson: JSON.stringify({
      passed,
      checkedAt: "2026-08-01T06:00:00.000Z",
      laws: [{ law: "faq", passed, threshold: null, excerpt: null }],
      failure: passed ? null : { reason: "laws_unmet", detail: "1 law unmet." },
    }),
  };
}

beforeEach(() => {
  mocks.autopilot.reconcile.mockResolvedValue(null);
  mocks.autopilot.getStatus.mockResolvedValue(statusOf());
  mocks.repo.countCommittedNetNew.mockResolvedValue(0);
  mocks.repo.getWritableNetNewProposals.mockResolvedValue([]);
  mocks.repo.getReviewArticles.mockResolvedValue([]);
  mocks.proposals.getProposals.mockResolvedValue([]);
  mocks.proposals.decideProposal.mockResolvedValue({ id: "proposal_1" });
  mocks.netNew.getWritingQuota.mockResolvedValue({
    owed: 2,
    outstanding: 0,
    slots: 2,
    reason: null,
    throttle: null,
    exclusions: [],
  });
  mocks.writer.hasWriterProvider.mockResolvedValue(true);
  mocks.write.startArticle.mockImplementation(
    (input: { proposalId: string }) => ({
      articleId: `article_for_${input.proposalId}`,
      alreadyWriting: false,
    }),
  );
  mocks.publish.startPublish.mockImplementation(
    (input: { articleId: string }) => ({
      articleId: input.articleId,
      alreadyPublishing: false,
    }),
  );
  mocks.connection.getForProject.mockResolvedValue({
    adapter: "github",
    status: "ok",
  });
});

async function run() {
  const { runAutopilot } = await import("./AutopilotRunService");
  return runAutopilot({ projectId: PROJECT, now: NOW });
}

function reasons(result: Awaited<ReturnType<typeof run>>, phase: string) {
  return result.refusals
    .filter((refusal) => refusal.phase === phase)
    .map((refusal) => refusal.reason);
}

// ---------------------------------------------------------------------------
// The five preconditions
// ---------------------------------------------------------------------------

describe("runAutopilot — the preconditions, each refusing with its reason", () => {
  it("does nothing at all while the kill switch is tripped", async () => {
    mocks.autopilot.reconcile.mockResolvedValue({
      reason: "autopilot paused — 3 drafts in a row failed the gate",
      since: "2026-07-30T09:00:00.000Z",
    });
    mocks.proposals.getProposals.mockResolvedValue([
      proposal("proposal_1", "write_new"),
    ]);

    const result = await run();

    expect(result.decisions).toEqual([]);
    expect(result.refusals).toEqual([
      {
        phase: "run",
        reason: "autopilot paused — 3 drafts in a row failed the gate",
      },
    ]);
    expect(mocks.proposals.decideProposal).not.toHaveBeenCalled();
    expect(mocks.publish.startPublish).not.toHaveBeenCalled();
  });

  it("refuses a project whose dial moved off autopilot", async () => {
    mocks.autopilot.getStatus.mockResolvedValue(
      statusOf({ trustDial: "drafts" }),
    );
    mocks.proposals.getProposals.mockResolvedValue([
      proposal("proposal_1", "write_new"),
    ]);

    const result = await run();

    expect(result.decisions).toEqual([]);
    expect(result.refusals).toEqual([
      { phase: "run", reason: "the trust dial is set to drafts" },
    ]);
  });

  it("refuses an action type that has not earned it, and says what it needs", async () => {
    mocks.autopilot.getStatus.mockResolvedValue(
      statusOf({
        types: [
          {
            ...allEarned(["write_new"])[0],
            eligible: false,
            reason: "needs 5 measured results, has 2",
            behavior: "drafts",
            fallbackReason: "needs 5 measured results, has 2",
          },
        ],
      }),
    );
    mocks.proposals.getProposals.mockResolvedValue([
      proposal("proposal_1", "write_new"),
    ]);

    const result = await run();

    expect(mocks.proposals.decideProposal).not.toHaveBeenCalled();
    expect(reasons(result, "approve")).toEqual([
      "write_new: needs 5 measured results, has 2",
    ]);
    expect(reasons(result, "write")).toEqual([
      "write_new: needs 5 measured results, has 2",
    ]);
    expect(reasons(result, "publish")).toEqual([
      "write_new: needs 5 measured results, has 2",
    ]);
  });

  it("stops net-new when indexation has paused it, and says the rate", async () => {
    mocks.netNew.getWritingQuota.mockResolvedValue({
      owed: 2,
      outstanding: 0,
      slots: 0,
      reason: null,
      throttle: {
        cap: 0,
        reason: "net-new paused — 31% of recent posts are indexed",
      },
      exclusions: [],
    });
    mocks.proposals.getProposals.mockResolvedValue([
      proposal("proposal_1", "write_new"),
    ]);
    mocks.repo.getWritableNetNewProposals.mockResolvedValue([
      { id: "proposal_9", target: "already approved" },
    ]);

    const result = await run();

    expect(mocks.proposals.decideProposal).not.toHaveBeenCalled();
    expect(mocks.write.startArticle).not.toHaveBeenCalled();
    expect(reasons(result, "approve")).toEqual([
      "net-new paused — 31% of recent posts are indexed",
    ]);
    expect(reasons(result, "write")).toEqual([
      "net-new paused — 31% of recent posts are indexed",
    ]);
  });

  it("refuses to write without a writer provider rather than throwing per proposal", async () => {
    mocks.writer.hasWriterProvider.mockResolvedValue(false);
    mocks.repo.getWritableNetNewProposals.mockResolvedValue([
      { id: "proposal_9", target: "a keyword" },
    ]);

    const result = await run();

    expect(mocks.write.startArticle).not.toHaveBeenCalled();
    expect(reasons(result, "write")).toEqual([
      "no writer provider is configured",
    ]);
  });

  it("refuses to publish with no target connected", async () => {
    mocks.connection.getForProject.mockResolvedValue(null);
    mocks.repo.getReviewArticles.mockResolvedValue([
      reviewArticle("article_1"),
    ]);

    const result = await run();

    expect(mocks.publish.startPublish).not.toHaveBeenCalled();
    expect(reasons(result, "publish")).toEqual([
      "no publish target is connected",
    ]);
  });

  it("leaves a draft whose stored gate verdict failed for a human", async () => {
    mocks.repo.getReviewArticles.mockResolvedValue([
      reviewArticle("article_1", false),
      reviewArticle("article_2", true),
    ]);

    const result = await run();

    expect(mocks.publish.startPublish).toHaveBeenCalledTimes(1);
    expect(mocks.publish.startPublish).toHaveBeenCalledWith({
      projectId: PROJECT,
      articleId: "article_2",
    });
    expect(reasons(result, "publish")).toEqual([
      "a draft in review has not passed the gate — it needs a human",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Merge and prune
// ---------------------------------------------------------------------------

describe("runAutopilot — the two actions no cohort can unlock", () => {
  it("never approves a merge or a prune, whatever else is eligible", async () => {
    mocks.autopilot.getStatus.mockResolvedValue(
      statusOf({
        types: [
          ...allEarned(["write_new"]),
          {
            ...allEarned(["merge"])[0],
            eligible: false,
            reason: "never unattended — this action removes a page that exists",
            behavior: "drafts",
            fallbackReason:
              "never unattended — this action removes a page that exists",
          },
          {
            ...allEarned(["prune"])[0],
            eligible: false,
            reason: "never unattended — this action removes a page that exists",
            behavior: "drafts",
            fallbackReason:
              "never unattended — this action removes a page that exists",
          },
        ],
      }),
    );
    mocks.proposals.getProposals.mockResolvedValue([
      proposal("proposal_merge", "merge", "optimize"),
      proposal("proposal_prune", "prune", "optimize"),
    ]);

    const result = await run();

    expect(mocks.proposals.decideProposal).not.toHaveBeenCalled();
    expect(result.decisions).toEqual([]);
    expect(reasons(result, "approve")).toEqual([
      "merge: never unattended — this action removes a page that exists",
      "prune: never unattended — this action removes a page that exists",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

describe("runAutopilot — every unattended decision says a machine made it", () => {
  it("writes decidedBy: 'autopilot' on each approval", async () => {
    mocks.proposals.getProposals.mockResolvedValue([
      proposal("proposal_1", "write_new"),
      proposal("proposal_2", "retitle", "optimize"),
    ]);

    await run();

    expect(mocks.proposals.decideProposal).toHaveBeenNthCalledWith(1, {
      projectId: PROJECT,
      proposalId: "proposal_1",
      decision: "approved",
      decidedBy: "autopilot",
    });
    expect(mocks.proposals.decideProposal).toHaveBeenNthCalledWith(2, {
      projectId: PROJECT,
      proposalId: "proposal_2",
      decision: "approved",
      decidedBy: "autopilot",
    });
  });

  it("runs the whole loop end to end on a healthy project", async () => {
    mocks.proposals.getProposals.mockResolvedValue([
      proposal("proposal_1", "write_new"),
    ]);
    mocks.repo.getWritableNetNewProposals.mockResolvedValue([
      { id: "proposal_0", target: "yesterday's keyword" },
    ]);
    mocks.repo.getReviewArticles.mockResolvedValue([
      reviewArticle("article_0"),
    ]);

    const result = await run();

    expect(result.decisions).toEqual([
      {
        phase: "approve",
        id: "proposal_1",
        detail: "write_new target of proposal_1",
      },
      {
        phase: "write",
        id: "article_for_proposal_0",
        detail: "yesterday's keyword",
      },
      { phase: "publish", id: "article_0", detail: "keyword article_0" },
    ]);
  });
});
