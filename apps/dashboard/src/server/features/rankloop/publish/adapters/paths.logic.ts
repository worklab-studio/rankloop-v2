// Where a page goes, derived from its page type's urlPattern. Pure, because
// two adapters need the same answer for different reasons: the webhook target
// computes a URL it was not told, and the GitHub target commits a file at the
// path the pattern implies.

/** "/compare/{slug}/" is the shape the planner emits (planner.logic.ts). */
const SLUG_TOKEN = "{slug}";

/** Leading slash, single trailing slash, no doubles in between. */
export function normalizePath(path: string): string {
  const cleaned = `/${path}/`.replace(/\/{2,}/g, "/");
  return cleaned;
}

/**
 * The instance path for a slug. A pattern without the token gets the slug
 * appended rather than rejected: an approved page type whose pattern a human
 * edited to "/blog/" still has to publish somewhere sensible, and "/blog/foo/"
 * is the only sensible answer.
 */
export function pathFromUrlPattern(
  urlPattern: string | null,
  slug: string,
): string {
  if (!urlPattern) return normalizePath(slug);
  if (!urlPattern.includes(SLUG_TOKEN)) {
    return normalizePath(`${urlPattern}/${slug}`);
  }
  return normalizePath(urlPattern.split(SLUG_TOKEN).join(slug));
}

/**
 * The hub path for a page type: the pattern with its slug segment removed.
 * "/compare/{slug}/" hubs at "/compare/", which is where a reader who deletes
 * the last path segment already expects to land.
 */
export function hubPathFromUrlPattern(
  urlPattern: string | null,
): string | null {
  if (!urlPattern?.includes(SLUG_TOKEN)) return null;
  const segments = urlPattern
    .split("/")
    .filter((segment) => segment !== "" && !segment.includes(SLUG_TOKEN));
  if (segments.length === 0) return null;
  return normalizePath(segments.join("/"));
}

/** The last path segment — a slug on a post, the hub name on a hub. */
export function slugFromPath(path: string): string {
  const segments = path.split("/").filter(Boolean);
  return segments.at(-1) ?? "";
}

export function absoluteUrl(siteUrl: string, path: string): string {
  return `${siteUrl.replace(/\/+$/, "")}${normalizePath(path)}`;
}

/**
 * The markdown file for a path, mirroring the URL structure under the repo's
 * content root: "/compare/foo/" -> "content/compare/foo.md". A hub, which has
 * no slug segment of its own, becomes that directory's index — the one stem
 * the engine's markdown manifest deliberately skips, so a hub page never shows
 * up in the corpus as a post.
 */
export function repoPathFor(
  contentDir: string,
  path: string,
  kind: "post" | "hub",
): string {
  const dir = contentDir.replace(/^\/+|\/+$/g, "");
  const rel = path.replace(/^\/+|\/+$/g, "");
  const stem = kind === "hub" ? `${rel}/index` : rel;
  return dir ? `${dir}/${stem}.md` : `${stem}.md`;
}
