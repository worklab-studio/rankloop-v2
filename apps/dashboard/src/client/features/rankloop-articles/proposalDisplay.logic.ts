import type { TagColorKey } from "@/shared/tag-colors";

type ProposalTypeDisplay = { label: string; color: TagColorKey };

// The three optimize-track signals from S3a plus S7a's net-new type. Emerald
// is the one colour left that reads as growth once violet is spoken for by
// the page-type chip a write_new row also carries, and lime by its
// fresh-question chip — a row can wear three chips, so none of them may
// collide.
//
// Merge and prune have no emitter yet, and they are still named here: the
// Automation surface lists every type the proposals column knows, so the two
// that may never run unattended were rendering as raw lowercase "merge" and
// "prune" beside four proper labels — a missing translation, read as one.
// Rose and fuchsia are what the palette has left, and they are the right
// leftovers: both actions remove or redirect a page that exists, and warm
// reads as caution next to emerald's growth. A type beyond these still falls
// back to a neutral chip rather than crashing on a missing color.
const TYPE_DISPLAY = new Map<string, ProposalTypeDisplay>([
  ["retitle", { label: "Retitle", color: "sky" }],
  ["push", { label: "Push", color: "violet" }],
  ["refresh", { label: "Refresh", color: "amber" }],
  ["write_new", { label: "Write new", color: "emerald" }],
  ["merge", { label: "Merge", color: "fuchsia" }],
  ["prune", { label: "Prune", color: "rose" }],
]);

export function proposalTypeDisplay(type: string): ProposalTypeDisplay {
  return TYPE_DISPLAY.get(type) ?? { label: type, color: "slate" };
}

// Scores are recovered-clicks-scale reals (impressions × deficit for
// RETITLE), so one decimal keeps 1,240.7 readable without false precision.
const scoreFormat = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
});

export function formatScore(score: number): string {
  return scoreFormat.format(score);
}

// Numeric factor values keep two decimals because sub-1 multipliers (CTR
// deficit, proximity) would collapse at one — 0.55 and 0.61 both round to
// "0.6". String values arrive pre-formatted at compute time and render
// verbatim.
const factorValueFormat = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 2,
});

export function formatFactorValue(value: string | number): string {
  return typeof value === "number" ? factorValueFormat.format(value) : value;
}

type WinningQuery = { query: string; detail: string };

// Retitle evidence chips are pre-formatted at compute time as
// `"query" · stats…` (see computeRetitleCandidates), so the Apply modal
// recovers the bare query from the leading quoted segment and keeps the full
// chip as hover detail. The "+n more below expected" summary chip carries no
// query and drops out.
const QUOTED_QUERY_PREFIX = /^"(.+)" · /;

export function retitleWinningQueries(evidence: string[]): WinningQuery[] {
  const queries: WinningQuery[] = [];
  for (const chip of evidence) {
    const match = QUOTED_QUERY_PREFIX.exec(chip);
    if (match) queries.push({ query: match[1], detail: chip });
  }
  return queries;
}
