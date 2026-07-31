import type { TagColorKey } from "@/shared/tag-colors";

type ChipDisplay = { label: string; color: TagColorKey };

// Structural subsets of what the plan run stores, so this module stays a pure
// display layer with no server or db import behind it — the same shape
// competitorDisplay.logic.ts takes.
type SerpCheck = {
  status: string;
  reason: string | null;
  sampled: number;
  hardSerps: number;
  aiOverviews: number;
  winnable: number;
};

type Evidence =
  | { hasCompetitorSignal: false; competitorsChecked: number }
  | {
      hasCompetitorSignal: true;
      leadDomain: string;
      pageSharePct: number;
      etvSharePct: number | null;
    };

type PlanAuthority = {
  ourRank: number;
  competitorCount: number;
  lowestRank: number;
  highestRank: number;
  topDomain: string;
};

type TemplateContract = {
  requiredBlocks: string[];
  wordBand: [number, number];
  h2Min: number;
  faqMin: number;
  internalLinksMin: number;
  schemaType: string | null;
  notes: string[];
};

// The two shapes a page type can be. pSEO is the templated many-pages-from-one
// contract, blog is the editorial cluster — the founder is choosing between
// them on every card, so they get the two loudest chip colors in the palette
// and nothing else on the card competes for them.
const KIND_DISPLAY = new Map<string, ChipDisplay>([
  ["pseo", { label: "pSEO", color: "violet" }],
  ["blog", { label: "blog", color: "lime" }],
  ["hub", { label: "hub", color: "slate" }],
]);

export function kindDisplay(kind: string): ChipDisplay {
  return KIND_DISPLAY.get(kind) ?? { label: kind, color: "slate" };
}

// The verdict is a *sample*, and the labels say so: rankloop checked a handful
// of this type's keywords against live SERPs, it did not measure the whole
// shape. "not sampled" is slate rather than red because an unsampled type is
// unknown, not bad — the plan still runs without an API key.
const SERP_VERDICT_DISPLAY = new Map<string, ChipDisplay>([
  ["ok", { label: "winnable sample", color: "emerald" }],
  ["caution", { label: "mixed sample", color: "amber" }],
  ["kill", { label: "hard sample", color: "rose" }],
  ["unsampled", { label: "not sampled", color: "slate" }],
]);

// A type whose serp_check_json is missing or unreadable is in exactly the
// state a keyless run leaves one in: nothing was checked. Both render as "not
// sampled" rather than as a verdict nobody reached.
export function serpVerdictDisplay(serpCheck: SerpCheck | null): ChipDisplay {
  if (!serpCheck) return { label: "not sampled", color: "slate" };
  return (
    SERP_VERDICT_DISPLAY.get(serpCheck.status) ?? {
      label: serpCheck.status,
      color: "slate",
    }
  );
}

/**
 * The one-line reading of the SERP sample that sits beside the verdict chip.
 * Anything other than a clean sample quotes the planner's own stored reason
 * rather than re-deriving one here — the card must say what was decided, not
 * offer a second opinion on it.
 */
export function serpVerdictLine(serpCheck: SerpCheck | null): string {
  if (!serpCheck || serpCheck.status === "unsampled") {
    return "Not sampled — this shape was proposed from your backlog alone.";
  }
  if (serpCheck.status !== "ok") {
    return serpCheck.reason ?? "Mixed signals across the keywords we sampled.";
  }
  return `Sampled ${serpCheck.sampled} keyword${
    serpCheck.sampled === 1 ? "" : "s"
  } · ${serpCheck.winnable} with a beatable result outside the top three.`;
}

/** The full sample readout, for behind "More details". */
export function serpSummaryLine(serpCheck: SerpCheck | null): string {
  if (!serpCheck || serpCheck.status === "unsampled") {
    return "No SERP sample stored for this type.";
  }
  return [
    `${serpCheck.sampled} keyword${serpCheck.sampled === 1 ? "" : "s"} sampled`,
    `${serpCheck.hardSerps} with a forum or Reddit in the top five`,
    `${serpCheck.aiOverviews} with an AI Overview`,
    `${serpCheck.winnable} with a beatable result`,
  ].join(" · ");
}

/**
 * Demand in words, not a metric tile. Zero is the honest reading of a cluster
 * built entirely from free sources — autocomplete and harvested questions
 * carry no volume, and those rows are kept on purpose.
 */
export function demandSentence(
  demand: number | null,
  instanceCount: number,
): string {
  const pages = `${instanceCount} page${instanceCount === 1 ? "" : "s"}`;
  if (demand === null || demand <= 0) {
    return `No measured volume across ${pages} — long-tail keywords often carry none.`;
  }
  return `${demand.toLocaleString("en-US")} searches a month across ${pages}.`;
}

/**
 * What the writer costs. Not stored data: it is the house per-page estimate
 * for a written instance, which is why both halves of the sentence carry a
 * tilde and the card stamp repeats the assumption.
 */
const WRITE_COST_PER_PAGE_USD = 0.25;

export function moneySentence(instanceCount: number): string {
  const total = instanceCount * WRITE_COST_PER_PAGE_USD;
  // Cents stop meaning anything past ten dollars, and "~$11.75" reads like a
  // quote rather than an estimate.
  const totalLabel =
    total >= 10 ? `~$${Math.round(total)}` : `~$${total.toFixed(2)}`;
  const scope = instanceCount === 1 ? "the page" : `all ${instanceCount}`;
  return `${totalLabel} to write ${scope} at ~$${WRITE_COST_PER_PAGE_USD.toFixed(
    2,
  )} each`;
}

/**
 * The competitor evidence sentence, or its honest absence. rankloop never
 * fakes this line: with no competitor carrying a page of this shape there is
 * no share to quote, and the card says so in the same slot — naming how many
 * competitors were checked, so "no signal" is a claim you can audit.
 *
 * Traffic share is the sentence when the provider priced the matching pages;
 * when it priced none, the page share is what we actually know and the wording
 * changes with it rather than passing one number off as the other.
 */
export function evidenceSentence(evidence: Evidence | null): string {
  const absence = "No competitor signal for this shape";
  if (!evidence) return `${absence}.`;
  if (!evidence.hasCompetitorSignal) {
    if (evidence.competitorsChecked === 0) {
      return `${absence} — no competitor has been studied yet.`;
    }
    return `${absence} — ${evidence.competitorsChecked} studied competitor${
      evidence.competitorsChecked === 1 ? "" : "s"
    } carr${evidence.competitorsChecked === 1 ? "ies" : "y"} no page like it.`;
  }
  if (evidence.etvSharePct === null) {
    return `${evidence.leadDomain} puts ${Math.round(
      evidence.pageSharePct,
    )}% of its top-earning pages into this shape.`;
  }
  return `${evidence.leadDomain} earns ${Math.round(
    evidence.etvSharePct,
  )}% of its search traffic from pages like these.`;
}

/** Difficulty as the p25–p75 band the candidate's keywords actually span. */
export function kdBandLabel(
  kdBand: { p25: number; p75: number } | null,
): string {
  if (!kdBand) return "No difficulty data on these keywords";
  return `KD ${Math.round(kdBand.p25)}–${Math.round(kdBand.p75)} (middle half)`;
}

/**
 * The template contract in sentences. The writer (S7) reads the JSON; this is
 * the same contract in the words a founder can argue with before approving.
 */
export function contractLines(contract: TemplateContract | null): string[] {
  if (!contract) return [];
  const [minWords, maxWords] = contract.wordBand;
  const lines = [
    `${minWords.toLocaleString("en-US")}–${maxWords.toLocaleString(
      "en-US",
    )} words`,
    `at least ${contract.h2Min} H2 section${contract.h2Min === 1 ? "" : "s"}`,
    `at least ${contract.faqMin} FAQ entr${contract.faqMin === 1 ? "y" : "ies"}`,
    `at least ${contract.internalLinksMin} internal link${
      contract.internalLinksMin === 1 ? "" : "s"
    }`,
  ];
  if (contract.schemaType) lines.push(`${contract.schemaType} structured data`);
  return lines;
}

// The writer reads block ids; a founder deciding whether to build the shape
// should not have to. Anything the derivation invents later falls through as
// its raw id rather than disappearing from the contract.
const REQUIRED_BLOCK_LABEL = new Map<string, string>([
  ["dataTable", "data table"],
  ["faq", "FAQ section"],
  ["byline", "named author"],
  ["dateModified", "visible last-updated date"],
]);

export function requiredBlockLabel(block: string): string {
  return REQUIRED_BLOCK_LABEL.get(block) ?? block;
}

/** Per-card provenance: what was sampled, and which figure is an estimate. */
export function cardStamp(serpCheck: SerpCheck | null): string {
  const sample =
    !serpCheck || serpCheck.status === "unsampled"
      ? "not SERP-sampled"
      : `SERP sample of ${serpCheck.sampled} keyword${
          serpCheck.sampled === 1 ? "" : "s"
        }`;
  return `${sample} · write cost estimated at ~$${WRITE_COST_PER_PAGE_USD.toFixed(
    2,
  )} a page`;
}

/**
 * The tab's stamp: what the plan was clustered from and what came out.
 *
 * `keywordsClustered` is the count the run stored, not the backlog's current
 * size — approving a type flips its keywords out of the plannable pool, so a
 * live count would shrink under a stamp claiming the plan came from it. A run
 * that predates the column, or one still in flight, has no number and the
 * clause is dropped rather than filled in from the nearest thing to hand.
 */
export function planStamp(counts: {
  keywordsClustered: number | null;
  proposed: number;
  notWorthBuilding: number;
}): string {
  const clustered =
    counts.keywordsClustered === null
      ? []
      : [
          `clustered from ${counts.keywordsClustered.toLocaleString(
            "en-US",
          )} backlog keyword${counts.keywordsClustered === 1 ? "" : "s"}`,
        ];
  return [
    ...clustered,
    `${counts.proposed} type${counts.proposed === 1 ? "" : "s"} proposed`,
    `${counts.notWorthBuilding} not worth building`,
  ].join(" · ");
}

/**
 * The authority comparison, or nothing. rankloop does not price each SERP
 * result's authority, so the card compares the two site-level ranks it has
 * actually stored — ours from the newest backlink snapshot, theirs from the
 * competitor study — and stays silent when either side was never measured.
 * There is no estimated fallback here on purpose.
 */
export function authoritySentence(authority: PlanAuthority | null): string {
  if (!authority) return "";
  if (authority.competitorCount === 1) {
    return `Your domain rank is ${authority.ourRank} against ${authority.topDomain} at ${authority.highestRank}.`;
  }
  const spread =
    authority.lowestRank === authority.highestRank
      ? `${authority.highestRank}`
      : `${authority.lowestRank}–${authority.highestRank}`;
  return `Your domain rank is ${authority.ourRank} against ${authority.competitorCount} tracked competitors at ${spread}.`;
}
