/** Where in the file a violation is, for the laws that can point at text.
 *
 * This decides NOTHING. The verdict has already come back from the engine's
 * `validate`; all this does is find a line number so a GitHub annotation
 * lands on the offending line of the diff instead of on line 1 of the file.
 * Two laws can be located that way — an em dash and a banned phrase are both
 * a specific string that is present. Every other law fails for an absence (too
 * few words, no FAQ, a link that resolves nowhere), and an absence has no
 * line: pointing at one would be a guess dressed up as precision.
 *
 * A drift here shows up as an annotation on the wrong line, never as a post
 * that ships or a post that is wrongly rejected. */

import { articleText, fillerHits } from "@rankloop/engine";
import type { EngineConfig, Post } from "@rankloop/engine";

const EM_DASH = "—";

/** 1-based line containing `index`, the convention every editor and CI
 * annotation uses. */
function lineAt(text: string, index: number): number {
  if (index < 0) return 1;
  let line = 1;
  for (let i = 0; i < index; i++) if (text[i] === "\n") line += 1;
  return line;
}

function firstBannedPhraseLine(cfg: EngineConfig, post: Post): number {
  const hits = fillerHits(cfg, articleText(cfg, post));
  const low = post.raw.toLowerCase();
  // Scan the raw file rather than the extracted prose: the prose has the
  // frontmatter (or the html head) stripped, so its offsets do not map back
  // to file lines.
  const positions = hits
    .map((phrase) => low.indexOf(phrase.toLowerCase()))
    .filter((at) => at !== -1);
  return positions.length === 0 ? 1 : lineAt(post.raw, Math.min(...positions));
}

/** Matched on the engine's stable law-name prefixes; the thresholds those
 * names carry ("word count >= 850") move with the config. */
export function lineOfViolation(cfg: EngineConfig, post: Post, law: string): number {
  if (law === "em dash") return lineAt(post.raw, post.raw.indexOf(EM_DASH));
  if (law === "no filler AI phrases") return firstBannedPhraseLine(cfg, post);
  return 1;
}
