import { z } from "zod";

// The writer's types and its input validation. The law-report shapes live
// here rather than next to the gate on purpose: they are what gets persisted
// in `articles.law_report_json`, so the adapter that produces them, the
// generator that repairs against them and the UI that renders them all read
// one definition. Nothing in this file knows a provider exists.

// ---------------------------------------------------------------------------
// The law report (the persisted shape of articles.lawReportJson)
// ---------------------------------------------------------------------------

/**
 * One law's verdict on one draft.
 *
 * `law` is the engine's own law name, verbatim — the names are parity-tested
 * against the Python original and already carry their bound ("word count >=
 * 850"), so re-deriving a label here would be a second, driftable definition
 * of what was checked. `threshold` restates that bound for the checklist and
 * `excerpt` carries the offending text for the laws that can point at one; a
 * law like "date parses" can produce neither, and says so with nulls rather
 * than with an invented string.
 */
export const lawResultSchema = z.object({
  law: z.string(),
  passed: z.boolean(),
  threshold: z.string().nullable(),
  excerpt: z.string().nullable(),
});

/** Why an article ended where it did. `laws_unmet` is the ordinary exhaustion;
 *  the rest are the honesty cases, where no gradeable draft ever existed and
 *  the report says so instead of showing a green checklist over a half-written
 *  article. `internal_error` exists so a run that threw somewhere unexpected
 *  still lands terminally — an article wedged in `briefing` holds its
 *  proposal's one in-flight slot forever. `insufficient_credits` is the hosted
 *  balance running out mid-article: named rather than folded into
 *  `provider_error` because the fix is a top-up, not a retry.
 *  `publish_blocked` is the only one a passing article can carry: publishing
 *  refused it and sent it back to review, and the checklist above the reason
 *  is still green and still true. */
export const writeFailureSchema = z.object({
  reason: z.enum([
    "laws_unmet",
    "provider_error",
    "truncated",
    "unparseable_frontmatter",
    "internal_error",
    "insufficient_credits",
    "publish_blocked",
  ]),
  detail: z.string(),
});

/**
 * Every law, pass or fail — not just the failures.
 *
 * The report is the product's receipt for quality: "it passed" is only worth
 * something if you can see the nineteen things it passed. Storing failures
 * alone would make a clean article indistinguishable from an ungraded one.
 */
export const lawReportSchema = z.object({
  passed: z.boolean(),
  checkedAt: z.string(),
  laws: z.array(lawResultSchema),
  // Null on a report that actually graded a draft.
  failure: writeFailureSchema.nullable().default(null),
});

export type RankloopLawResult = z.infer<typeof lawResultSchema>;
export type RankloopWriteFailure = z.infer<typeof writeFailureSchema>;
export type RankloopLawReport = z.infer<typeof lawReportSchema>;

/** A stored report read back, or null when the column is empty or was written
 *  by an older shape. A corrupt receipt must cost the detail page its
 *  checklist, never the page. */
export function parseLawReport(raw: string | null): RankloopLawReport | null {
  if (!raw) return null;
  try {
    const parsed = lawReportSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

/** Start the writer on an approved net-new proposal. The article row and the
 *  workflow instance are minted server-side; a client cannot name either. */
export const writeRankloopArticleSchema = z.object({
  projectId: z.string().uuid(),
  proposalId: z.string().uuid(),
});

/** The Writing/Review/Failed tabs' poll. Deliberately unfiltered: one fetch
 *  feeds all three tabs, so their counts and their rows can never disagree. */
export const getRankloopArticlesSchema = z.object({
  projectId: z.string().uuid(),
});

export const getRankloopArticleSchema = z.object({
  projectId: z.string().uuid(),
  articleId: z.string().uuid(),
});

/**
 * The detail editor's save. This re-runs the gate and NOTHING else — no model
 * call, no spend, no attempt increment. Fixing one sentence by hand is the
 * cheapest repair in the system and charging a generation for it would push
 * users back toward accepting whatever the model produced.
 *
 * The 200k ceiling is a guard, not a law: the word-count law is what actually
 * bounds an article, and this only stops a paste that would never be one.
 */
export const recheckRankloopArticleSchema = z.object({
  projectId: z.string().uuid(),
  articleId: z.string().uuid(),
  content: z.string().min(1).max(200_000),
});
