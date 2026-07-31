/** The grounded writer brief, ported from rankloop 0.2 brief.py.
 *
 * The brief IS the product's grounding: cached SERP titles for angle-gap
 * analysis, real People-Also-Ask questions for the FAQ, the laws as hard
 * requirements, and internal-link candidates drawn from pages that
 * actually exist so the writer never invents a slug.
 *
 * Output is parity-tested byte-for-byte against the Python renderer —
 * treat the strings as law. (Wording tweaks are fine later; regenerate
 * the fixtures in the same change.) */

import type { EngineConfig, KeywordRow, Post, SerpData } from "./types.ts";
import { slugify } from "./text.ts";

function cell(v: number | string | null | undefined, fmt?: ".2f"): string {
  if (v === null || v === undefined) return "-";
  if (fmt === ".2f") return (v as number).toFixed(2);
  return String(v);
}

/** Python's %g for the density percentage: 6 significant digits, trailing
 * zeros stripped (0.025*100 -> "2.5"). */
function pyG(x: number): string {
  return String(parseFloat(x.toPrecision(6)));
}

/** Real published pages the writer may link to. Same-category pages first
 * (the natural neighbors), deduped by slug: offering the same URL twice
 * just burns the writer's link budget. */
export function linkCandidates(posts: Post[], category: string, limit = 14): Post[] {
  const ordered = [
    ...posts.filter((p) => p.category === category),
    ...posts.filter((p) => p.category !== category),
  ];
  const seen = new Set<string>();
  const out: Post[] = [];
  for (const p of ordered) {
    if (seen.has(p.slug)) continue;
    seen.add(p.slug);
    out.push(p);
    if (out.length >= limit) break;
  }
  return out;
}

/** Cached SERP -> angle + FAQ material. Titles only for the organic set:
 * the writer needs the gap, not ammunition to paraphrase competitors. */
export function serpSection(serp: SerpData | null): string {
  if (!serp) return "No cached SERP for this keyword. Write from the topic itself.";
  const out: string[] = [];
  const titles = serp.organic
    .slice(0, 10)
    .map((o) => (o && typeof o === "object" ? o.title : undefined))
    .filter((t): t is string => Boolean(t));
  if (titles.length) {
    out.push("What currently ranks (titles only, for angle and gap analysis):");
    out.push(...titles.map((t) => `  - ${t}`));
    out.push("");
    out.push(
      "Angle: write what these results underserve. The question they " +
        "all skip, the number none of them measured, the honest " +
        '"it depends" they all avoid. Do not re-cover their common ground.',
    );
  }
  const questions = serp.paa
    .slice(0, 10)
    .map((q) => (typeof q === "string" ? q : ((q as { question?: string })?.question ?? "")))
    .filter(Boolean);
  if (questions.length) {
    out.push("");
    out.push("People Also Ask (real questions; use these to shape the FAQ):");
    out.push(...questions.map((q) => `  - ${q}`));
  }
  return out.join("\n").trim() || "No usable SERP data.";
}

export interface BriefInput {
  cfg: EngineConfig;
  row: KeywordRow;
  /** Resolved category (caller applies the taxonomy fallback). */
  category: string;
  posts: Post[];
  serp: SerpData | null;
  /** ISO date injected for determinism (the Python used date.today()). */
  today: string;
}

export function renderBrief({ cfg, row, category: cat, posts, serp, today }: BriefInput): string {
  const lw = cfg.laws;
  const kw = row.keyword;
  const blog = cfg.site.blogPath.replace(/^\/+|\/+$/g, "");

  // Suggested slug, deduped against pages that already exist: several
  // keywords can converge on one slug, and a collision must never
  // overwrite a live post.
  let slug = slugify(kw);
  const taken = new Set(posts.map((p) => p.slug));
  if (taken.has(slug)) {
    const base = slug;
    let i = 2;
    while (taken.has(slug)) {
      slug = `${base}-${i}`;
      i += 1;
    }
  }

  const links = linkCandidates(posts, cat);
  const linklist =
    links.map((p) => `  - /${blog}/${p.slug}/  (${p.title})`).join("\n") ||
    "  (none yet; link only to pages that actually exist, never invent a slug)";

  const L: string[] = [`# Writer brief: "${kw}"`, ""];
  L.push(`Today's date is ${today}. Primary keyword: "${kw}". Category: ${cat}.`);
  L.push(`Suggested slug: ${slug} (page URL: /${blog}/${slug}/).`);
  L.push("");

  L.push("## The keyword row");
  L.push("");
  L.push(
    `- score: ${cell(row.score, ".2f")}  ` +
      `volume: ${cell(row.searchVolume)}  ` +
      `difficulty: ${cell(row.keywordDifficulty)}  ` +
      `intent: ${row.intent || "-"}`,
  );
  L.push(`- format: ${row.format || "-"}  source: ${row.source || "-"}`);
  if (row.notes) L.push(`- provenance: ${row.notes}`);
  L.push("");

  L.push("## Search context");
  L.push("");
  L.push(serpSection(serp));
  L.push("");

  L.push("## Hard requirements (the laws; `rankloop check` rejects the post otherwise)");
  L.push("");
  L.push(`- ${lw.wordMin} to ${lw.wordMax} words in the article body`);
  L.push(`- At least ${lw.h2Min} H2 sections`);
  L.push(`- At least ${lw.faqMin} FAQ entries: real questions with direct answers`);
  L.push(`- At least ${lw.internalLinksMin} internal links, using ONLY these real pages:`);
  L.push(linklist);
  L.push(`- Title at most ${lw.titleMax} characters; meta description at most ${lw.descriptionMax}`);
  L.push(
    `- Use the exact phrase "${kw}" in the body at least once, ` +
      `but keep its density under ${pyG(lw.keywordDensityMax * 100)}%`,
  );
  if (lw.banEmDash) L.push("- NO em dashes anywhere. Use commas, colons or a full stop.");
  if (lw.requireFirstPerson)
    L.push('- Written in first person where natural ("I built", "I measured", "in my testing")');
  L.push(`- Category must be exactly: ${cat}`);
  L.push(`- Publish date: ${today}`);
  L.push("");

  L.push("## Banned phrases (automatic rejection)");
  L.push("");
  L.push(lw.bannedPhrases.join(", "));
  L.push("");

  // The anti-slop voice rules, ported from the daily routine that wrote the
  // source corpus. These are the product: every law above is enforceable by
  // regex, but this section is what makes a post worth ranking.
  L.push("## Voice");
  L.push("");
  L.push(
    "Write like a working practitioner explaining something to a peer.\n" +
      "Concrete over abstract. Short sentences carry the weight. No hype, no\n" +
      "marketing cadence, no sentence that could open any article on any\n" +
      "topic. Earn the reader's next paragraph. If the honest answer to the\n" +
      'title\'s question is "no" or "it depends", say so plainly rather than\n' +
      "padding toward a pitch.",
  );
  L.push("");
  L.push(
    "Every product claim (yours or a competitor's) must be something you can\n" +
      "actually verify; when you cannot, hedge honestly or cut the claim. The\n" +
      "post should be genuinely useful to someone who never buys anything from\n" +
      "you. Sell nothing until the end.",
  );
  L.push("");

  L.push("## Site taxonomy");
  L.push("");
  for (const [c, hub] of Object.entries(cfg.taxonomy)) {
    const marker = c === cat ? "  <- this post" : "";
    L.push(`- ${c} -> /${blog}/${hub}/${marker}`);
  }
  L.push("");
  return L.join("\n");
}

/** run_brief's category fallback: the row's category if it is a real hub,
 * else the first configured category, else whatever the row carried. */
export function resolveCategory(cfg: EngineConfig, rowCategory: string | null): string {
  const cats = Object.keys(cfg.taxonomy);
  if (rowCategory !== null && rowCategory in cfg.taxonomy) return rowCategory;
  return cats[0] ?? (rowCategory || "Guides");
}
