import type { InferSelectModel } from "drizzle-orm";
import { z } from "zod";
import type { siteStudyRuns } from "@/db/schema";

// ---------------------------------------------------------------------------
// DB-derived types
// ---------------------------------------------------------------------------

export type SiteStudyRun = InferSelectModel<typeof siteStudyRuns>;

// ---------------------------------------------------------------------------
// API / UI types
// ---------------------------------------------------------------------------

/** What the Content inventory card renders: corpus counts by kind, the
 *  median length, and the trailing-12-month posting cadence. */
export type ContentInventorySummary = {
  totalPages: number;
  kindCounts: Record<"post" | "page" | "hub" | "other", number>;
  medianWordCount: number | null;
  lastPublishedAt: string | null;
  /** Trailing 12 months, oldest first; month is "YYYY-MM". */
  monthlyPosts: Array<{ month: string; count: number }>;
};

/** The polling payload: last study run, the derived inventory (null until a
 *  study has produced rows — that null is the card's empty state), and the
 *  live crawl numbers while the ensured audit runs. Polled at 3000ms while a
 *  run is active. */
export type RankloopSiteStudy = {
  lastRun: SiteStudyRun | null;
  inventory: ContentInventorySummary | null;
  auditProgress: { pagesCrawled: number; pagesTotal: number } | null;
};

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

export const startRankloopSiteStudySchema = z.object({
  projectId: z.string().uuid(),
});

export const getRankloopSiteStudySchema = z.object({
  projectId: z.string().uuid(),
});
