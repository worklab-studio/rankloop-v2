// Pure functions behind the derive step: classify each crawled page into the
// coarse content kind, and invert the per-page outlink lists into inlink
// counts. No I/O — unit-tested directly in derive.logic.test.ts.

export type ContentPageKind = "post" | "page" | "hub" | "other";

export type DeriveKindInput = {
  /** URL pathname, e.g. "/blog/how-to-x". Keys the returned map. */
  path: string;
  publishedAt: string | null;
  wordCount: number;
  isIndexable: boolean;
  /** Same-origin outlink paths persisted by the crawl (deduped, capped). */
  outlinkPaths: string[];
};

// A hub is a thin page whose job is fanning out to posts (blog index,
// category-ish landing). ≥8 distinct post targets separates real hubs from
// articles that merely cross-link a handful of siblings; wordCount < 500
// keeps long-form roundups classified as the posts they are.
const HUB_MIN_POST_OUTLINKS = 8;
const HUB_MAX_WORD_COUNT = 500;

// Path segments that mark the common blog URL shapes. The segment must not be
// the last one — /blog/ itself is the index (a hub candidate), not a post.
const POST_SECTION_SEGMENTS = new Set(["blog", "posts", "articles", "news"]);

// Utility paths carry no content worth inventorying: archive/taxonomy
// listings, pagination, and account/commerce plumbing. Deliberately short —
// S6's page_types refinement owns anything subtler than this.
const UTILITY_SEGMENTS = new Set([
  "tag",
  "tags",
  "category",
  "categories",
  "author",
  "authors",
  "search",
  "login",
  "signin",
  "signup",
  "register",
  "account",
  "cart",
  "checkout",
  "feed",
]);

function pathSegments(path: string): string[] {
  return path
    .split("/")
    .filter(Boolean)
    .map((s) => s.toLowerCase());
}

/** Dated paths: /2024/05/... year/month segments or a segment that starts
 *  with a full YYYY-MM-DD date — the classic permalink shapes. */
function isDatedPath(segments: string[]): boolean {
  for (let i = 0; i < segments.length - 1; i++) {
    if (/^\d{4}$/.test(segments[i]) && /^\d{2}$/.test(segments[i + 1])) {
      return true;
    }
  }
  return segments.some((segment) => /^\d{4}-\d{2}-\d{2}/.test(segment));
}

/** Common blog shapes: a blog-section segment with something after it, or a
 *  dated path. Exported for tests; derive uses derivePageKinds. */
export function isPostLikePath(path: string): boolean {
  const segments = pathSegments(path);
  const sectionIndex = segments.findIndex((segment) =>
    POST_SECTION_SEGMENTS.has(segment),
  );
  // The section segment must not be last: /blog/ is the index, /blog/foo the
  // post.
  if (sectionIndex !== -1 && sectionIndex < segments.length - 1) return true;
  return isDatedPath(segments);
}

/** Exported for the competitor study, which classifies a foreign sitemap by
 *  URL shape alone and must draw the utility line in the same place. */
export function isUtilityPath(path: string): boolean {
  const segments = pathSegments(path);
  if (segments.some((segment) => UTILITY_SEGMENTS.has(segment))) return true;
  // /page/2 pagination anywhere in the path.
  for (let i = 0; i < segments.length - 1; i++) {
    if (segments[i] === "page" && /^\d+$/.test(segments[i + 1])) return true;
  }
  return false;
}

/**
 * A bare blog-section index — /blog, /news/. The only hub shape a URL can
 * prove on its own: derivePageKinds finds real hubs through the outlink
 * graph, and a competitor studied from its sitemap has no graph to invert.
 */
export function isSectionIndexPath(path: string): boolean {
  const segments = pathSegments(path);
  return segments.length === 1 && POST_SECTION_SEGMENTS.has(segments[0]);
}

/**
 * The coarse kind heuristic, keyed by path. Two passes because 'hub' is
 * relational: a hub is recognized by the posts it fans out to, so posts must
 * be settled first.
 *
 * Precedence: 'other' (non-indexable/utility — nothing downstream should
 * link-build toward these) → 'post' (publishedAt present or a blog-shaped
 * path) → 'hub' (≥8 distinct post outlinks, < 500 words) → 'page'.
 */
export function derivePageKinds(
  pages: DeriveKindInput[],
): Map<string, ContentPageKind> {
  const kinds = new Map<string, ContentPageKind>();
  const postPaths = new Set<string>();

  for (const page of pages) {
    if (!page.isIndexable || isUtilityPath(page.path)) {
      kinds.set(page.path, "other");
    } else if (page.publishedAt !== null || isPostLikePath(page.path)) {
      kinds.set(page.path, "post");
      postPaths.add(page.path);
    }
  }

  for (const page of pages) {
    if (kinds.has(page.path)) continue;
    const distinctPostOutlinks = new Set(
      page.outlinkPaths.filter(
        (target) => target !== page.path && postPaths.has(target),
      ),
    );
    kinds.set(
      page.path,
      distinctPostOutlinks.size >= HUB_MIN_POST_OUTLINKS &&
        page.wordCount < HUB_MAX_WORD_COUNT
        ? "hub"
        : "page",
    );
  }

  return kinds;
}

/**
 * Invert the outlink graph: for each path, how many crawled pages link to it.
 * Counts source pages, not edges — outlinkPaths is already deduped per page —
 * and a page linking to itself earns no inlink.
 */
export function invertInlinkCounts(
  pages: Array<{ path: string; outlinkPaths: string[] }>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const page of pages) {
    for (const target of new Set(page.outlinkPaths)) {
      if (target === page.path) continue;
      counts.set(target, (counts.get(target) ?? 0) + 1);
    }
  }
  return counts;
}

/** URL → pathname, tolerating the malformed rows a crawl can persist. */
export function urlToPath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}
