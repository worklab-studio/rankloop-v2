import type { TagColorKey } from "@/shared/tag-colors";

type ChipDisplay = { label: string; color: TagColorKey };

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

// Three sources get a color because three sources mean something different
// about the row: 'gsc' is demand this site already proved it can be shown for,
// 'gap' is demand a tracked competitor is currently eating, 'harvest' is a
// question a human actually asked out loud. The rest — expansion,
// autocomplete, manual — are ideas, and ideas share the neutral chip rather
// than each claiming a color the eye then has to learn.
const SOURCE_DISPLAY = new Map<string, ChipDisplay>([
  ["gsc", { label: "search console", color: "sky" }],
  ["gap", { label: "competitor gap", color: "violet" }],
  ["harvest", { label: "harvest", color: "lime" }],
  ["expansion", { label: "expansion", color: "slate" }],
  ["autocomplete", { label: "autocomplete", color: "slate" }],
  ["manual", { label: "manual", color: "slate" }],
]);

export function sourceDisplay(source: string): ChipDisplay {
  return SOURCE_DISPLAY.get(source) ?? { label: source, color: "slate" };
}

/** The filter row's label for a source, same words as the chip so a founder
 *  filtering by "competitor gap" sees rows chipped "competitor gap". */
export function sourceLabel(source: string): string {
  return sourceDisplay(source).label;
}

// ---------------------------------------------------------------------------
// What the metered buttons cost
// ---------------------------------------------------------------------------

// Provider prices, not billed amounts — the hosted markup lives in the
// metering seam and a self-host operator pays exactly these. Both are Labs
// endpoints priced per call, and both are stated per unit the user chose
// (a competitor, a seed) rather than per run, because the run's size is the
// user's decision and a single "~$0.40 a run" would be a guess about it.
const GAP_CALL_COST_USD = 0.02;
const EXPANSION_CALL_COST_USD = 0.01;

/** Seeds one expansion run may spend, mirroring the workflow's own cap. */
const EXPANSION_MAX_SEEDS = 20;

/**
 * The cost sentence under a metered button. Every number carries a tilde:
 * these are per-call list prices and a run's real total depends on how many
 * competitors are tracked or how many seeds clear the scoring floor, so
 * stating an exact total would be the one dishonest number on this screen.
 */
export function costSentence(source: "gap" | "expansion"): string {
  if (source === "gap") {
    return `~$${GAP_CALL_COST_USD.toFixed(2)} per competitor`;
  }
  return `~$${EXPANSION_CALL_COST_USD.toFixed(
    2,
  )} per seed · up to ${EXPANSION_MAX_SEEDS} seeds a run`;
}

// ---------------------------------------------------------------------------
// Run state
// ---------------------------------------------------------------------------

// Gerunds per source, so the running button says which step is spending time
// rather than a generic "Working…". A run with several sources names the one
// the user pressed first; the rest are visible in the stamp when it lands.
const RUNNING_LABEL = new Map<string, string>([
  ["gsc", "Reading Search Console…"],
  ["gap", "Finding gaps…"],
  ["expansion", "Expanding seeds…"],
  ["autocomplete", "Asking autocomplete…"],
  ["harvest", "Harvesting questions…"],
]);

export function runningLabel(sources: readonly string[]): string {
  const first = sources[0];
  return (first ? RUNNING_LABEL.get(first) : null) ?? "Filling the backlog…";
}

/**
 * The tab's stamp. The seen/kept pair is the run's whole honesty: rejected
 * candidates are counted and written nowhere, so the only place the gate's
 * work is visible is this sentence. The NULL-volume clause is not a caveat —
 * it is the doctrine the table would otherwise look broken without.
 */
export function universeStamp(
  run: { seenCount: number | null; keptCount: number | null } | null,
): string {
  const nullVolume =
    "NULL-volume rows are kept on purpose — long tail is where a new site wins";
  if (!run || run.seenCount === null || run.keptCount === null) {
    return nullVolume;
  }
  return [
    `${run.seenCount.toLocaleString("en-US")} candidate${
      run.seenCount === 1 ? "" : "s"
    } seen`,
    `${run.keptCount.toLocaleString("en-US")} passed your gate`,
    nullVolume,
  ].join(" · ");
}

// ---------------------------------------------------------------------------
// The gate card
// ---------------------------------------------------------------------------

/** Where the tokens came from, in one line. The second half is the promise
 *  the "Re-derive" button's disabled state keeps: an edited gate is yours. */
export const GATE_STAMP =
  "derived from your own pages and queries — edit anytime";

/** Why "Re-derive" is disabled. The rule lives in the schema (user_edited),
 *  not in this tooltip — the tooltip only has to say what the rule protects. */
export const REDERIVE_DISABLED_TOOLTIP =
  "You have edited these tokens, so re-deriving would overwrite your work. Remove a token you disagree with instead.";

/**
 * The KD ceiling's stamp — what earned this number, and how fast it can move.
 *
 * A ceiling that has never been computed against real samples says so: it is
 * the starting floor, and claiming a project "earned" 20 before it ranked for
 * anything would be the same lie as an estimated metric. `sampleCount` is
 * quoted only when the payload carries one, because the gate row stores the
 * ceiling and not the sample set behind it.
 */
export function kdCeilingStamp(gate: {
  kdCeilingUpdatedAt: string | null;
  sampleCount?: number | null;
}): string {
  const move = "moves at most +5 per computation";
  if (gate.kdCeilingUpdatedAt === null) {
    return `the starting ceiling — you need 10 keywords ranking top-10 before it moves · ${move}`;
  }
  if (gate.sampleCount == null) {
    return `earned from the keywords you already rank top-10 for · ${move}`;
  }
  return `earned from ${gate.sampleCount.toLocaleString(
    "en-US",
  )} keyword${gate.sampleCount === 1 ? "" : "s"} you already rank top-10 for · ${move}`;
}

/**
 * A derived token with the document count that admitted it ("espresso · 41
 * pages"). Counts are absent for a token a human typed in — nothing counted
 * it, and printing "0 pages" beside it would read as a warning rather than as
 * the truth that it was your idea.
 */
export function gateTokenLabel(token: {
  token: string;
  documentCount?: number | null;
}): string {
  if (token.documentCount == null) return token.token;
  return `${token.token} · ${token.documentCount.toLocaleString("en-US")} page${
    token.documentCount === 1 ? "" : "s"
  }`;
}

// ---------------------------------------------------------------------------
// Table cells
// ---------------------------------------------------------------------------

/** Volume and score share the em-dash-for-null rule the whole app uses: a
 *  keyword nobody priced is not a keyword worth zero. */
export function formatMetric(value: number | null): string {
  return value === null ? "—" : value.toLocaleString("en-US");
}

/** Score is the engine's own 0–100 ordering. One decimal: the differences
 *  between adjacent rows are fractional, and rounding them away would make a
 *  sorted column look arbitrary. */
export function formatScore(value: number | null): string {
  return value === null ? "—" : value.toFixed(1);
}

// Only the statuses a backlog row can be seen in here. 'discovered' is the
// norm and reads as plain text rather than a badge — a badge on every row is
// no signal at all.
const STATUS_LABEL = new Map<string, string>([
  ["discovered", "in the backlog"],
  ["planned", "in a page type"],
  ["proposed", "proposed"],
  ["queued", "queued to write"],
  ["published", "published"],
  ["skipped", "skipped"],
  ["needs_human", "needs a human"],
]);

export function statusLabel(status: string): string {
  return STATUS_LABEL.get(status) ?? status;
}

/** Cluster keys are machine-shaped ("vs-comparison"); the column prints the
 *  key as stored because it is what the page plan clusters on, and inventing
 *  a prettier label would decouple the two. */
export function clusterLabel(clusterKey: string | null): string {
  return clusterKey ?? "—";
}
