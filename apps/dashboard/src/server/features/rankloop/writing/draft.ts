import { generateText } from "ai";
import type { LanguageModelV3 } from "@openrouter/ai-sdk-provider";
import type { LawsConfig } from "@rankloop/engine";
import { frontmatter } from "@rankloop/engine";
import type { TemplateContract } from "@/server/features/rankloop/page-plan/contracts.logic";
import { openRouterCostUsd } from "@/server/lib/chatAgent";
import {
  buildChatAgentModel,
  getZdrPreference,
  DEFAULT_CHAT_AGENT_MODEL,
} from "@/server/lib/openrouter";
import {
  getOptionalEnvValue,
  getRequiredEnvValue,
} from "@/server/lib/runtime-env";
import type { RankloopWriteFailure } from "@/types/schemas/rankloopWriter";
import { renderRepairPayload, type RepairPayload } from "./repair.logic";

// Generation. This is the only file in the writer that talks to a model, and
// it does exactly one thing per call: turn a brief (or a brief plus the laws
// the last draft broke) into markdown. It never judges the result — the laws
// do that, in a package with no model on its dependency graph.
//
// The provider is the fork's existing OpenRouter plumbing, unchanged: same
// key, same ZDR routing, same usage-accounting cost helper the chat agents
// meter with. A second provider path here would mean a second set of routing
// and privacy rules to keep true.

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** What the article is contractually required to carry, as the writer must
 *  read it. Everything here is measured by a law after the call. */
export type DraftContract = {
  pageTypeName: string;
  /** The page type's stored contract; null is a real state (no study behind
   *  this type) and prints as the house laws unchanged. */
  contract: TemplateContract | null;
  /** The contract merged over the engine defaults — the exact numbers the
   *  gate will check. Built by `mergeContractLaws`, never by this file. */
  laws: LawsConfig;
  /** The site's voice in the user's own words, or null. */
  voiceCardMd: string | null;
  keyword: string;
  /** ISO date the frontmatter should carry. Injected, never read from the
   *  clock here, so a replayed workflow step writes the same date. */
  today: string;
};

export type WriterOperation = "draft" | "fix";

/** What a returned call cost. Null when the provider never answered, because
 *  a call that produced no response produced no tokens to meter either. */
type WriterSpend = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
};

type WriterCallOutcome = {
  spend: WriterSpend | null;
  result:
    | { ok: true; markdown: string }
    | { ok: false; failure: RankloopWriteFailure };
};

type WriterCallInput = {
  briefMd: string;
  contract: DraftContract;
  /** Per-project model override; null runs the deployment's OPENROUTER_MODEL. */
  modelOverride: string | null;
  /** Present only on a fix: what to repair, and what it currently says. The
   *  payload is `repair.logic`'s, rendered there — the wording of a law's fix
   *  belongs next to the law, not next to the provider call. */
  repair: { previousMarkdown: string; payload: RepairPayload } | null;
};

// ---------------------------------------------------------------------------
// The honesty contract
// ---------------------------------------------------------------------------

/**
 * The rules that make a generated corpus worth publishing.
 *
 * These are not tone. Every line here exists because the alternative is a
 * page that reads authoritative and is false: a benchmark nobody ran, a price
 * that was true for a week, a testimonial from a person who does not exist.
 * The laws downstream cannot catch any of that — they count words, headings
 * and links. This paragraph is the only thing standing between the model and
 * a plausible lie, so it is stated as prohibitions with no escape hatch.
 */
const HONESTY_CONTRACT = [
  "## Honesty contract",
  "",
  "These are hard rules. A draft that breaks one is worse than no draft.",
  "",
  "- Invent no numbers. No benchmarks, statistics, percentages, sample sizes, dates or study results that are not in the brief. If you do not have a number, write the sentence without one.",
  "- Invent no people. No quotes, testimonials, customer stories, survey responses or named experts.",
  "- Claim no testing. Do not say you tried, tested, benchmarked, installed, measured or ran anything. First-person voice is required below; first-person experience you did not have is fabrication wearing it.",
  "- Name no prices. Describe pricing models (per seat, usage based, free tier, annual commitment) and never a figure or a currency. Any price you print is wrong by the time this publishes.",
  "- Cite no sources you were not given. No study names, no report titles, no external URLs beyond what the brief supplies.",
  '- Anything you cannot ground in the brief: hedge it in plain words ("usually", "in most setups", "depending on your stack") or cut it. Cutting is almost always the better answer.',
  "- Link internally only to the paths the brief lists under its link candidates. An invented slug is a 404, and the gate counts a link that does not resolve as no link at all.",
].join("\n");

const OUTPUT_SHAPE_INTRO = [
  "## Output shape",
  "",
  "Return the article as markdown and nothing else: no preamble, no sign-off, no fence around the whole document. It must begin with exactly this frontmatter block, delimited by three hyphens on their own lines:",
].join("\n");

/** Frontmatter keys the parser needs; the article is ungradeable without
 *  them, so the prompt spells them out and the gate refuses a draft missing
 *  any (see `readDraftFrontmatter`). */
const REQUIRED_FRONTMATTER_KEYS = [
  "title",
  "description",
  "date",
  "category",
  "keyword",
] as const;

function outputShapeSection(contract: DraftContract): string {
  const { laws } = contract;
  return [
    OUTPUT_SHAPE_INTRO,
    "",
    "```",
    "---",
    `title: the article title, at most ${laws.titleMax} characters`,
    `description: one sentence, at most ${laws.descriptionMax} characters`,
    `date: ${contract.today}`,
    `category: ${contract.pageTypeName}`,
    `keyword: ${contract.keyword}`,
    "---",
    "```",
    "",
    "Then the body, starting with a sentence and not with a repeat of the title.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// The page type contract, as checkable requirements
// ---------------------------------------------------------------------------

/** Contract block ids as a writer should read them. Same vocabulary the brief
 *  uses; the raw ids mean nothing to anyone outside contracts.logic. */
const BLOCK_LABELS: Readonly<Record<string, string>> = {
  dataTable: "a data table",
  faq: "an FAQ block",
  byline: "a byline",
  dateModified: "a visible date-modified stamp",
};

/**
 * The laws, restated as instructions.
 *
 * Every line here is something a pure function will measure the moment the
 * call returns, which is why the numbers are interpolated from the merged
 * `LawsConfig` rather than typed out: a contract that says 900 words while
 * the gate checks 850 would send every draft into the repair loop for a
 * reason the report could not explain.
 */
function contractSection(contract: DraftContract): string {
  const { laws } = contract;
  const [wordMin, wordMax] = [laws.wordMin, laws.wordMax];
  const lines = [
    `## Page type contract: ${contract.pageTypeName}`,
    "",
    "Each of these is checked by a program after you finish. None of them is a preference.",
    "",
    `- Body length between ${wordMin} and ${wordMax} words. A band, not a target: do not pad toward the ceiling.`,
    `- At least ${laws.h2Min} \`##\` sections.`,
    `- At least ${laws.faqMin} of the \`##\` headings must be questions ending in a question mark, each answered directly underneath.`,
    `- At least ${laws.internalLinksMin} internal links, written as \`[text](/path/to/post/)\`, using only paths the brief lists.`,
    `- The exact keyword "${contract.keyword}" appears in the body, at a density no higher than ${(laws.keywordDensityMax * 100).toFixed(1)} percent. Below the ceiling is the goal, not near it.`,
  ];
  if (laws.banEmDash) {
    lines.push(
      "- No em dashes anywhere in the document. Not in the frontmatter, not in the body. Use a comma, a colon, or two sentences.",
    );
  }
  if (laws.requireFirstPerson) {
    lines.push(
      "- Write in first person (I, we, my, our) about what this site thinks, recommends and builds. Never about tests you did not run.",
    );
  }
  if (laws.bannedPhrases.length > 0) {
    lines.push(
      `- None of these phrases appears anywhere: ${laws.bannedPhrases.map((phrase) => `"${phrase}"`).join(", ")}.`,
    );
  }
  const blocks = contract.contract?.requiredBlocks ?? [];
  if (blocks.length > 0) {
    lines.push(
      `- The page carries ${blocks.map((block) => BLOCK_LABELS[block] ?? block).join(", ")}.`,
    );
  }
  return lines.join("\n");
}

/** The site's voice, verbatim. When there is none the writer is told to write
 *  plainly rather than handed a synthesized persona — inventing one is how
 *  every generated corpus ends up sounding like every other one. */
function voiceSection(voiceCardMd: string | null): string {
  const body = voiceCardMd?.trim();
  return [
    "## Voice card",
    "",
    body ??
      "No voice card exists for this site. Write plainly and in first person, as yourself. Do not adopt a persona.",
  ].join("\n");
}

function buildDraftSystemPrompt(contract: DraftContract): string {
  return [
    "You are writing one article for a real website, from a brief that was assembled from measured facts. You are not a chat assistant here; you produce one document.",
    "",
    HONESTY_CONTRACT,
    "",
    voiceSection(contract.voiceCardMd),
    "",
    contractSection(contract),
    "",
    outputShapeSection(contract),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// The draft's own output contract
// ---------------------------------------------------------------------------

/**
 * Does this text have the frontmatter the engine's parser reads?
 *
 * Uses `@rankloop/engine`'s own `frontmatter` — the same parser `parseMdPost`
 * runs — so "unparseable" here means exactly what it means downstream. A miss
 * is terminal rather than retried: a model that returned an explanation
 * instead of a document did not almost succeed, and the next call would cost
 * the same money to be told the same thing.
 */
export function readDraftFrontmatter(
  markdown: string,
): { ok: true } | { ok: false; missing: string[] } {
  const [meta] = frontmatter(markdown);
  const missing = REQUIRED_FRONTMATTER_KEYS.filter(
    (key) => !(meta[key] ?? "").trim(),
  );
  return missing.length === 0 ? { ok: true } : { ok: false, missing };
}

// ---------------------------------------------------------------------------
// The call
// ---------------------------------------------------------------------------

/**
 * Output headroom, derived from the band the laws will measure.
 *
 * A constant cap is how a writer silently truncates: raise a page type's word
 * ceiling and every draft of it starts coming back cut off mid-sentence, with
 * the gate reporting a word-count failure that repair calls can never fix.
 * Roughly 1.4 tokens per word, doubled for markdown syntax and frontmatter,
 * floored so a short page type still has room to be wrong in.
 */
function maxOutputTokensFor(laws: LawsConfig): number {
  return Math.min(24_000, Math.max(4_000, Math.ceil(laws.wordMax * 2.8)));
}

/** True when this deployment can write at all. The UI asks before it renders
 *  a Write button; the workflow asks before it spends a step. */
export async function hasWriterProvider(): Promise<boolean> {
  return Boolean(await getOptionalEnvValue("OPENROUTER_API_KEY"));
}

/**
 * Which model this project writes with: its own override, else the
 * deployment's `OPENROUTER_MODEL`, else the house default.
 *
 * Read separately from the call because the confirm modal names the model
 * before spending on it, and the name it shows has to be the one that will
 * actually run.
 */
export async function resolveWriterModelId(
  modelOverride: string | null,
): Promise<string> {
  return (
    modelOverride ??
    (await getOptionalEnvValue("OPENROUTER_MODEL")) ??
    DEFAULT_CHAT_AGENT_MODEL
  );
}

async function resolveModel(
  modelOverride: string | null,
): Promise<LanguageModelV3> {
  const apiKey = await getRequiredEnvValue("OPENROUTER_API_KEY");
  return buildChatAgentModel(
    apiKey,
    await resolveWriterModelId(modelOverride),
    // The writer is the one path an operator points at a `:free` model, and
    // free models are excluded by ZDR routing by construction. Honor the
    // opt-out here or a self-host BYO-key install can never write a word.
    await getZdrPreference(),
  );
}

/**
 * One generation, metered, never retried.
 *
 * Retries are the caller's to refuse: this is spend, and an automatic second
 * attempt on a provider hiccup doubles a bill the user cannot see happening.
 * Failures come back as data (`ok: false`) rather than exceptions so the
 * workflow can land the article in `failed` with the reason intact instead of
 * a stack trace.
 */
export async function runWriterCall(
  input: WriterCallInput,
): Promise<WriterCallOutcome> {
  const model = await resolveModel(input.modelOverride);
  const messages = buildMessages(input);
  const maxOutputTokens = maxOutputTokensFor(input.contract.laws);

  let response: Awaited<ReturnType<typeof generateText>>;
  try {
    response = await generateText({
      model,
      system: buildDraftSystemPrompt(input.contract),
      messages,
      maxOutputTokens,
      // The AI SDK's own retry, off for the same reason the workflow step's
      // is: a retried call is a second charge.
      maxRetries: 0,
    });
  } catch (error) {
    return {
      spend: null,
      result: {
        ok: false,
        failure: {
          reason: "provider_error",
          // One bounded line: provider errors can echo the prompt back.
          detail: errorLine(error),
        },
      },
    };
  }

  const spend: WriterSpend = {
    model: model.modelId,
    inputTokens: response.usage.inputTokens ?? 0,
    outputTokens: response.usage.outputTokens ?? 0,
    costUsd: openRouterCostUsd(response.providerMetadata),
  };

  // A generation that hit the ceiling is half an article. Presenting it as a
  // draft would put a document that stops mid-sentence in front of a human
  // with a law report attached, as though it had been graded fairly.
  if (response.finishReason === "length") {
    return {
      spend,
      result: {
        ok: false,
        failure: {
          reason: "truncated",
          detail: `The model stopped at the ${maxOutputTokens} token ceiling before finishing the article.`,
        },
      },
    };
  }

  const markdown = response.text.trim();
  if (markdown === "") {
    return {
      spend,
      result: {
        ok: false,
        failure: {
          reason: "provider_error",
          detail: "The model returned an empty response.",
        },
      },
    };
  }

  const shape = readDraftFrontmatter(markdown);
  if (!shape.ok) {
    return {
      spend,
      result: {
        ok: false,
        failure: {
          reason: "unparseable_frontmatter",
          detail: `The draft is missing required frontmatter: ${shape.missing.join(", ")}.`,
        },
      },
    };
  }

  return { spend, result: { ok: true, markdown } };
}

/**
 * The conversation. A fix replays the brief and the draft it produced before
 * asking for the repair, so the model is repairing its own document with the
 * original requirements still in view rather than editing a stranger's text.
 */
function buildMessages(
  input: WriterCallInput,
): Array<{ role: "user" | "assistant"; content: string }> {
  const brief: { role: "user"; content: string } = {
    role: "user",
    content: input.briefMd,
  };
  if (!input.repair) return [brief];
  return [
    brief,
    { role: "assistant", content: input.repair.previousMarkdown },
    { role: "user", content: renderRepairPayload(input.repair.payload) },
  ];
}

function errorLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").slice(0, 300);
}
