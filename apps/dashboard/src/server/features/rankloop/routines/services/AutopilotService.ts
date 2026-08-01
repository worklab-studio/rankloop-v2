// Earned autopilot, wired to storage (spec 0024). `autopilot.logic.ts` decides;
// this file feeds it the project's settled receipts, its recent gate verdicts
// and its publish connection, and answers the one question every caller
// actually has: what happens to THIS action type today, and why.
//
// The clock is a parameter, not `new Date()` inside. Both dispatchers — the
// Cloudflare cron and the DO alarm — call the routine with one `now`, and a
// service that read its own clock could hand two halves of the same run two
// different days.

import {
  authPause,
  autopilotEligibility,
  autopilotGateStreak,
  autopilotKillSwitch,
  autopilotWriterStreak,
  resolveActionBehavior,
  type ActionBehavior,
  type AutopilotEligibility,
  type AutopilotPause,
  type GateOutcome,
  type SettledReceipt,
} from "@/server/features/rankloop/routines/autopilot.logic";
import { AutopilotRepository } from "@/server/features/rankloop/routines/repositories/AutopilotRepository";
import { WriterSettingsRepository } from "@/server/features/rankloop/writing/repositories/WriterSettingsRepository";
import { proposals } from "@/db/schema";
import type { TrustDial } from "@/shared/rankloop-writer";
import { WRITER_SETTINGS_DEFAULTS } from "@/shared/rankloop-writing";
import {
  receiptBaselineSchema,
  receiptResultSchema,
} from "@/types/schemas/rankloopReceipts";
import { parseLawReport } from "@/types/schemas/rankloopWriter";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Every action type the engine can propose, derived from the column so the
 *  two spellings can never drift apart. */
const ACTION_TYPES = proposals.type.enumValues;

type AutopilotActionStatus = AutopilotEligibility & ActionBehavior;

type AutopilotStatus = {
  trustDial: TrustDial;
  /** Non-null when autopilot has stopped itself; the digest reports it. */
  pause: AutopilotPause | null;
  /** Failed gates in a row as the switch has them stored — what Settings
   *  shows beside a switch that has not tripped yet ("2 of 3"). */
  consecutiveGateFailures: number;
  /** The publish target's last verdict on our credentials, when it was a no.
   *  Carried alongside the pause it caused so the digest can list the cause
   *  and the consequence as the two separate things they are. */
  adapterError: { adapter: string; detail: string } | null;
  /** One entry per action type, in the column's own order. */
  types: AutopilotActionStatus[];
};

// ---------------------------------------------------------------------------
// Parsing what is stored
// ---------------------------------------------------------------------------

/** The impressions-weighted position out of a stored metrics block, or null
 *  when the column is empty or was written by an older shape. A receipt we
 *  cannot read is a receipt that does not vote — never one that votes zero. */
function storedPosition(
  raw: string | null,
  schema: typeof receiptBaselineSchema | typeof receiptResultSchema,
): number | null {
  if (!raw) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data.weightedPosition : null;
  } catch {
    return null;
  }
}

function toSettledReceipts(
  rows: Awaited<ReturnType<typeof AutopilotRepository.getMeasuredReceipts>>,
): SettledReceipt[] {
  const settled: SettledReceipt[] = [];
  for (const row of rows) {
    if (row.windowEnd === null) continue;
    settled.push({
      actionType: row.actionType,
      windowEnd: row.windowEnd,
      baselinePosition: storedPosition(row.baselineJson, receiptBaselineSchema),
      resultPosition: storedPosition(row.resultJson, receiptResultSchema),
    });
  }
  return settled;
}

/**
 * The recent gate verdicts, newest first.
 *
 * Reports whose `failure` names something other than the laws are dropped
 * rather than counted as failures: a provider outage or a truncated response
 * is the writer's problem, and pausing autopilot for it would blame the gate
 * for an incident it had no part in. Reports that graded nothing are dropped
 * for the same reason. Those verdicts are not lost — `toWriterOutcomes` below
 * is where they land.
 */
function toGateOutcomes(
  rows: Awaited<ReturnType<typeof AutopilotRepository.getRecentGateVerdicts>>,
): GateOutcome[] {
  const outcomes: GateOutcome[] = [];
  for (const row of rows) {
    const report = parseLawReport(row.lawReportJson);
    if (!report) continue;
    if (report.laws.length === 0) continue;
    if (report.failure && report.failure.reason !== "laws_unmet") continue;
    outcomes.push({ at: row.at, passed: report.passed });
  }
  return outcomes;
}

/** Failures the gate never got to judge — the writer's own. `publish_blocked`
 *  is the one failure that is not one: the article passed, and publishing sent
 *  it back. */
const WRITER_FAILURE_REASONS = [
  "provider_error",
  "truncated",
  "unparseable_frontmatter",
  "internal_error",
  "insufficient_credits",
];

/**
 * The recent verdicts as the writer's own streak sees them, newest first.
 *
 * `passed` here means "this draft reached a law", not "the laws liked it": a
 * graded fail is evidence the writer is working and ends the streak, which is
 * why the two counters cannot share one array. Every terminal landing is one
 * charged generation (~$0.12), so a writer that truncates on every attempt
 * costs exactly as much as one the laws reject — the reason it needs a
 * ceiling at all, and the reason that ceiling is not the gate's.
 */
function toWriterOutcomes(
  rows: Awaited<ReturnType<typeof AutopilotRepository.getRecentGateVerdicts>>,
): GateOutcome[] {
  const outcomes: GateOutcome[] = [];
  for (const row of rows) {
    const report = parseLawReport(row.lawReportJson);
    if (!report) continue;
    const failed = WRITER_FAILURE_REASONS.some(
      (reason) => reason === report.failure?.reason,
    );
    outcomes.push({ at: row.at, passed: !failed });
  }
  return outcomes;
}

// ---------------------------------------------------------------------------
// The status
// ---------------------------------------------------------------------------

/**
 * What the trust dial means for this project right now, per action type.
 *
 * Computed whole rather than per type because the three reads behind it are
 * shared: the receipt cohort is one query for every type (the other types are
 * each type's control group), and the kill switch is a property of the
 * project, not of the action.
 */
async function getStatus(input: {
  projectId: string;
  now: Date;
}): Promise<AutopilotStatus> {
  const [settings, receiptRows, state, failedConnection] = await Promise.all([
    WriterSettingsRepository.getSettings(input.projectId),
    AutopilotRepository.getMeasuredReceipts(input.projectId),
    AutopilotRepository.getState(input.projectId),
    AutopilotRepository.getFailedConnection(input.projectId),
  ]);
  // Sequential, and only this one read is: the verdict window starts at the
  // stored fold watermark, so it cannot be asked for until the state row is
  // in hand. A project that has never been reconciled has no watermark and
  // reads the whole lookback, which is what S9 did before the row existed.
  const verdictRows = await AutopilotRepository.getRecentGateVerdicts(
    input.projectId,
    state?.updatedAt,
  );

  const trustDial = settings?.trustDial ?? WRITER_SETTINGS_DEFAULTS.trustDial;
  // The stored pause wins outright. It is the one a human has to clear, and a
  // freshly computed answer would either re-raise it forever or — worse —
  // silently un-pause the loop the moment the failing drafts aged out of the
  // lookback.
  const pause =
    storedPause(state) ??
    autopilotKillSwitch({
      recentGateOutcomes: toGateOutcomes(verdictRows),
      adapterAuthError: toAuthError(failedConnection, input.now),
      priorGateFailures: state?.consecutiveGateFailures ?? 0,
      recentWriterOutcomes: toWriterOutcomes(verdictRows),
      priorWriterFailures: state?.consecutiveWriterFailures ?? 0,
    });

  const receipts = toSettledReceipts(receiptRows);
  const today = input.now.toISOString().slice(0, 10);
  const types = ACTION_TYPES.map((actionType) => {
    const eligibility = autopilotEligibility({ actionType, receipts, today });
    return {
      ...eligibility,
      ...resolveActionBehavior({ trustDial, eligibility, pause }),
    };
  });

  return {
    trustDial,
    pause,
    consecutiveGateFailures: state?.consecutiveGateFailures ?? 0,
    adapterError: failedConnection
      ? {
          adapter: failedConnection.adapter,
          detail: "the last connection check was rejected",
        }
      : null,
    types,
  };
}

/** What happens to one action type today. The routine asks this before it
 *  decides anything, and the answer carries the reason it must show on screen
 *  when the dial says autopilot and the behavior does not. */
async function getActionBehavior(input: {
  projectId: string;
  actionType: string;
  now: Date;
}): Promise<ActionBehavior> {
  const status = await getStatus({
    projectId: input.projectId,
    now: input.now,
  });
  const match = status.types.find(
    (type) => type.actionType === input.actionType,
  );
  // An action type the proposals column does not know about cannot have
  // earned anything, so it gets the loop's safe behavior and says why.
  if (!match) {
    return {
      behavior: status.trustDial === "autopilot" ? "drafts" : status.trustDial,
      fallbackReason:
        status.trustDial === "autopilot"
          ? `no receipts exist for ${input.actionType}`
          : null,
    };
  }
  return { behavior: match.behavior, fallbackReason: match.fallbackReason };
}

// ---------------------------------------------------------------------------
// The switch itself
// ---------------------------------------------------------------------------

type StoredState = Awaited<ReturnType<typeof AutopilotRepository.getState>>;

/** The pause as the row holds it, or null while autopilot is running. */
function storedPause(state: StoredState): AutopilotPause | null {
  if (!state?.pausedAt) return null;
  return {
    // A row paused without a reason can only come from a hand-written UPDATE,
    // and "paused, cause unknown" is still the honest thing to print.
    reason: state.pausedReason ?? "autopilot paused",
    since: state.pausedAt,
  };
}

function toAuthError(
  connection: Awaited<
    ReturnType<typeof AutopilotRepository.getFailedConnection>
  >,
  now: Date,
): { adapter: string; at: string } | null {
  if (!connection) return null;
  return {
    adapter: connection.adapter,
    // A connection can be marked failed without a stamp only if the status was
    // written by hand; the row's own truth is the fallback.
    at: connection.lastCheckedAt ?? now.toISOString(),
  };
}

/**
 * Bring the stored switch up to date, and return the pause if one is in force.
 *
 * The unattended block calls this before it does anything else, and it is the
 * only writer of `autopilot_state`. Three rules, in order:
 *
 * 1. a pause already on the row stands until a human resumes it — nothing here
 *    re-judges it, because the streak that caused it is now history;
 * 2. a rejected credential pauses immediately and outranks any counting: a
 *    wrong credential retried unattended is how an account gets locked;
 * 3. otherwise the verdicts that landed since the watermark fold into the two
 *    counters, and three in a row on either trips the switch.
 *
 * Two counters, not one: "the laws rejected three drafts" and "three drafts
 * never reached a law" are different faults with different first moves, and
 * folding them together would pause a whole project for one provider outage.
 * They cost the same money, which is why neither is allowed to run free.
 *
 * Idempotent by the watermark: a second call in the same tick sees no new
 * verdicts, changes nothing, and writes nothing.
 */
async function reconcile(input: {
  projectId: string;
  now: Date;
}): Promise<AutopilotPause | null> {
  const state = await AutopilotRepository.getState(input.projectId);
  const held = storedPause(state);
  if (held) return held;

  const failedConnection = await AutopilotRepository.getFailedConnection(
    input.projectId,
  );
  const authError = toAuthError(failedConnection, input.now);
  if (authError) {
    const pause = authPause(authError);
    await AutopilotRepository.saveState({
      projectId: input.projectId,
      // Neither counter had anything to do with this one. Carrying them
      // forward rather than zeroing them keeps a project that was two bad
      // drafts deep from starting over on the day its token expired.
      consecutiveGateFailures: state?.consecutiveGateFailures ?? 0,
      consecutiveWriterFailures: state?.consecutiveWriterFailures ?? 0,
      pausedAt: pause.since,
      pausedReason: pause.reason,
      updatedAt: input.now.toISOString(),
    });
    return pause;
  }

  const verdictRows = await AutopilotRepository.getRecentGateVerdicts(
    input.projectId,
    state?.updatedAt,
  );
  const outcomes = toGateOutcomes(verdictRows);
  const writerOutcomes = toWriterOutcomes(verdictRows);
  // Nothing new to fold: leave the row exactly as it is. Writing it anyway
  // would move the watermark past verdicts that landed in the same instant.
  if (outcomes.length === 0 && writerOutcomes.length === 0) return null;

  const streak = autopilotGateStreak({
    priorFailures: state?.consecutiveGateFailures ?? 0,
    recentGateOutcomes: outcomes,
  });
  const writerStreak = autopilotWriterStreak({
    priorFailures: state?.consecutiveWriterFailures ?? 0,
    recentWriterOutcomes: writerOutcomes,
  });
  // The gate's sentence wins a tie: it names a cause the user can open a law
  // report on, where "never reached the gate" sends them to the provider.
  const pause = streak.pause ?? writerStreak.pause;
  await AutopilotRepository.saveState({
    projectId: input.projectId,
    consecutiveGateFailures: streak.consecutiveGateFailures,
    consecutiveWriterFailures: writerStreak.consecutiveWriterFailures,
    pausedAt: pause?.since ?? null,
    pausedReason: pause?.reason ?? null,
    updatedAt: input.now.toISOString(),
  });
  return pause;
}

/**
 * A human takes the switch off.
 *
 * Both counters go back to zero with the pause, and the watermark moves to
 * now, which is what makes the resume final: the three drafts that tripped it
 * are behind the watermark and can never be folded in again. Resuming a
 * project that was never paused is a no-op that still writes the row — the
 * operator asked for a clean slate and gets one.
 */
async function resume(input: { projectId: string; now: Date }): Promise<void> {
  await AutopilotRepository.saveState({
    projectId: input.projectId,
    consecutiveGateFailures: 0,
    consecutiveWriterFailures: 0,
    pausedAt: null,
    pausedReason: null,
    updatedAt: input.now.toISOString(),
  });
}

export const AutopilotService = {
  getStatus,
  getActionBehavior,
  reconcile,
  resume,
};
