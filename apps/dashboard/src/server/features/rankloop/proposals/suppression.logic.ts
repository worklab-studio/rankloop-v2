// Decision suppression: which targets the optimize signals must not propose
// again yet. Its own leaf module because all three signals in signals.logic.ts
// consult it and none of them owns it. No I/O — unit-tested directly in
// suppression.logic.test.ts.

import type { RankloopProposal } from "@/types/schemas/rankloopProposals";

const MS_PER_DAY = 86_400_000;

/** A proposal the user already ruled on — approved, declined, or executed.
 *  `type` is the whole proposals enum because the query that feeds this reads
 *  every row; each signal filters to its own type. */
export type RecentDecision = {
  type: RankloopProposal["type"];
  target: string;
  decidedAt: string | null;
  executedAt: string | null;
};

/** A decided proposal needs ~2 GSC-lagged weeks before its effect shows up;
 *  re-proposing inside 60 days would judge the pre-decision data, thrash the
 *  page, and re-litigate a decline the user already made. */
export const DECISION_SUPPRESSION_DAYS = 60;

/** An executed proposal owns an open receipt whose evaluation window closes 42
 *  days after execution (MEASUREMENT_CLOSE_AFTER_DAYS in receipts.logic.ts —
 *  duplicated rather than imported so this module stays a leaf). Re-proposing
 *  inside that window is what lets a second execution land on the same page,
 *  which isContaminated then reads as contamination and closes the original
 *  receipt unmeasured: rankloop invalidating its own proof. */
const RECEIPT_SUPPRESSION_DAYS = 42;

/** The suppression slice every optimize signal carries. */
export type SuppressionInput = {
  recentDecisions: RecentDecision[];
  /** ISO timestamp the suppression windows count back from — real time, not
   *  the GSC watermark: decisions are stamped when the user makes them. */
  now: string;
};

/**
 * Targets of `type` the engine must not propose again yet. Every signal runs
 * this — a re-proposal is not a harmless duplicate: acting on one destroys the
 * receipt the first execution opened, and ignoring one churns the queue every
 * 10-day TTL until the GSC lag finally catches up.
 *
 * The anchor is coalesce(executedAt, decidedAt): a push approved on the 1st
 * but executed on the 20th has a receipt running to the 20th + 42 days, so a
 * decidedAt anchor would re-open the target in the middle of its own
 * measurement. Rows with no executedAt — declines, and approvals still waiting
 * to be executed — fall back to the decision window.
 */
export function suppressedTargets(
  input: SuppressionInput,
  type: RecentDecision["type"],
): Set<string> {
  const nowMs = Date.parse(input.now);
  const suppressed = new Set<string>();
  for (const decision of input.recentDecisions) {
    if (decision.type !== type) continue;
    const anchor = decision.executedAt ?? decision.decidedAt;
    if (anchor === null) continue;
    const windowDays =
      decision.executedAt === null
        ? DECISION_SUPPRESSION_DAYS
        : RECEIPT_SUPPRESSION_DAYS;
    if ((nowMs - Date.parse(anchor)) / MS_PER_DAY < windowDays) {
      suppressed.add(decision.target);
    }
  }
  return suppressed;
}
