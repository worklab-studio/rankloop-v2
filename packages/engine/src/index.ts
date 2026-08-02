/** @rankloop/engine — the rankloop method as a pure TypeScript library.
 *
 * Zero LLM calls in this package, by design and forever: the laws that
 * decide whether a post ships must never be graded by the thing that
 * wrote the post. Generation lives in @rankloop/writer; storage lives in
 * the app. This package is the method.
 *
 * Ported from rankloop 0.2 (github.com/worklab-studio/rankloop) and
 * parity-tested against it — see test/fixtures + tools/gen-parity-fixtures.py. */

export * from "./types.ts";
export {
  slugify, xmlEscape, unescapeEntities, articleOf, stripTags, frontmatter,
  words, parseIsoDate, reEscape, countOccurrences,
} from "./text.ts";
export { relevant, classify, score } from "./score.ts";
export { computeQuota, type QuotaConfig } from "./quota.ts";
export { applyPoolMix, type Slot } from "./pick.ts";
export { parseHtmlPost, parseMdPost, manifest, type CorpusEntry } from "./parse.ts";
export {
  articleText, fillerHits, internalSlugs, experienceClaims, coreLaws, validate,
} from "./laws.ts";
export {
  linkCandidates, serpSection, renderBrief, resolveCategory, type BriefInput,
} from "./brief.ts";
export {
  postUrl, sitemap, rss, rfc822, llmsTxt, llmsFull, articleMarkdown, mdBody,
  type SitemapOptions,
} from "./wire.ts";
