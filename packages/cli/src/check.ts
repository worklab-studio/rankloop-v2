/** `rankloop check` — the publish laws as a CI status check.
 *
 * The whole point of this command is that it needs nothing: no API key, no
 * rankloop account, no network, no model. It reads rankloop.json, reads the
 * content tree, and asks @rankloop/engine for verdicts. Whichever writer
 * produced a post — an agent, the hosted writer, or a human at 2am — nothing
 * merges that breaks the laws.
 *
 * Not one law is implemented here. `manifest` and `validate` are the engine's,
 * they are parity-tested against the Python original, and the dashboard's own
 * gate calls the same two functions. A second opinion about how long is long
 * enough would fork the method the product sells. */

import { manifest, validate } from "@rankloop/engine";
import { ConfigError, loadConfig } from "./config.ts";
import { CorpusError, loadCorpus } from "./corpus.ts";
import type { LoadedPost } from "./corpus.ts";
import type { Io } from "./io.ts";
import { lineOfViolation } from "./locate.ts";
import { formatViolation, summarize } from "./report.ts";
import type { Violation } from "./report.ts";

export type CheckFormat = "human" | "github";

export interface CheckOptions {
  /** Directory holding rankloop.json. */
  dir: string;
  format: CheckFormat;
}

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;

/**
 * Returns the process exit code: 0 when every law passes, 1 on any violation
 * and on anything that stopped the check from running at all. CI only reads
 * the one bit, and "the config is broken" must never be greener than "a post
 * is broken".
 */
export function runCheck(options: CheckOptions, io: Io): number {
  let loaded;
  let corpus: LoadedPost[];
  try {
    loaded = loadConfig(options.dir);
    corpus = loadCorpus(loaded.root, loaded.contentDir, loaded.cfg.site.mode);
  } catch (error) {
    if (error instanceof ConfigError || error instanceof CorpusError) {
      io.err(error.message);
      return EXIT_FAILED;
    }
    throw error;
  }

  if (corpus.length === 0) {
    io.out(`no posts found under ${loaded.contentDirRelative}; nothing to check`);
    return EXIT_OK;
  }

  const { cfg } = loaded;
  let posts;
  try {
    posts = manifest(cfg, corpus);
  } catch (error) {
    // The engine throws with the slug in the message on an unparseable post
    // (no JSON-LD, no BlogPosting node). A corrupt corpus stops the pipeline
    // rather than silently shrinking it.
    io.err(`parse fail: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT_FAILED;
  }

  const fileOf = new Map(corpus.map((entry) => [entry.slug, entry.file]));
  const postOf = new Map(posts.map((post) => [post.slug, post]));

  const violations: Violation[] = validate(cfg, posts).map((problem) => {
    const post = postOf.get(problem.slug)!;
    return {
      file: fileOf.get(problem.slug) ?? problem.slug,
      slug: problem.slug,
      law: problem.law,
      line: lineOfViolation(cfg, post, problem.law),
    };
  });

  for (const violation of violations) io.out(formatViolation(violation, options.format));

  const summary = summarize(violations, posts.length);
  // In github format the summary is a notice, not an annotation: annotating
  // "3 violations" against a file would put a second marker on a line that
  // already carries the real one.
  io.out(options.format === "github" && violations.length > 0 ? `::notice::${summary}` : summary);

  return violations.length > 0 ? EXIT_FAILED : EXIT_OK;
}
