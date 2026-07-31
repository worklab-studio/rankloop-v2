import { GscService } from "@/server/features/gsc/services/GscService";
import { IndexationRepository } from "@/server/features/rankloop/indexation/repositories/IndexationRepository";
import {
  computeIndexationRate,
  indexationThrottle,
  INDEXATION_MAX_AGE_DAYS,
  INDEXATION_MIN_AGE_DAYS,
  INDEXATION_MIN_COHORT,
} from "@/server/features/rankloop/indexation/indexation.logic";
import type { IndexationThrottle } from "@/server/features/rankloop/indexation/indexation.logic";
import {
  isoDay,
  shiftDate,
} from "@/server/features/rankloop/receipts/receipts.logic";

const MS_PER_DAY = 86_400_000;

/** URL Inspection is free but quota'd at 2,000/day/property. Twenty a project
 *  keeps a hosted instance running dozens of projects far clear of it, and
 *  still sweeps a 140-post cohort inside its own 7-day recheck window. */
const DAILY_URL_BUDGET = 20;

/** The API inspects one URL per call, so a "batch" is only a chunk of the
 *  loop — its size is the blast radius of a token failure, not a payload
 *  limit. Ten keeps a run that dies mid-sweep having still banked most of it. */
const INSPECT_BATCH_SIZE = 10;

/** A verdict a week old still describes the page; re-asking sooner spends
 *  quota to watch Google not change its mind. */
const RECHECK_AFTER_DAYS = 7;

/** The rate plus what it does to today's quota — one read, because every
 *  caller that wants one wants the other. */
type IndexationStatus = {
  rate: number | null;
  indexed: number;
  cohort: number;
  /** Shipped with the number so the card can say what a null rate needs
   *  instead of hard-coding the threshold on the other side of the wire. */
  minimumCohort: number;
  /** No property, no checks — the difference between "unknown" and "bad". */
  connected: boolean;
  throttle: IndexationThrottle | null;
};

/**
 * What indexation says about this project right now.
 *
 * Read-only and side-effect free: the Articles header polls it on every visit,
 * and a status read that inspected URLs as a side effect of being looked at
 * would spend the day's quota on whoever had the tab open.
 */
async function getIndexationStatus(
  projectId: string,
): Promise<IndexationStatus> {
  const today = isoDay(new Date().toISOString());
  const oldest = shiftDate(today, -INDEXATION_MAX_AGE_DAYS);
  const [pages, checks, connection] = await Promise.all([
    IndexationRepository.getPublishedPagesSince(projectId, oldest),
    IndexationRepository.getChecksSince(projectId, oldest),
    GscService.getConnection(projectId),
  ]);
  const rate = computeIndexationRate({ pages, checks, today });
  return {
    ...rate,
    minimumCohort: INDEXATION_MIN_COHORT,
    connected: connection !== null,
    throttle: indexationThrottle(rate),
  };
}

/** What one sweep did. `reason` is set on every empty run — a job that checked
 *  nothing because it was done and one that checked nothing because the
 *  property is gone look identical from the outside. */
type IndexationRunResult = {
  checked: number;
  indexed: number;
  /** URLs the API refused or answered without an index status. */
  failed: number;
  reason: string | null;
};

const EMPTY_RUN = { checked: 0, indexed: 0, failed: 0 };

/**
 * Inspect this project's stalest cohort pages and write down what Google said.
 *
 * No connected property is a clean no-op, not an error: most projects never
 * connect one, and the card's honest answer there is "indexation is unknown"
 * rather than a red number nobody can act on.
 */
async function runIndexationChecks(
  projectId: string,
): Promise<IndexationRunResult> {
  const connection = await GscService.getConnection(projectId);
  if (!connection) {
    return { ...EMPTY_RUN, reason: "no Search Console property connected" };
  }

  const now = new Date();
  const today = isoDay(now.toISOString());
  // The budget resets on the UTC day, the same day the checks are stamped in.
  const spent = await IndexationRepository.countChecksSince(
    projectId,
    `${today}T00:00:00.000Z`,
  );
  if (spent >= DAILY_URL_BUDGET) {
    return { ...EMPTY_RUN, reason: "today's inspection budget is spent" };
  }

  const due = await IndexationRepository.getPagesDueForCheck({
    projectId,
    publishedFrom: shiftDate(today, -INDEXATION_MAX_AGE_DAYS),
    // Exclusive: the day after the youngest cohort day, so a post published
    // exactly 7 days ago is included whether its stamp is a bare date or an
    // instant.
    publishedBefore: shiftDate(today, -(INDEXATION_MIN_AGE_DAYS - 1)),
    staleBefore: new Date(
      now.getTime() - RECHECK_AFTER_DAYS * MS_PER_DAY,
    ).toISOString(),
    limit: DAILY_URL_BUDGET - spent,
  });
  if (due.length === 0) {
    return { ...EMPTY_RUN, reason: "every recent post has a fresh verdict" };
  }

  const checkedAt = now.toISOString();
  let checked = 0;
  let indexed = 0;
  let failed = 0;
  for (let i = 0; i < due.length; i += INSPECT_BATCH_SIZE) {
    const urls = due.slice(i, i + INSPECT_BATCH_SIZE).map((page) => page.url);
    const inspection = await GscService.inspectUrls({ projectId, urls });
    const rows = [];
    for (const item of inspection.results) {
      const status = item.result?.indexStatusResult;
      // A per-URL failure is already captured inline by inspectUrls, and a
      // result with no indexStatusResult is the same nothing. Neither is
      // written: a row claiming a verdict we never got would be indistinguish-
      // able from Google saying no.
      if (status?.verdict === undefined) {
        failed += 1;
        continue;
      }
      if (status.verdict === "PASS") indexed += 1;
      rows.push({
        projectId,
        url: item.url,
        verdict: status.verdict,
        coverageState: status.coverageState ?? null,
        // Stamped here rather than left to the column default: the two
        // dialects' defaults are not the same shape, and every read of this
        // column compares it as a string.
        checkedAt,
      });
    }
    await IndexationRepository.insertChecks(rows);
    checked += rows.length;
    // A whole batch answered with nothing means the property is rate-limited,
    // revoked, or down — and the day's budget only counts rows written, so
    // without this the next tick would ask the same ten URLs fifteen minutes
    // later, ninety-six times a day, into the quota we are trying to protect.
    if (rows.length === 0) {
      return {
        checked,
        indexed,
        failed,
        reason: "Search Console answered nothing — backing off until next tick",
      };
    }
  }

  return { checked, indexed, failed, reason: null };
}

export const IndexationService = {
  getIndexationStatus,
  runIndexationChecks,
};
