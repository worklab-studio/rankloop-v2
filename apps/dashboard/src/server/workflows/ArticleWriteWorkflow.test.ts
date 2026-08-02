import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { defaultLaws } from "@rankloop/engine";
import type {
  LawReport,
  LawVerdict,
} from "@/server/features/rankloop/writing/gate";

// The writer end to end with only the model client faked. Everything that
// decides anything is real: the prompts, the attempt bound, the ledger
// arithmetic and the repair payload the fix call carries. The gate is stubbed
// because its own grading is covered against fixtures in gate.test.ts — what
// is under test here is that the workflow spends once per attempt, stops at
// three, and never presents a partial article as a finished one.

// Typed so the assertions below read `.mock.calls` without an unsafe cast
// (an untyped vi.fn() yields `any` calls).
type GenerateTextArgs = {
  system: string;
  messages: Array<{ role: string; content: string }>;
  maxOutputTokens: number;
  maxRetries: number;
};
type Patch = Record<string, unknown>;
type SpendRow = { operation: string; model: string; costUsd: number };

const mocks = vi.hoisted(() => ({
  generateText: vi.fn<(args: GenerateTextArgs) => Promise<unknown>>(),
  env: new Map<string, string>(),
  articleRepo: {
    getArticleById: vi.fn(),
    updateArticle: vi.fn<(id: string, update: Patch) => Promise<void>>(),
    insertSpend: vi.fn<(input: SpendRow) => Promise<void>>(),
    getSpendForArticle: vi.fn(),
  },
  briefService: { buildBrief: vi.fn() },
  settingsRepo: { getSettings: vi.fn() },
  pagePlanRepo: { getPageTypeById: vi.fn() },
  projectRepo: { getProjectById: vi.fn() },
  gateService: { gate: vi.fn() },
}));

vi.mock("cloudflare:workers", () => ({
  env: {},
  // oxlint-disable-next-line typescript/no-extraneous-class -- stand-in for the real base class; the workflow only inherits its shape
  WorkflowEntrypoint: class {},
}));
vi.mock("@/db", () => ({ withPgClient: (fn: () => unknown) => fn() }));
vi.mock("ai", () => ({ generateText: mocks.generateText }));
vi.mock("@/server/lib/openrouter", () => ({
  DEFAULT_CHAT_AGENT_MODEL: "house/default",
  buildChatAgentModel: (_key: string, modelId?: string) => ({
    modelId: modelId ?? "house/default",
  }),
  getZdrPreference: vi.fn(async () => true),
}));
vi.mock("@/server/lib/runtime-env", () => ({
  getOptionalEnvValue: (name: string) => Promise.resolve(mocks.env.get(name)),
  getRequiredEnvValue: (name: string) => Promise.resolve(mocks.env.get(name)),
  // Read off the same map rather than pinned false: the writer meters its
  // generation against the credit pool only in hosted mode, and this fixture
  // sets no AUTH_MODE — a self-hosted deployment with its own key, which is
  // the world every case below is written in.
  isHostedServerAuthMode: () =>
    Promise.resolve(mocks.env.get("AUTH_MODE") === "hosted"),
}));
vi.mock(
  "@/server/features/rankloop/writing/repositories/ArticleRepository",
  () => ({ ArticleRepository: mocks.articleRepo }),
);
vi.mock(
  "@/server/features/rankloop/writing/repositories/WriterSettingsRepository",
  () => ({ WriterSettingsRepository: mocks.settingsRepo }),
);
vi.mock("@/server/features/rankloop/writing/services/BriefService", () => ({
  BriefService: mocks.briefService,
}));
vi.mock(
  "@/server/features/rankloop/writing/services/ArticleGateService",
  () => ({ ArticleGateService: mocks.gateService }),
);
vi.mock(
  "@/server/features/rankloop/page-plan/repositories/PagePlanRepository",
  () => ({ PagePlanRepository: mocks.pagePlanRepo }),
);
vi.mock("@/server/features/projects/repositories/ProjectRepository", () => ({
  ProjectRepository: mocks.projectRepo,
}));

const { buildRepairPayload } =
  await import("@/server/features/rankloop/writing/repair.logic");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ARTICLE_ID = "article_1";
const PROJECT_ID = "project_1";

function draftMarkdown(marker: string): string {
  return [
    "---",
    `title: Burr grinder retention (${marker})`,
    "description: What retention costs you per dose.",
    "date: 2026-08-01",
    "category: Comparisons",
    "keyword: burr grinder retention",
    "---",
    "",
    "I weigh every dose.",
  ].join("\n");
}

function verdict(overrides: Partial<LawVerdict>): LawVerdict {
  return {
    id: "unknown",
    law: "a law",
    passed: true,
    threshold: null,
    observed: null,
    excerpt: null,
    excerpts: [],
    ...overrides,
  };
}

/** A report with the two failures spec 0020's scenario (b) names. */
function failingReport(): LawReport {
  const laws: LawVerdict[] = [
    verdict({ id: "wordMin", law: "word count >= 850", passed: true }),
    verdict({
      id: "bannedPhrases",
      law: "no filler AI phrases",
      passed: false,
      threshold: "none of the 15 banned phrases",
      observed: "1 phrase",
      excerpt: "Let's explore the tradeoffs.",
      excerpts: [
        {
          quote: "Let's explore the tradeoffs.",
          label: 'banned phrase: "let\'s explore"',
        },
      ],
    }),
    verdict({
      id: "internalLinksMin",
      law: "internal links >= 2",
      passed: false,
      threshold: "2 links that resolve",
      observed: "1 resolving link, 1 dead path",
      excerpt: "/blog/grinder-myths/",
      excerpts: [
        { quote: "/blog/grinder-myths/", label: "no page at this path" },
      ],
    }),
  ];
  return {
    slug: "burr-grinder-retention",
    passed: false,
    violations: 2,
    checkedAt: "2026-08-01T00:00:00.000Z",
    failure: null,
    frontmatterParsed: true,
    laws,
  };
}

function passingReport(): LawReport {
  return {
    slug: "burr-grinder-retention",
    passed: true,
    violations: 0,
    checkedAt: "2026-08-01T00:00:00.000Z",
    failure: null,
    frontmatterParsed: true,
    laws: [verdict({ id: "wordMin", law: "word count >= 850", passed: true })],
  };
}

function gateResult(report: LawReport) {
  return { passed: report.passed, report, payload: buildRepairPayload(report) };
}

function modelResponse(overrides: Record<string, unknown> = {}) {
  return {
    text: draftMarkdown("v1"),
    finishReason: "stop",
    usage: { inputTokens: 1000, outputTokens: 800 },
    providerMetadata: { openrouter: { usage: { cost: 0.05 } } },
    ...overrides,
  };
}

// Runs every step body inline: the workflow's control flow is what's under
// test, not the engine's checkpointing.
function makeFakeStep(): WorkflowStep {
  const fake = {
    do: (
      _name: string,
      configOrFn: (() => Promise<unknown>) | Record<string, unknown>,
      maybeFn?: () => Promise<unknown>,
    ) => (typeof configOrFn === "function" ? configOrFn() : maybeFn?.()),
    sleep: vi.fn(),
  };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double: only do/sleep are exercised
  return fake as unknown as WorkflowStep;
}

const EVENT: WorkflowEvent<{ articleId: string; projectId: string }> = {
  payload: { articleId: ARTICLE_ID, projectId: PROJECT_ID },
  timestamp: new Date(),
  instanceId: ARTICLE_ID,
  workflowName: "article-write-workflow",
};

async function runWorkflow() {
  const { ArticleWriteWorkflow } = await import("./ArticleWriteWorkflow");
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double: ctx/env are never touched (every collaborator is mocked)
  const stub = {} as ExecutionContext & Env;
  await new ArticleWriteWorkflow(stub, stub).run(EVENT, makeFakeStep());
}

/** Every `updateArticle` patch, in order — the article's whole life. */
function patches(): Patch[] {
  return mocks.articleRepo.updateArticle.mock.calls.map((call) => call[1]);
}

function finalStatus(): unknown {
  return patches().findLast((patch) => "status" in patch)?.status;
}

/** The report as it was persisted — the receipt a human opens the article to. */
function storedReport(): LawReport {
  const patch = patches().findLast((update) => "lawReportJson" in update);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the column is written by this workflow from a LawReport one line earlier
  return JSON.parse(String(patch?.lawReportJson)) as LawReport;
}

beforeEach(() => {
  // vitest.config's restoreMocks/clearMocks already reset every vi.fn();
  // only the env map is ours to clear.
  vi.resetModules();
  mocks.env.clear();
  mocks.env.set("OPENROUTER_API_KEY", "sk-test");
  mocks.articleRepo.getArticleById.mockResolvedValue({
    id: ARTICLE_ID,
    projectId: PROJECT_ID,
    proposalId: "proposal_1",
    pageTypeId: "type_1",
    keyword: "burr grinder retention",
    status: "briefing",
    title: null,
  });
  mocks.articleRepo.updateArticle.mockResolvedValue(undefined);
  mocks.articleRepo.insertSpend.mockResolvedValue(undefined);
  mocks.articleRepo.getSpendForArticle.mockImplementation(() =>
    Promise.resolve(
      mocks.articleRepo.insertSpend.mock.calls.reduce(
        (total, call) => total + call[0].costUsd,
        0,
      ),
    ),
  );
  mocks.projectRepo.getProjectById.mockResolvedValue({
    id: PROJECT_ID,
    organizationId: "org_1",
    name: "Acme",
    domain: "acme.com",
  });
  mocks.pagePlanRepo.getPageTypeById.mockResolvedValue({
    id: "type_1",
    name: "Comparisons",
    templateContractJson: null,
    urlPattern: "/blog/",
  });
  mocks.settingsRepo.getSettings.mockResolvedValue({
    trustDial: "drafts",
    voiceCardMd: "Blunt, technical.",
    model: null,
  });
  mocks.briefService.buildBrief.mockResolvedValue({
    markdown: "# Brief\n\nWrite about burr grinder retention.",
    keyword: "burr grinder retention",
    serpSource: "none",
    serpFetchedAt: null,
    costUsd: 0,
  });
});

// ---------------------------------------------------------------------------
// (a) a compliant draft passes on the first attempt
// ---------------------------------------------------------------------------

describe("ArticleWriteWorkflow: a draft that clears the laws", () => {
  it("spends once, lands in review, and freezes the brief it was written from", async () => {
    mocks.generateText.mockResolvedValue(modelResponse());
    mocks.gateService.gate.mockResolvedValue(gateResult(passingReport()));

    await runWorkflow();

    expect(mocks.generateText).toHaveBeenCalledTimes(1);
    // One model call, one ledger row.
    expect(mocks.articleRepo.insertSpend).toHaveBeenCalledTimes(1);
    expect(mocks.articleRepo.insertSpend).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      articleId: ARTICLE_ID,
      operation: "draft",
      model: "house/default",
      inputTokens: 1000,
      outputTokens: 800,
      costUsd: 0.05,
    });
    // The brief is stored verbatim, before a word is generated against it.
    expect(patches()[0]).toMatchObject({
      briefMd: "# Brief\n\nWrite about burr grinder retention.",
      status: "writing",
    });
    expect(finalStatus()).toBe("review");
    expect(mocks.gateService.gate).toHaveBeenCalledTimes(1);
  });

  it("auto-approves when the trust dial is titles", async () => {
    mocks.settingsRepo.getSettings.mockResolvedValue({
      trustDial: "titles",
      voiceCardMd: null,
      model: null,
    });
    mocks.generateText.mockResolvedValue(modelResponse());
    mocks.gateService.gate.mockResolvedValue(gateResult(passingReport()));

    await runWorkflow();

    expect(finalStatus()).toBe("approved");
  });

  it("writes with the project's model override and bills the ledger for it", async () => {
    mocks.settingsRepo.getSettings.mockResolvedValue({
      trustDial: "drafts",
      voiceCardMd: null,
      model: "anthropic/claude-sonnet-4-6",
    });
    mocks.generateText.mockResolvedValue(modelResponse());
    mocks.gateService.gate.mockResolvedValue(gateResult(passingReport()));

    await runWorkflow();

    expect(mocks.articleRepo.insertSpend).toHaveBeenCalledWith(
      expect.objectContaining({ model: "anthropic/claude-sonnet-4-6" }),
    );
  });
});

// ---------------------------------------------------------------------------
// (b) fail, repair against the laws as data, pass
// ---------------------------------------------------------------------------

describe("ArticleWriteWorkflow: the bounded fix loop", () => {
  it("hands the repair call both violated laws with their excerpts, then lands the fix", async () => {
    mocks.generateText
      .mockResolvedValueOnce(modelResponse({ text: draftMarkdown("v1") }))
      .mockResolvedValueOnce(modelResponse({ text: draftMarkdown("v2") }));
    mocks.gateService.gate
      .mockResolvedValueOnce(gateResult(failingReport()))
      .mockResolvedValueOnce(gateResult(passingReport()));

    await runWorkflow();

    expect(mocks.generateText).toHaveBeenCalledTimes(2);
    expect(mocks.articleRepo.insertSpend).toHaveBeenCalledTimes(2);
    expect(mocks.articleRepo.insertSpend.mock.calls[1][0]).toMatchObject({
      operation: "fix",
    });

    const repairCall = mocks.generateText.mock.calls[1][0];
    // The failed draft is replayed, then repaired against the laws it broke.
    expect(repairCall.messages[1].content).toBe(draftMarkdown("v1"));
    const repair = repairCall.messages[2].content;
    expect(repair).toContain("no filler AI phrases");
    expect(repair).toContain("Let's explore the tradeoffs.");
    expect(repair).toContain("internal links >= 2");
    expect(repair).toContain("/blog/grinder-myths/");
    expect(repair).toContain("2 links that resolve");
    // Laws the first draft already passed are not in the repair payload.
    expect(repair).not.toContain("word count >= 850");

    expect(finalStatus()).toBe("review");
    // The running total is re-summed from the ledger, never incremented.
    expect(patches().findLast((patch) => "costUsd" in patch)?.costUsd).toBe(
      0.1,
    );
  });

  it("stops at three attempts including the first draft, and keeps the report", async () => {
    mocks.generateText.mockResolvedValue(modelResponse());
    mocks.gateService.gate.mockResolvedValue(gateResult(failingReport()));

    await runWorkflow();

    // Three generations total: one draft and two repairs, never a fourth.
    expect(mocks.generateText).toHaveBeenCalledTimes(3);
    expect(mocks.articleRepo.insertSpend).toHaveBeenCalledTimes(3);
    expect(
      mocks.articleRepo.insertSpend.mock.calls.map((call) => call[0].operation),
    ).toEqual(["draft", "fix", "fix"]);

    expect(finalStatus()).toBe("failed");
    // The report survives intact: every law, and why the run ended.
    expect(storedReport().laws).toHaveLength(3);
    expect(storedReport().failure).toEqual({
      reason: "laws_unmet",
      detail: "3 attempts left 2 laws unmet.",
    });
    expect(
      patches().findLast((patch) => "lawReportJson" in patch)?.attempts,
    ).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Failure honesty
// ---------------------------------------------------------------------------

describe("ArticleWriteWorkflow: never a partial article presented as complete", () => {
  it("lands a provider error terminally without a second call or a ledger row", async () => {
    mocks.generateText.mockRejectedValue(new Error("502 upstream"));

    await runWorkflow();

    expect(mocks.generateText).toHaveBeenCalledTimes(1);
    expect(mocks.articleRepo.insertSpend).not.toHaveBeenCalled();
    expect(mocks.gateService.gate).not.toHaveBeenCalled();
    expect(finalStatus()).toBe("failed");
    expect(storedReport().failure?.reason).toBe("provider_error");
    // Nothing was graded, so the report claims nothing.
    expect(storedReport().laws).toEqual([]);
  });

  it("lands a truncated generation terminally, but still bills for it", async () => {
    mocks.generateText.mockResolvedValue(
      modelResponse({ finishReason: "length", text: "---\ntitle: half a" }),
    );

    await runWorkflow();

    expect(mocks.generateText).toHaveBeenCalledTimes(1);
    expect(mocks.articleRepo.insertSpend).toHaveBeenCalledTimes(1);
    expect(finalStatus()).toBe("failed");
    expect(storedReport().failure?.reason).toBe("truncated");
  });

  it("lands an unreadable frontmatter terminally instead of burning the budget on it", async () => {
    mocks.generateText.mockResolvedValue(
      modelResponse({ text: "Sure! Here is your article about grinders." }),
    );

    await runWorkflow();

    expect(mocks.generateText).toHaveBeenCalledTimes(1);
    expect(finalStatus()).toBe("failed");
    expect(storedReport().failure?.reason).toBe("unparseable_frontmatter");
  });

  it("lands the article rather than leaving it holding the proposal's slot when a step throws", async () => {
    mocks.briefService.buildBrief.mockRejectedValue(new Error("brief blew up"));

    await expect(runWorkflow()).rejects.toThrow("brief blew up");

    expect(mocks.generateText).not.toHaveBeenCalled();
    expect(finalStatus()).toBe("failed");
    expect(storedReport().failure).toEqual({
      reason: "internal_error",
      detail: "brief blew up",
    });
    // The attempt count on the row is left alone; nothing was attempted.
    expect(
      patches().findLast((patch) => "lawReportJson" in patch),
    ).not.toHaveProperty("attempts");
  });
});

// ---------------------------------------------------------------------------
// The brief the laws are read against
// ---------------------------------------------------------------------------

describe("ArticleWriteWorkflow: the frozen brief", () => {
  it("buys no SERP, and sends the model the brief it stored on the article", async () => {
    mocks.generateText.mockResolvedValue(modelResponse());
    mocks.gateService.gate.mockResolvedValue(gateResult(passingReport()));

    await runWorkflow();

    // A writer run renders the brief from cached grounding only: the user
    // already saw what a fresh SERP costs in the brief drawer.
    expect(mocks.briefService.buildBrief).toHaveBeenCalledWith(
      expect.objectContaining({ allowSerpFetch: false }),
    );
    const call = mocks.generateText.mock.calls[0][0];
    expect(call.messages[0].content).toBe(
      "# Brief\n\nWrite about burr grinder retention.",
    );
    // No page-type contract stored means the engine's own laws, unchanged.
    expect(call.system).toContain(
      `between ${defaultLaws().wordMin} and ${defaultLaws().wordMax} words`,
    );
  });
});
