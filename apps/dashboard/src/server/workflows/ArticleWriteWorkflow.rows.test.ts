import { readdirSync, readFileSync } from "node:fs";
import { createClient } from "@libsql/client";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import {
  articles,
  contentPages,
  keywordBacklog,
  llmSpend,
  organization,
  pageTypes,
  projects,
  proposals,
  writerSettings,
} from "@/db/schema";
import type { RankloopLawReport } from "@/types/schemas/rankloopWriter";

// The mocked-provider proof (spec 0020, acceptance 3), run against rows
// rather than against mock call arguments.
//
// ArticleWriteWorkflow.test.ts already covers the control flow with every
// collaborator faked. What that cannot show is what a human actually opens
// afterwards: the article row, its stored law report, and the ledger. So this
// file fakes exactly one thing — the model client — and lets the real
// repositories write to a real SQLite database built from the shipped D1
// migrations. The gate, the engine's laws, the repair payload and the ledger
// arithmetic are all the ones that deploy.

const client = createClient({ url: ":memory:" });
const testDb = drizzle(client);

const mocks = vi.hoisted(() => ({
  generateText:
    vi.fn<
      (args: {
        system: string;
        messages: Array<{ role: string; content: string }>;
      }) => Promise<unknown>
    >(),
  env: new Map<string, string>(),
}));

vi.mock("cloudflare:workers", () => ({
  env: {},
  // oxlint-disable-next-line typescript/no-extraneous-class -- stand-in for the real base class; the workflow only inherits its shape
  WorkflowEntrypoint: class {},
}));
vi.mock("@/db", () => ({
  db: testDb,
  withPgClient: (fn: () => unknown) => fn(),
}));
vi.mock("ai", () => ({ generateText: mocks.generateText }));
vi.mock("@/server/lib/openrouter", () => ({
  DEFAULT_CHAT_AGENT_MODEL: "house/default",
  buildChatAgentModel: (_key: string, modelId?: string) => ({
    modelId: modelId ?? "house/default",
  }),
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

const { ArticleGateService } =
  await import("@/server/features/rankloop/writing/services/ArticleGateService");
const { ArticleWriteWorkflow } = await import("./ArticleWriteWorkflow");

// ---------------------------------------------------------------------------
// The database the repositories actually write to
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = new URL("../../../drizzle", import.meta.url).pathname;

/** The shipped D1 migrations, replayed. Hand-written DDL here would be a
 *  second definition of the schema, and a proof about stored rows is only
 *  worth as much as the table those rows land in. */
async function applyMigrations(): Promise<void> {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .toSorted();
  for (const name of files) {
    const sql = readFileSync(`${MIGRATIONS_DIR}/${name}`, "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed) await client.execute(trimmed);
    }
  }
}

await applyMigrations();

const ORG_ID = "org_1";
const PROJECT_ID = "project_1";
const PAGE_TYPE_ID = "type_guides";
const PROPOSAL_ID = "proposal_1";
const KEYWORD_ID = "kw_1";
const ARTICLE_ID = "article_1";
const KEYWORD = "espresso grind size";

/** Sized to the fixture drafts below, exactly as gate.test.ts sizes it. */
const CONTRACT = {
  requiredBlocks: ["faq"],
  wordBand: [60, 400],
  h2Min: 2,
  faqMin: 1,
  internalLinksMin: 1,
  schemaType: "Article",
  notes: [],
};

async function seed(trustDial: "titles" | "drafts"): Promise<void> {
  for (const table of [
    llmSpend,
    articles,
    proposals,
    writerSettings,
    contentPages,
    keywordBacklog,
    pageTypes,
    projects,
    organization,
  ]) {
    await testDb.delete(table);
  }

  await testDb.insert(organization).values({
    id: ORG_ID,
    name: "Acme",
    slug: "acme",
    createdAt: new Date(0),
  });
  await testDb.insert(projects).values({
    id: PROJECT_ID,
    organizationId: ORG_ID,
    name: "Beanpress",
    domain: "beanpress.example",
  });
  await testDb.insert(pageTypes).values({
    id: PAGE_TYPE_ID,
    projectId: PROJECT_ID,
    name: "Guides",
    kind: "blog",
    status: "approved",
    urlPattern: "/blog/{slug}/",
    templateContractJson: JSON.stringify(CONTRACT),
  });
  await testDb.insert(keywordBacklog).values({
    id: KEYWORD_ID,
    projectId: PROJECT_ID,
    keyword: KEYWORD,
    source: "manual",
    category: "Guides",
    pageTypeId: PAGE_TYPE_ID,
    searchVolume: 480,
    score: 7.2,
  });
  await testDb.insert(contentPages).values([
    {
      id: "page_1",
      projectId: PROJECT_ID,
      url: "https://beanpress.example/blog/burr-grinder-guide/",
      path: "/blog/burr-grinder-guide/",
      kind: "post",
      title: "Burr grinders",
      category: "Guides",
      source: "crawl",
      publishedAt: "2026-01-02",
    },
    {
      id: "page_2",
      projectId: PROJECT_ID,
      url: "https://beanpress.example/blog/descaling/",
      path: "/blog/descaling/",
      kind: "post",
      title: "Descaling",
      category: "Guides",
      source: "crawl",
      publishedAt: "2026-01-01",
    },
  ]);
  await testDb.insert(proposals).values({
    id: PROPOSAL_ID,
    projectId: PROJECT_ID,
    type: "write_new",
    track: "net_new",
    status: "approved",
    target: KEYWORD,
    pageTypeId: PAGE_TYPE_ID,
    keywordBacklogId: KEYWORD_ID,
    score: 7.2,
  });
  await testDb.insert(writerSettings).values({
    id: "settings_1",
    projectId: PROJECT_ID,
    trustDial,
    voiceCardMd: "Blunt, technical, first person.",
  });
  await testDb.insert(articles).values({
    id: ARTICLE_ID,
    projectId: PROJECT_ID,
    proposalId: PROPOSAL_ID,
    pageTypeId: PAGE_TYPE_ID,
    keyword: KEYWORD,
    writerMode: "api",
    status: "briefing",
  });
}

// ---------------------------------------------------------------------------
// Fixture drafts
// ---------------------------------------------------------------------------

// Trimmed at the edges because `runWriterCall` trims what the model returns,
// and these fixtures stand in for exactly that string.
const COMPLIANT_DRAFT = `---
title: Dialing in espresso on a home machine
description: What I changed to get repeatable shots without buying anything.
date: 2026-08-01
category: Guides
keyword: espresso grind size
---

I measured every shot on my home machine for a week before I trusted any of
this. The numbers below are the ones I wrote down, not the ones a manufacturer
prints on a box.

## Start coarse and tighten one notch at a time

Espresso grind size is the only variable worth moving on the first day. Set the
dose, keep it there, and change nothing else until the shot runs somewhere near
thirty seconds. Small moves beat big ones, because a burr set travels further
than the numbers on the collar suggest.

## What the shot time is telling you

A fast shot is under extracted and tastes sour. A slow one is over extracted
and tastes bitter and dry. Both are grind problems long before they are machine
problems, which is why I stopped replacing gear to fix taste.

## How long should a double shot take?

Between twenty five and thirty two seconds from first drip, for most beans
roasted for espresso. Older beans run faster and want a finer setting.

## What I would check next

If the taste still swings between two shots in a row, weigh the dose. My own
swing came from scooping rather than weighing, and it disappeared the day I put
the basket on a scale. The [burr grinder guide](/blog/burr-grinder-guide/)
covers the machine side.
`.trim();

/** Two failures the engine can point at: a banned phrase, and the only
 *  internal link pointing at a path no page serves. */
const BROKEN_DRAFT = COMPLIANT_DRAFT.replace(
  "The [burr grinder guide](/blog/burr-grinder-guide/)\ncovers the machine side.",
  "Let's explore the tradeoffs. The [burr grinder guide](/blog/grinder-myths/)\ncovers the machine side.",
);

function modelResponse(text: string) {
  return {
    text,
    finishReason: "stop",
    usage: { inputTokens: 1000, outputTokens: 800 },
    providerMetadata: { openrouter: { usage: { cost: 0.05 } } },
  };
}

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
  workflowName: "article-write-workflow",
};

async function runWorkflow(): Promise<void> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double: ctx/env are never touched
  const stub = {} as ExecutionContext & Env;
  await new ArticleWriteWorkflow(stub, stub).run(EVENT, makeFakeStep());
}

/** The article as a human would open it. */
async function storedArticle() {
  const rows = await testDb
    .select()
    .from(articles)
    .where(eq(articles.id, ARTICLE_ID));
  return rows[0];
}

async function storedReport(): Promise<RankloopLawReport> {
  const row = await storedArticle();
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- written by the gate one step earlier
  return JSON.parse(String(row?.lawReportJson)) as RankloopLawReport;
}

/** The ledger for this article, oldest first. */
async function storedSpend() {
  return testDb
    .select()
    .from(llmSpend)
    .where(eq(llmSpend.articleId, ARTICLE_ID))
    .orderBy(llmSpend.id);
}

function failedLaws(report: RankloopLawReport) {
  return report.laws.filter((law) => !law.passed);
}

beforeEach(async () => {
  mocks.env.clear();
  mocks.env.set("OPENROUTER_API_KEY", "sk-test");
  await seed("drafts");
});

// ---------------------------------------------------------------------------
// (a) a compliant draft passes on attempt 1
// ---------------------------------------------------------------------------

describe("the writer, stored: a draft that clears the laws", () => {
  it("lands one article row in review with one ledger row behind it", async () => {
    mocks.generateText.mockResolvedValue(modelResponse(COMPLIANT_DRAFT));

    await runWorkflow();

    expect(mocks.generateText).toHaveBeenCalledTimes(1);

    const row = await storedArticle();
    expect(row?.status).toBe("review");
    expect(row?.attempts).toBe(1);
    expect(row?.content).toBe(COMPLIANT_DRAFT);
    expect(row?.title).toBe("Dialing in espresso on a home machine");
    expect(row?.slug).toBe("dialing-in-espresso-on-a-home-machine");
    expect(row?.model).toBe("house/default");
    expect(row?.costUsd).toBeCloseTo(0.05, 10);
    // The brief is frozen on the row, so the report stays explainable.
    expect(row?.briefMd).toContain(KEYWORD);

    const report = await storedReport();
    expect(report.passed).toBe(true);
    expect(failedLaws(report)).toEqual([]);
    // Passes are recorded too — the report is the receipt for quality.
    expect(report.laws.length).toBeGreaterThan(10);

    // One model call, one ledger row.
    const spend = await storedSpend();
    expect(spend).toHaveLength(mocks.generateText.mock.calls.length);
    expect(spend[0]).toMatchObject({
      projectId: PROJECT_ID,
      operation: "draft",
      provider: "openrouter",
      model: "house/default",
      inputTokens: 1000,
      outputTokens: 800,
      costUsd: 0.05,
    });
  });

  it("lands approved instead when the trust dial is titles", async () => {
    await seed("titles");
    mocks.generateText.mockResolvedValue(modelResponse(COMPLIANT_DRAFT));

    await runWorkflow();

    expect((await storedArticle())?.status).toBe("approved");
    expect(await storedSpend()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// (b) fail on both laws, repair from the report, pass
// ---------------------------------------------------------------------------

describe("the writer, stored: the fix loop", () => {
  it("repairs against both violated laws and lands the second attempt", async () => {
    mocks.generateText
      .mockResolvedValueOnce(modelResponse(BROKEN_DRAFT))
      .mockResolvedValueOnce(modelResponse(COMPLIANT_DRAFT));

    await runWorkflow();

    expect(mocks.generateText).toHaveBeenCalledTimes(2);

    // The repair call carries the laws as data, with the draft's own words.
    const repairCall = mocks.generateText.mock.calls[1][0];
    expect(repairCall.messages[1].content).toBe(BROKEN_DRAFT);
    const repair = repairCall.messages[2].content;
    expect(repair).toContain("no filler AI phrases");
    expect(repair).toContain("let's explore");
    expect(repair).toContain("internal links");
    expect(repair).toContain("/blog/grinder-myths/");
    // Laws the broken draft already passed stay out of the payload.
    expect(repair).not.toContain("category is a known type");

    const row = await storedArticle();
    expect(row?.status).toBe("review");
    expect(row?.attempts).toBe(2);
    expect(row?.content).toBe(COMPLIANT_DRAFT);
    expect((await storedReport()).passed).toBe(true);

    // Two model calls, two ledger rows, and the total re-summed from them.
    const spend = await storedSpend();
    expect(spend).toHaveLength(mocks.generateText.mock.calls.length);
    expect(spend.map((entry) => entry.operation)).toEqual(["draft", "fix"]);
    expect(row?.costUsd).toBeCloseTo(0.1, 10);
  });

  it("stops at three attempts and lands failed with the report intact", async () => {
    mocks.generateText.mockResolvedValue(modelResponse(BROKEN_DRAFT));

    await runWorkflow();

    expect(mocks.generateText).toHaveBeenCalledTimes(3);

    const row = await storedArticle();
    expect(row?.status).toBe("failed");
    expect(row?.attempts).toBe(3);
    // The draft the human has to edit is still on the row.
    expect(row?.content).toBe(BROKEN_DRAFT);

    const report = await storedReport();
    expect(report.passed).toBe(false);
    expect(failedLaws(report).map((law) => law.law).length).toBe(2);
    expect(report.failure).toEqual({
      reason: "laws_unmet",
      detail: "3 attempts left 2 laws unmet.",
    });
    // Every law is still listed, not just the two that failed.
    expect(report.laws.length).toBeGreaterThan(10);

    const spend = await storedSpend();
    expect(spend).toHaveLength(mocks.generateText.mock.calls.length);
    expect(spend.map((entry) => entry.operation)).toEqual([
      "draft",
      "fix",
      "fix",
    ]);
    expect(row?.costUsd).toBeCloseTo(0.15, 10);
  });
});

// ---------------------------------------------------------------------------
// The editor: a hand edit costs nothing
// ---------------------------------------------------------------------------

describe("the writer, stored: Save & re-check", () => {
  it("re-grades an edited draft with no model call and no ledger row", async () => {
    mocks.generateText.mockResolvedValue(modelResponse(BROKEN_DRAFT));
    await runWorkflow();
    expect((await storedArticle())?.status).toBe("failed");

    const callsBefore = mocks.generateText.mock.calls.length;
    const spendBefore = (await storedSpend()).length;

    const outcome = await ArticleGateService.recheck({
      projectId: PROJECT_ID,
      articleId: ARTICLE_ID,
      content: COMPLIANT_DRAFT,
    });

    expect(outcome).toEqual({ passed: true, failedCount: 0, status: "review" });
    // The whole point of the editor: fixing a sentence by hand is free.
    expect(mocks.generateText).toHaveBeenCalledTimes(callsBefore);
    expect(await storedSpend()).toHaveLength(spendBefore);

    const row = await storedArticle();
    expect(row?.status).toBe("review");
    expect(row?.content).toBe(COMPLIANT_DRAFT);
    // The attempt count belongs to generations, and none happened.
    expect(row?.attempts).toBe(3);
    expect((await storedReport()).passed).toBe(true);
  });
});
