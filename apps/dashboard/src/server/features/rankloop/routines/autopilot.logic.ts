// Pure functions behind earned autopilot (spec 0024): whether an action type
// has proved itself, what the trust dial therefore means for that type today,
// and when autopilot pauses itself. No I/O and no Date.now() — the caller
// injects `today`, which is what lets the tests age a cohort past its
// settling period. Unit-tested in autopilot.logic.test.ts.
//
// The doctrine this file encodes: autopilot is not a toggle someone flips on
// faith, it is a permission a project earns per action type by having already
// been right about that action type — measured, on its own site, on results
// old enough to have settled. Everything here exists to make "eligible" a
// sentence with numbers in it, so a user who disagrees can check the work.

import { shiftDate } from "@/server/features/rankloop/receipts/receipts.logic";
import type { TrustDial } from "@/shared/rankloop-writer";

// ---------------------------------------------------------------------------
// The cohort
// ---------------------------------------------------------------------------

/**
 * How long after a receipt's evaluation window closes before it may vote.
 *
 * The window itself already ends 42 days after the action; ninety days on top
 * of that is what separates "this ranked" from "this held". Rankings that
 * revert do so within a quarter far more often than after one, and the whole
 * point of earning autopilot is that the evidence outlasts the excitement.
 */
const AUTOPILOT_SETTLE_DAYS = 90;

/** Below five settled results there is no distribution, only anecdotes. Four
 *  wins is a run of luck the same way three coin flips is. */
const AUTOPILOT_MIN_MEASURED = 5;

/** At most one in five may have come out worse than baseline. Expressed as
 *  the ratio the test applies (worse * 5 <= n) so it stays exact at every
 *  cohort size instead of drifting on a float comparison. */
const AUTOPILOT_WORSE_PER = 5;

/**
 * Fewer control receipts than this and no drift is removed at all.
 *
 * The control is the project's OTHER action types over the same period — the
 * closest thing to "what would have happened anyway" that stored receipts can
 * offer, since position has no site-wide twin the way clicks do (receipts
 * store site clicks and impressions, never a site-wide position). Two
 * controls is not a trend, it is two numbers, and subtracting their median
 * would inject more noise than it removes.
 */
const AUTOPILOT_MIN_CONTROLS = 3;

/**
 * Action types that never run unattended, whatever the receipts say.
 *
 * Merging and pruning delete or redirect a page that exists. Every other
 * action is additive or reversible by doing it again; these two are the ones
 * where being right on average is not good enough, because the one in twenty
 * that was wrong cannot be undone by another receipt.
 */
const NEVER_AUTOPILOT_TYPES = ["merge", "prune"] as const;

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** One 'measured' receipt, as eligibility sees it. Contaminated receipts
 *  never reach here — their windows measured two actions at once, so they
 *  cannot testify about either. */
export type SettledReceipt = {
  actionType: string;
  /** Exclusive end of the evaluation window (YYYY-MM-DD). */
  windowEnd: string;
  /** Impressions-weighted position of the baseline window, null when that
   *  window had no impressions to weight. */
  baselinePosition: number | null;
  resultPosition: number | null;
};

export type AutopilotEligibility = {
  actionType: string;
  eligible: boolean;
  /** The clause the Settings surface prints after the action name, verbatim:
   *  "retitle: eligible (7 measured, median +3.1 positions)". */
  reason: string;
  /** Settled receipts that could actually be compared. */
  measured: number;
  /** Positive is an improvement — positions move down as pages move up. */
  medianPositionDelta: number | null;
  worse: number;
};

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/** The middle value, averaging the two middles on an even count. */
function median(values: number[]): number {
  const sorted = values.toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** "+3.1" / "-0.4". The sign is always written: a bare "3.1 positions" reads
 *  as a rank, not a movement. */
function formatPositions(delta: number): string {
  return `${delta > 0 ? "+" : delta < 0 ? "-" : "±"}${Math.abs(delta).toFixed(1)}`;
}

/** Positive means the page moved up. Null when either window had no
 *  impressions — a receipt with no position cannot vote on positions. */
function rawDelta(receipt: SettledReceipt): number | null {
  if (receipt.baselinePosition === null || receipt.resultPosition === null) {
    return null;
  }
  return receipt.baselinePosition - receipt.resultPosition;
}

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

/**
 * Whether `actionType` has earned unattended execution on this project.
 *
 * `receipts` is every measured receipt the project has, all types — the other
 * types are the control cohort the drift term comes from, so passing only the
 * type under test would silently disable the adjustment.
 *
 * Four answers, each stating its numbers: never (merge/prune), too few, poor
 * results, eligible. There is no fifth answer where the function shrugs.
 */
export function autopilotEligibility(input: {
  actionType: string;
  receipts: SettledReceipt[];
  /** YYYY-MM-DD from the injected clock. */
  today: string;
}): AutopilotEligibility {
  const settledBy = shiftDate(input.today, -AUTOPILOT_SETTLE_DAYS);
  const settled = input.receipts.filter(
    (receipt) => receipt.windowEnd <= settledBy && rawDelta(receipt) !== null,
  );
  const cohort = settled.filter(
    (receipt) => receipt.actionType === input.actionType,
  );

  // Checked before the counts so the answer cannot be read as "not yet". No
  // number of good receipts turns this into a yes, and a reason phrased as a
  // shortfall would invite someone to go collect five more.
  if (isNeverAutopilot(input.actionType)) {
    return {
      actionType: input.actionType,
      eligible: false,
      reason: "never unattended — this action removes a page that exists",
      measured: cohort.length,
      medianPositionDelta: null,
      worse: 0,
    };
  }

  if (cohort.length < AUTOPILOT_MIN_MEASURED) {
    return {
      actionType: input.actionType,
      eligible: false,
      reason: `needs ${AUTOPILOT_MIN_MEASURED} measured results, has ${cohort.length}`,
      measured: cohort.length,
      medianPositionDelta: null,
      worse: 0,
    };
  }

  const controls = settled
    .filter((receipt) => receipt.actionType !== input.actionType)
    .map((receipt) => rawDelta(receipt) ?? 0);
  // With no control cohort there is no drift to remove, and inventing one
  // would either flatter or punish the only action type a project runs.
  const drift =
    controls.length >= AUTOPILOT_MIN_CONTROLS ? median(controls) : 0;

  const deltas = cohort.map((receipt) =>
    round2((rawDelta(receipt) ?? 0) - drift),
  );
  const medianDelta = round2(median(deltas));
  const worse = deltas.filter((delta) => delta < 0).length;

  if (medianDelta <= 0) {
    return {
      actionType: input.actionType,
      eligible: false,
      reason: `median result is ${formatPositions(medianDelta)} positions across ${cohort.length} measured — autopilot needs an improvement`,
      measured: cohort.length,
      medianPositionDelta: medianDelta,
      worse,
    };
  }

  if (worse * AUTOPILOT_WORSE_PER > cohort.length) {
    return {
      actionType: input.actionType,
      eligible: false,
      reason: `${worse} of ${cohort.length} measured results came out worse than baseline`,
      measured: cohort.length,
      medianPositionDelta: medianDelta,
      worse,
    };
  }

  return {
    actionType: input.actionType,
    eligible: true,
    reason: `eligible (${cohort.length} measured, median ${formatPositions(medianDelta)} positions)`,
    measured: cohort.length,
    medianPositionDelta: medianDelta,
    worse,
  };
}

/** Merge and prune, by name rather than by inference — see
 *  NEVER_AUTOPILOT_TYPES for why they are exempt from evidence. */
function isNeverAutopilot(actionType: string): boolean {
  return NEVER_AUTOPILOT_TYPES.some((type) => type === actionType);
}

// ---------------------------------------------------------------------------
// Kill switches
// ---------------------------------------------------------------------------

/** Consecutive failed gates that stop autopilot. Three is a pattern: one is a
 *  bad draft, two is a bad morning, three is a writer producing work the laws
 *  reject and a machine that would keep paying for it. */
const AUTOPILOT_GATE_FAILURE_LIMIT = 3;

/** One gate verdict, newest first in the array the caller passes. */
export type GateOutcome = { at: string; passed: boolean };

export type AutopilotPause = {
  /** Printed in the digest and on Settings, as-is. */
  reason: string;
  /** ISO instant of the event that tripped it. */
  since: string;
};

/**
 * Whether autopilot has stopped itself.
 *
 * An adapter auth failure outranks the gate count because it is a different
 * kind of broken: the gate tells us the writing is wrong, a 401 tells us we
 * no longer have permission to write at all, and continuing to try is how a
 * revoked token becomes a rate-limit ban. Either way the pause is a fact the
 * digest reports rather than a setting the user has to go find.
 */
export function autopilotKillSwitch(input: {
  /** Newest first. */
  recentGateOutcomes: GateOutcome[];
  adapterAuthError: { adapter: string; at: string } | null;
  /** Failures already counted and stored before this window — see
   *  `autopilot_state.consecutive_gate_failures`. Omitted by callers reading
   *  the whole history, which is the same thing as a prior of nothing. */
  priorGateFailures?: number;
}): AutopilotPause | null {
  if (input.adapterAuthError) {
    return authPause(input.adapterAuthError);
  }
  return autopilotGateStreak({
    priorFailures: input.priorGateFailures ?? 0,
    recentGateOutcomes: input.recentGateOutcomes,
  }).pause;
}

/** The pause a rejected credential earns, phrased the same way wherever it is
 *  raised. */
export function authPause(error: {
  adapter: string;
  at: string;
}): AutopilotPause {
  return {
    reason: `autopilot paused — ${error.adapter} rejected our credentials`,
    since: error.at,
  };
}

/**
 * The streak after folding in the verdicts that landed since it was last
 * stored — the counter to write back, and the pause if it tripped.
 *
 * `priorFailures` is only carried forward when the whole window is failures.
 * A pass anywhere in it is the streak ending, and a stored 2 that survived a
 * passing gate would pause a project on its next bad draft rather than its
 * third.
 */
export function autopilotGateStreak(input: {
  priorFailures: number;
  /** Newest first, the order the repository returns them in. */
  recentGateOutcomes: GateOutcome[];
}): { consecutiveGateFailures: number; pause: AutopilotPause | null } {
  const streak: GateOutcome[] = [];
  let broken = false;
  for (const outcome of input.recentGateOutcomes) {
    if (outcome.passed) {
      broken = true;
      break;
    }
    streak.push(outcome);
  }
  const consecutiveGateFailures =
    streak.length + (broken ? 0 : input.priorFailures);
  // A trip is an event, so it needs a verdict to have caused it. An empty
  // window over a stored 3 is not a new pause — it is the pause already
  // written on the row, and re-raising it here would re-date it every run.
  if (
    consecutiveGateFailures < AUTOPILOT_GATE_FAILURE_LIMIT ||
    streak.length === 0
  ) {
    return { consecutiveGateFailures, pause: null };
  }
  return {
    consecutiveGateFailures,
    pause: {
      reason: `autopilot paused — ${AUTOPILOT_GATE_FAILURE_LIMIT} drafts in a row failed the gate`,
      // The oldest failure this window can see: the streak started at or
      // before it, and stamping the pause with the newest failure would date
      // it to the moment we noticed rather than the moment it went wrong.
      since: streak[streak.length - 1].at,
    },
  };
}

// ---------------------------------------------------------------------------
// Honoring the dial
// ---------------------------------------------------------------------------

export type ActionBehavior = {
  /** What actually happens to this action type today. */
  behavior: TrustDial;
  /** Null when the behavior is exactly what the dial says. Non-null is the
   *  sentence the surface must show beside it — a dial set to autopilot that
   *  quietly behaves like drafts, with no reason on screen, is the bug this
   *  field exists to prevent. */
  fallbackReason: string | null;
};

/**
 * What the trust dial means for one action type right now.
 *
 * `titles` and `drafts` need no evidence — both keep a human in the loop, and
 * eligibility has nothing to say about a decision a person is making. Only
 * `autopilot` can fall back, and it falls back to `drafts` (not to the
 * project's previous setting), because the safe interpretation of "run this
 * unattended" that we cannot honor is "show me the draft".
 */
export function resolveActionBehavior(input: {
  trustDial: TrustDial;
  eligibility: AutopilotEligibility;
  pause: AutopilotPause | null;
}): ActionBehavior {
  if (input.trustDial !== "autopilot") {
    return { behavior: input.trustDial, fallbackReason: null };
  }
  if (input.pause) {
    return { behavior: "drafts", fallbackReason: input.pause.reason };
  }
  if (!input.eligibility.eligible) {
    return { behavior: "drafts", fallbackReason: input.eligibility.reason };
  }
  return { behavior: "autopilot", fallbackReason: null };
}
