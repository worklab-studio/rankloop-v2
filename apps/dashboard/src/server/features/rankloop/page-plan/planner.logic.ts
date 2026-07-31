// Pure functions behind the page-type planner (spec 0017): the shipped
// pattern table that turns gated backlog rows into candidate page types, the
// editorial clustering that catches whatever the patterns miss, and the
// demand / KD-band math every candidate carries. No I/O, no provider call, no
// model call — unit-tested directly in planner.logic.test.ts.

import { PLAN_SERP_CALL_BUDGET } from "@/shared/rankloop-page-plan";

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** The slice of a keyword_backlog row detection reads. */
export type PlannerBacklogRow = {
  id: string;
  keyword: string;
  searchVolume: number | null;
  keywordDifficulty: number | null;
  /**
   * 28-day Search Console impressions for a GSC-evidenced row. The universe
   * step stores it in notesJson and scores with it (S5's volume imputation);
   * demand reads the same number for the same reason — a query the site
   * already earns impressions for has proven demand, and a vendor zero must
   * not outvote it.
   */
  impressions28: number | null;
};

/** Σ-able demand for one row: the larger of what the vendor priced and what
 *  Search Console actually measured. Both null is a real zero — a long-tail
 *  row with no metrics still belongs to its type, it just adds no demand. */
export function effectiveVolume(row: PlannerBacklogRow): number {
  return Math.max(row.searchVolume ?? 0, row.impressions28 ?? 0);
}

// ---------------------------------------------------------------------------
// The shipped pattern table
// ---------------------------------------------------------------------------

type PagePattern = {
  key: string;
  name: string;
  /** Tested against the lowercased keyword. First match in table order wins:
   *  "best espresso machine vs delonghi" is a comparison, not a list. */
  matcher: RegExp;
  /** `{slug}` is filled per instance by the writer, not here. */
  urlPattern: string;
  /** The engine's format vocabulary (score.ts classify) — the writer's brief
   *  and the schema mapping in contracts.logic both read it. */
  format: string;
};

/**
 * Eight structural shapes, in precedence order.
 *
 * These are shapes, not niches: nothing here names a product, a domain or a
 * vertical, because niche knowledge belongs to the user's own backlog. A
 * keyword's word shape is what tells you which page the searcher expects,
 * which is exactly what the v1 engine's classifier learned on a real corpus.
 */
const PAGE_PATTERNS: readonly PagePattern[] = [
  {
    key: "comparisons",
    name: "Comparisons",
    matcher: /\bvs\b|versus/,
    urlPattern: "/compare/{slug}/",
    format: "comparison",
  },
  {
    key: "alternatives",
    name: "Alternatives",
    matcher: /alternative to|alternatives/,
    urlPattern: "/alternatives/{slug}/",
    format: "comparison",
  },
  {
    key: "best-of",
    name: "Best-of lists",
    matcher: /\bbest\b|\btop\b.*\bfor\b/,
    urlPattern: "/best/{slug}/",
    format: "listicle",
  },
  {
    key: "how-to",
    name: "How-to guides",
    matcher: /^how (to|do|can)/,
    urlPattern: "/how-to/{slug}/",
    format: "how-to",
  },
  {
    key: "glossary",
    name: "Glossary",
    matcher: /^what (is|are)/,
    urlPattern: "/glossary/{slug}/",
    format: "explainer",
  },
  {
    key: "troubleshooting",
    name: "Troubleshooting",
    matcher: /not working|won'?t|error|fix/,
    urlPattern: "/fix/{slug}/",
    format: "troubleshooting",
  },
  {
    key: "specs",
    name: "Specs and data",
    matcher: /size|dimensions|specs|chart|comparison table/,
    urlPattern: "/specs/{slug}/",
    format: "data",
  },
  {
    key: "pricing",
    // A price page is a data page: the answer is a number with a source, so
    // it inherits the data format's table-and-provenance contract.
    name: "Pricing",
    matcher: /price|pricing|cost|how much/,
    urlPattern: "/pricing/{slug}/",
    format: "data",
  },
];

/** The first pattern claiming a keyword, or null for the editorial pool. */
export function matchPattern(keyword: string): PagePattern | null {
  const k = keyword.toLowerCase();
  return PAGE_PATTERNS.find((pattern) => pattern.matcher.test(k)) ?? null;
}

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/** A pSEO template that would ship three pages is not a template — it is
 *  three posts, and the hub, the dataset and the URL pattern it drags along
 *  cost more than they return. */
const MIN_INSTANCES_PSEO = 4;

/** Editorial clusters are held to a lower bar: a blog category is a shelf,
 *  not a machine, and three posts is a shelf. This is also the floor a
 *  cluster must clear to form at all — the same rule seen twice. */
const MIN_INSTANCES_BLOG = 3;

/** Two tokens is a topic ("espresso machine"); three is a title, and a
 *  cluster keyed on a title has exactly one member. */
const CLUSTER_MAX_TOKENS = 2;

/** Tokens under 3 chars ("io", "at") match half the backlog and mean
 *  nothing — the floor the outreach asset match uses too. */
const MIN_TOKEN_LENGTH = 3;

/** How many example keywords a card quotes. Three is enough for a founder to
 *  recognize the shape and few enough to read in one glance. */
const EXAMPLE_TITLE_COUNT = 3;

/** SERP samples per candidate. Six readings is enough to see a majority and
 *  cheap enough that a plan covering seven types fits the 40-call budget. */
const SAMPLES_PER_CANDIDATE = 6;

// The junk orbit of English question keywords: present in every niche,
// discriminating in none. Kept small on purpose — a long stopword list
// starts deleting real topic words ("best", "size") that the pattern table
// has already had its chance at.
const STOPWORDS = new Set([
  "and",
  "are",
  "but",
  "can",
  "did",
  "does",
  "for",
  "from",
  "get",
  "has",
  "how",
  "into",
  "its",
  "not",
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
]);

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

export type KdBand = { p25: number; p75: number };

export type PageTypeCandidate = {
  /** Stable within a run: the pattern key, or `cluster:<tokens>`. */
  key: string;
  name: string;
  kind: "pseo" | "blog";
  urlPattern: string;
  /** Stored for the details drawer only. Binding re-runs detection rather
   *  than re-matching this string — see the note on bindability below. */
  keywordPattern: string;
  /** The stems an editorial cluster is keyed on; empty for a pattern
   *  candidate. Competitor evidence matches URLs on these. */
  clusterTokens: string[];
  format: string;
  instances: PlannerBacklogRow[];
  demand: number;
  /** p25–p75 of the non-null KDs in the cluster; null when nothing in it has
   *  a difficulty at all, which is the normal state of a free-source
   *  backlog. */
  kdBand: KdBand | null;
  /** Real keywords, verbatim and in quotes on the card. We do not synthesize
   *  a headline: the writer decides the title, and a card that invented one
   *  would be promising a page that doesn't exist yet. */
  exampleTitles: string[];
};

/**
 * Cluster gated backlog rows into candidate page types.
 *
 * Two passes over the same rows: the pattern table claims what it recognizes,
 * and everything left over goes to editorial clustering. Candidates below
 * their kind's floor are dropped — a "page type" of two pages is not a type —
 * and the survivors come back ordered by demand, which is the order the
 * approval cards read best in.
 *
 * Deterministic end to end: same rows in, same candidates out, in the same
 * order. A recompute that reshuffled the cards would make the user re-read
 * decisions they already made.
 */
export function detectCandidates(
  rows: PlannerBacklogRow[],
): PageTypeCandidate[] {
  const byPattern = new Map<string, PlannerBacklogRow[]>();
  const unmatched: PlannerBacklogRow[] = [];

  for (const row of rows) {
    const pattern = matchPattern(row.keyword);
    if (!pattern) {
      unmatched.push(row);
      continue;
    }
    const claimed = byPattern.get(pattern.key) ?? [];
    claimed.push(row);
    byPattern.set(pattern.key, claimed);
  }

  const candidates: PageTypeCandidate[] = [];
  for (const pattern of PAGE_PATTERNS) {
    const instances = byPattern.get(pattern.key);
    if (!instances || instances.length < MIN_INSTANCES_PSEO) continue;
    candidates.push(
      buildCandidate({
        key: pattern.key,
        name: pattern.name,
        kind: "pseo",
        urlPattern: pattern.urlPattern,
        keywordPattern: pattern.matcher.source,
        clusterTokens: [],
        format: pattern.format,
        instances,
      }),
    );
  }

  for (const cluster of clusterEditorialRows(unmatched)) {
    if (cluster.instances.length < MIN_INSTANCES_BLOG) continue;
    candidates.push(
      buildCandidate({
        key: `cluster:${cluster.tokens.join(" ")}`,
        name: `${capitalize(cluster.tokens.join(" "))} guides`,
        kind: "blog",
        urlPattern: "/blog/{slug}/",
        keywordPattern: cluster.tokens.map(reEscape).join("|"),
        clusterTokens: cluster.tokens,
        // The engine's own fallthrough for a keyword no rule claims — an
        // unmatched row IS the explainer bucket, by both definitions.
        format: "explainer",
        instances: cluster.instances,
      }),
    );
  }

  return candidates.toSorted(
    (a, b) => b.demand - a.demand || a.name.localeCompare(b.name),
  );
}

function buildCandidate(
  input: Omit<
    PageTypeCandidate,
    "demand" | "kdBand" | "exampleTitles" | "instances"
  > & { instances: PlannerBacklogRow[] },
): PageTypeCandidate {
  const ranked = rankByDemand(input.instances);
  return {
    ...input,
    instances: ranked,
    demand: ranked.reduce((sum, row) => sum + effectiveVolume(row), 0),
    kdBand: computeKdBand(ranked),
    exampleTitles: ranked
      .slice(0, EXAMPLE_TITLE_COUNT)
      .map((row) => row.keyword),
  };
}

/** Biggest demand first; the keyword breaks ties so two runs over the same
 *  backlog quote the same three examples. */
function rankByDemand(rows: PlannerBacklogRow[]): PlannerBacklogRow[] {
  return rows.toSorted(
    (a, b) =>
      effectiveVolume(b) - effectiveVolume(a) ||
      a.keyword.localeCompare(b.keyword),
  );
}

/**
 * The interquartile difficulty of a cluster. Nearest-rank on a 0-based index
 * rather than an interpolated percentile: KD is an integer estimate to begin
 * with, and interpolating between 34 and 41 to report 37.5 would dress a
 * vendor's guess up as a measurement. Rows without a KD are skipped, never
 * imputed — an unknown difficulty is not an average one.
 */
export function computeKdBand(rows: PlannerBacklogRow[]): KdBand | null {
  const kds = rows
    .flatMap((row) =>
      row.keywordDifficulty === null ? [] : [row.keywordDifficulty],
    )
    .toSorted((a, b) => a - b);
  if (kds.length === 0) return null;
  return { p25: percentile(kds, 0.25), p75: percentile(kds, 0.75) };
}

function percentile(sorted: number[], fraction: number): number {
  return sorted[Math.round((sorted.length - 1) * fraction)];
}

// ---------------------------------------------------------------------------
// Editorial clustering
// ---------------------------------------------------------------------------

type EditorialCluster = { tokens: string[]; instances: PlannerBacklogRow[] };

/**
 * Group the rows no pattern claimed by the stems they share.
 *
 * Greedy and repeated: take the stem the most unclaimed rows carry, hand it
 * every row that carries it, and go again on what's left. Greedy rather than
 * a similarity matrix because the output has to be explainable on a card —
 * "these 14 keywords all say 'descaling'" is a sentence a founder can check,
 * and a cluster id from an embedding is not.
 */
function clusterEditorialRows(rows: PlannerBacklogRow[]): EditorialCluster[] {
  const stemsByRow = new Map<string, Set<string>>(
    rows.map((row) => [row.id, new Set(stems(row.keyword))]),
  );
  const clusters: EditorialCluster[] = [];
  let remaining = rows;

  // Bounded by construction: every iteration removes at least
  // MIN_INSTANCES_BLOG rows or breaks.
  while (remaining.length >= MIN_INSTANCES_BLOG) {
    const counts = new Map<string, number>();
    for (const row of remaining) {
      for (const stem of stemsByRow.get(row.id) ?? []) {
        counts.set(stem, (counts.get(stem) ?? 0) + 1);
      }
    }

    const dominant = pickTopToken(counts);
    if (dominant === null || (counts.get(dominant) ?? 0) < MIN_INSTANCES_BLOG) {
      break;
    }

    const members = remaining.filter((row) =>
      stemsByRow.get(row.id)?.has(dominant),
    );
    const tokens = [dominant];
    const secondary = sharedSecondaryToken(members, stemsByRow, dominant);
    if (secondary !== null && tokens.length < CLUSTER_MAX_TOKENS) {
      tokens.push(secondary);
    }

    clusters.push({ tokens, instances: members });
    const claimed = new Set(members.map((row) => row.id));
    remaining = remaining.filter((row) => !claimed.has(row.id));
  }

  return clusters;
}

/** Most frequent token; the token itself breaks ties so clustering is stable
 *  across runs. */
function pickTopToken(counts: Map<string, number>): string | null {
  let best: string | null = null;
  let bestCount = 0;
  for (const [token, count] of counts) {
    if (count > bestCount || (count === bestCount && token < (best ?? "￿"))) {
      best = token;
      bestCount = count;
    }
  }
  return best;
}

/**
 * A second token to name the cluster by — but only one every member carries.
 * A token most of them share would put "milk" in the name of a cluster where
 * a third of the keywords never mention it, and the name is the promise the
 * card makes about what the pages will be about.
 */
function sharedSecondaryToken(
  members: PlannerBacklogRow[],
  stemsByRow: Map<string, Set<string>>,
  dominant: string,
): string | null {
  const shared = new Map<string, number>();
  for (const row of members) {
    for (const stem of stemsByRow.get(row.id) ?? []) {
      if (stem === dominant) continue;
      shared.set(stem, (shared.get(stem) ?? 0) + 1);
    }
  }
  for (const [token, count] of shared) {
    if (count < members.length) shared.delete(token);
  }
  return pickTopToken(shared);
}

/**
 * Topic stems of a keyword: lowercase words, stopwords and short tokens
 * dropped, a trailing plural "s" trimmed off anything long enough to survive
 * it. Deliberately not a real stemmer — Porter would fold "pressing" into
 * "press" and merge two clusters a reader can tell apart, and it would need
 * a dictionary this file has no business shipping.
 */
export function stems(keyword: string): string[] {
  const out: string[] = [];
  for (const raw of keyword.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < MIN_TOKEN_LENGTH) continue;
    if (STOPWORDS.has(raw)) continue;
    const stem =
      raw.endsWith("s") && !raw.endsWith("ss") && raw.length > MIN_TOKEN_LENGTH
        ? raw.slice(0, -1)
        : raw;
    if (!out.includes(stem)) out.push(stem);
  }
  return out;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function reEscape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// SERP sampling plan
// ---------------------------------------------------------------------------

/**
 * The keywords to spend SERP calls on for one candidate: up to six, spread
 * evenly across the demand-ordered instances rather than taken off the top.
 *
 * The head of a cluster is its easiest sell and its hardest SERP; sampling
 * only the head would kill types whose tail is winnable and pass types whose
 * tail is a wasteland. Even spacing costs nothing and reads the whole range.
 */
export function pickSerpSampleKeywords(
  candidate: PageTypeCandidate,
  limit = SAMPLES_PER_CANDIDATE,
): string[] {
  const ranked = candidate.instances;
  const count = Math.min(limit, ranked.length);
  if (count <= 0) return [];
  if (count === 1) return [ranked[0].keyword];

  const picked: string[] = [];
  for (let i = 0; i < count; i++) {
    const index = Math.round((i * (ranked.length - 1)) / (count - 1));
    const keyword = ranked[index].keyword;
    if (!picked.includes(keyword)) picked.push(keyword);
  }
  return picked;
}

/**
 * Split candidates into the ones this run can afford to sample and the ones
 * it can't, cheapest first.
 *
 * Cheapest-first maximizes how many candidates get *a* verdict, which is the
 * thing the user is deciding on — six readings on one big type teaches less
 * than one verdict each on four. Candidates are taken whole or not at all,
 * and since the list is sorted ascending, the first one that doesn't fit ends
 * the run's spending. What's left is proposed honestly as 'unsampled'.
 */
export function allocateSerpBudget<T extends { sampleKeywords: string[] }>(
  candidates: T[],
  budget = PLAN_SERP_CALL_BUDGET,
): { sampled: T[]; unsampled: T[] } {
  const cheapestFirst = candidates.toSorted(
    (a, b) => a.sampleKeywords.length - b.sampleKeywords.length,
  );
  const sampled: T[] = [];
  const unsampled: T[] = [];
  let spent = 0;
  for (const [index, candidate] of cheapestFirst.entries()) {
    const cost = candidate.sampleKeywords.length;
    // Nothing to sample (no instances to draw from) — not a budget decision.
    if (cost === 0) {
      unsampled.push(candidate);
      continue;
    }
    if (spent + cost > budget) {
      unsampled.push(...cheapestFirst.slice(index));
      break;
    }
    spent += cost;
    sampled.push(candidate);
  }
  return { sampled, unsampled };
}
