/** Framework and content-directory detection.
 *
 * `init` has to guess two things before it can scaffold anything: where the
 * posts live and whether they are markdown or rendered html. Guessing from
 * the dependency list plus a short candidate list of directories is right
 * far more often than asking a user to type a path, and when it is wrong the
 * interactive prompt costs one keystroke to correct.
 *
 * Nothing here is niche knowledge: these are the conventions the frameworks
 * themselves ship in their starters. */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { SiteMode } from "@rankloop/engine";

export type Framework = "astro" | "next" | "eleventy" | "hugo" | "markdown";

export interface Detection {
  framework: Framework;
  /** How to say it to a human: "Astro", "plain markdown". */
  label: string;
  /** Relative to the scanned root; null when nothing plausible was found. */
  contentDir: string | null;
  mode: SiteMode;
  /** Best guess at the URL path posts are served under. */
  blogPath: string;
}

const LABELS: Record<Framework, string> = {
  astro: "Astro",
  next: "Next.js",
  eleventy: "Eleventy",
  hugo: "Hugo",
  markdown: "plain markdown",
};

/** Directories a content walk must never descend into. Cheap, and it keeps a
 * detection scan from reading a 200MB node_modules. */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  ".astro",
  ".cache",
  ".vercel",
  "dist",
  "build",
  "public",
  "out",
  "resources",
]);

const MARKDOWN_EXTENSIONS = [".md", ".mdx", ".markdown"];

/** Ordered by specificity: the first candidate that actually holds content
 * wins, so a repo with both `content/` and `content/blog/` gets the narrower
 * one and does not sweep in every unrelated page. */
const CANDIDATES: Record<Framework, string[]> = {
  astro: [
    "src/content/blog",
    "src/content/posts",
    "src/content/articles",
    "src/pages/blog",
    "src/content",
  ],
  next: [
    "src/content/blog",
    "src/content/posts",
    "content/blog",
    "content/posts",
    "src/posts",
    "posts",
    "_posts",
    "content",
  ],
  eleventy: ["src/posts", "src/blog", "posts", "blog", "content/posts", "content"],
  hugo: ["content/posts", "content/blog", "content/post", "content/articles", "content"],
  markdown: [
    "content/blog",
    "content/posts",
    "src/content/blog",
    "posts",
    "blog",
    "_posts",
    "content",
    "docs",
  ],
};

/** The directory name is the best available guess at the URL path, and it is
 * right for Hugo's `content/posts` -> /posts/ and for most hand-rolled sites.
 * Anything else gets `blog`; the user edits one line of rankloop.json. */
const PATH_LIKE_NAMES = new Set(["blog", "posts", "articles", "guides", "writing", "notes"]);

function readPackageJson(root: string): Record<string, unknown> | null {
  const path = join(root, "package.json");
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    // A package.json we cannot read tells us nothing; fall through to the
    // filesystem signals rather than failing the whole init.
    return null;
  }
}

function dependencyNames(pkg: Record<string, unknown> | null): Set<string> {
  const names = new Set<string>();
  if (!pkg) return names;
  for (const field of ["dependencies", "devDependencies"]) {
    const block = pkg[field];
    if (typeof block === "object" && block !== null) {
      for (const name of Object.keys(block)) names.add(name);
    }
  }
  return names;
}

function anyExists(root: string, names: string[]): boolean {
  return names.some((name) => existsSync(join(root, name)));
}

export function detectFramework(root: string): Framework {
  const deps = dependencyNames(readPackageJson(root));
  // Dependency evidence first: it is a declaration, where a stray config file
  // is only a leftover. Astro before Next because an Astro repo can carry
  // `next` in a docs example, never the reverse.
  if (deps.has("astro")) return "astro";
  if (deps.has("next")) return "next";
  if (deps.has("@11ty/eleventy")) return "eleventy";
  if (anyExists(root, [".eleventy.js", "eleventy.config.js", "eleventy.config.mjs"])) {
    return "eleventy";
  }
  if (anyExists(root, ["hugo.toml", "hugo.yaml", "hugo.json", "config.toml", "config.yaml"])) {
    return "hugo";
  }
  return "markdown";
}

function entries(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function isMarkdownFile(name: string): boolean {
  return MARKDOWN_EXTENSIONS.some((ext) => name.endsWith(ext));
}

/** What kind of pages a directory holds, looking two levels down: markdown
 * files, or `<slug>/index.html` post directories, or nothing usable. */
export function contentModeOf(dir: string, depth = 2): SiteMode | null {
  if (!isDirectory(dir)) return null;
  let html = false;
  for (const name of entries(dir)) {
    if (name.startsWith(".") || SKIP_DIRS.has(name)) continue;
    const path = join(dir, name);
    if (isDirectory(path)) {
      if (existsSync(join(path, "index.html"))) html = true;
      if (depth > 0) {
        const nested = contentModeOf(path, depth - 1);
        // markdown wins over html: a markdown source tree that also renders
        // html into a subfolder is still a markdown site.
        if (nested === "markdown") return "markdown";
        if (nested === "html") html = true;
      }
      continue;
    }
    if (isMarkdownFile(name)) return "markdown";
    if (name.endsWith(".html") && name !== "index.html") html = true;
  }
  return html ? "html" : null;
}

export function blogPathFor(contentDir: string | null): string {
  if (!contentDir) return "blog";
  const name = basename(contentDir).replace(/^_/, "");
  return PATH_LIKE_NAMES.has(name) ? name : "blog";
}

export function detect(root: string): Detection {
  const framework = detectFramework(root);
  for (const candidate of CANDIDATES[framework]) {
    const mode = contentModeOf(join(root, candidate));
    if (mode) {
      return {
        framework,
        label: LABELS[framework],
        contentDir: candidate,
        mode,
        blogPath: blogPathFor(candidate),
      };
    }
  }
  return {
    framework,
    label: LABELS[framework],
    contentDir: null,
    mode: "markdown",
    blogPath: "blog",
  };
}
