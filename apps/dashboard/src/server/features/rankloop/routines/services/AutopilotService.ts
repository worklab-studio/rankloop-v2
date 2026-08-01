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
  autopilotEligibility,
  autopilotKillSwitch,
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
 * for the same reason.
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
  const [settings, receiptRows, verdictRows, failedConnection] =
    await Promise.all([
      WriterSettingsRepository.getSettings(input.projectId),
      AutopilotRepository.getMeasuredReceipts(input.projectId),
      AutopilotRepository.getRecentGateVerdicts(input.projectId),
      AutopilotRepository.getFailedConnection(input.projectId),
    ]);

  const trustDial = settings?.trustDial ?? WRITER_SETTINGS_DEFAULTS.trustDial;
  const pause = autopilotKillSwitch({
    recentGateOutcomes: toGateOutcomes(verdictRows),
    adapterAuthError: failedConnection
      ? {
          adapter: failedConnection.adapter,
          // A connection can be marked failed without a stamp only if the
          // status was written by hand; the row's own truth is the fallback.
          at: failedConnection.lastCheckedAt ?? input.now.toISOString(),
        }
      : null,
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

export const AutopilotService = {
  getStatus,
  getActionBehavior,
};
