/** THE PUBLISH LAWS, ported from rankloop 0.2 laws.py.
 *
 * An LLM writer is a firehose; the only thing standing between a firehose
 * and a slop blog is a set of machine-checkable laws. This module is the
 * gate the whole honesty story rests on — and it deliberately contains no
 * model call of any kind: the grader is never the author.
 *
 * Law names and check semantics are parity-tested against the Python
 * implementation; the fixtures pin both the verdicts and their order. */

import type { EngineConfig, LawProblem, Post } from "./types.ts";
import {
  articleOf, countOccurrences, frontmatter, parseIsoDate, reEscape, stripTags, words,
} from "./text.ts";

/** Plain prose of a post — what the content laws measure. */
export function articleText(cfg: EngineConfig, post: Post): string {
  if (cfg.site.mode === "markdown") return frontmatter(post.raw)[1];
  return stripTags(articleOf(post.raw));
}

function kwDensity(cfg: EngineConfig, p: Post): number {
  const kw = p.keyword;
  if (!kw) return 0;
  const text = articleText(cfg, p).toLowerCase();
  const wc = Math.max(1, words(text).length);
  return (countOccurrences(text, kw) * words(kw).length) / wc;
}

export function fillerHits(cfg: EngineConfig, text: string): string[] {
  const low = text.toLowerCase();
  return cfg.laws.bannedPhrases.filter((f) => low.includes(f.toLowerCase()));
}

function canonicalOk(cfg: EngineConfig, p: Post): boolean {
  const expected = reEscape(
    `${cfg.site.url.replace(/\/+$/, "")}/${cfg.site.blogPath.replace(/^\/+|\/+$/g, "")}/${p.slug}/`,
  );
  // attribute order varies by generator; accept either
  return (
    new RegExp(`rel="canonical"\\s+href="${expected}"`).test(p.raw) ||
    new RegExp(`href="${expected}"\\s+rel="canonical"`).test(p.raw)
  );
}

function h2Count(cfg: EngineConfig, p: Post): number {
  if (cfg.site.mode === "markdown")
    return [...frontmatter(p.raw)[1].matchAll(/^## /gm)].length;
  return [...articleOf(p.raw).matchAll(/<h2[ >]/g)].length;
}

/** html: count 'faq-item' blocks (the template convention the JSON-LD
 * FAQPage mirrors). markdown has no class hook, so count question-shaped
 * headings (`## ... ?`) — the honest proxy. */
function faqCount(cfg: EngineConfig, p: Post): number {
  if (cfg.site.mode === "markdown")
    return [...frontmatter(p.raw)[1].matchAll(/^##+ .*\?\s*$/gm)].length;
  return countOccurrences(articleOf(p.raw), "faq-item");
}

function dateOk(p: Post): boolean {
  return parseIsoDate(p.date.slice(0, 10)) !== null;
}

export function internalSlugs(cfg: EngineConfig, text: string): string[] {
  const blog = reEscape(cfg.site.blogPath.replace(/^\/+|\/+$/g, ""));
  const rx =
    cfg.site.mode === "markdown"
      ? new RegExp(`\\]\\(/${blog}/([a-z0-9-]+)/?\\)`, "g")
      : new RegExp(`href="/${blog}/([a-z0-9-]+)/?"`, "g");
  return [...text.matchAll(rx)].map((m) => m[1]!);
}

type Law = [name: string, check: (p: Post) => boolean];

/** The law table, thresholds bound from cfg.laws. Order matters (the
 * report lists failures in table order) and is pinned by the fixtures. */
export function coreLaws(cfg: EngineConfig, validSlugs: Set<string>): Law[] {
  const L = cfg.laws;
  const laws: Law[] = [];
  if (L.banEmDash) {
    // the single highest-signal LLM tell; ban it and writers find real verbs
    laws.push(["em dash", (p) => !p.raw.includes("—")]);
  }
  if (cfg.site.mode === "html") {
    laws.push(["canonical", (p) => canonicalOk(cfg, p)]);
  }
  laws.push(
    ["category known", (p) => p.category in cfg.taxonomy],
    [`title <= ${L.titleMax} chars`, (p) => p.title.length > 0 && p.title.length <= L.titleMax],
    [
      `description <= ${L.descriptionMax} chars`,
      (p) => p.description.length > 0 && p.description.length <= L.descriptionMax,
    ],
    ["date parses", dateOk],
    [`word count >= ${L.wordMin}`, (p) => p.wordCount >= L.wordMin],
    [`word count <= ${L.wordMax}`, (p) => p.wordCount <= L.wordMax],
    [`h2 sections >= ${L.h2Min}`, (p) => h2Count(cfg, p) >= L.h2Min],
    [`faq entries >= ${L.faqMin}`, (p) => faqCount(cfg, p) >= L.faqMin],
    // only links that RESOLVE count — an invented slug is not an internal link
    [
      `internal links >= ${L.internalLinksMin}`,
      (p) => internalSlugs(cfg, p.raw).filter((s) => validSlugs.has(s)).length >= L.internalLinksMin,
    ],
    [
      "keyword in body",
      (p) => p.keyword === null || articleText(cfg, p).toLowerCase().includes(p.keyword),
    ],
    [
      `keyword density <= ${(L.keywordDensityMax * 100).toFixed(1)}%`,
      (p) => kwDensity(cfg, p) <= L.keywordDensityMax,
    ],
    ["no filler AI phrases", (p) => fillerHits(cfg, articleText(cfg, p)).length === 0],
  );
  if (L.requireFirstPerson) {
    laws.push([
      "first-person experience",
      // deliberately case-sensitive, same as the source: "I " is a capital
      (p) => /\b(I |I've|my |we |our |in my testing|I measured|I found|I built)/.test(articleText(cfg, p)),
    ]);
  }
  if (L.banExperienceClaims) {
    laws.push([
      "no claimed experience",
      (p) => experienceClaims(articleText(cfg, p)).length === 0,
    ]);
  }
  return laws;
}

/**
 * Sentences where the author claims to have done something.
 *
 * The hard part is that this law and `requireFirstPerson` want opposite
 * things from the same pronoun, so the patterns match a first-person verb of
 * DOING or WITNESSING and nothing else. "I find", "I would start with", "my
 * setup", "I recommend" are voice and stay legal; "I tested", "I have seen",
 * "in my testing" are evidence, and a machine that writes them is inventing a
 * credential.
 *
 * Kept narrow on purpose. A false positive here sends a good draft back into
 * the repair loop and costs a generation, so the list is verbs a writer
 * cannot honestly use without having been there.
 */
export function experienceClaims(text: string): string[] {
  const rx =
    // The subject may carry a contraction ("I've"), an auxiliary ("I have"),
    // or neither ("I tested") — hence the optional group before the verb
    // rather than a required space after the pronoun.
    /\b(?:I|we)(?:'ve|\s+have|\s+had)?\s+(?:tested|tried|used|ran|run|opened|installed|measured|benchmarked|timed|weighed|monitored|observed|witnessed|seen|watched)\b|\bin\s+(?:my|our)\s+(?:testing|tests|experience|trials|lab|kitchen|setup)\b|\b(?:my|our)\s+(?:testing|tests|benchmarks|measurements)\s+(?:showed|found|revealed)\b|\bwhen\s+(?:I|we)\s+(?:tested|tried|ran|measured)\b/gi;
  return [...text.matchAll(rx)].map((m) => m[0]);
}

/** Validate a corpus against the laws. Returns every violation; an empty
 * array is the green light. A check that throws counts as a failure. */
export function validate(cfg: EngineConfig, posts: Post[]): LawProblem[] {
  const validSlugs = new Set([...posts.map((p) => p.slug), ...Object.values(cfg.taxonomy)]);
  const problems: LawProblem[] = [];
  for (const p of posts) {
    for (const [law, check] of coreLaws(cfg, validSlugs)) {
      let ok: boolean;
      try {
        ok = check(p);
      } catch {
        ok = false;
      }
      if (!ok) problems.push({ slug: p.slug, law });
    }
  }
  return problems;
}
