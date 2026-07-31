import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultLaws } from "@rankloop/engine";
import type { DraftContract } from "./draft";
import type { RepairPayload } from "./repair.logic";

// Typed so the assertions below read `.mock.calls` without an unsafe cast
// (an untyped vi.fn() yields `any` calls).
type CallArgs = {
  system: string;
  messages: Array<{ role: string; content: string }>;
  maxOutputTokens: number;
  maxRetries: number;
};

const mocks = vi.hoisted(() => ({
  generateText: vi.fn<(args: CallArgs) => Promise<unknown>>(),
  env: new Map<string, string>(),
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
  getRequiredEnvValue: (name: string) => {
    const value = mocks.env.get(name);
    if (!value) throw new Error(`Missing ${name}`);
    return Promise.resolve(value);
  },
}));

const { readDraftFrontmatter, resolveWriterModelId, runWriterCall } =
  await import("./draft");

const contract: DraftContract = {
  pageTypeName: "Comparisons",
  contract: {
    requiredBlocks: ["dataTable", "faq"],
    wordBand: [900, 1800],
    h2Min: 5,
    faqMin: 3,
    internalLinksMin: 2,
    schemaType: "Article",
    notes: [],
  },
  laws: { ...defaultLaws(), wordMin: 900, wordMax: 1800, h2Min: 5 },
  voiceCardMd: "Blunt, technical, never salesy.",
  keyword: "burr grinder retention",
  today: "2026-08-01",
};

const COMPLIANT_DRAFT = [
  "---",
  "title: Burr grinder retention, measured",
  "description: What retention actually costs you per dose.",
  "date: 2026-08-01",
  "category: Comparisons",
  "keyword: burr grinder retention",
  "---",
  "",
  "I weigh every dose.",
].join("\n");

function respond(overrides: Record<string, unknown> = {}) {
  return {
    text: COMPLIANT_DRAFT,
    finishReason: "stop",
    usage: { inputTokens: 1200, outputTokens: 900 },
    providerMetadata: { openrouter: { usage: { cost: 0.0431 } } },
    ...overrides,
  };
}

/** The arguments of the nth generation, 0-indexed; -1 is the most recent. */
function callArgs(index: number): CallArgs {
  const calls = mocks.generateText.mock.calls;
  return (index < 0 ? calls[calls.length + index] : calls[index])[0];
}

beforeEach(() => {
  mocks.generateText.mockReset();
  mocks.env.clear();
  mocks.env.set("OPENROUTER_API_KEY", "sk-test");
});

describe("runWriterCall system prompt", () => {
  it("carries the honesty contract, the voice card and the merged law numbers", async () => {
    mocks.generateText.mockResolvedValue(respond());

    await runWriterCall({
      briefMd: "# Brief",
      contract,
      modelOverride: null,
      repair: null,
    });

    const system = callArgs(-1).system;
    expect(system).toContain("Invent no numbers");
    expect(system).toContain("Invent no people");
    expect(system).toContain("Claim no testing");
    expect(system).toContain("Name no prices");
    // The voice card verbatim, not a persona synthesized from the niche.
    expect(system).toContain("Blunt, technical, never salesy.");
    // The contract's numbers, not the engine defaults they replaced.
    expect(system).toContain("between 900 and 1800 words");
    expect(system).toContain("At least 5 `##` sections");
    expect(system).toContain("a data table, an FAQ block");
    // The output shape the engine's parser reads.
    expect(system).toContain("category: Comparisons");
    expect(system).toContain("keyword: burr grinder retention");
  });

  it("tells a voiceless site to write plainly instead of inventing a persona", async () => {
    mocks.generateText.mockResolvedValue(respond());

    await runWriterCall({
      briefMd: "# Brief",
      contract: { ...contract, voiceCardMd: null },
      modelOverride: null,
      repair: null,
    });

    expect(callArgs(-1).system).toContain("Do not adopt a persona.");
  });

  it("sends the brief as the only message on a first draft", async () => {
    mocks.generateText.mockResolvedValue(respond());

    await runWriterCall({
      briefMd: "# Brief for burr grinder retention",
      contract,
      modelOverride: null,
      repair: null,
    });

    expect(callArgs(-1).messages).toEqual([
      { role: "user", content: "# Brief for burr grinder retention" },
    ]);
  });
});

describe("runWriterCall repair turn", () => {
  const payload: RepairPayload = {
    instruction: "Fix only what the violations below require.",
    violations: [
      {
        id: "bannedPhrases",
        law: "no filler AI phrases",
        threshold: "none of the 15 banned phrases",
        observed: "1 phrase",
        fix: "Delete these phrases and say the thing plainly.",
        excerpts: [
          {
            quote: "Let's explore the tradeoffs.",
            label: 'banned phrase: "let\'s explore"',
          },
        ],
      },
      {
        id: "internalLinksMin",
        law: "internal links >= 2",
        threshold: "2 links that resolve",
        observed: "1 resolving link, 1 dead path",
        fix: "Link only to the pages the brief listed as candidates.",
        excerpts: [
          { quote: "/blog/grinder-myths/", label: "no page at this path" },
        ],
      },
    ],
  };

  it("replays the brief and the draft, then hands over both violations as data", async () => {
    mocks.generateText.mockResolvedValue(respond());

    await runWriterCall({
      briefMd: "# Brief",
      contract,
      modelOverride: null,
      repair: { previousMarkdown: COMPLIANT_DRAFT, payload },
    });

    const messages = callArgs(-1).messages;
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
    expect(messages[1].content).toBe(COMPLIANT_DRAFT);

    const repair = messages[2].content;
    expect(repair).toContain("no filler AI phrases");
    expect(repair).toContain("internal links >= 2");
    expect(repair).toContain("Let's explore the tradeoffs.");
    expect(repair).toContain("/blog/grinder-myths/");
    expect(repair).toContain("Fix only what the violations below require.");
    // No second model is ever asked whether the prose is good enough.
    expect(repair).not.toMatch(/better|improve the quality|rate this/i);
  });
});

describe("runWriterCall outcomes", () => {
  it("returns the draft and the real metered cost when the call succeeds", async () => {
    mocks.generateText.mockResolvedValue(respond());

    const outcome = await runWriterCall({
      briefMd: "# Brief",
      contract,
      modelOverride: "anthropic/claude-sonnet-4-6",
      repair: null,
    });

    expect(outcome.result).toEqual({ ok: true, markdown: COMPLIANT_DRAFT });
    expect(outcome.spend).toEqual({
      model: "anthropic/claude-sonnet-4-6",
      inputTokens: 1200,
      outputTokens: 900,
      costUsd: 0.0431,
    });
  });

  it("never retries: one provider failure is one terminal outcome, unmetered", async () => {
    mocks.generateText.mockRejectedValue(new Error("502 upstream\n  at x"));

    const outcome = await runWriterCall({
      briefMd: "# Brief",
      contract,
      modelOverride: null,
      repair: null,
    });

    expect(mocks.generateText).toHaveBeenCalledTimes(1);
    expect(mocks.generateText.mock.calls[0][0]).toMatchObject({
      maxRetries: 0,
    });
    // No response came back, so there are no tokens to charge for.
    expect(outcome.spend).toBeNull();
    expect(outcome.result).toEqual({
      ok: false,
      failure: { reason: "provider_error", detail: "502 upstream at x" },
    });
  });

  it("calls a generation that hit the token ceiling truncated, and still meters it", async () => {
    mocks.generateText.mockResolvedValue(
      respond({ finishReason: "length", text: "---\ntitle: half a" }),
    );

    const outcome = await runWriterCall({
      briefMd: "# Brief",
      contract,
      modelOverride: null,
      repair: null,
    });

    expect(outcome.result).toMatchObject({
      ok: false,
      failure: { reason: "truncated" },
    });
    // The call cost money whether or not it finished.
    expect(outcome.spend?.costUsd).toBe(0.0431);
  });

  it("refuses a response the engine's parser could not read as a post", async () => {
    mocks.generateText.mockResolvedValue(
      respond({ text: "Sure! Here is your article about burr grinders." }),
    );

    const outcome = await runWriterCall({
      briefMd: "# Brief",
      contract,
      modelOverride: null,
      repair: null,
    });

    expect(outcome.result).toMatchObject({
      ok: false,
      failure: { reason: "unparseable_frontmatter" },
    });
    expect(outcome.spend).not.toBeNull();
  });

  it("sizes the output ceiling from the page type's word band, not a constant", async () => {
    mocks.generateText.mockResolvedValue(respond());

    await runWriterCall({
      briefMd: "# Brief",
      contract,
      modelOverride: null,
      repair: null,
    });
    const narrow = callArgs(0).maxOutputTokens;

    await runWriterCall({
      briefMd: "# Brief",
      contract: { ...contract, laws: { ...contract.laws, wordMax: 6000 } },
      modelOverride: null,
      repair: null,
    });
    const wide = callArgs(1).maxOutputTokens;

    expect(wide).toBeGreaterThan(narrow);
  });
});

describe("readDraftFrontmatter", () => {
  it("accepts the shape parseMdPost reads", () => {
    expect(readDraftFrontmatter(COMPLIANT_DRAFT)).toEqual({ ok: true });
  });

  it("names every key the draft is missing", () => {
    const partial = ["---", "title: Only a title", "---", "", "Body."].join(
      "\n",
    );
    expect(readDraftFrontmatter(partial)).toEqual({
      ok: false,
      missing: ["description", "date", "category", "keyword"],
    });
  });
});

describe("resolveWriterModelId", () => {
  it("prefers the project override, then the deployment, then the house default", async () => {
    expect(await resolveWriterModelId("x/project-model")).toBe(
      "x/project-model",
    );
    mocks.env.set("OPENROUTER_MODEL", "x/deployment-model");
    expect(await resolveWriterModelId(null)).toBe("x/deployment-model");
    mocks.env.delete("OPENROUTER_MODEL");
    expect(await resolveWriterModelId(null)).toBe("house/default");
  });
});
