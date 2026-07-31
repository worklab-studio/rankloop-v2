/** Loading the content tree from disk.
 *
 * The engine grades `{ slug, raw }` entries and knows nothing about files;
 * this module is the only place that turns a repository into that shape. It
 * also holds the slug -> file mapping, which is what lets a violation be
 * reported at a path a developer can open instead of at a slug they then have
 * to go hunting for. */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative, sep } from "node:path";
import type { CorpusEntry, SiteMode } from "@rankloop/engine";
import { isMarkdownFile } from "./detect.ts";

export class CorpusError extends Error {}

export interface LoadedPost extends CorpusEntry {
  /** Path relative to the repo root, POSIX-separated: what CI annotates. */
  file: string;
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".astro"]);

function walk(dir: string, out: string[]): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names.sort()) {
    if (name.startsWith(".") || SKIP_DIRS.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
}

/** `blog/my-post/index.md` is one post named `my-post`, not one named
 * `index` — the directory carries the slug in every framework that uses this
 * layout. A bare `blog/my-post.md` names itself. */
function slugOf(contentDir: string, path: string): string {
  const stem = basename(path, extname(path));
  if (stem !== "index") return stem;
  const dir = dirname(path);
  return dir === contentDir ? stem : basename(dir);
}

function posixPath(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

/**
 * Every post under `contentDir`, in slug order.
 *
 * A duplicate slug is fatal rather than last-write-wins: two files claiming
 * one URL is a bug the laws cannot see, and silently grading only one of them
 * would hide it behind a green check.
 */
export function loadCorpus(root: string, contentDir: string, mode: SiteMode): LoadedPost[] {
  const files: string[] = [];
  walk(contentDir, files);

  const wanted = files.filter((path) =>
    mode === "markdown" ? isMarkdownFile(path) : path.endsWith(".html"),
  );

  const bySlug = new Map<string, LoadedPost>();
  for (const path of wanted) {
    const slug = slugOf(contentDir, path);
    const file = posixPath(root, path);
    const clash = bySlug.get(slug);
    if (clash) {
      throw new CorpusError(
        `duplicate slug "${slug}": ${clash.file} and ${file} would publish to the same URL`,
      );
    }
    bySlug.set(slug, { slug, file, raw: readFileSync(path, "utf8") });
  }

  return [...bySlug.values()].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
}
