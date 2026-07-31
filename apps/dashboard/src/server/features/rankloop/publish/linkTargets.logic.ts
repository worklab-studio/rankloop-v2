// Which pages get a link to the article that just published (spec 0021,
// step 5). Pure selection over the content_pages manifest — no I/O, no
// adapter, no writes; the caller decides what to do with the answer.
//
// The rule is the spec's, in order: same page type first, then shared-token
// neighbours, never the hub and never the article itself. An orphan is what
// kills a programmatic page, but a link from an unrelated post is the other
// failure — it teaches a crawler that this site links everything to
// everything, which is worth less than no link at all.

/** Three is a paragraph of context on three pages. Beyond that the injection
 *  stops being contextual and starts being a footer. */
const MAX_LINK_TARGETS = 3;

/** Tokens under three characters ("a", "of", "10") match everything and mean
 *  nothing — the same floor the push heuristic uses. */
const MIN_TOKEN_LENGTH = 3;

/**
 * Sharing a page type outranks any amount of vocabulary overlap.
 *
 * The spec says "same page type first", not "same page type scores higher":
 * a page type is a human-approved statement that these pages are one family,
 * and a comparison page that happens to share the word "pricing" with a
 * changelog post is not a closer neighbour than another comparison page. The
 * constant is larger than the most tokens two slugs can plausibly share, so
 * the two pools never interleave.
 */
const SAME_PAGE_TYPE_SCORE = 1000;

export type LinkTargetCandidate = {
  id: string;
  path: string;
  title: string | null;
  kind: "post" | "page" | "hub" | "other";
  pageTypeId: string | null;
};

export type LinkTarget = {
  contentPageId: string;
  path: string;
  /** Only for the run record and the UI — the anchor text in the block is the
   *  published article's title, not this one's. */
  title: string;
};

/** Tokens of the last path segment only. Leading segments are site chrome
 *  ("/blog/", "/2026/") and would make every post a neighbour of every other. */
function pathTokens(path: string): string[] {
  const slug = path.split("/").filter(Boolean).at(-1) ?? "";
  return tokenize(slug);
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= MIN_TOKEN_LENGTH);
}

function sharedTokenCount(a: Set<string>, b: Iterable<string>): number {
  let shared = 0;
  const counted = new Set<string>();
  for (const token of b) {
    if (a.has(token) && !counted.has(token)) {
      counted.add(token);
      shared++;
    }
  }
  return shared;
}

/** Trailing slashes are a permalink setting, not an identity — the same guard
 *  the owned block uses, and the reason a fresh manifest row cannot be picked
 *  as a neighbour of itself. */
function pathKey(path: string): string {
  return path.replace(/\/+$/, "").toLowerCase();
}

/**
 * Up to three existing pages that should link to the new article.
 *
 * Everything scoring zero is dropped rather than padded in: returning two
 * genuine neighbours is a better answer than three, and the caller records
 * `linksInjected < intended` honestly either way. The tie-break is the path,
 * so the same manifest always yields the same three — a workflow that resumes
 * mid-injection must not pick a different set the second time.
 */
export function pickLinkTargets(input: {
  candidates: LinkTargetCandidate[];
  /** The published article's page type, when it has one. */
  pageTypeId: string | null;
  /** The keyword the article was written for — its strongest vocabulary. */
  keyword: string;
  /** Where the article now lives, so the manifest row written a step ago is
   *  not offered as a neighbour of itself. */
  selfPath: string;
  hubContentPageId: string | null;
}): LinkTarget[] {
  const selfKey = pathKey(input.selfPath);
  const articleTokens = new Set([
    ...tokenize(input.keyword),
    ...pathTokens(input.selfPath),
  ]);

  const scored = input.candidates
    // Posts only. A hub already links to every instance under it by
    // definition, and a "link from your privacy policy" is noise nobody wants
    // in their own page.
    .filter((candidate) => candidate.kind === "post")
    .filter((candidate) => candidate.id !== input.hubContentPageId)
    .filter((candidate) => pathKey(candidate.path) !== selfKey)
    .map((candidate) => {
      const samePageType =
        input.pageTypeId !== null && candidate.pageTypeId === input.pageTypeId;
      const overlap = sharedTokenCount(articleTokens, [
        ...pathTokens(candidate.path),
        ...tokenize(candidate.title ?? ""),
      ]);
      return {
        candidate,
        score: (samePageType ? SAME_PAGE_TYPE_SCORE : 0) + overlap,
      };
    })
    .filter((row) => row.score > 0)
    .toSorted(
      (a, b) =>
        b.score - a.score || a.candidate.path.localeCompare(b.candidate.path),
    );

  return scored.slice(0, MAX_LINK_TARGETS).map((row) => ({
    contentPageId: row.candidate.id,
    path: row.candidate.path,
    title: row.candidate.title ?? row.candidate.path,
  }));
}
