// Pure functions behind the project's relevance gate (spec 0016): the one
// tokenizer the universe step shares, the derivation that reads a project's
// own evidence, and the translation from a stored gate into the EngineConfig
// @rankloop/engine's relevant()/classify()/score() expect. No I/O — unit-tested
// directly in gate.logic.test.ts.
//
// This is the niche knowledge v1 read out of a hand-authored rankloop.toml.
// Nothing here names a product, a vertical or a domain: the vocabulary comes
// from the project's own titles, paths and earned queries, and a human edits
// it afterwards. A model never guesses it.

import { defaultLaws } from "@rankloop/engine";
import type { EngineConfig } from "@rankloop/engine";
import { isBrandQuery } from "@/server/features/rankloop/proposals/signals.logic";

// ---------------------------------------------------------------------------
// Tokenizing
// ---------------------------------------------------------------------------

/** Tokens under 3 chars ("io", "at") appear in half of everything and
 *  discriminate nothing — the floor planner.logic and the outreach asset
 *  match both draw in the same place. */
const MIN_TOKEN_LENGTH = 3;

// Two kinds of noise, one list: English function words, and the URL plumbing
// every CMS puts in every path ("blog", "index", "html"). Both clear a
// document-frequency bar with room to spare, so both would spend the 40
// positive slots on words that describe no niche at all. Deliberately short —
// a long stopword list starts deleting the words a niche is made of, and this
// one has to survive being pointed at somebody else's site.
const STOPWORDS = new Set([
  "about",
  "and",
  "are",
  "but",
  "can",
  "does",
  "for",
  "from",
  "get",
  "has",
  "have",
  "how",
  "into",
  "its",
  "not",
  "our",
  "out",
  "should",
  "than",
  "that",
  "the",
  "their",
  "them",
  "there",
  "these",
  "they",
  "this",
  "was",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "will",
  "with",
  "you",
  "your",
  // URL and CMS plumbing.
  "amp",
  "article",
  "articles",
  "blog",
  "category",
  "com",
  "default",
  "home",
  "htm",
  "html",
  "index",
  "main",
  "net",
  "org",
  "page",
  "pages",
  "php",
  "post",
  "posts",
  "tag",
  "tags",
  "www",
]);

/**
 * The universe step's one tokenizer: lowercased words of three characters or
 * more, minus stopwords and bare numbers, deduped in first-seen order.
 *
 * Deliberately not planner.logic's `stems`. That one trims plurals so two
 * clusters can merge under one name; this one has to read URL paths as well
 * as prose (hence the CMS plumbing in the stopword list) and its output
 * becomes a matching pattern rather than a label. Deduping is what makes a
 * call over one document a document-frequency vote instead of a word count —
 * a title that says "espresso" four times is still one page of evidence.
 */
export function topicTokens(text: string): string[] {
  const tokens: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < MIN_TOKEN_LENGTH) continue;
    if (STOPWORDS.has(raw)) continue;
    // Bare numbers are dates and pagination ("/2024/05/", "page 2"), never
    // topics. A number attached to a word ("18650", "4k") survives as part of
    // that word because the split above never separated them.
    if (/^\d+$/.test(raw)) continue;
    if (!tokens.includes(raw)) tokens.push(raw);
  }
  return tokens;
}

/** The normalized token set of a phrase: the same tokens, sorted and joined.
 *  Two phrasings of one question ("how to descale a breville", "descale
 *  breville how") collapse to the same key, which is what near-duplicate
 *  clustering and the already-served check both compare on. */
export function normalizeTokenSet(text: string): string {
  return topicTokens(text).toSorted().join(" ");
}

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

/** A token has to show up in three of the project's own documents before it
 *  describes the site rather than one page of it. Two would admit every
 *  cross-link pair; four starves a site with twenty pages. */
const POSITIVE_MIN_DOCUMENTS = 3;

/** Forty literal alternatives is a regex the engine compiles in microseconds
 *  and a card a human can still read. Past that the tail tokens are page
 *  furniture, not the niche. */
export const POSITIVE_TOKEN_CAP = 40;

/**
 * The junk orbit every niche shares.
 *
 * These are the queries that reach any site with traffic regardless of what
 * it is about — job hunters, pirates, casinos, crypto, people looking for a
 * login box, coupon scrapers. Shipping them as a default costs nothing and
 * saves every new project from writing the same nine lines; they are stored
 * on the row rather than read from this constant so that a user who deletes
 * one keeps it deleted through the next rankloop upgrade.
 */
const DEFAULT_NEGATIVE_TOKENS: readonly string[] = [
  "jobs",
  "salary",
  "torrent",
  "casino",
  "crypto",
  "login",
  "coupon code",
  "free download",
];

/** The project's own evidence: what it has published, and what it already
 *  earns impressions for. Nothing else — a gate derived from a vendor's idea
 *  of the niche would be a guess wearing a measurement's clothes. */
type GateEvidence = {
  /** One document per content page. Title and path fold into a single string
   *  because a token in both is one page's worth of evidence, not two. */
  pages: { title: string | null; path: string }[];
  /** One document per query the site already earns impressions for. */
  queries: string[];
};

type DerivedGate = {
  positives: string[];
  negatives: string[];
  brandTokens: string[];
};

/**
 * Derive the relevance gate from a project's own evidence.
 *
 * Brand tokens are dropped before the count, because the brand is in every
 * title on the site: left in, it would clear the document-frequency bar first
 * and then admit the entire internet that happens to mention the brand. The
 * cost is real and deliberate — a site whose brand IS its niche ("Espresso
 * Obsession") loses "espresso" as a positive. That failure mode is visible on
 * the gate card and fixable with one click; the opposite failure is silent.
 *
 * A project with no pages and no earned queries derives no positives, and an
 * empty positive list admits everything the negatives don't veto. That is the
 * honest day-one behaviour: refusing every candidate because the site hasn't
 * published yet would make the first run return nothing at all and teach the
 * user nothing about why.
 */
export function deriveRelevanceGate(input: {
  evidence: GateEvidence;
  brandTokens: string[];
}): DerivedGate {
  const documents = [
    ...input.evidence.pages.map((page) => `${page.title ?? ""} ${page.path}`),
    ...input.evidence.queries,
  ];

  const documentCounts = new Map<string, number>();
  for (const document of documents) {
    for (const token of topicTokens(document)) {
      // Substring, not equality: brand queries concatenate ("acmeapp docs"),
      // which is the same reasoning isBrandQuery was written for.
      if (isBrandQuery(token, input.brandTokens)) continue;
      documentCounts.set(token, (documentCounts.get(token) ?? 0) + 1);
    }
  }

  const positives = [...documentCounts.entries()]
    .filter(([, count]) => count >= POSITIVE_MIN_DOCUMENTS)
    // Commonest first so the cap keeps the tokens the site is most about; the
    // token breaks ties so two derivations over the same corpus produce the
    // same gate in the same order.
    .toSorted(
      ([aToken, aCount], [bToken, bCount]) =>
        bCount - aCount || aToken.localeCompare(bToken),
    )
    .slice(0, POSITIVE_TOKEN_CAP)
    .map(([token]) => token);

  return {
    positives,
    negatives: [...DEFAULT_NEGATIVE_TOKENS],
    brandTokens: [...input.brandTokens],
  };
}

// ---------------------------------------------------------------------------
// Engine translation
// ---------------------------------------------------------------------------

/** The stored tokens are literals, never patterns — that is what makes an
 *  edited gate incapable of becoming a syntax error or a catastrophic
 *  backtrack. Escaping happens here, at the one seam where they meet a
 *  regex. */
function escapeLiteral(token: string): string {
  return token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build the EngineConfig the engine's three shared functions read.
 *
 * `relevant` and `classify` only ever touch `keywords` and `taxonomy`; the
 * site block and the laws are required by the type and read by nobody on this
 * path, so they carry the project's own values and the engine defaults rather
 * than anything invented.
 */
export function toEngineConfig(input: {
  project: { name: string; domain: string | null };
  positives: string[];
  negatives: string[];
}): EngineConfig {
  return {
    site: {
      url: input.project.domain ? `https://${input.project.domain}` : "",
      name: input.project.name,
      description: "",
      blogPath: "blog",
      mode: "markdown",
    },
    // Empty on purpose. classify() falls back to its built-in category names
    // ("Compare", "Reviews", "Lists", "Data", "Guides") when the taxonomy
    // doesn't claim the one it proposed, and those names are exactly what
    // keyword_backlog.category wants at this step. Real page types are S6's
    // job; a taxonomy invented here would be niche vocabulary living in code.
    taxonomy: {},
    keywords: {
      positive: input.positives.map(escapeLiteral),
      negative: input.negatives.map(escapeLiteral),
      classify: [],
    },
    laws: defaultLaws(),
  };
}
