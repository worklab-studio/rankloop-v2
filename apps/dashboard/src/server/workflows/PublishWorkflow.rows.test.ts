import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import {
  articles,
  contentPages,
  keywordBacklog,
  proposals,
  publishConnections,
  receipts,
} from "@/db/schema";
import {
  ARTICLE_ID,
  bodiesWritten,
  END,
  field,
  HUB_PATH,
  KEYWORD,
  NEIGHBOURS,
  PATH,
  PROJECT_ID,
  PROPOSAL_ID,
  KEYWORD_ID,
  seed,
  sent,
  SLUG,
  START,
  testDb,
  USER_PROSE,
  wordpressFetch,
  webhookFetch,
  githubFetch,
  type AdapterKind,
  type Sent,
} from "./publishRows.fixture";

// The mocked-adapter proof (spec 0021, acceptance 2, 3 and 4), run against rows
// and bytes rather than against mock call arguments.
//
// PublishWorkflow.test.ts already covers the order with every collaborator
// faked, and the adapter contract tests cover each target's HTTP shape. What
// neither can show is the thing the spec actually promises: that for all three
// targets a real article reaches a real site through the real adapter, its hub
// exists BEFORE the instance does, at most three real neighbours get the owned
// block and nothing else, a receipt opens with a baseline, and the proposal and
// backlog rows move — all in one run, and none of it twice.
//
// So exactly one thing is faked here: `fetch`. Everything below it is the code
// that deploys — the real workflow, the real gate, the real adapters, the real
// repositories writing to a real SQLite database built from the shipped D1
// migrations (see publishRows.fixture.ts).

const mocks = vi.hoisted(() => ({ env: new Map<string, string>() }));

vi.mock("cloudflare:workers", () => ({
  env: {},
  // oxlint-disable-next-line typescript/no-extraneous-class -- stand-in for the real base class; the workflow only inherits its shape
  WorkflowEntrypoint: class {},
}));
vi.mock("@/db", async () => ({
  db: (await import("./publishRows.fixture")).testDb,
  withPgClient: (fn: () => unknown) => fn(),
}));
// The publish commit is the one write that goes through runBatch rather than
// `db`, and it is the write this proof is about — so the batch executor is
// pointed at the same real database instead of the module being stubbed out.
vi.mock("@/db/d1/client", async () => ({
  d1Db: (await import("./publishRows.fixture")).testDb,
}));
vi.mock("@/db/pg/client", async () => ({
  pgDb: (await import("./publishRows.fixture")).testDb,
  withPgClient: (fn: () => unknown) => fn(),
}));
vi.mock("@/db/provider", () => ({ getDatabaseProvider: () => "d1" }));
// A real 32-char secret: the connection row the fixture seeds is genuinely
// encrypted, and `resolvePublishAdapter` genuinely decrypts and re-validates it.
vi.mock("@/lib/auth", () => ({
  getAuth: () => ({
    $context: Promise.resolve({
      secretConfig: "0123456789abcdef0123456789abcdef",
    }),
  }),
}));
vi.mock("@/server/lib/runtime-env", () => ({
  getOptionalEnvValue: (name: string) => Promise.resolve(mocks.env.get(name)),
  getRequiredEnvValue: (name: string) => Promise.resolve(mocks.env.get(name)),
}));

const { PublishWorkflow } = await import("./PublishWorkflow");

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

// Runs every step body inline; checkpointing is the engine's business.
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
  workflowName: "publish-workflow",
};

async function runWorkflow(): Promise<void> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double: ctx/env are never touched
  const stub = {} as ExecutionContext & Env;
  await new PublishWorkflow(stub, stub).run(EVENT, makeFakeStep());
}

/** The pinned pre-publish window. A receipt without one measures nothing, so
 *  the proof parses it rather than checking the column is non-null. */
const baselineShape = z.object({
  window: z.object({ start: z.string(), end: z.string() }),
});

async function storedArticle() {
  const rows = await testDb
    .select()
    .from(articles)
    .where(eq(articles.id, ARTICLE_ID));
  return rows[0];
}

async function storedReceipts() {
  return testDb
    .select()
    .from(receipts)
    .where(eq(receipts.projectId, PROJECT_ID));
}

async function storedProposal() {
  const rows = await testDb
    .select()
    .from(proposals)
    .where(eq(proposals.id, PROPOSAL_ID));
  return rows[0];
}

async function storedBacklog() {
  const rows = await testDb
    .select()
    .from(keywordBacklog)
    .where(eq(keywordBacklog.id, KEYWORD_ID));
  return rows[0];
}

/** The injection record on the article row, as the Published tab reads it. */
async function injectedLinks(): Promise<{ path: string; outcome: string }[]> {
  const raw = (await storedArticle())?.linksInjectedJson;
  if (!raw) return [];
  const parsed: unknown = JSON.parse(raw);
  return Array.isArray(parsed)
    ? parsed.map((entry) => ({
        path: field(entry, "path"),
        outcome: field(entry, "outcome"),
      }))
    : [];
}

// Where each target's hub creation and post creation show up in the request
// log. Indexes, not booleans: rule 1 is about order, and a proof that only
// checked presence would pass on a run that created the hub afterwards.
type CreateIndexes = { hub: number; post: number };

const CREATE_INDEXES: Record<AdapterKind, () => CreateIndexes> = {
  wordpress: () => ({
    hub: sent.findIndex(
      (call) => call.method === "POST" && call.url.endsWith("/wp/v2/pages"),
    ),
    post: sent.findIndex(
      (call) => call.method === "POST" && call.url.endsWith("/wp/v2/posts"),
    ),
  }),
  webhook: () => ({
    hub: sent.findIndex((call) => call.event === "hub.ensure"),
    post: sent.findIndex((call) => call.event === "post.create"),
  }),
  github: () => ({
    hub: sent.findIndex(
      (call) => call.method === "PUT" && call.url.includes("/compare/index.md"),
    ),
    post: sent.findIndex(
      (call) => call.method === "PUT" && call.url.includes(`/${SLUG}.md`),
    ),
  }),
};

const FETCHES: Record<AdapterKind, () => typeof fetch> = {
  wordpress: wordpressFetch,
  webhook: webhookFetch,
  github: githubFetch,
};

/** Requests that created a post on the target. The re-run assertion counts
 *  these, because "no second post" is the only thing adapterRef guards. */
function postCreations(adapter: AdapterKind): Sent[] {
  if (adapter === "wordpress") {
    return sent.filter(
      (call) => call.method === "POST" && call.url.endsWith("/wp/v2/posts"),
    );
  }
  if (adapter === "webhook") {
    return sent.filter((call) => call.event === "post.create");
  }
  return sent.filter(
    (call) => call.method === "PUT" && call.url.includes(`/${SLUG}.md`),
  );
}

async function setUp(adapter: AdapterKind): Promise<void> {
  sent.length = 0;
  mocks.env.clear();
  await seed(adapter);
  vi.stubGlobal("fetch", FETCHES[adapter]());
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Acceptance 2 — the same proof, three targets
// ---------------------------------------------------------------------------

describe.each<AdapterKind>(["wordpress", "webhook", "github"])(
  "publishing for real: the %s target",
  (adapter) => {
    it("creates the hub before the instance", async () => {
      await setUp(adapter);

      await runWorkflow();

      const { hub, post } = CREATE_INDEXES[adapter]();
      expect(hub).toBeGreaterThanOrEqual(0);
      expect(post).toBeGreaterThanOrEqual(0);
      // Rule 1, as an ordering rather than a presence check.
      expect(hub).toBeLessThan(post);
    });

    it("lands the article, its receipt, its proposal and its backlog row", async () => {
      await setUp(adapter);

      await runWorkflow();

      const article = await storedArticle();
      expect(article?.status).toBe("published");
      expect(article?.adapter).toBe(adapter);
      expect(article?.adapterRef).toBeTruthy();
      expect(article?.publishedUrl).toContain(SLUG);
      expect(article?.publishedAt).toBeTruthy();

      // One receipt, opened with a real baseline — a published article with no
      // baseline has nothing to measure against later.
      const opened = await storedReceipts();
      expect(opened).toHaveLength(1);
      expect(opened[0]?.actionType).toBe("write_new");
      expect(opened[0]?.status).toBe("baseline");
      expect(opened[0]?.targetQuery).toBe(KEYWORD);
      expect(opened[0]?.articleId).toBe(ARTICLE_ID);
      const baseline = baselineShape.parse(
        JSON.parse(String(opened[0]?.baselineJson)),
      );
      expect(baseline.window.start).not.toBe("");
      expect(baseline.window.end).not.toBe("");

      expect((await storedProposal())?.status).toBe("done");
      expect((await storedBacklog())?.status).toBe("published");
    });

    it("touches at most three real neighbours, and only through the owned block", async () => {
      await setUp(adapter);

      await runWorkflow();

      const links = await injectedLinks();
      expect(links.length).toBeGreaterThan(0);
      expect(links.length).toBeLessThanOrEqual(3);
      // Every path is a page that existed before this run — the manifest rows
      // seeded above, never the new article and never the hub.
      const neighbourPaths = NEIGHBOURS.map((neighbour) => neighbour.path);
      for (const link of links) expect(neighbourPaths).toContain(link.path);
      expect(links.map((link) => link.path)).not.toContain(PATH);
      expect(links.map((link) => link.path)).not.toContain(HUB_PATH);

      if (adapter === "webhook") {
        // This target applies the links itself; rankloop sends them and edits
        // nothing, which is what "delegated" has to mean in the record too.
        expect(links.every((link) => link.outcome === "delegated")).toBe(true);
        return;
      }

      expect(links.every((link) => link.outcome === "injected")).toBe(true);
      // Every neighbour body that went out carries the delimiters and the new
      // article's path inside them.
      const neighbourWrites = bodiesWritten().filter((body) =>
        body.includes(START),
      );
      expect(neighbourWrites).toHaveLength(links.length);
      for (const body of neighbourWrites) {
        expect(body.slice(body.indexOf(START), body.indexOf(END))).toContain(
          PATH,
        );
      }
    });

    it("creates no second post when the workflow runs again", async () => {
      await setUp(adapter);
      await runWorkflow();
      const firstRef = (await storedArticle())?.adapterRef;
      expect(postCreations(adapter)).toHaveLength(1);

      // A resumed run, not a fresh one: the article is put back in the status
      // a crash between step 3 and step 8 would have left it in, so the guard
      // being tested is `adapterRef` rather than the published-status check.
      await testDb
        .update(articles)
        .set({ status: "publishing" })
        .where(eq(articles.id, ARTICLE_ID));

      await runWorkflow();

      expect(postCreations(adapter)).toHaveLength(1);
      expect((await storedArticle())?.adapterRef).toBe(firstRef);
      expect((await storedArticle())?.status).toBe("published");
    });

    it("creates no second post when the button is pressed twice", async () => {
      await setUp(adapter);
      await runWorkflow();

      // The row exactly as the first run left it, which is what a double click
      // actually looks like: preflight stops before any adapter is reached, so
      // nothing is created and no second baseline is opened.
      await runWorkflow();

      expect(postCreations(adapter)).toHaveLength(1);
      expect(await storedReceipts()).toHaveLength(1);
      expect((await storedArticle())?.status).toBe("published");
    });
  },
);

describe("the publish commit, replayed", () => {
  it("opens exactly one receipt when step 8 runs twice on the same stamp", async () => {
    await setUp("wordpress");
    await runWorkflow();

    const article = await storedArticle();
    const stamp = String(article?.publishedAt);
    const pages = await testDb
      .select()
      .from(contentPages)
      .where(eq(contentPages.path, PATH));

    // What a workflow engine does when a step's checkpoint is lost: the step
    // body runs again with the results the earlier steps already stored, so
    // the stamp is the same one. The commit's CAS and its insert-select both
    // have to miss, or one publish ends up with two baselines and the Receipts
    // screen reports the second one's numbers forever.
    const { PublishService } =
      await import("@/server/features/rankloop/publish/services/PublishService");
    const { describeRun } =
      await import("@/server/features/rankloop/publish/services/publishContext");
    await PublishService.commitPublished({
      context: await describeRun({
        projectId: PROJECT_ID,
        articleId: ARTICLE_ID,
      }),
      contentPageId: String(pages[0]?.id),
      adapter: "wordpress",
      adapterRef: String(article?.adapterRef),
      publishedUrl: String(article?.publishedUrl),
      links: [],
      publishedAt: stamp,
    });

    expect(await storedReceipts()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Acceptance 3 — the bytes outside the block
// ---------------------------------------------------------------------------

describe("the owned block, byte for byte", () => {
  it("injects once and leaves the user's own words byte-identical", async () => {
    await setUp("wordpress");

    await runWorkflow();
    const afterFirst = bodiesWritten().filter((body) => body.includes(START));
    expect(afterFirst).toHaveLength(3);

    const written = afterFirst[0] ?? "";
    // Exactly one block, and the user's prose is the result's byte-identical
    // prefix — asserted on the exact string, not on a fuzzy match.
    expect(written.split(START)).toHaveLength(2);
    expect(written.split(END)).toHaveLength(2);
    expect(written.startsWith(USER_PROSE)).toBe(true);
    expect(written.slice(0, USER_PROSE.length)).toBe(USER_PROSE);

    // Re-run against the page the target now holds: the second pass must find
    // its own block, change nothing, and write nothing at all.
    sent.length = 0;
    await testDb
      .update(articles)
      .set({ status: "publishing" })
      .where(eq(articles.id, ARTICLE_ID));

    await runWorkflow();

    const afterSecond = bodiesWritten().filter((body) => body.includes(START));
    expect(afterSecond).toHaveLength(0);
    expect(
      (await injectedLinks()).every((link) => link.outcome === "unchanged"),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Acceptance 4 — no connection
// ---------------------------------------------------------------------------

describe("with nothing connected", () => {
  it("refuses cleanly and writes nothing anywhere", async () => {
    await setUp("wordpress");
    await testDb.delete(publishConnections);
    sent.length = 0;

    await runWorkflow();

    // Not one request left the process.
    expect(sent).toHaveLength(0);
    const article = await storedArticle();
    // Back where a human can act on it, with the reason beside the report.
    expect(article?.status).toBe("review");
    expect(article?.adapterRef).toBeNull();
    expect(article?.publishedUrl).toBeNull();
    expect(await storedReceipts()).toHaveLength(0);
    expect((await storedProposal())?.status).toBe("approved");
    expect((await storedBacklog())?.status).toBe("queued");
    // Nothing was added to the manifest either — the corpus only learns about
    // pages that exist.
    const pages = await testDb
      .select()
      .from(contentPages)
      .where(eq(contentPages.projectId, PROJECT_ID));
    expect(pages).toHaveLength(NEIGHBOURS.length);
  });

  it("gives the panel the setup pitch and refuses the button before a run starts", async () => {
    await setUp("wordpress");
    await testDb.delete(publishConnections);
    sent.length = 0;

    const { PublishPlanService } =
      await import("@/server/features/rankloop/publish/services/PublishPlanService");
    const plan = await PublishPlanService.getPublishPlan({
      projectId: PROJECT_ID,
      articleId: ARTICLE_ID,
    });
    // `capabilities: null` is exactly what RankloopPublishPanel branches on to
    // render PublishSetupPitch, and the rest of the plan is empty rather than
    // absent so the panel has a whole shape to read.
    expect(plan.capabilities).toBeNull();
    expect(plan.published).toBeNull();
    expect(plan.linkTargets).toEqual([]);
    expect(plan.blockedReason).toBeNull();

    // And the button itself refuses with the same story, before a workflow
    // instance exists to bounce the article back to review.
    const { PublishService } =
      await import("@/server/features/rankloop/publish/services/PublishService");
    await expect(
      PublishService.startPublish({
        projectId: PROJECT_ID,
        articleId: ARTICLE_ID,
      }),
    ).rejects.toMatchObject({ code: "PUBLISH_NOT_CONNECTED" });

    expect(sent).toHaveLength(0);
    expect((await storedArticle())?.status).toBe("approved");
  });
});
