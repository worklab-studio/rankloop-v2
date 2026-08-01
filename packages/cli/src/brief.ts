/** `rankloop brief <keyword>` — the writer brief, offline.
 *
 * The same renderer the dashboard uses, fed only from what is on disk: the
 * config, and the posts that actually exist. That means no SERP section, no
 * volume, no difficulty, no score. It is honestly weaker than the grounded
 * brief that comes over MCP, and it says so in the output rather than
 * printing "-" and letting the writer assume the data was checked.
 *
 * What it still carries is everything the laws will judge: the thresholds,
 * the taxonomy, the banned phrases, and the real internal-link candidates.
 * That is enough to write a post that passes without guessing at the rules. */

import { manifest, renderBrief, resolveCategory } from "@rankloop/engine";
import type { KeywordRow } from "@rankloop/engine";
import { ConfigError, loadConfig } from "./config.ts";
import { CorpusError, loadCorpus } from "./corpus.ts";
import type { Io } from "./io.ts";

export interface BriefOptions {
  dir: string;
  keyword: string;
  /** Overrides the taxonomy fallback when the writer already knows the hub. */
  category?: string | undefined;
  /** Injected so the output is reproducible in a test. */
  today?: string | undefined;
}

/** UTC, deliberately, and not the machine's local day.
 *
 * The date this returns is printed as the post's publish date and read back by
 * the laws (`parseIsoDate` is UTC), by the quota's day arithmetic and by the
 * dashboard, which stamps its own briefs in UTC too. A local-time day would
 * put a writer in Auckland a day ahead of the same brief rendered on the
 * server, and a writer in Los Angeles a day behind it, for the same run. One
 * clock for everyone is worth more than matching the wall in the room.
 * `toISOString` is the UTC one; the test pins that with a shifted TZ. */
function isoToday(): string {
  return new Date().toISOString().slice(0, 10);
}

export function runBrief(options: BriefOptions, io: Io): number {
  const keyword = options.keyword.trim().toLowerCase();
  if (keyword === "") {
    io.err("usage: rankloop brief <keyword>");
    return 1;
  }

  let loaded;
  let posts;
  try {
    loaded = loadConfig(options.dir);
    posts = manifest(
      loaded.cfg,
      loadCorpus(loaded.root, loaded.contentDir, loaded.cfg.site.mode),
    );
  } catch (error) {
    if (error instanceof ConfigError || error instanceof CorpusError) {
      io.err(error.message);
      return 1;
    }
    io.err(`parse fail: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  const row: KeywordRow = {
    keyword,
    category: options.category ?? null,
    format: null,
    // Nothing on disk knows what this keyword is worth. The grounded numbers
    // come from the backlog over MCP; leaving them null prints "-", which is
    // the truth.
    searchVolume: null,
    keywordDifficulty: null,
    intent: null,
    score: null,
    source: "local",
    notes: "offline brief: no SERP, no volume, no network. Grounding comes from the site itself.",
  };

  io.out(
    renderBrief({
      cfg: loaded.cfg,
      row,
      category: resolveCategory(loaded.cfg, row.category),
      posts,
      serp: null,
      today: options.today ?? isoToday(),
    }),
  );
  return 0;
}
