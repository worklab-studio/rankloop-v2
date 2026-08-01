import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrustDial } from "@/shared/rankloop-writer";

// What one unattended run is allowed to set in motion: the day's quota on
// approvals, two drafts, two publishes — and what it says when it stops.
//
// Split from AutopilotRunService.test.ts, which owns the five preconditions;
// the harness below is the same one, duplicated rather than shared because
// `vi.hoisted` mocks have to be declared in the file that mocks with them.

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
// The caps
// ---------------------------------------------------------------------------

describe("runAutopilot — the caps", () => {
  it("approves up to the day's quota and no further", async () => {
    mocks.proposals.getProposals.mockResolvedValue([
      proposal("proposal_1", "write_new"),
      proposal("proposal_2", "write_new"),
      proposal("proposal_3", "write_new"),
    ]);

    const result = await run();

    expect(mocks.proposals.decideProposal).toHaveBeenCalledTimes(2);
    expect(result.decisions.map((decision) => decision.id)).toEqual([
      "proposal_1",
      "proposal_2",
    ]);
    expect(reasons(result, "approve")).toEqual(["today's quota of 2 is spent"]);
  });

  it("subtracts what it already committed to, so a second run does not re-spend the quota", async () => {
    mocks.repo.countCommittedNetNew.mockResolvedValue(2);
    mocks.proposals.getProposals.mockResolvedValue([
      proposal("proposal_1", "write_new"),
    ]);

    const result = await run();

    expect(mocks.proposals.decideProposal).not.toHaveBeenCalled();
    expect(reasons(result, "approve")).toEqual([
      "today's quota is already committed",
    ]);
  });

  it("holds net-new to the throttle's cap while still approving optimize work", async () => {
    mocks.netNew.getWritingQuota.mockResolvedValue({
      owed: 3,
      outstanding: 0,
      slots: 1,
      reason: null,
      throttle: {
        cap: 1,
        reason: "quota held at 1 — 52% of recent posts are indexed",
      },
      exclusions: [],
    });
    mocks.proposals.getProposals.mockResolvedValue([
      proposal("proposal_1", "write_new"),
      proposal("proposal_2", "write_new"),
      proposal("proposal_3", "retitle", "optimize"),
    ]);

    const result = await run();

    expect(result.decisions.map((decision) => decision.id)).toEqual([
      "proposal_1",
      "proposal_3",
    ]);
    expect(reasons(result, "approve")).toEqual([
      "quota held at 1 — 52% of recent posts are indexed",
    ]);
  });

  it("asks for at most two drafts and two publishes a run", async () => {
    mocks.repo.getWritableNetNewProposals.mockResolvedValue([
      { id: "proposal_1", target: "keyword one" },
      { id: "proposal_2", target: "keyword two" },
    ]);
    mocks.repo.getReviewArticles.mockResolvedValue([
      reviewArticle("article_1"),
      reviewArticle("article_2"),
      reviewArticle("article_3"),
    ]);

    const result = await run();

    expect(mocks.repo.getWritableNetNewProposals).toHaveBeenCalledWith(
      PROJECT,
      2,
    );
    expect(mocks.write.startArticle).toHaveBeenCalledTimes(2);
    expect(mocks.publish.startPublish).toHaveBeenCalledTimes(2);
    expect(reasons(result, "publish")).toEqual(["2 per run is the cap"]);
  });

  it("records the in-flight guard as a refusal instead of a second draft", async () => {
    mocks.repo.getWritableNetNewProposals.mockResolvedValue([
      { id: "proposal_1", target: "keyword one" },
    ]);
    mocks.write.startArticle.mockResolvedValue({
      articleId: "article_1",
      alreadyWriting: true,
    });

    const result = await run();

    expect(result.decisions.filter((d) => d.phase === "write")).toEqual([]);
    expect(reasons(result, "write")).toEqual([
      "a draft for this proposal is already in flight",
    ]);
  });

  it("turns a thrown adapter error into one bounded refusal, not a retry storm", async () => {
    mocks.repo.getReviewArticles.mockResolvedValue([
      reviewArticle("article_1"),
    ]);
    mocks.publish.startPublish.mockRejectedValue(
      new Error("Connect a publish target before publishing."),
    );

    const result = await run();

    expect(reasons(result, "publish")).toEqual([
      "Connect a publish target before publishing.",
    ]);
  });
});
