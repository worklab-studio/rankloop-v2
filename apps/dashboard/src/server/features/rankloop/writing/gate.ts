// The gate: the half of the writer that never touches a model (spec 0020).
//
// A generated draft is adapted into the only two things @rankloop/engine
// grades — a parsed Post and an EngineConfig — and the verdicts come back from
// the engine's own `validate`. Nothing in this file re-implements a law. The
// checks are parity-tested against the Python original, and a second
// definition of "how long is long enough" living in the app would fork the
// method the product sells.
//
// What this file adds is the two things `validate` deliberately does not do.
// It reports the laws that PASSED as well as the ones that failed, because the
// report is the receipt for quality and a receipt listing only failures proves
// nothing. And it pulls the offending text out of the draft wherever a law can
// point at one, so the repair call argues from the draft's own words instead of
// from a law name.
//
// There is no provider import here and there never will be: the thing that
// grades the article is not the thing that wrote it.

import {
  articleText,
  coreLaws,
  fillerHits,
  frontmatter,
  experienceClaims,
  internalSlugs,
  parseMdPost,
  validate,
} from "@rankloop/engine";
import type { EngineConfig, Post } from "@rankloop/engine";
import type { TemplateContract } from "@/server/features/rankloop/page-plan/contracts.logic";
import type {
  RankloopLawReport,
  RankloopLawResult,
} from "@/types/schemas/rankloopWriter";
import {
  blogRootFrom,
  mergeContractLaws,
  taxonomyFrom,
  toLinkPosts,
} from "./brief";
import type { BriefContentPage } from "./brief";

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

/**
 * A stable id per law, for code that has to branch on one.
 *
 * The engine's law names carry their own numbers ("word count >= 850"), which
 * is right for a report a human reads and wrong for a switch statement: a page
 * type moving the word band would silently fall through every case. `unknown`
 * is the honest landing spot for a law the engine grows later — it still
 * reaches the report and the fix call, just without this build's commentary.
 */
export type LawId =
  | "emDash"
  | "canonical"
  | "categoryKnown"
  | "titleMax"
  | "descriptionMax"
  | "dateParses"
  | "wordMin"
  | "wordMax"
  | "h2Min"
  | "faqMin"
  | "internalLinksMin"
  | "keywordInBody"
  | "keywordDensityMax"
  | "bannedPhrases"
  | "firstPerson"
  | "experienceClaims"
  | "unknown";

/** A quote from the draft showing why a law failed. */
export type LawExcerpt = {
  /** Verbatim from the draft, trimmed to the sentence around the offense. */
  quote: string;
  /** What it is an instance of, in the fewest words. */
  label: string;
};

/**
 * One law's verdict: the persisted shape, plus what the gate can add.
 *
 * `law`, `passed`, `threshold` and `excerpt` are `RankloopLawResult`, which is
 * what `articles.law_report_json` stores and what the detail page renders.
 * They are widened here rather than redefined so there is one definition of a
 * verdict across the adapter, the repair call and the UI. The three additions
 * are the gate's own: a stable id to branch on, the measurement behind the
 * verdict, and every excerpt rather than only the first.
 */
export type LawVerdict = RankloopLawResult & {
  id: LawId;
  /** What the draft actually has, where the engine hands over the number. */
  observed: string | null;
  /** Empty unless the law failed AND can point at text. */
  excerpts: LawExcerpt[];
};

export type LawReport = Omit<RankloopLawReport, "laws"> & {
  slug: string;
  violations: number;
  /**
   * False when the draft carried no `--- key: value ---` block the engine
   * could read. Every metadata law then fails at once for one upstream reason,
   * and the workflow needs to tell that apart from a title three characters
   * too long: the first is a broken generation, the second is a fixable draft.
   */
  frontmatterParsed: boolean;
  /** Every law, pass or fail, in the engine's table order. */
  laws: LawVerdict[];
};

/**
 * Everything the gate needs, and nothing it could fetch itself.
 *
 * Deliberately the same shape as `BriefInputs`: the gate has to grade against
 * the taxonomy, the blog root and the contract the brief already promised the
 * writer, or the article is judged by rules it was never given.
 */
export type GateInput = {
  slug: string;
  /** The generated draft: frontmatter plus body, exactly as it was returned. */
  draft: string;
  site: { url: string; name: string; description: string };
  pageTypeName: string;
  contract: TemplateContract | null;
  urlPattern: string | null;
  approvedTypeNames: string[];
  /** Real pages on the site. These are what makes an internal link resolve. */
  pages: BriefContentPage[];
  /** ISO timestamp, injected rather than read from the clock here: the same
   *  draft has to grade identically in a test and in a re-run. */
  checkedAt: string;
};

// ---------------------------------------------------------------------------
// Law identification
// ---------------------------------------------------------------------------

type LawSpec = { id: LawId; prefix: string };

// Matched on the stable prose prefix rather than the whole name, so a page
// type that moves a threshold cannot break the mapping.
const LAW_SPECS: readonly LawSpec[] = [
  { id: "emDash", prefix: "em dash" },
  { id: "canonical", prefix: "canonical" },
  { id: "categoryKnown", prefix: "category known" },
  { id: "titleMax", prefix: "title <= " },
  { id: "descriptionMax", prefix: "description <= " },
  { id: "dateParses", prefix: "date parses" },
  { id: "wordMin", prefix: "word count >= " },
  { id: "wordMax", prefix: "word count <= " },
  { id: "h2Min", prefix: "h2 sections >= " },
  { id: "faqMin", prefix: "faq entries >= " },
  { id: "internalLinksMin", prefix: "internal links >= " },
  { id: "keywordInBody", prefix: "keyword in body" },
  { id: "keywordDensityMax", prefix: "keyword density <= " },
  { id: "bannedPhrases", prefix: "no filler AI phrases" },
  { id: "firstPerson", prefix: "first-person experience" },
  { id: "experienceClaims", prefix: "no claimed experience" },
];

function identify(law: string): LawId {
  return LAW_SPECS.find((spec) => law.startsWith(spec.prefix))?.id ?? "unknown";
}

// ---------------------------------------------------------------------------
// Excerpts
// ---------------------------------------------------------------------------

const EM_DASH = "—";
/** One sentence is the unit a writer can act on; more is the whole draft. */
const EXCERPT_MAX_CHARS = 200;
/** A repair prompt listing twenty instances of one mistake teaches nothing the
 *  first five did not, and every extra instance is paid for in tokens. */
const MAX_EXCERPTS_PER_LAW = 5;

const SENTENCE_MARKS = [". ", "! ", "? ", "\n"];

/** The sentence containing `index`, clamped. Prose boundaries only: markdown
 *  headings and list items end at the newline, which is what a writer sees. */
function sentenceAround(text: string, index: number): string {
  let start = 0;
  let end = text.length;
  for (const mark of SENTENCE_MARKS) {
    const before = text.lastIndexOf(mark, index);
    if (before !== -1 && before + mark.length > start) {
      start = before + mark.length;
    }
    const after = text.indexOf(mark, index);
    if (after !== -1 && after + mark.length < end) end = after + mark.length;
  }
  const quote = text.slice(start, end).trim();
  return quote.length > EXCERPT_MAX_CHARS
    ? `${quote.slice(0, EXCERPT_MAX_CHARS).trimEnd()}…`
    : quote;
}

/** Scanned over the raw draft, not the body: the law is `!raw.includes("—")`,
 *  so an em dash in the title is a violation and has to be quotable. */
function emDashExcerpts(raw: string): LawExcerpt[] {
  const excerpts: LawExcerpt[] = [];
  let from = 0;
  for (;;) {
    const at = raw.indexOf(EM_DASH, from);
    if (at === -1 || excerpts.length >= MAX_EXCERPTS_PER_LAW) return excerpts;
    excerpts.push({ quote: sentenceAround(raw, at), label: "em dash" });
    from = at + 1;
  }
}

/** One excerpt per distinct phrase rather than per occurrence: the fix is to
 *  rewrite the habit, and the writer finds the second "delve into" itself. */
function bannedPhraseExcerpts(body: string, hits: string[]): LawExcerpt[] {
  const low = body.toLowerCase();
  return hits.slice(0, MAX_EXCERPTS_PER_LAW).map((phrase) => {
    const at = low.indexOf(phrase.toLowerCase());
    return {
      quote: at === -1 ? phrase : sentenceAround(body, at),
      label: `banned phrase: "${phrase}"`,
    };
  });
}

/** The path as the writer wrote it, rebuilt from the slug the engine's own
 *  link regex found — quoting the whole link would drag the anchor text in. */
function deadLinkExcerpts(blogPath: string, slugs: string[]): LawExcerpt[] {
  return slugs.slice(0, MAX_EXCERPTS_PER_LAW).map((slug) => ({
    quote: `/${blogPath}/${slug}/`,
    label: "no page at this path",
  }));
}

// ---------------------------------------------------------------------------
// Measurements the engine already exposes
// ---------------------------------------------------------------------------

type DraftFacts = {
  /** The prose the content laws measure (frontmatter stripped). */
  body: string;
  bannedHits: string[];
  /** Counted with duplicates, exactly as the internal-links law counts them. */
  resolvableLinks: number;
  deadLinkSlugs: string[];
};

function measure(
  cfg: EngineConfig,
  post: Post,
  validSlugs: Set<string>,
): DraftFacts {
  const body = articleText(cfg, post);
  const linked = internalSlugs(cfg, post.raw);
  return {
    body,
    bannedHits: fillerHits(cfg, body),
    resolvableLinks: linked.filter((slug) => validSlugs.has(slug)).length,
    deadLinkSlugs: [...new Set(linked.filter((slug) => !validSlugs.has(slug)))],
  };
}

function thresholdFor(id: LawId, cfg: EngineConfig, post: Post): string | null {
  const laws = cfg.laws;
  switch (id) {
    case "emDash":
      return "none anywhere";
    case "canonical":
      return "the post's own URL";
    case "categoryKnown":
      return `one of: ${Object.keys(cfg.taxonomy).join(", ")}`;
    case "titleMax":
      return `${laws.titleMax} characters`;
    case "descriptionMax":
      return `${laws.descriptionMax} characters`;
    case "dateParses":
      return "YYYY-MM-DD";
    case "wordMin":
      return `${laws.wordMin} words`;
    case "wordMax":
      return `${laws.wordMax} words`;
    case "h2Min":
      return `${laws.h2Min} H2 sections`;
    case "faqMin":
      return `${laws.faqMin} FAQ entries`;
    case "internalLinksMin":
      return `${laws.internalLinksMin} links that resolve`;
    case "keywordInBody":
      return post.keyword === null
        ? "no keyword to check"
        : `the keyword "${post.keyword}" appears in the body`;
    case "keywordDensityMax":
      return `${(laws.keywordDensityMax * 100).toFixed(1)}% of body words`;
    case "bannedPhrases":
      return `none of the ${laws.bannedPhrases.length} banned phrases`;
    case "firstPerson":
      return "at least one first-person passage";
    case "experienceClaims":
      return "no claimed first-hand experience";
    case "unknown":
      return null;
  }
}

/**
 * What the draft actually has.
 *
 * Only where the engine already hands over the number: `Post` carries the word
 * count and the metadata, and `fillerHits` / `internalSlugs` are exported. The
 * H2 count, the FAQ count and the keyword density are the engine's private
 * counters, so this reports no number for them rather than counting them a
 * second way and printing a figure the law might disagree with.
 */
function observedFor(id: LawId, post: Post, facts: DraftFacts): string | null {
  switch (id) {
    case "titleMax":
      return `${post.title.length} characters`;
    case "descriptionMax":
      return `${post.description.length} characters`;
    case "categoryKnown":
      return post.category === "" ? "no category" : `"${post.category}"`;
    case "dateParses":
      return post.date === "" ? "no date" : `"${post.date}"`;
    case "wordMin":
    case "wordMax":
      return `${post.wordCount} words`;
    case "internalLinksMin": {
      const resolving = `${facts.resolvableLinks} resolving link${
        facts.resolvableLinks === 1 ? "" : "s"
      }`;
      const dead = facts.deadLinkSlugs.length;
      return dead === 0
        ? resolving
        : `${resolving}, ${dead} dead path${dead === 1 ? "" : "s"}`;
    }
    case "bannedPhrases":
      return `${facts.bannedHits.length} phrase${
        facts.bannedHits.length === 1 ? "" : "s"
      }`;
    default:
      return null;
  }
}

/** Only the three laws that can point at text. Everything else fails for an
 *  absence, and quoting an absence is how a fix prompt starts inventing. */
/** The sentence around each invented credential. This law is the one where
 *  the quote does the whole job: "I have opened enough machines to know" is
 *  self-evidently wrong once a writer sees it beside the instruction not to
 *  claim experience, and a law name alone would not land. */
function experienceExcerpts(body: string): LawExcerpt[] {
  const seen = new Set<string>();
  const out: LawExcerpt[] = [];
  for (const claim of experienceClaims(body)) {
    const at = body.indexOf(claim);
    if (at === -1) continue;
    const quote = sentenceAround(body, at);
    if (seen.has(quote)) continue;
    seen.add(quote);
    out.push({ quote, label: claim.trim() });
    if (out.length >= MAX_EXCERPTS_PER_LAW) break;
  }
  return out;
}

function excerptsFor(
  id: LawId,
  cfg: EngineConfig,
  post: Post,
  facts: DraftFacts,
): LawExcerpt[] {
  switch (id) {
    case "emDash":
      return emDashExcerpts(post.raw);
    case "bannedPhrases":
      return bannedPhraseExcerpts(facts.body, facts.bannedHits);
    case "internalLinksMin":
      return deadLinkExcerpts(cfg.site.blogPath, facts.deadLinkSlugs);
    case "experienceClaims":
      return experienceExcerpts(facts.body);
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

function buildConfig(input: GateInput, blogRoot: string): EngineConfig {
  return {
    site: {
      url: input.site.url,
      name: input.site.name,
      description: input.site.description,
      blogPath: blogRoot,
      // The writer's required output shape is `--- key: value ---` frontmatter
      // plus a markdown body, so the draft is graded as markdown whatever the
      // publish adapter later renders it into.
      mode: "markdown",
    },
    taxonomy: taxonomyFrom(input.approvedTypeNames, input.pageTypeName),
    // Empty for the same reason the brief leaves them empty: the relevance
    // gate ran back in S5, and no publish law reads these patterns.
    keywords: { positive: [], negative: [], classify: [] },
    laws: {
      ...mergeContractLaws(input.contract),
      // The author here is a model, always. The engine leaves this law off by
      // default because a human writing about their own site may genuinely
      // have tested the thing, and requireFirstPerson wants them to say so.
      // A machine writing "I have opened enough machines to know" is inventing
      // a credential, and no other law in the table can see it — they count
      // words, headings and links, and a fabricated sentence counts perfectly.
      // Observed on the first live generation (2026-08-01): 14 laws passed and
      // the draft still claimed two first-hand experiences.
      banExperienceClaims: true,
    },
  };
}

/**
 * Grade one draft. Free, deterministic, and callable as often as the user
 * edits — which is the point of keeping it out of the model's reach: fixing a
 * sentence by hand must never cost another generation.
 */
export function runGate(input: GateInput): LawReport {
  const blogRoot = blogRootFrom(
    input.pages.map((page) => page.path),
    input.urlPattern,
  );
  const cfg = buildConfig(input, blogRoot);
  const post = parseMdPost(input.slug, input.draft);

  // `validate` derives the resolvable-slug set from the corpus it is handed,
  // so the site's existing posts have to be IN that corpus. Their verdicts are
  // discarded below: they are link targets, not the thing being graded. A
  // neighbour sharing the draft's slug is dropped first, or its failures would
  // be indistinguishable from the draft's own.
  const neighbours = toLinkPosts(input.pages, blogRoot).filter(
    (page) => page.slug !== post.slug,
  );
  const failed = new Set(
    validate(cfg, [post, ...neighbours])
      .filter((problem) => problem.slug === post.slug)
      .map((problem) => problem.law),
  );

  // Mirrors the set `validate` builds internally; it exists here only so the
  // excerpts can name the links that did not resolve.
  const validSlugs = new Set([
    post.slug,
    ...neighbours.map((page) => page.slug),
    ...Object.values(cfg.taxonomy),
  ]);
  const facts = measure(cfg, post, validSlugs);

  const laws: LawVerdict[] = coreLaws(cfg, validSlugs).map(([law]) => {
    const id = identify(law);
    const passed = !failed.has(law);
    const excerpts = passed ? [] : excerptsFor(id, cfg, post, facts);
    return {
      id,
      law,
      passed,
      threshold: thresholdFor(id, cfg, post),
      observed: observedFor(id, post, facts),
      excerpts,
      // The persisted field the checklist renders: the first instance, quoted
      // bare. Five near-identical em dashes in a receipt is noise; the repair
      // call reads `excerpts` and gets all of them.
      excerpt: excerpts[0]?.quote ?? null,
    };
  });

  const violations = laws.filter((verdict) => !verdict.passed).length;
  return {
    slug: post.slug,
    passed: violations === 0,
    violations,
    checkedAt: input.checkedAt,
    // The gate graded a draft, so there is no honesty case to record here.
    // A provider error, a truncated generation and frontmatter nothing could
    // read all happen before this function is reachable, and the workflow owns
    // saying so.
    failure: null,
    frontmatterParsed: Object.keys(frontmatter(input.draft)[0]).length > 0,
    laws,
  };
}
