/** A throwaway site on disk, for the tests that need a real content tree.
 *
 * The posts are generated rather than committed as fixtures because every one
 * of them has to CLEAR the laws — 850 words, four H2s, three question-shaped
 * headings, two links that resolve — and eight hundred words of committed
 * filler in the repo would be read by nobody and maintained by nobody. What
 * matters to the tests is which law a post breaks, and that is set explicitly
 * per post below. */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface PostSpec {
  slug: string;
  title?: string;
  description?: string;
  date?: string;
  category?: string;
  keyword?: string;
  /** Slugs this post links to; a slug with no post is a dead link. */
  links?: string[];
  /** Dropped into the body verbatim, for the laws that fail on a string. */
  inject?: string;
  /** Roughly how many words of body prose. */
  words?: number;
}

const SENTENCES = [
  "I measured the grind on a set of kitchen scales before every shot.",
  "The result held across three machines and two bags of beans.",
  "Nothing here needs a subscription or a second device to reproduce.",
  "A dose that heavy pulls sour no matter how fine you go.",
  "Water temperature moved the outcome less than the burr alignment did.",
  "The cheap timer was accurate to about half a second, which was enough.",
  "Most guides skip the part where the basket itself limits the yield.",
  "I threw out the first four shots of every session and logged the rest.",
];

function paragraphs(wordTarget: number, keyword: string, seed: number): string {
  const out: string[] = [];
  let words = 0;
  let index = seed;
  while (words < wordTarget) {
    const lines: string[] = [];
    for (let i = 0; i < 4; i++) {
      const sentence = SENTENCES[index++ % SENTENCES.length]!;
      lines.push(sentence);
      words += sentence.split(/\s+/).length;
    }
    out.push(lines.join(" "));
  }
  // The keyword-in-body law needs the exact phrase at least once, and the
  // density law caps how often: one mention in ~900 words is well under 2.5%.
  out.push(`The short version: a ${keyword} is worth buying used.`);
  return out.join("\n\n");
}

export function markdownPost(spec: PostSpec): string {
  const keyword = spec.keyword ?? "espresso grinder";
  const links = (spec.links ?? []).map((slug) => `[${slug}](/blog/${slug}/)`).join(" and ");
  const body = [
    "I bought the wrong machine twice before this one worked.",
    "",
    "## What I actually measured",
    "",
    paragraphs(spec.words ?? 900, keyword, 0),
    "",
    links === "" ? "" : `See also ${links}.`,
    "",
    "## Where the numbers came from",
    "",
    paragraphs(120, keyword, 3),
    spec.inject ?? "",
    "",
    "## What I would do differently",
    "",
    paragraphs(120, keyword, 5),
    "",
    "## Frequently asked questions",
    "",
    "### Does the burr material matter?",
    "",
    "In my testing, less than the alignment did.",
    "",
    "### Is a used one safe to buy?",
    "",
    "Yes, if you can see it run before you pay.",
    "",
    "### How long does a burr set last?",
    "",
    "About four hundred kilograms of beans, give or take the roast.",
  ].join("\n");

  return [
    "---",
    `title: ${spec.title ?? "What I learned buying a grinder"}`,
    `description: ${spec.description ?? "The measurements I took, the mistakes I made, and what I would buy again."}`,
    `date: ${spec.date ?? "2026-07-01"}`,
    `category: ${spec.category ?? "Guides"}`,
    `keyword: ${keyword}`,
    "---",
    "",
    body,
    "",
  ].join("\n");
}

export interface SiteSpec {
  posts: PostSpec[];
  /** Overrides merged into the scaffolded config's `laws` block. */
  laws?: Record<string, unknown>;
  contentDir?: string;
}

export interface TempSite {
  root: string;
  contentDir: string;
}

export function writeSite(spec: SiteSpec): TempSite {
  const root = mkdtempSync(join(tmpdir(), "rankloop-cli-"));
  const contentDir = spec.contentDir ?? "content/blog";

  const config = {
    site: {
      url: "https://example.com",
      name: "Example",
      description: "A site that exists only inside a test.",
      blogPath: "blog",
      mode: "markdown",
    },
    contentDir,
    taxonomy: { Guides: "guides", Comparisons: "compare" },
    laws: spec.laws ?? {},
  };
  writeFileSync(join(root, "rankloop.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");

  for (const post of spec.posts) {
    const path = join(root, contentDir, `${post.slug}.md`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, markdownPost(post), "utf8");
  }
  return { root, contentDir };
}

/** Three posts that all pass, each linking to the other two. */
export function cleanSite(): TempSite {
  return writeSite({
    posts: [
      { slug: "grinder-notes", links: ["burr-alignment", "used-machines"] },
      { slug: "burr-alignment", links: ["grinder-notes", "used-machines"] },
      { slug: "used-machines", links: ["grinder-notes", "burr-alignment"] },
    ],
  });
}
