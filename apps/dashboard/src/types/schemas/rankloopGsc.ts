import type { InferSelectModel } from "drizzle-orm";
import { z } from "zod";
import type { gscSyncRuns } from "@/db/schema";

// ---------------------------------------------------------------------------
// DB-derived types
// ---------------------------------------------------------------------------

export type GscSyncRun = InferSelectModel<typeof gscSyncRuns>;

// ---------------------------------------------------------------------------
// API / UI types
// ---------------------------------------------------------------------------

/** The provenance stamp payload: last sync run plus how much day-grain
 *  memory is stored. Polled at 3000ms while a run is active. */
export type RankloopGscMemory = {
  lastRun: GscSyncRun | null;
  latestDate: string | null;
  dayCount: number;
  rowCount: number;
};

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

export const startRankloopGscSyncSchema = z.object({
  projectId: z.string().uuid(),
});

export const getRankloopGscMemorySchema = z.object({
  projectId: z.string().uuid(),
});
