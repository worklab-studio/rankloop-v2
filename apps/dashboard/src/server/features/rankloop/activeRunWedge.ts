import { gt, sql } from "drizzle-orm";
import type { AnyColumn, SQL } from "drizzle-orm";

// How long an active run row stays believable. Every rankloop due-query skips
// projects with a pending/running run, but `getStaleRunReason` only ever runs
// from a user-triggered start — so a row that outlived its workflow instance
// (deploy mid-run, instance lost) would remove that project from the
// scheduled flywheel permanently, and self-host, where nobody clicks the
// manual button, would never recover. Two hours is ~4x the longest legitimate
// run (the site study polls its audit for at most 30 minutes); past it the
// row re-enters the tick and the blocked-INSERT probe settles it — a live
// instance answers "already running", a corpse flips to error and the work
// proceeds.
const RUN_WEDGE_AFTER_MS = 2 * 60 * 60 * 1000;

/**
 * The `activeRuns` subquery predicate shared by gsc-sync, site-study and
 * competitors: only a *young* active run suppresses its project.
 *
 * `started_at` arrives in two shapes — SQLite's `current_timestamp` default
 * writes "YYYY-MM-DD HH:MM:SS", Postgres' writes ISO-8601 — and a space sorts
 * before "T", so comparing the raw column against an ISO cutoff would call
 * every same-day D1 row stale and turn the exclusion into a no-op on the
 * default self-host path. `replace` (same signature in both dialects)
 * normalizes the separator first; the ISO cutoff's trailing ".mmmZ" only
 * costs sub-second precision, which a two-hour window doesn't notice.
 */
export function isYoungActiveRun(startedAt: AnyColumn): SQL {
  const cutoff = new Date(Date.now() - RUN_WEDGE_AFTER_MS).toISOString();
  return gt(sql`replace(${startedAt}, ' ', 'T')`, cutoff);
}
