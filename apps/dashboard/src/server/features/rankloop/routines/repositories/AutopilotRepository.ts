import { and, desc, eq, isNotNull, ne } from "drizzle-orm";
import { db } from "@/db";
import { articles, publishConnections, receipts } from "@/db/schema";

// Reads behind earned autopilot: the settled receipt cohort that decides
// eligibility, and the two signals that trip the kill switch. Nothing here
// decides anything — autopilot.logic.ts does, on these rows.

/**
 * Every measured receipt with a closed window, all action types.
 *
 * All types, deliberately: eligibility for one type uses the others as its
 * control cohort (see AUTOPILOT_MIN_CONTROLS), so a per-type query would
 * quietly disable the drift adjustment. Contaminated receipts are excluded by
 * the status filter — their windows measured two actions at once and can
 * testify about neither.
 *
 * The 90-day settling cut is applied in the logic rather than in SQL: it is
 * clock arithmetic the tests time-travel over, and the row count here is
 * bounded by how many actions a project has ever executed.
 */
async function getMeasuredReceipts(projectId: string) {
  return db
    .select({
      actionType: receipts.actionType,
      windowEnd: receipts.windowEnd,
      baselineJson: receipts.baselineJson,
      resultJson: receipts.resultJson,
    })
    .from(receipts)
    .where(
      and(
        eq(receipts.projectId, projectId),
        eq(receipts.status, "measured"),
        isNotNull(receipts.windowEnd),
      ),
    );
}

/** How far back the kill switch looks. Three consecutive failures is the
 *  trip, so a handful of the most recent verdicts is all the streak can need;
 *  the extra rows only cover articles whose reports failed to parse. */
const GATE_VERDICT_LOOKBACK = 10;

/**
 * The most recent graded drafts, newest first.
 *
 * Ordered by `updatedAt` because that is when the verdict was written — an
 * article created on Monday and re-graded on Friday is Friday's evidence.
 * Rows with no stored report are excluded here rather than filtered later:
 * an article still being written has not passed or failed anything, and
 * letting it into the array would break a genuine streak in half.
 */
async function getRecentGateVerdicts(projectId: string) {
  return db
    .select({
      at: articles.updatedAt,
      lawReportJson: articles.lawReportJson,
    })
    .from(articles)
    .where(
      and(
        eq(articles.projectId, projectId),
        isNotNull(articles.lawReportJson),
        // Statuses before the gate carry a report only from a previous
        // attempt, and that verdict is already in this list under its own row.
        ne(articles.status, "briefing"),
        ne(articles.status, "writing"),
      ),
    )
    .orderBy(desc(articles.updatedAt))
    .limit(GATE_VERDICT_LOOKBACK);
}

/**
 * The publish connection when its last check failed.
 *
 * A failed "Test connection" is where a rejected credential is durably
 * recorded — the adapters throw PUBLISH_AUTH_FAILED at the call site and
 * nothing persists the throw. A connection that failed for some other reason
 * trips the same switch, which errs toward pausing: for the one mode that
 * publishes without asking, "the target rejected us and we don't know why" is
 * not a reason to keep going.
 */
async function getFailedConnection(projectId: string) {
  const rows = await db
    .select({
      adapter: publishConnections.adapter,
      lastCheckedAt: publishConnections.lastCheckedAt,
    })
    .from(publishConnections)
    .where(
      and(
        eq(publishConnections.projectId, projectId),
        eq(publishConnections.status, "failed"),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export const AutopilotRepository = {
  getMeasuredReceipts,
  getRecentGateVerdicts,
  getFailedConnection,
};
