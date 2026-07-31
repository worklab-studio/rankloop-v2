/** Catch-up quota, ported from rankloop 0.2 routines.compute_quota.
 *
 * A missed day is OWED, not skipped:
 *   expected = (days since startDate, inclusive) x postsPerDay
 *   owed     = min(max(0, expected - publishedSinceStart), catchupCap)
 *
 * The published count comes from the live corpus (post dates), not a
 * side-channel ledger — so the quota survives resets and manual posts, and
 * running twice in one day is naturally safe. */

export interface QuotaConfig {
  /** ISO date the quota counts from; empty/undefined = quota off. */
  startDate?: string;
  postsPerDay: number;
  catchupCap: number;
}

import { parseIsoDate } from "./text.ts";

const DAY_MS = 86_400_000;

/** Posts owed today. null = quota not configured (or unparseable start). */
export function computeQuota(
  cfg: QuotaConfig,
  publishedDates: string[],
  todayIso: string,
): number | null {
  if (!cfg.startDate) return null;
  const start = parseIsoDate(cfg.startDate);
  if (start === null) return null;
  const today = parseIsoDate(todayIso);
  if (today === null) return null;
  if (today < start) return 0;
  const days = Math.floor((today - start) / DAY_MS) + 1;
  const expected = days * cfg.postsPerDay;
  // ISO strings compare lexicographically — same trick the Python used.
  const published = publishedDates.filter((d) => d && d >= cfg.startDate!).length;
  return Math.min(Math.max(0, expected - published), cfg.catchupCap);
}
