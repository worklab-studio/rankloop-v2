/** Post parsing, ported from rankloop 0.2 laws.manifest and friends.
 *
 * Everything is derived from the post content itself — JSON-LD in html
 * mode (exactly what search engines read, so the manifest can never
 * disagree with what Google sees), frontmatter in markdown mode. No
 * side-channel state; every caller is idempotent.
 *
 * Throws Error (with the slug in the message) on an unparseable post; a
 * corrupt corpus should stop the pipeline, not silently shrink it. */

import type { EngineConfig, Post } from "./types.ts";
import { articleOf, frontmatter, stripTags, words } from "./text.ts";

export function parseHtmlPost(slug: string, raw: string): Post {
  const mld = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(raw);
  if (!mld) throw new Error(`${slug}: no JSON-LD`);
  const data: unknown = JSON.parse(mld[1]!);
  let nodes: Record<string, unknown>[];
  if (Array.isArray(data)) nodes = data as Record<string, unknown>[];
  else if (data && typeof data === "object") {
    const d = data as Record<string, unknown>;
    nodes = Array.isArray(d["@graph"]) ? (d["@graph"] as Record<string, unknown>[]) : [d];
  } else nodes = [];
  const bp = nodes.find((n) => n["@type"] === "BlogPosting" || n["@type"] === "Article");
  if (!bp) throw new Error(`${slug}: no BlogPosting node`);
  let minutes = 5;
  const tm = /^PT(\d+)M/.exec(String(bp["timeRequired"] ?? ""));
  if (tm) minutes = Number(tm[1]);
  const mkw = /<meta name="keywords" content="([^",]+)/.exec(raw);
  const keyword = mkw ? mkw[1]!.trim().toLowerCase() : null;
  const wordCount = words(stripTags(articleOf(raw))).length;
  return {
    slug,
    title: String(bp["headline"] ?? ""),
    description: String(bp["description"] ?? ""),
    date: String(bp["datePublished"] ?? ""),
    category: String(bp["articleSection"] ?? ""),
    raw,
    wordCount,
    keyword,
    minutes,
  };
}

export function parseMdPost(slug: string, raw: string): Post {
  const [meta, body] = frontmatter(raw);
  const wordCount = words(body).length;
  const kw = (meta["keyword"] ?? "").trim().toLowerCase();
  return {
    slug,
    title: meta["title"] ?? "",
    description: meta["description"] ?? "",
    date: meta["date"] ?? "",
    category: meta["category"] ?? "",
    raw,
    wordCount,
    keyword: kw || null,
    minutes: Math.max(1, Math.floor(wordCount / 200)),
  };
}

export interface CorpusEntry {
  /** html mode: the post's directory name; markdown mode: the file stem. */
  slug: string;
  raw: string;
}

/** Parse a corpus into posts, newest first. Hub pages (taxonomy slugs) and
 * a markdown `index` are skipped, same as the Python manifest. */
export function manifest(cfg: EngineConfig, entries: CorpusEntry[]): Post[] {
  const hubSlugs = new Set(Object.values(cfg.taxonomy));
  const ordered = [...entries].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  const posts: Post[] = [];
  for (const e of ordered) {
    if (hubSlugs.has(e.slug)) continue;
    if (cfg.site.mode === "markdown") {
      if (e.slug === "index") continue;
      posts.push(parseMdPost(e.slug, e.raw));
    } else {
      posts.push(parseHtmlPost(e.slug, e.raw));
    }
  }
  // stable sort, newest first — ties keep filename order, like the Python
  posts.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return posts;
}
