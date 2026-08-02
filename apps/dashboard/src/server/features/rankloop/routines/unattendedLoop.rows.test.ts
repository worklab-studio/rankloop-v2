/* eslint-disable max-lines -- one proof, one module-mock preamble: splitting
   this file would duplicate ~120 lines of vi.mock calls, which cannot be
   shared (they only hoist within the file that writes them), and two copies of
   the fake world is exactly how two halves of one proof drift apart. */
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import {
  articles,
  autopilotState,
  digests,
  llmSpend,
  proposals,
  publishConnections,
  receipts,
} from "@/db/schema";
import {
  AUTH_SECRET,
  BROKEN_DRAFT,
  COMPLIANT_DRAFT,
  DIGEST_WEBHOOK_URL,
  KEYWORD,
  KEYWORD_ID,
  modelResponse,
  NOW,
  PAGE_TYPE_ID,
  PROJECT_ID,
  PROPOSAL_ID,
  SLUG,
  TODAY,
  fakeFetch,
  publishAuth,
  seed,
  sent,
  testDb,
  truncatedModelResponse,
  type SeedOptions,
} from "./unattendedLoop.fixture";

// The unattended proof (spec 0025, acceptance 2–5), run against stored rows.
//
// AutopilotRunService.test.ts already covers the run's control flow with every
// collaborator mocked — which is exactly what it cannot prove: a mock's
// `decideProposal` call argument is not a row, and S9's own verify pass caught
// a feature that passed unit tests while nothing invoked it. So this file
// drives `runProjectRoutines` — the real dispatcher, the real ROUTINE_BLOCKS,
// the real services and repositories against a real SQLite database built from
// the shipped D1 migrations — and asserts what a human would find afterwards.
//
// Exactly two things are faked: the model client, and `fetch`. There is no
// human entry point anywhere in this file: the ONLY thing any test calls is the
// routine, so every row that moves was moved by a machine.

const mocks = vi.hoisted(() => ({
  generateText:
    vi.fn<
      (args: {
        system: string;
        messages: Array<{ role: string; content: string }>;
      }) => Promise<unknown>
    >(),
  runtimeEnv: new Map<string, string>(),
  /** Workflow instances the routine asked for, in order. Queued rather than
   *  run inline because that is what a Workflows binding does: `create()`
   *  returns as soon as the instance exists, so a phase never observes the
   *  work it just started. */
  queued: [] as { kind: "write" | "publish"; params: WorkflowParams }[],
}));

type WorkflowParams = { articleId: string; projectId: string };

/** Every binding the routine's blocks reach for. The two workflows this spec
 *  is about are captured; everything else answers like a binding that exists
 *  and does nothing, so an unrelated block cannot fail the run it shares. */
vi.mock("cloudflare:workers", () => ({
  env: new Proxy(
    {},
    {
      get(_target, name: string) {
        if (name === "ARTICLE_WRITE_WORKFLOW") {
          return {
            create: (options: { params: WorkflowParams }) => {
              mocks.queued.push({ kind: "write", params: options.params });
              return Promise.resolve({ id: options.params.articleId });
            },
          };
        }
        if (name === "PUBLISH_WORKFLOW") {
          return {
            create: (options: { params: WorkflowParams }) => {
              mocks.queued.push({ kind: "publish", params: options.params });
              return Promise.resolve({ id: options.params.articleId });
            },
          };
        }
        return { create: () => Promise.resolve({ id: "noop" }) };
      },
    },
  ),
  // oxlint-disable-next-line typescript/no-extraneous-class -- stand-in for the real base class; the workflows only inherit its shape
  WorkflowEntrypoint: class {},
}));
vi.mock("cloudflare:workflows", () => ({
  NonRetryableError: class extends Error {},
}));
vi.mock("@/db", async () => ({
  db: (await import("./unattendedLoop.fixture")).testDb,
  withPgClient: (fn: () => unknown) => fn(),
}));
vi.mock("@/db/d1/client", async () => ({
  d1Db: (await import("./unattendedLoop.fixture")).testDb,
}));
vi.mock("@/db/pg/client", async () => ({
  pgDb: (await import("./unattendedLoop.fixture")).testDb,
  withPgClient: (fn: () => unknown) => fn(),
}));
vi.mock("@/db/provider", () => ({ getDatabaseProvider: () => "d1" }));
// A real 32-char secret: the connection row is genuinely encrypted and
// genuinely decrypted, and the digest signature is genuinely derived from it.
vi.mock("@/lib/auth", () => ({
  getAuth: () => ({
    $context: Promise.resolve({ secretConfig: AUTH_SECRET }),
  }),
}));
vi.mock("@/server/lib/runtime-env", () => ({
  getOptionalEnvValue: (name: string) =>
    Promise.resolve(mocks.runtimeEnv.get(name)),
  getRequiredEnvValue: (name: string) =>
    Promise.resolve(mocks.runtimeEnv.get(name)),
  // Read off the same map rather than pinned false: the writer meters its
  // generation against the credit pool only in hosted mode, and this fixture
  // sets no AUTH_MODE — the self-hosted deployment spec 0025's acceptance is
  // written against, where the key is the operator's own.
  isHostedServerAuthMode: () =>
    Promise.resolve(mocks.runtimeEnv.get("AUTH_MODE") === "hosted"),
}));
vi.mock("ai", () => ({ generateText: mocks.generateText }));
vi.mock("@/server/lib/openrouter", () => ({
  DEFAULT_CHAT_AGENT_MODEL: "house/default",
  buildChatAgentModel: (_key: string, modelId?: string) => ({
    modelId: modelId ?? "house/default",
  }),
  getZdrPreference: vi.fn(async () => true),
}));

const { runProjectRoutines } =
  await import("@/server/features/rankloop/routines/services/runProjectRoutines");
const { ArticleWriteWorkflow } =
  await import("@/server/workflows/ArticleWriteWorkflow");
const { PublishWorkflow } = await import("@/server/workflows/PublishWorkflow");
const { AutopilotService } =
  await import("@/server/features/rankloop/routines/services/AutopilotService");
const { autopilotBlock } =
  await import("@/server/features/rankloop/routines/autopilotBlock");
const { EVENT_HEADER, SIGNATURE_HEADER, TIMESTAMP_HEADER, signEnvelope } =
  await import("@/server/features/rankloop/publish/adapters/webhook");

// ---------------------------------------------------------------------------
// Driving the routine
// ---------------------------------------------------------------------------

const kvPuts: string[] = [];
const routineEnv = {
  KV: {
    put: (key: string) => {
      kvPuts.push(key);
      return Promise.resolve();
    },
    get: () => Promise.resolve(null),
  },
  ROUTINE_SCHEDULER: {},
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the dispatch path only touches KV
} as unknown as Parameters<typeof runProjectRoutines>[0];

/** Runs every step body inline; checkpointing is the engine's business. */
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

function workflowEvent(params: WorkflowParams): WorkflowEvent<WorkflowParams> {
  return {
    payload: params,
    timestamp: NOW,
    instanceId: params.articleId,
    workflowName: "test",
  };
}

/** Run whatever the last routine tick queued, the way the platform would a
 *  moment later. Returns how many instances ran. */
async function drainWorkflows(): Promise<number> {
  const queue = mocks.queued.splice(0, mocks.queued.length);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double: ctx/env are never touched
  const stub = {} as ExecutionContext & Env;
  for (const instance of queue) {
    const workflow =
      instance.kind === "write"
        ? new ArticleWriteWorkflow(stub, stub)
        : new PublishWorkflow(stub, stub);
    await workflow.run(workflowEvent(instance.params), makeFakeStep());
  }
  return queue.length;
}

/** Everything the autopilot block said it declined to do, this tick. The block
 *  logs one line per distinct reason; this is that record, read back. */
let logged: string[] = [];

/** The dispatcher's own summary of the last tick. */
let lastRun: Awaited<ReturnType<typeof runProjectRoutines>> | null = null;

function refusals(phase?: string): string[] {
  const prefix = `[routines] autopilot ${phase ?? ""}`;
  return logged
    .filter(
      (line) =>
        line.startsWith("[routines] autopilot") &&
        line.includes(" skipped for "),
    )
    .filter((line) => (phase === undefined ? true : line.startsWith(prefix)))
    .map((line) => line.slice(line.indexOf(": ") + 2));
}

/**
 * One routine tick at `at`, then the workflows it queued.
 *
 * The clock moves forward between the two, by a minute, because that is what
 * really happens: the routine hands an instance to the platform and the
 * instance runs after it. The kill switch folds gate verdicts strictly after
 * the watermark it stored, so a test that ran the workflow at the tick's own
 * instant would never let a single failure be counted.
 */
async function tick(at: Date = NOW): Promise<void> {
  logged = [];
  vi.setSystemTime(at);
  const spy = vi.spyOn(console, "log").mockImplementation((...args) => {
    logged.push(args.map(String).join(" "));
  });
  try {
    lastRun = await runProjectRoutines(routineEnv, PROJECT_ID, at);
  } finally {
    spy.mockRestore();
  }
  vi.setSystemTime(new Date(at.getTime() + 60_000));
  await drainWorkflows();
}

/** What the dispatcher itself recorded about the autopilot block on the last
 *  tick: 'ran', 'not-due', or 'failed'. This is the assertion that a block
 *  nothing invokes cannot pass — S9 shipped a feature with no caller twice,
 *  and every test below states which of the three this run produced. */
function autopilotOutcome(): string {
  const outcome = lastRun?.blocks.find((block) => block.block === "autopilot");
  return outcome ? outcome.status : "absent";
}

// ---------------------------------------------------------------------------
// Reading the rows back
// ---------------------------------------------------------------------------

/** Stored JSON, read back the way the surfaces read it. Parsed rather than
 *  cast: a proof about a stored column is only as good as its refusal to
 *  believe a column that no longer holds what it claims. */
const deliverySchema = z.array(
  z.object({
    channel: z.string(),
    status: z.string(),
    error: z.string().nullable(),
  }),
);
const reportSchema = z.object({
  passed: z.boolean(),
  laws: z.array(z.unknown()),
});

function parse<T>(
  schema: z.ZodType<T>,
  raw: string | null | undefined,
): T | null {
  if (!raw) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function storedProposal() {
  const rows = await testDb
    .select()
    .from(proposals)
    .where(eq(proposals.id, PROPOSAL_ID));
  return rows[0];
}

async function storedArticles() {
  return testDb
    .select()
    .from(articles)
    .where(eq(articles.projectId, PROJECT_ID));
}

async function storedState() {
  const rows = await testDb
    .select()
    .from(autopilotState)
    .where(eq(autopilotState.projectId, PROJECT_ID));
  return rows[0];
}

/** Every metered generation this project was charged for. The money
 *  assertion: a loop that re-buys a doomed draft shows up here and nowhere
 *  else, because the article rows it produces all look alike. */
async function storedSpend() {
  return testDb
    .select()
    .from(llmSpend)
    .where(eq(llmSpend.projectId, PROJECT_ID));
}

async function storedConnection() {
  const rows = await testDb
    .select()
    .from(publishConnections)
    .where(eq(publishConnections.projectId, PROJECT_ID));
  return rows[0];
}

async function storedReceipts() {
  return testDb
    .select()
    .from(receipts)
    .where(eq(receipts.projectId, PROJECT_ID));
}

async function storedDigests() {
  return testDb
    .select()
    .from(digests)
    .where(eq(digests.projectId, PROJECT_ID))
    .orderBy(digests.forDate);
}

/** The digest for a day, parsed the way the card parses it. */
async function digestFor(forDate: string) {
  const rows = await storedDigests();
  const row = rows.find((entry) => entry.forDate === forDate);
  return {
    row,
    payload: row ? (JSON.parse(row.payloadJson) as unknown) : null,
    deliveries: parse(deliverySchema, row?.deliveredJson) ?? [],
  };
}

/** Whether the digest's blocked section says this, in the sentence it prints.
 *  A substring rather than an equality: the pause line appends "(since …)",
 *  and pinning the instant would be asserting the clock, not the reason. */
function digestSays(payload: unknown, reason: string): boolean {
  return blockedDetails(payload).some((detail) => detail.includes(reason));
}

function blockedDetails(payload: unknown): string[] {
  const blocked =
    payload && typeof payload === "object" && "blocked" in payload
      ? (payload as { blocked: unknown }).blocked
      : null;
  if (!Array.isArray(blocked)) return [];
  return blocked.map((line: unknown) =>
    line && typeof line === "object" && "detail" in line
      ? String((line as { detail: unknown }).detail)
      : "",
  );
}

const dayAfter = (days: number) => new Date(NOW.getTime() + days * 86_400_000);

async function reseed(options: SeedOptions = {}): Promise<void> {
  await seed(options);
  mocks.queued.length = 0;
  sent.length = 0;
  kvPuts.length = 0;
  publishAuth.rejects = false;
}

/** A tick whose workflow instance is expected to die inside a step. The
 *  platform records the dead instance and the next wake goes on without it;
 *  everywhere else in this file a thrown instance is a bug the test should
 *  surface, which is why this is not what `tick` does. */
async function tickThroughDeadInstance(at: Date): Promise<void> {
  await tick(at).catch(() => undefined);
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mocks.runtimeEnv.clear();
  mocks.runtimeEnv.set("OPENROUTER_API_KEY", "sk-test");
  mocks.generateText.mockReset();
  mocks.generateText.mockResolvedValue(modelResponse(COMPLIANT_DRAFT));
  vi.stubGlobal("fetch", fakeFetch());
  await reseed();
});

afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Acceptance 2 — the unattended proof
// ---------------------------------------------------------------------------

describe("the loop closes itself: approve, write, gate, publish", () => {
  it("moves a proposal to published with no human call anywhere in the path", async () => {
    // ---- tick 1: the machine says yes, and puts the work in front of the writer
    await tick();

    // The dispatcher admitted the block and ran it — not "not-due", which is
    // what a block nobody wired in would report.
    expect(autopilotOutcome()).toBe("ran");

    const approved = await storedProposal();
    expect(approved?.status).toBe("approved");
    // The row that makes a bad autopilot period auditable after the fact.
    expect(approved?.decidedBy).toBe("autopilot");
    expect(approved?.decidedAt).not.toBeNull();

    // The writer ran on the model double and the gate graded its output.
    expect(mocks.generateText).toHaveBeenCalledTimes(1);
    const [written] = await storedArticles();
    expect(written?.proposalId).toBe(PROPOSAL_ID);
    expect(written?.keyword).toBe(KEYWORD);
    expect(written?.content).toBe(COMPLIANT_DRAFT);
    // `review`, not `approved`: nobody opened it. `approved` is the status a
    // human click produces, and its absence here is what makes the publish
    // below an unattended one.
    expect(written?.status).toBe("review");
    const report = parse(reportSchema, written?.lawReportJson);
    expect(report?.passed).toBe(true);
    expect(report?.laws.length).toBeGreaterThan(10);

    // ---- tick 2: the draft that cleared the laws goes to the site
    await tick();

    const [published] = await storedArticles();
    expect(published?.status).toBe("published");
    expect(published?.publishedUrl).toContain(`/blog/${SLUG}/`);
    expect(published?.adapterRef).not.toBeNull();

    // It really went through the adapter.
    const posted = sent.filter((call) => call.event === "post.create");
    expect(posted).toHaveLength(1);

    // The receipt the Receipts screen opens on.
    const opened = (await storedReceipts()).filter(
      (row) => row.articleId === published?.id,
    );
    expect(opened).toHaveLength(1);
    expect(opened[0]?.baselineJson).not.toBeNull();

    // The whole path, restated as one fact: every decided proposal on this
    // project was decided by a machine.
    const decided = (
      await testDb
        .select()
        .from(proposals)
        .where(eq(proposals.projectId, PROJECT_ID))
    ).filter((row) => row.decidedBy !== null);
    expect(decided.length).toBeGreaterThan(0);
    expect(decided.every((row) => row.decidedBy === "autopilot")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Acceptance 3 — the four refusals
// ---------------------------------------------------------------------------

describe("the loop refuses, and says why", () => {
  it("(a) will not touch an action type that can never be eligible", async () => {
    await reseed({ proposalType: "merge" });

    await tick();

    expect(autopilotOutcome()).toBe("ran");
    expect((await storedProposal())?.status).toBe("proposed");
    expect((await storedProposal())?.decidedBy).toBeNull();
    expect(await storedArticles()).toHaveLength(0);
    expect(refusals("approve")).toContain(
      "merge: never unattended — this action removes a page that exists",
    );
  });

  it("(b) will not add net-new while 30% of recent posts are indexed", async () => {
    await reseed({ indexedShare: 0.3 });

    await tick();

    expect(autopilotOutcome()).toBe("ran");
    expect((await storedProposal())?.status).toBe("proposed");
    expect(await storedArticles()).toHaveLength(0);
    const reason = "net-new paused — 30% of recent posts are indexed";
    expect(refusals()).toContain(reason);
    // And the same sentence reaches the operator's morning, not just the log.
    const digest = await digestFor(TODAY);
    expect(digestSays(digest.payload, reason)).toBe(true);
  });

  it("(c) does nothing at all while the kill switch is tripped", async () => {
    const pausedReason = "autopilot paused — 3 drafts in a row failed the gate";
    await reseed({ pausedReason });

    await tick();

    expect(autopilotOutcome()).toBe("ran");
    expect((await storedProposal())?.status).toBe("proposed");
    expect(await storedArticles()).toHaveLength(0);
    expect(refusals("run")).toEqual([pausedReason]);
    // The reason is a stored row, not only a log line.
    expect((await storedState())?.pausedReason).toBe(pausedReason);
    const digest = await digestFor(TODAY);
    expect(digestSays(digest.payload, pausedReason)).toBe(true);
  });

  it("(d) does nothing at all while the dial says drafts", async () => {
    await reseed({ trustDial: "drafts" });

    await tick();

    // The recorded no-op: the dispatcher asked the block and the block said
    // this project is not one of its own. 'absent' would mean the block is not
    // in ROUTINE_BLOCKS at all, which is a different — and much worse — fact.
    expect(autopilotOutcome()).toBe("not-due");
    expect((await storedProposal())?.status).toBe("proposed");
    expect(await storedArticles()).toHaveLength(0);
    // The dial is the due-set's own filter, so the block never even admits the
    // project — which is itself the recorded no-op the digest reports as a
    // behavior of 'drafts' rather than autopilot.
    expect(refusals()).toEqual([]);
    const behavior = await AutopilotService.getActionBehavior({
      projectId: PROJECT_ID,
      actionType: "write_new",
      now: NOW,
    });
    expect(behavior.behavior).toBe("drafts");

    // And the in-run guard behind the filter, for the dial that moved between
    // the sweep and the call: the block's own entry point, asked directly,
    // still refuses in words rather than trusting the due-set to have been
    // right a moment ago.
    logged = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args) => {
      logged.push(args.map(String).join(" "));
    });
    try {
      await autopilotBlock.runForProject(PROJECT_ID, NOW);
    } finally {
      spy.mockRestore();
    }
    expect(refusals("run")).toEqual(["the trust dial is set to drafts"]);
    expect(await storedArticles()).toHaveLength(0);
  });

  it("also refuses an eligible type whose cohort came out worse", async () => {
    await reseed({ eligible: false });

    await tick();

    expect((await storedProposal())?.status).toBe("proposed");
    expect(refusals("approve").join(" ")).toContain(
      "autopilot needs an improvement",
    );
  });
});

// ---------------------------------------------------------------------------
// Acceptance 4 — the kill switch
// ---------------------------------------------------------------------------

describe("three failed gates stop the machine, and a human starts it again", () => {
  it("pauses at exactly three, reports the pause, and acts again after resume", async () => {
    // A writer whose output the laws reject, every attempt.
    mocks.generateText.mockResolvedValue(modelResponse(BROKEN_DRAFT));

    // Three ticks: each approves one proposal, writes it, and lands it failed.
    for (let day = 0; day < 3; day += 1) {
      await tick(dayAfter(day));
      // Re-open a proposal for the next day's approval, the way the net-new
      // block would.
      await testDb.insert(proposals).values({
        id: `proposal_extra_${day}`,
        projectId: PROJECT_ID,
        type: "write_new",
        track: "net_new",
        status: "proposed",
        target: `${KEYWORD} ${day}`,
        pageTypeId: PAGE_TYPE_ID,
        keywordBacklogId: KEYWORD_ID,
        score: 7.2,
      });
    }

    const failedArticles = (await storedArticles()).filter(
      (row) => row.status === "failed",
    );
    expect(failedArticles.length).toBeGreaterThanOrEqual(3);

    // The switch, on the row. One more tick folds the third verdict in.
    await tick(dayAfter(3));
    const paused = await storedState();
    expect(paused?.consecutiveGateFailures).toBeGreaterThanOrEqual(3);
    expect(paused?.pausedAt).not.toBeNull();
    expect(paused?.pausedReason).toBe(
      "autopilot paused — 3 drafts in a row failed the gate",
    );

    // It is in the digest, where the operator actually looks.
    const digest = await digestFor(dayAfter(3).toISOString().slice(0, 10));
    expect(digestSays(digest.payload, String(paused?.pausedReason))).toBe(true);

    // And the block is genuinely a no-op now.
    const beforeCount = (await storedArticles()).length;
    await tick(dayAfter(4));
    expect((await storedArticles()).length).toBe(beforeCount);
    expect(refusals("run")).toEqual([paused?.pausedReason]);

    // A human clears it from Settings — the one human action in this file, and
    // it is the one the spec says a human must take.
    await AutopilotService.resume({ projectId: PROJECT_ID, now: dayAfter(5) });
    expect((await storedState())?.pausedAt).toBeNull();
    expect((await storedState())?.consecutiveGateFailures).toBe(0);

    // The next run acts again.
    mocks.generateText.mockResolvedValue(modelResponse(COMPLIANT_DRAFT));
    await testDb.insert(proposals).values({
      id: "proposal_after_resume",
      projectId: PROJECT_ID,
      type: "write_new",
      track: "net_new",
      status: "proposed",
      target: "resumed keyword",
      pageTypeId: PAGE_TYPE_ID,
      keywordBacklogId: KEYWORD_ID,
      score: 7.2,
    });
    await tick(dayAfter(6));

    const resumed = (
      await testDb
        .select()
        .from(proposals)
        .where(eq(proposals.id, "proposal_after_resume"))
    )[0];
    expect(resumed?.status).toBe("approved");
    expect(resumed?.decidedBy).toBe("autopilot");
  });

  it("pauses immediately when the publish target rejects our credentials", async () => {
    await reseed({ connectionStatus: "failed" });

    await tick();

    const paused = await storedState();
    expect(paused?.pausedReason).toBe(
      "autopilot paused — webhook rejected our credentials",
    );
    expect((await storedProposal())?.status).toBe("proposed");
  });

  it("records the rejection an unattended publish met, so nobody has to press Test connection first", async () => {
    // The connection was tested and passed; the credential was revoked
    // afterwards. Nothing but a publish will ever discover that, and the test
    // above starts from a row only a human could have written.
    await tick();
    expect((await storedArticles())[0]?.status).toBe("review");

    publishAuth.rejects = true;
    await tickThroughDeadInstance(dayAfter(1));

    expect((await storedConnection())?.status).toBe("failed");

    // Which is the row the switch reads on the next wake.
    publishAuth.rejects = false;
    await tick(dayAfter(2));
    expect((await storedState())?.pausedReason).toBe(
      "autopilot paused — webhook rejected our credentials",
    );
  });
});

// ---------------------------------------------------------------------------
// Acceptance 4, the other half — failures that never reached the gate
// ---------------------------------------------------------------------------

describe("a draft that never reached the gate is bought twice, not forever", () => {
  it("stops re-buying one proposal after two drafts died before review", async () => {
    // Truncation, every attempt: charged in full, and no law ever gets to
    // grade it. The gate streak cannot see this class at all — the report it
    // stores has an empty checklist — so the only thing standing between it
    // and a call every fifteen minutes is the per-proposal ceiling.
    mocks.generateText.mockResolvedValue(truncatedModelResponse());

    for (let day = 0; day < 4; day += 1) await tick(dayAfter(day));

    expect(mocks.generateText).toHaveBeenCalledTimes(2);
    expect(await storedSpend()).toHaveLength(2);
    const written = await storedArticles();
    expect(written).toHaveLength(2);
    expect(written.every((row) => row.status === "failed")).toBe(true);

    // And it says so by name rather than going quiet, which from the outside
    // is indistinguishable from a loop that had nothing to do.
    expect(refusals("write")).toContain(
      `${KEYWORD}: 2 drafts failed before reaching review — it needs a human`,
    );
  });

  it("pauses the whole loop on the third draft in a row that never reached the gate", async () => {
    mocks.generateText.mockResolvedValue(truncatedModelResponse());

    for (let day = 0; day < 3; day += 1) {
      await tick(dayAfter(day));
      // A fresh keyword each day, the way the net-new block would: the
      // per-proposal ceiling alone would otherwise stop the count at two.
      await testDb.insert(proposals).values({
        id: `proposal_extra_${day}`,
        projectId: PROJECT_ID,
        type: "write_new",
        track: "net_new",
        status: "proposed",
        target: `${KEYWORD} ${day}`,
        pageTypeId: PAGE_TYPE_ID,
        keywordBacklogId: KEYWORD_ID,
        score: 7.2,
      });
    }
    await tick(dayAfter(3));

    const paused = await storedState();
    expect(paused?.pausedReason).toBe(
      "autopilot paused — 3 drafts in a row never reached the gate",
    );
    expect(paused?.pausedAt).not.toBeNull();
    // Counted apart from the gate's own streak: no law rejected anything here.
    expect(paused?.consecutiveGateFailures).toBe(0);

    // And the pause is real money saved, not just a row.
    const spent = (await storedSpend()).length;
    await tick(dayAfter(4));
    expect(await storedSpend()).toHaveLength(spent);
    expect(refusals("run")).toEqual([paused?.pausedReason]);
  });
});

// ---------------------------------------------------------------------------
// Acceptance 5 — delivery
// ---------------------------------------------------------------------------

describe("the digest goes out, and the receiver can prove it came from us", () => {
  it("records in-app as stored", async () => {
    await tick();

    const digest = await digestFor(TODAY);
    expect(digest.row).toBeDefined();
    expect(digest.deliveries).toContainEqual(
      expect.objectContaining({ channel: "in_app", status: "stored" }),
    );
  });

  it("sends exactly one signed webhook whose signature verifies", async () => {
    await reseed({ digestWebhookUrl: DIGEST_WEBHOOK_URL });

    await tick();

    const calls = sent.filter((call) =>
      call.url.startsWith(DIGEST_WEBHOOK_URL),
    );
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.method).toBe("POST");
    expect(call.headers[EVENT_HEADER.toLowerCase()]).toBe("digest.daily");

    // Verify it the way a receiver would: derive the per-project secret from
    // the deployment secret, then HMAC the timestamp and the exact bytes that
    // arrived. A re-serialized body would not match.
    const secret = await signEnvelope(
      AUTH_SECRET,
      "rankloop:digest",
      PROJECT_ID,
    );
    const expected = await signEnvelope(
      secret,
      call.headers[TIMESTAMP_HEADER.toLowerCase()],
      call.rawBody,
    );
    expect(call.headers[SIGNATURE_HEADER.toLowerCase()]).toBe(expected);
    // A wrong secret must not verify, or the assertion above proves nothing.
    const wrong = await signEnvelope(
      "not-the-secret",
      call.headers[TIMESTAMP_HEADER.toLowerCase()],
      call.rawBody,
    );
    expect(call.headers[SIGNATURE_HEADER.toLowerCase()]).not.toBe(wrong);

    const digest = await digestFor(TODAY);
    expect(digest.deliveries).toContainEqual(
      expect.objectContaining({ channel: "webhook", status: "sent" }),
    );
  });

  it("records a webhook that could not be delivered, and still stores in-app", async () => {
    await reseed({ digestWebhookUrl: "not-a-url" });

    await tick();

    const digest = await digestFor(TODAY);
    expect(digest.deliveries).toContainEqual(
      expect.objectContaining({ channel: "in_app", status: "stored" }),
    );
    expect(digest.deliveries).toContainEqual(
      expect.objectContaining({ channel: "webhook", status: "failed" }),
    );
  });
});
