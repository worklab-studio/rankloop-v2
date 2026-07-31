// Pure functions behind the template contract (spec 0017): what a page of
// this type must contain, derived from the winners-vs-median deltas S4a
// measured, and falling back to the engine's own law defaults — labelled as
// defaults — when no competitor has been studied. No I/O, no model call —
// unit-tested directly in contracts.logic.test.ts.

import { defaultLaws } from "@rankloop/engine";

/** One structural feature delta as the competitor study wrote it: the label
 *  is the study's own ("Data table", "FAQ block", …), not a field name. */
export type FeatureDelta = {
  feature: string;
  winnersPct: number;
  medianPct: number;
};

export type TemplateContract = {
  requiredBlocks: string[];
  /** [min, max] words. A band, not a target — a target is how you get a
   *  writer padding to a number. */
  wordBand: [number, number];
  h2Min: number;
  faqMin: number;
  internalLinksMin: number;
  schemaType: string;
  /** Provenance, one line per rule, written for the approval card's "More
   *  details" drawer. Every number a contract asserts says where it came
   *  from here — including when the answer is "nowhere, these are defaults". */
  notes: string[];
};

/**
 * The study's boolean features, mapped to block names the writer's brief
 * uses. `media` is deliberately absent: the study counts media elements but
 * never decides a page "has media", so asserting a media block would be this
 * module inventing a measurement nobody took.
 */
const BLOCK_BY_FEATURE: ReadonlyMap<string, string> = new Map([
  ["Data table", "dataTable"],
  ["FAQ block", "faq"],
  ["Byline", "byline"],
  ["Date modified", "dateModified"],
]);

/** The delta rule: the winners nearly all do it AND the ordinary pages nearly
 *  all don't. Either half alone is noise — a feature both cohorts carry is
 *  house style, and one only the winners *sometimes* carry is a coin flip at
 *  a 30-page sample. */
const WINNERS_REQUIRED_PCT = 60;
const MEDIAN_ABSENT_PCT = 40;

/** The band around the winners' median: enough room that two honest posts on
 *  the same template land inside it, tight enough that a 400-word stub and a
 *  4,000-word essay don't. */
const WORD_BAND_LOW = 0.85;
const WORD_BAND_HIGH = 1.25;

/**
 * Primary schema type by page format. FAQPage is not in this table on
 * purpose: an FAQ block is a section of a page, not the thing the page is,
 * and a page claiming to *be* an FAQPage while ranking as a comparison is the
 * kind of markup that earns a manual action.
 */
const SCHEMA_BY_FORMAT: Readonly<Record<string, string>> = {
  "how-to": "HowTo",
  listicle: "ItemList",
  comparison: "Article",
  data: "Dataset",
  troubleshooting: "HowTo",
  explainer: "Article",
  review: "Review",
};

const DEFAULTS_NOTE = "defaults — no competitor signal";

function fmtInt(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * Derive the contract for one candidate.
 *
 * Blocks come only from measured deltas; the numeric laws come from the
 * engine's defaults and are moved only by evidence (the word band). A
 * contract with no competitor behind it is not a weaker contract — it is the
 * house laws, and it says so in `notes` so the approval card can too.
 */
export function deriveTemplateContract(input: {
  format: string;
  /** The lead competitor's deltas, empty when nothing was studied (or when
   *  the study ran sitemap-only and measured no page bodies). */
  deltas: FeatureDelta[];
  winnersMedianWordCount: number | null;
  /** Our own corpus median (S2) — context for the band, never a source of
   *  it: matching our own current length is how a site stays where it is. */
  ourMedianWordCount: number | null;
  competitorDomain: string | null;
}): TemplateContract {
  const laws = defaultLaws();
  const notes: string[] = [];

  const requiredBlocks: string[] = [];
  for (const delta of input.deltas) {
    const block = BLOCK_BY_FEATURE.get(delta.feature);
    if (!block) continue;
    if (
      delta.winnersPct >= WINNERS_REQUIRED_PCT &&
      delta.medianPct < MEDIAN_ABSENT_PCT
    ) {
      requiredBlocks.push(block);
      notes.push(
        `${delta.feature} required — ${delta.winnersPct}% of ${input.competitorDomain ?? "their"} winners carry one, ${delta.medianPct}% of their ordinary pages do.`,
      );
    }
  }

  const wordBand = deriveWordBand(input.winnersMedianWordCount, laws);
  if (input.winnersMedianWordCount !== null) {
    notes.push(
      `Word band from ${input.competitorDomain ?? "the studied competitor"}'s winners (median ${fmtInt(input.winnersMedianWordCount)} words)${
        input.ourMedianWordCount === null
          ? ""
          : `; your own posts median ${fmtInt(input.ourMedianWordCount)}`
      }.`,
    );
  }

  // Nothing measured moved a single rule — say so rather than let the card
  // present the house laws as a finding about this niche.
  if (notes.length === 0) notes.push(DEFAULTS_NOTE);

  return {
    requiredBlocks,
    wordBand,
    h2Min: laws.h2Min,
    faqMin: laws.faqMin,
    internalLinksMin: laws.internalLinksMin,
    schemaType: SCHEMA_BY_FORMAT[input.format] ?? "Article",
    notes,
  };
}

/** The band, clamped inside the publish laws: a contract can never ask for a
 *  post the gate would then reject. */
function deriveWordBand(
  winnersMedianWordCount: number | null,
  laws: ReturnType<typeof defaultLaws>,
): [number, number] {
  if (winnersMedianWordCount === null) return [laws.wordMin, laws.wordMax];
  const low = Math.max(
    laws.wordMin,
    Math.round(winnersMedianWordCount * WORD_BAND_LOW),
  );
  const high = Math.min(
    laws.wordMax,
    Math.round(winnersMedianWordCount * WORD_BAND_HIGH),
  );
  // A competitor whose winners run shorter than the publish laws allow cannot
  // lower the floor — the gate rejects a 600-word post whatever their SERP
  // rewards — so the floor wins and the band collapses onto it.
  return [low, Math.max(low, high)];
}
