import { GscSyncRepository } from "@/server/features/rankloop/gsc-sync/repositories/GscSyncRepository";
import {
  addDays,
  GSC_SYNC_SENTINEL,
} from "@/server/features/rankloop/gsc-sync/services/GscSyncService";
import {
  aggregatePageQueryWindows,
  SIGNAL_WINDOW_DAYS,
} from "@/server/features/rankloop/proposals/signals.logic";
import type { PageQueryAggregate } from "@/server/features/rankloop/proposals/signals.logic";
import { UniverseRepository } from "@/server/features/rankloop/universe/repositories/UniverseRepository";

/**
 * The 28-day memory, rolled up per (page, query).
 *
 * Three things in this feature read the same window — the gate's query
 * evidence, the KD ceiling's top-10 samples, and the unserved candidates — so
 * it is one function rather than three subtly different date ranges. The
 * window anchors on the watermark (the newest stored date), not on today:
 * Search Console data ends about four days back, and anchoring on today would
 * silently shorten every window by the finalization lag.
 *
 * Empty before the first sync, which every caller treats as "nothing to say
 * yet" rather than as an error — a project can reach this step before its
 * Search Console backfill has run.
 */
export async function read28DayWindow(
  projectId: string,
): Promise<PageQueryAggregate[]> {
  const windowEnd = await GscSyncRepository.getLatestStoredDate(projectId);
  if (windowEnd === null) return [];
  const since = addDays(windowEnd, -(SIGNAL_WINDOW_DAYS - 1));
  const rows = await UniverseRepository.getDailyPageQueryRows(projectId, since);
  return aggregatePageQueryWindows(rows, GSC_SYNC_SENTINEL);
}
