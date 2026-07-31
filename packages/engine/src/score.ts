/** Relevance gate, classifier and scorer — ported verbatim from
 * rankloop 0.2 discover.py. These three functions are shared by every
 * source (paid metrics, autocomplete, harvested questions, GSC), so all
 * inputs pass the identical gate. Parity-tested against the Python. */

import type { EngineConfig, Intent } from "./types.ts";

function joinedRx(patterns: string[]): RegExp | null {
  return patterns.length ? new RegExp(patterns.join("|"), "i") : null;
}

/** Negative patterns veto first, then a positive pattern must claim the
 * keyword. An empty positive list accepts everything that survives the
 * negatives — convenient on day one, dangerous at scale. */
export function relevant(cfg: EngineConfig, kw: string): boolean {
  const neg = joinedRx(cfg.keywords.negative);
  if (neg && neg.test(kw)) return false;
  const pos = joinedRx(cfg.keywords.positive);
  return pos ? pos.test(kw) : true;
}

/** Built-in rules may propose categories the site doesn't have; a category
 * that isn't a real hub is a broken breadcrumb, so unknown names collapse
 * to the first configured category. */
function category(cfg: EngineConfig, name: string): string {
  const cats = Object.keys(cfg.taxonomy);
  return name in cfg.taxonomy ? name : (cats[0] ?? name);
}

/** Map a keyword onto [category, format]. Site-authored classify rules run
 * first (they know the niche); then the built-ins ported from the
 * production engine — word-shape tells you what kind of page the searcher
 * expects. */
export function classify(cfg: EngineConfig, kw: string): [string, string] {
  const k = kw.toLowerCase();
  for (const rule of cfg.keywords.classify) {
    if (rule.pattern && new RegExp(rule.pattern, "i").test(k)) {
      return [rule.category || category(cfg, "Guides"), rule.format || "explainer"];
    }
  }
  if (/\bvs\b|versus/.test(k) || k.includes("alternative") || k.includes("instead of"))
    return [category(cfg, "Compare"), "comparison"];
  if (k.includes("review") || k.includes("worth it"))
    return [category(cfg, "Reviews"), "review"];
  if (/\bbest\b|\btop\b|apps for|tools for/.test(k))
    return [category(cfg, "Lists"), "listicle"];
  if (/size|dimension|resolution|how (big|tall|wide)|measured/.test(k))
    return [category(cfg, "Data"), "data"];
  if (/not working|fix|problem|error|stuck|slow|drain/.test(k))
    return [category(cfg, "Guides"), "troubleshooting"];
  if (/^how |^what |^why |^can |^does |^is |^do /.test(k))
    return [category(cfg, "Guides"), k.startsWith("how") ? "how-to" : "explainer"];
  return [category(cfg, "Guides"), "explainer"];
}

const INTENT_BOOST: Record<string, number> = {
  commercial: 1.3,
  transactional: 1.4,
  informational: 1.0,
  navigational: 0.6,
};

/** log-volume x inverse-difficulty x intent boost. NULL volume scores as
 * zero volume (log10(10) = 1.0) rather than zero score — the free
 * long-tail sources live there and a hard zero would bury them forever. */
export function score(
  volume: number | null | undefined,
  difficulty: number | null | undefined,
  intent: Intent | null | undefined,
): number {
  const v = Math.log10((volume ?? 0) + 10);
  const d = (100 - (difficulty ?? 50)) / 50;
  const boost = INTENT_BOOST[intent ?? ""] ?? 1.0;
  return round3(v * d * boost);
}

/** Match Python round(x, 3) closely enough for scoring (banker's rounding
 * differences only bite on exact .0005 boundaries, which log10 products
 * never hit in practice — the parity fixtures would catch it). */
function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}
