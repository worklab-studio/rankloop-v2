/** Derived artifacts, regenerated whole — ported from rankloop 0.2 wire.py.
 *
 * YOUR pages (index, theme, hub pages) are yours and this module never
 * touches them. The DERIVED artifacts (sitemap.xml, rss.xml, llms.txt,
 * llms-full.txt) are regenerated in full from the post manifest on every
 * run. Regeneration is idempotent by construction: there is no splice
 * state to corrupt.
 *
 * llms.txt / llms-full.txt earn their place: the source engine's site
 * measured ~175 AI-agent hits a day. Output is parity-tested against the
 * Python generators byte-for-byte. */

import type { EngineConfig, Post } from "./types.ts";
import { parseIsoDate, unescapeEntities, xmlEscape } from "./text.ts";

function site(cfg: EngineConfig): string {
  return cfg.site.url.replace(/\/+$/, "");
}

function blogRoot(cfg: EngineConfig): string {
  return `${site(cfg)}/${cfg.site.blogPath.replace(/^\/+|\/+$/g, "")}/`;
}

/** Both modes publish to the same clean URL shape: /<blogPath>/<slug>/. */
export function postUrl(cfg: EngineConfig, slug: string): string {
  return `${blogRoot(cfg)}${slug}/`;
}

// ---------- sitemap ----------

export interface SitemapOptions {
  /** ISO date used for the empty-corpus fallback. */
  today: string;
  /** Homepage lastmod (the Python derived it from index.html's mtime);
   * omit to fall back to the newest post's date. */
  homeLastmod?: string;
}

/** posts: newest first. Priorities are a fixed editorial statement, not a
 * computation: home 1.0, blog root 0.8, hubs 0.6, posts 0.7 monthly. */
export function sitemap(cfg: EngineConfig, posts: Post[], opts: SitemapOptions): string {
  const homeMod = opts.homeLastmod ?? (posts.length ? posts[0]!.date : opts.today);
  const newest = posts.length && posts[0]!.date ? posts[0]!.date : homeMod;

  // Hub lastmod = newest post in that category (posts arrive newest first,
  // so first-write-wins keeps the newest).
  const newestIn: Record<string, string> = {};
  for (const p of posts) {
    if (p.date && !(p.category in newestIn)) newestIn[p.category] = p.date;
  }

  const entries: [loc: string, lastmod: string | null, freq: string, prio: string][] = [];
  entries.push([`${site(cfg)}/`, homeMod || null, "weekly", "1.0"]);
  entries.push([blogRoot(cfg), newest || null, "weekly", "0.8"]);
  for (const [cat, hub] of Object.entries(cfg.taxonomy)) {
    entries.push([`${blogRoot(cfg)}${hub}/`, newestIn[cat] ?? null, "weekly", "0.6"]);
  }
  for (const p of posts) {
    entries.push([postUrl(cfg, p.slug), p.date || null, "monthly", "0.7"]);
  }

  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ];
  for (const [loc, lastmod, freq, prio] of entries) {
    lines.push("  <url>");
    lines.push(`    <loc>${xmlEscape(loc)}</loc>`);
    if (lastmod) lines.push(`    <lastmod>${lastmod}</lastmod>`);
    lines.push(`    <changefreq>${freq}</changefreq>`);
    lines.push(`    <priority>${prio}</priority>`);
    lines.push("  </url>");
  }
  lines.push("</urlset>");
  return lines.join("\n") + "\n";
}

// ---------- rss ----------

const DAY_ABBR = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** 09:00 GMT is deliberate and ported verbatim: a stable, believable
 * publish hour beats midnight timestamps that scream "generated". */
export function rfc822(isoDate: string): string | null {
  const t = parseIsoDate(isoDate);
  if (t === null) return null;
  const d = new Date(t);
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${DAY_ABBR[d.getUTCDay()]}, ${dd} ${MONTH_ABBR[d.getUTCMonth()]} ${d.getUTCFullYear()} 09:00:00 GMT`;
}

export function rss(cfg: EngineConfig, posts: Post[]): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0">',
    "<channel>",
    `  <title>${xmlEscape(cfg.site.name)}</title>`,
    `  <link>${xmlEscape(site(cfg))}/</link>`,
    `  <description>${xmlEscape(cfg.site.description)}</description>`,
  ];
  const build = posts.length ? rfc822(posts[0]!.date) : null;
  if (build) lines.push(`  <lastBuildDate>${build}</lastBuildDate>`);
  for (const p of posts) {
    const url = postUrl(cfg, p.slug);
    lines.push("  <item>");
    lines.push(`    <title>${xmlEscape(p.title)}</title>`);
    lines.push(`    <link>${xmlEscape(url)}</link>`);
    lines.push(`    <guid>${xmlEscape(url)}</guid>`);
    const pub = rfc822(p.date);
    if (pub) lines.push(`    <pubDate>${pub}</pubDate>`);
    lines.push(`    <description>${xmlEscape(p.description)}</description>`);
    lines.push("  </item>");
  }
  lines.push("</channel>", "</rss>");
  return lines.join("\n") + "\n";
}

// ---------- llms.txt (the map) ----------

/** llmstxt.org shape: H1 site name, blockquote description, one ## section
 * per category, one link line per post. Posts whose category is not in the
 * taxonomy land in a trailing 'Other' section rather than vanishing. */
export function llmsTxt(cfg: EngineConfig, posts: Post[]): string {
  const parts: string[] = [`# ${cfg.site.name}`, ""];
  if (cfg.site.description) parts.push(`> ${cfg.site.description}`, "");
  const cats = Object.keys(cfg.taxonomy);
  const byCat: Record<string, Post[]> = {};
  for (const p of posts) {
    const key = cats.includes(p.category) ? p.category : "Other";
    (byCat[key] ??= []).push(p);
  }
  const order = [...cats, ...("Other" in byCat && !cats.includes("Other") ? ["Other"] : [])];
  for (const cat of order) {
    const group = byCat[cat];
    if (!group) continue;
    parts.push(`## ${cat}`, "");
    for (const p of group) {
      const desc = p.description ? `: ${p.description}` : "";
      parts.push(`- [${p.title}](${postUrl(cfg, p.slug)})${desc}`);
    }
    parts.push("");
  }
  return parts.join("\n").trimEnd() + "\n";
}

// ---------- llms-full.txt (the content) ----------

function textOf(fragment: string): string {
  let t = fragment.replace(/<br\s*\/?>/g, "\n");
  t = t.replace(/<[^>]+>/g, "");
  return unescapeEntities(t).trim();
}

/** HTML article -> markdown-ish text. Simple regex extraction is a known
 * limitation and an accepted trade: it loses inline emphasis, which agents
 * reading for content do not miss, and it costs zero dependencies. */
export function articleMarkdown(src: string): string {
  const m = /<article[^>]*>([\s\S]*?)<\/article>/.exec(src);
  if (!m) return "";
  let art = m[1]!;
  // strip the anchor-link glyphs inside headings before conversion
  art = art.replace(/<a [^>]*>\s*#\s*<\/a>/g, "");
  const out: string[] = [];
  // walk block-level pieces in order: headings, paragraphs, list items, tables
  for (const block of art.matchAll(/<(h2|h3|p|li|td|th)\b[^>]*>([\s\S]*?)<\/\1>/g)) {
    const tag = block[1]!;
    const txt = textOf(block[2]!).replace(/\s+/g, " ");
    if (!txt) continue;
    if (tag === "h2") out.push(`\n## ${txt}\n`);
    else if (tag === "h3") out.push(`\n### ${txt}\n`);
    else if (tag === "li") out.push(`- ${txt}`);
    else if (tag === "td" || tag === "th") out.push(`| ${txt} `);
    else out.push(txt);
  }
  return out.join("\n");
}

const FRONTMATTER_RX = /^---\s*\n[\s\S]*?\n---\s*\n/;

/** Markdown posts are already the mirror; just drop the frontmatter. */
export function mdBody(src: string): string {
  return src.replace(FRONTMATTER_RX, "").trim();
}

export function llmsFull(cfg: EngineConfig, posts: Post[]): string {
  let host: string;
  try {
    host = new URL(cfg.site.url).host || cfg.site.url;
  } catch {
    host = cfg.site.url;
  }
  const parts: string[] = [
    `# ${cfg.site.name}: all posts (llms-full)\n`,
    `> Full text of every ${host} post, one file, for AI agents.\n` +
      `> Canonical URLs included per post. Site map: ${site(cfg)}/llms.txt\n`,
  ];
  for (const p of posts) {
    const body = cfg.site.mode === "html" ? articleMarkdown(p.raw) : mdBody(p.raw);
    parts.push(`\n\n---\n\n# ${p.title}\n\nURL: ${postUrl(cfg, p.slug)}\n\n${p.description}\n` + body);
  }
  return parts.join("\n") + "\n";
}
