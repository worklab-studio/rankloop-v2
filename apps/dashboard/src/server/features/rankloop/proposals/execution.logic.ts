// Pure functions behind proposal execution (spec 0013): pulling the headline
// query and WordPress slug out of a proposal, and the push inlink-candidate
// heuristic. Receipt window/baseline math lives with its consumer in
// receipts/receipts.logic.ts. No I/O — unit-tested directly in
// execution.logic.test.ts.

// ---------------------------------------------------------------------------
// Proposal parsing helpers
// ---------------------------------------------------------------------------

/** Retitle and push titles carry their headline query in quotes ('Push
 *  "espresso tamper" from position 11.2') — the receipt's targetQuery is
 *  that query, extracted rather than re-derived so receipt and proposal can
 *  never disagree about what was being optimized. */
export function headlineQuery(title: string | null): string | null {
  const match = title?.match(/"([^"]+)"/);
  return match?.[1] ?? null;
}

/** WordPress resolves ?slug= against the post's own slug, which is the last
 *  path segment however deep the permalink structure nests it. */
export function slugFromPath(path: string): string | null {
  return path.split("/").filter(Boolean).at(-1) ?? null;
}

// ---------------------------------------------------------------------------
// Push inlink candidates
// ---------------------------------------------------------------------------

/** Three suggestions is a to-do list; ten is homework nobody does. */
const INLINK_CANDIDATE_LIMIT = 3;

// Tokens under 3 chars ("a", "of", "10") match everything and mean nothing.
const MIN_PATH_TOKEN_LENGTH = 3;

// Sharing a category counts like two shared slug tokens — categories are
// human-curated relatedness, tokens are incidental.
const SAME_CATEGORY_SCORE = 2;

type InlinkSourcePage = {
  path: string;
  title: string | null;
  category: string | null;
};

type InlinkCandidate = InlinkSourcePage & { score: number };

/** Tokens of the last path segment only — leading segments are shared site
 *  chrome ("/blog/", "/2026/") and would match every post to every post. */
function slugTokens(path: string): Set<string> {
  return new Set(
    (slugFromPath(path) ?? "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= MIN_PATH_TOKEN_LENGTH),
  );
}

/**
 * The top inlink sources for a push target: posts sharing slug tokens or a
 * category with the target page. Deliberately naive — shared tokens and
 * categories are what the manifest already knows without any model call, and
 * a human vets the list before adding a single link. Pages with no overlap
 * at all are dropped rather than padded in: a wrong suggestion costs trust.
 */
export function computeInlinkCandidates(input: {
  target: { path: string; category: string | null };
  pages: InlinkSourcePage[];
}): InlinkCandidate[] {
  const targetTokens = slugTokens(input.target.path);
  const scored: InlinkCandidate[] = [];
  for (const page of input.pages) {
    if (page.path === input.target.path) continue;
    let score = 0;
    for (const token of slugTokens(page.path)) {
      if (targetTokens.has(token)) score += 1;
    }
    if (
      input.target.category !== null &&
      page.category === input.target.category
    ) {
      score += SAME_CATEGORY_SCORE;
    }
    if (score > 0) scored.push({ ...page, score });
  }
  // Path breaks score ties so the list is stable across refetches.
  return scored
    .toSorted((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, INLINK_CANDIDATE_LIMIT);
}
