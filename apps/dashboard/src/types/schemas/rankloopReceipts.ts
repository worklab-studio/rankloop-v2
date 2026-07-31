import type { InferSelectModel } from "drizzle-orm";
import { z } from "zod";
import type { receipts } from "@/db/schema";

// ---------------------------------------------------------------------------
// DB-derived types
// ---------------------------------------------------------------------------

export type RankloopReceipt = InferSelectModel<typeof receipts>;

// ---------------------------------------------------------------------------
// JSON column shapes
// ---------------------------------------------------------------------------

/** Inclusive first/last stored day (YYYY-MM-DD) a metrics block covers. Both
 *  the baseline and the result span exactly 28 days so their deltas compare
 *  like for like. */
const receiptWindowSchema = z.object({
  start: z.string(),
  end: z.string(),
});

/** One window's rollup for the receipt's page, plus the site-wide totals that
 *  make the later diff-in-diff possible: without them, a site-wide lift (or a
 *  Google update) would be credited to whatever action happened to be open. */
export const receiptMetricsSchema = z.object({
  impressions: z.number(),
  clicks: z.number(),
  ctr: z.number(),
  // Null when the window had zero impressions — there is no position to weight.
  weightedPosition: z.number().nullable(),
  siteImpressions: z.number(),
  siteClicks: z.number(),
});

export type ReceiptMetrics = z.infer<typeof receiptMetricsSchema>;

/** baselineJson: pinned at execution time, never recomputed. */
export const receiptBaselineSchema = receiptMetricsSchema.extend({
  window: receiptWindowSchema,
});

export type ReceiptBaseline = z.infer<typeof receiptBaselineSchema>;

/** resultJson: the evaluation window's metrics plus the trend adjustment.
 *  The delta fields are null only when the stored baseline failed to parse —
 *  the raw window metrics still land so the receipt is never empty. */
export const receiptResultSchema = receiptMetricsSchema.extend({
  window: receiptWindowSchema,
  clicksDelta: z.number().nullable(),
  siteClicksDeltaRatio: z.number().nullable(),
  adjustedClicksDelta: z.number().nullable(),
});

export type ReceiptResult = z.infer<typeof receiptResultSchema>;

// ---------------------------------------------------------------------------
// API / UI types
// ---------------------------------------------------------------------------

/** A receipt row with its JSON columns parsed into typed objects, plus the
 *  display target: the page's current path when the manifest row still
 *  exists, else the pinned target query — a receipt outlives its page. */
export type RankloopReceiptListItem = RankloopReceipt & {
  target: string;
  baseline: ReceiptBaseline | null;
  result: ReceiptResult | null;
};

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

export const getRankloopReceiptsSchema = z.object({
  projectId: z.string().uuid(),
});
