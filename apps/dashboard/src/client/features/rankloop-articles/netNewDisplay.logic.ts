// Structural subsets of what a proposal row carries, so this module stays a
// pure display layer with no server or db import behind it — the same shape
// proposalDisplay.logic.ts and pagePlanDisplay.logic.ts take.
type Factor = { name: string; value: string | number; note: string };

// Mirrors the fields of the selection layer's NetNewSlots / NetNewExclusion
// that this screen renders.
type Quota = {
  /** null means no quota start date is set — selection is manual only. */
  owed: number | null;
  /** Net-new proposals already proposed/approved/executing. */
  outstanding: number;
};

type Exclusion = {
  pageTypeName: string;
  keywordCount: number;
  reason: string;
};

/** The pool-slot marker `buildNetNewProposal` writes into factorsJson. The
 *  factor is the authority — a chip can be filtered out of the evidence list,
 *  a scored factor cannot — so the chip is derived from it rather than from
 *  the matching evidence string. */
const SLOT_FACTOR_NAME = "Slot";
const FRESH_QUESTION_LABEL = "fresh question";

/**
 * Did this row come from the fresh-question pool rather than the score
 * ranking? Exactly one slot per batch does, and the row wears a chip for it —
 * the pool-mix rule is the least obvious thing rankloop does to your calendar,
 * so it is shown on the row rather than buried in the factor breakdown.
 */
export function isFreshQuestionSlot(factors: Factor[]): boolean {
  return factors.some(
    (factor) =>
      factor.name === SLOT_FACTOR_NAME && factor.value === FRESH_QUESTION_LABEL,
  );
}

/**
 * Evidence chips minus the two facts that got promoted to chips of their own.
 *
 * Compute writes the page type name and the pool marker into evidenceJson so
 * the row explains itself without a join. Both now render as coloured chips —
 * violet for the type, lime for the slot — and a slate duplicate beside each
 * one would read as two different facts that happen to share a word.
 */
export function netNewEvidenceChips(
  evidence: string[],
  pageTypeName: string | null,
): string[] {
  return evidence.filter(
    (chip) => chip !== FRESH_QUESTION_LABEL && chip !== pageTypeName,
  );
}

/**
 * The quota sentence above the queue. It states what today owes and what has
 * already been proposed against it, so clicking "Propose now" a second time is
 * visibly a no-op rather than a gamble.
 */
export function quotaLine({ owed, outstanding }: Quota): string {
  if (owed === null) return "quota off — propose manually";
  const owedPart = owed === 0 ? "nothing owed today" : `${owed} owed today`;
  if (outstanding > 0) return `${owedPart} · ${outstanding} already proposed`;
  // "nothing owed · none proposed" says the same thing twice; the shorter
  // line is the honest one when there is nothing to reconcile.
  return owed === 0 ? owedPart : `${owedPart} · none proposed yet`;
}

/**
 * A page type that contributed nothing, and why, in the queue's own stamp
 * grammar. The keyword count is the part that makes it worth reading: it is
 * the size of the backlog sitting behind one missing dataset.
 */
export function exclusionLine({
  pageTypeName,
  keywordCount,
  reason,
}: Exclusion): string {
  const plural = keywordCount === 1 ? "keyword" : "keywords";
  return `${pageTypeName} · ${keywordCount} ${plural} held back · ${reason}`;
}

// Metered costs are fractions of a cent per SERP, so two decimals would round
// every one of them to "$0.00". Four keeps ~$0.0025 readable while whole-cent
// figures still render as ~$0.08.
const costFormat = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

export function formatCost(usd: number): string {
  return `~$${costFormat.format(usd)}`;
}

/** Where the brief's Search context section came from, said plainly. It is the
 *  one section that can cost money, and reuse is the whole reason it usually
 *  doesn't — so "reused" and "bought just now" are never collapsed into one
 *  word. */
export function serpSourceStamp(source: string): string {
  if (source === "plan") return "SERP reused from the page plan snapshot";
  if (source === "grounding") return "SERP reused from an earlier brief";
  if (source === "fetched") return "SERP fetched for this brief";
  return "no SERP cached — the brief says to write from the topic itself";
}
