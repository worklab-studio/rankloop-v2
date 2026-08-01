import {
  and,
  count,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  ne,
  notExists,
  sql,
} from "drizzle-orm";
import { db } from "@/db";
import {
  articles,
  autopilotState,
  projects,
  proposals,
  publishConnections,
  receipts,
  writerSettings,
} from "@/db/schema";

// Reads behind earned autopilot: the settled receipt cohort that decides
// eligibility, the two signals that trip the kill switch, the stored switch
// itself, and the three work queues the unattended block draws from. Nothing
// here decides anything — autopilot.logic.ts does, on these rows.

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
async function getRecentGateVerdicts(projectId: string, since?: string) {
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
        // The fold watermark. Strictly after, because everything at or before
        // it is already inside the stored counter — re-reading it would count
        // the same three failures a second time and pause a healthy project.
        since === undefined ? undefined : gt(articles.updatedAt, since),
      ),
    )
    .orderBy(desc(articles.updatedAt))
    .limit(GATE_VERDICT_LOOKBACK);
}

/**
 * The publish connection when its last check failed.
 *
 * One definition of "this connection is broken", written from two places: a
 * failed "Test connection", and a publish whose adapter threw
 * PUBLISH_AUTH_FAILED (PublishService records it there, or the pause below
 * would only ever be reachable by a human clicking a button). A connection
 * that failed for some other reason trips the same switch, which errs toward
 * pausing: for the one mode that publishes without asking, "the target
 * rejected us and we don't know why" is not a reason to keep going.
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

// ---------------------------------------------------------------------------
// The stored kill switch
// ---------------------------------------------------------------------------

async function getState(projectId: string) {
  const rows = await db
    .select()
    .from(autopilotState)
    .where(eq(autopilotState.projectId, projectId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Write the switch: the folded counter, and the pause when one is in force.
 *
 * Upsert on the project unique rather than read-then-branch, the
 * writer_settings idiom — two dispatchers reaching this line for one project
 * would otherwise both see "no row" and race two INSERTs.
 *
 * `updatedAt` is stamped here rather than left to the column default: the two
 * dialects' defaults are not the same shape, and this value is compared as a
 * string against `articles.updated_at` on every fold.
 */
async function saveState(input: {
  projectId: string;
  consecutiveGateFailures: number;
  consecutiveWriterFailures: number;
  pausedAt: string | null;
  pausedReason: string | null;
  updatedAt: string;
}): Promise<void> {
  const { projectId, ...state } = input;
  await db
    .insert(autopilotState)
    .values({ id: crypto.randomUUID(), projectId, ...state })
    .onConflictDoUpdate({ target: autopilotState.projectId, set: state });
}

/**
 * Projects whose dial is set to autopilot, least-recently-reconciled first.
 *
 * The dial is the cheapest of the five preconditions and the only one that is
 * a stored user choice, so it is the one that narrows the due-set; the other
 * four are per-project reads the block makes for itself. Projects with no
 * state row sort first — they have never been reconciled, so they are the
 * furthest behind.
 *
 * The inner join on `projects` is the archived guard every other due-query
 * carries. Archiving is a soft delete, so nothing else stops a deleted
 * project's dial from still reading 'autopilot': without this the loop keeps
 * approving proposals and starting drafts inside a project the tenant can no
 * longer open, forever, and holds a due-set slot doing it.
 */
async function getAutopilotProjects(limit: number, projectId?: string) {
  const rows = await db
    .select({
      projectId: writerSettings.projectId,
      lastReconciledAt: autopilotState.updatedAt,
    })
    .from(writerSettings)
    .innerJoin(projects, eq(projects.id, writerSettings.projectId))
    .leftJoin(
      autopilotState,
      eq(autopilotState.projectId, writerSettings.projectId),
    )
    .where(
      and(
        eq(writerSettings.trustDial, "autopilot"),
        isNull(projects.archivedAt),
        projectId ? eq(writerSettings.projectId, projectId) : undefined,
      ),
    )
    .orderBy(sql`${autopilotState.updatedAt} asc nulls first`)
    .limit(limit);
  return rows;
}

// ---------------------------------------------------------------------------
// The three work queues
// ---------------------------------------------------------------------------

/**
 * Net-new proposals already said yes to and not yet published.
 *
 * This is what "the day's remaining quota" subtracts: the quota counts posts,
 * an approved proposal is a post this loop has already committed to, and a cap
 * that ignored them would hand out today's whole debt again on every tick
 * until the queue was unreadable.
 */
async function countCommittedNetNew(projectId: string): Promise<number> {
  const rows = await db
    .select({ committed: count() })
    .from(proposals)
    .where(
      and(
        eq(proposals.projectId, projectId),
        eq(proposals.track, "net_new"),
        inArray(proposals.status, ["approved", "executing"]),
      ),
    );
  return rows[0]?.committed ?? 0;
}

/**
 * Net-new the day has already said yes to, whoever said it.
 *
 * The indexation throttle's cap is a per-day ceiling ("posts net-new may
 * propose today"), and the unattended run is one wake of ninety-six — a
 * counter that started at zero each wake would pace the queue and never bound
 * the day. Counted from `decidedAt` rather than from the quota's own debt
 * because a publish repays the debt and would hand the allowance straight
 * back. Every decider counts: the rule is one post today, and a human's yes
 * spends the same day.
 */
async function countNetNewApprovedSince(
  projectId: string,
  sinceIso: string,
): Promise<number> {
  const rows = await db
    .select({ approved: count() })
    .from(proposals)
    .where(
      and(
        eq(proposals.projectId, projectId),
        eq(proposals.track, "net_new"),
        inArray(proposals.status, [
          "approved",
          "executing",
          "done",
          "measured",
        ]),
        gte(proposals.decidedAt, sinceIso),
      ),
    );
  return rows[0]?.approved ?? 0;
}

/**
 * Approved net-new proposals with no article in flight, oldest decision first.
 *
 * The `notExists` is a filter, not the guard: the partial unique on
 * `articles(proposal_id)` is what actually stops two writers, and this only
 * keeps the run from spending its cap of 2 on proposals whose article is
 * already being written.
 *
 * `failedArticles` rides along rather than becoming a WHERE clause: the run
 * has to be able to name what it refused (AUTOPILOT_PROPOSAL_FAIL_LIMIT), and
 * a proposal filtered out in SQL is a proposal nobody can be told about.
 */
async function getWritableNetNewProposals(projectId: string, limit: number) {
  return db
    .select({
      id: proposals.id,
      target: proposals.target,
      // `eq(...)` rather than a hand-written comparison: drizzle only
      // table-qualifies a column inside a raw template when it renders the
      // condition itself, and an unqualified `proposal_id = id` reads as two
      // columns of the INNER table — a correlated subquery that silently
      // counts zero.
      failedArticles: sql<number>`(
        select count(*) from ${articles}
        where ${eq(articles.proposalId, proposals.id)}
          and ${eq(articles.status, "failed")}
      )`,
    })
    .from(proposals)
    .where(
      and(
        eq(proposals.projectId, projectId),
        eq(proposals.status, "approved"),
        eq(proposals.track, "net_new"),
        eq(proposals.type, "write_new"),
        notExists(
          db
            .select({ one: sql`1` })
            .from(articles)
            .where(
              and(
                eq(articles.proposalId, proposals.id),
                sql`${articles.status} NOT IN ('published', 'failed')`,
              ),
            ),
        ),
      ),
    )
    .orderBy(proposals.decidedAt)
    .limit(limit);
}

/**
 * Drafts sitting in `review`, oldest first, with the verdict they carry.
 *
 * The report comes back raw because "the gate currently passes" is a question
 * about its contents, and parsing JSON in SQL to filter on it would put the
 * law report's shape in two places. Ordered oldest-first so a backlog drains
 * in the order it formed instead of the newest draft jumping the queue every
 * run.
 */
async function getReviewArticles(projectId: string, limit: number) {
  return db
    .select({
      id: articles.id,
      keyword: articles.keyword,
      lawReportJson: articles.lawReportJson,
    })
    .from(articles)
    .where(
      and(eq(articles.projectId, projectId), eq(articles.status, "review")),
    )
    .orderBy(articles.updatedAt)
    .limit(limit);
}

export const AutopilotRepository = {
  getMeasuredReceipts,
  getRecentGateVerdicts,
  getFailedConnection,
  getState,
  saveState,
  getAutopilotProjects,
  countCommittedNetNew,
  countNetNewApprovedSince,
  getWritableNetNewProposals,
  getReviewArticles,
};
