import type { InferSelectModel } from "drizzle-orm";
import { z } from "zod";
import type {
  competitorPages,
  competitors,
  competitorStudyRuns,
} from "@/db/schema";

// ---------------------------------------------------------------------------
// DB-derived types
// ---------------------------------------------------------------------------

export type Competitor = InferSelectModel<typeof competitors>;
export type CompetitorPage = InferSelectModel<typeof competitorPages>;
type CompetitorStudyRun = InferSelectModel<typeof competitorStudyRuns>;

export type CompetitorStudyStatus = CompetitorStudyRun["status"];

// ---------------------------------------------------------------------------
// The studied playbook (competitors.studySummaryJson)
// ---------------------------------------------------------------------------

/**
 * What the summarize step writes and the Blog playbook card renders,
 * render-ready on purpose: it is an aggregate view, not relational data, so
 * the reshaping that a card needs happens once at write time rather than on
 * every read. Parsed through {@link competitorPlaybookSchema} on the way out —
 * the column can hold JSON an older version of this code wrote, and a shape
 * change must degrade to "nothing studied yet", never to a crash.
 */
export type CompetitorPlaybook = {
  /** Trailing 24 months of post lastmods, oldest first; month is "YYYY-MM". */
  cadence: Array<{ month: string; count: number }>;
  /** Non-empty kinds only, biggest first — the mix renders as chips. */
  pageTypeMix: Array<{ pageType: string; count: number }>;
  totalContentPages: number;
  /**
   * Only the features their winners carry MORE often than their median page.
   * A feature both cohorts use equally is table stakes, not a template
   * contract, and an empty array is the card's "no structural difference"
   * state — which is a real finding, not a missing one.
   */
  featureDeltas: Array<{
    feature: string;
    winnersPct: number;
    medianPct: number;
  }>;
  winnersMedianWordCount: number | null;
  medianSampleWordCount: number | null;
  winnersStudied: number;
  sampleStudied: number;
};

const competitorPlaybookSchema = z.object({
  cadence: z.array(z.object({ month: z.string(), count: z.number() })),
  pageTypeMix: z.array(z.object({ pageType: z.string(), count: z.number() })),
  totalContentPages: z.number(),
  featureDeltas: z.array(
    z.object({
      feature: z.string(),
      winnersPct: z.number(),
      medianPct: z.number(),
    }),
  ),
  winnersMedianWordCount: z.number().nullable(),
  medianSampleWordCount: z.number().nullable(),
  winnersStudied: z.number(),
  sampleStudied: z.number(),
});

/** Read a stored playbook, or null when there isn't one this code understands. */
export function parseCompetitorPlaybook(
  json: string | null,
): CompetitorPlaybook | null {
  if (!json) return null;
  try {
    const parsed = competitorPlaybookSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// API / UI types
// ---------------------------------------------------------------------------

/** A tracked or suggested competitor plus the live state of its study — one
 *  row of the Competitors tab. Polled at 3000ms while a study is active. */
export type CompetitorRow = Competitor & {
  pagesStudied: number | null;
  studyStatus: CompetitorStudyStatus | null;
  /**
   * Keywords this domain shares with the project, from discovery. It lives in
   * `organicKeywords` until the competitor is tracked — the schema has one
   * keyword-count column and a suggested row has never been studied, so the
   * column carries the only keyword count that exists for it. Once a study
   * has run, that column means the domain's own organic footprint, which is a
   * different number, so overlap reads null rather than lying.
   */
  overlapKeywords: number | null;
};

export type RankloopCompetitors = {
  tracked: CompetitorRow[];
  suggested: CompetitorRow[];
};

/** The competitor detail drill-in. `playbook` is null until a study has
 *  written one; `decayedPages` stays empty until a refresh has something to
 *  compare against. */
export type RankloopCompetitorDetail = {
  competitor: Competitor & { studyStatus: CompetitorStudyStatus | null };
  playbook: CompetitorPlaybook | null;
  topPages: CompetitorPage[];
  decayedPages: CompetitorPage[];
};

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

export const getRankloopCompetitorsSchema = z.object({
  projectId: z.string().uuid(),
});

export const discoverRankloopCompetitorsSchema = z.object({
  projectId: z.string().uuid(),
});

export const addRankloopCompetitorSchema = z.object({
  projectId: z.string().uuid(),
  // Free text: the service normalizes and tldts-validates it, so
  // "https://www.acme.com/pricing" and "acme.com" land on the same bare
  // domain. 253 is the DNS name ceiling.
  domain: z.string().min(1).max(253),
});

export const decideRankloopCompetitorSchema = z.object({
  projectId: z.string().uuid(),
  competitorId: z.string().uuid(),
  decision: z.enum(["tracked", "skipped"]),
});

export const getRankloopCompetitorSchema = z.object({
  projectId: z.string().uuid(),
  competitorId: z.string().uuid(),
});
