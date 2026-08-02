/** Engine types, ported from rankloop 0.2 (Python). One rule above all:
 * this package makes ZERO LLM calls. The laws that decide whether a post
 * ships are pure functions — the grader is never the author. */

export type SiteMode = "html" | "markdown";

export interface SiteConfig {
  url: string;
  name: string;
  description: string;
  /** Blog root relative to the site root; posts live at blogPath/<slug>/. */
  blogPath: string;
  mode: SiteMode;
}

/** Display category -> hub slug. The site's information architecture. */
export type Taxonomy = Record<string, string>;

export interface ClassifyRule {
  pattern: string;
  category?: string;
  format?: string;
}

export interface KeywordsConfig {
  /** Relevance gate: must match a positive pattern and no negative pattern.
   * These regexes ARE the niche. Joined with "|", compiled case-insensitive. */
  positive: string[];
  negative: string[];
  /** Site-authored classify rules, tried before the built-ins. */
  classify: ClassifyRule[];
}

export interface LawsConfig {
  wordMin: number;
  wordMax: number;
  h2Min: number;
  faqMin: number;
  internalLinksMin: number;
  titleMax: number;
  descriptionMax: number;
  /** A FRACTION: 0.025 = 2.5%. */
  keywordDensityMax: number;
  banEmDash: boolean;
  requireFirstPerson: boolean;
  /**
   * Fail a post that claims first-hand experience ("I tested", "I have
   * seen", "in my testing").
   *
   * OFF by default, and the default is the whole point: for a human author
   * those sentences are the best thing in the piece, and `requireFirstPerson`
   * exists to encourage exactly them. For a MACHINE author the same sentence
   * is a fabrication wearing a human voice, and no other law can catch it —
   * the rest of this table counts words, headings and links.
   *
   * So the caller who knows who is writing sets it: the app's writer gate
   * turns it on for generated drafts, `rankloop check` over a human's own
   * corpus leaves it off.
   */
  banExperienceClaims?: boolean;
  bannedPhrases: string[];
}

/** Defaults calibrated on the source engine's real corpus. */
export const DEFAULT_BANNED_PHRASES: string[] = [
  "delve into", "leverage the", "in today's fast-paced world",
  "it's important to note that", "in this guide", "let's explore",
  "at the heart of", "the bottom line is", "it's crucial to",
  "as you can see", "game-changer", "unlock the power",
  "seamlessly integrate", "in the ever-evolving", "navigating the landscape",
];

export function defaultLaws(): LawsConfig {
  return {
    wordMin: 850,
    wordMax: 4500,
    h2Min: 4,
    faqMin: 3,
    internalLinksMin: 2,
    titleMax: 70,
    descriptionMax: 165,
    keywordDensityMax: 0.025,
    banEmDash: true,
    requireFirstPerson: true,
    bannedPhrases: [...DEFAULT_BANNED_PHRASES],
  };
}

/** The engine-facing site configuration (the rankloop.toml equivalent;
 * in the product this is hydrated from the DB per site). */
export interface EngineConfig {
  site: SiteConfig;
  taxonomy: Taxonomy;
  keywords: KeywordsConfig;
  laws: LawsConfig;
}

/** One published post, derived entirely from its file/content. */
export interface Post {
  slug: string;
  title: string;
  description: string;
  /** ISO date (datePublished / frontmatter `date`). */
  date: string;
  category: string;
  /** The raw file text; the regex laws grep this. */
  raw: string;
  wordCount: number;
  /** Primary keyword (meta keywords tag / frontmatter `keyword`). */
  keyword: string | null;
  /** Reading time (html: timeRequired; md: words/200). */
  minutes: number;
}

export type Intent =
  | "commercial" | "transactional" | "informational" | "navigational"
  | (string & {});

/** A backlog row as the engine sees it (storage-agnostic). */
export interface KeywordRow {
  keyword: string;
  category: string | null;
  format: string | null;
  searchVolume: number | null;
  keywordDifficulty: number | null;
  intent: Intent | null;
  score: number | null;
  source: string | null;
  notes: string | null;
}

export interface SerpData {
  organic: { url?: string; title?: string; description?: string }[];
  paa: string[];
}

export type LawProblem = { slug: string; law: string };
