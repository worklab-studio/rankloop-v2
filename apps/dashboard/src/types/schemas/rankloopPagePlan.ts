import type { InferSelectModel } from "drizzle-orm";
import { z } from "zod";
import type { pagePlanRuns, pageTypes } from "@/db/schema";
import type { PageTypeEvidence } from "@/server/features/rankloop/page-plan/evidence.logic";
import type { TemplateContract } from "@/server/features/rankloop/page-plan/contracts.logic";
import type { PageTypeSerpCheck } from "@/server/features/rankloop/page-plan/serpVerdict.logic";

// ---------------------------------------------------------------------------
// DB-derived types
// ---------------------------------------------------------------------------

export type PageType = InferSelectModel<typeof pageTypes>;
export type PagePlanRun = InferSelectModel<typeof pagePlanRuns>;

// ---------------------------------------------------------------------------
// The JSON columns a plan run writes
// ---------------------------------------------------------------------------

// Each column below is parsed back through its schema on read: it can hold
// JSON an older version of this code wrote, and a shape change must degrade
// to "nothing stored" — which every surface renders as its own honest absence
// state — never to a crash that blanks the tab.

/**
 * page_types.evidenceJson. The competitor half is what the card's evidence
 * sentence is built from; the rest is what the run measured about the cluster
 * itself and has no column of its own (the schema's "counts, sample queries").
 */
export type PageTypeEvidenceRecord = {
  /** Real backlog keywords, verbatim — the three the card quotes. */
  exampleTitles: string[];
  kdBand: { p25: number; p75: number } | null;
  competitor: PageTypeEvidence;
};

const competitorEvidenceSchema: z.ZodType<PageTypeEvidence> = z.union([
  z.object({
    hasCompetitorSignal: z.literal(false),
    competitorsChecked: z.number(),
  }),
  z.object({
    hasCompetitorSignal: z.literal(true),
    leadDomain: z.string(),
    matchedPages: z.number(),
    totalPages: z.number(),
    pageSharePct: z.number(),
    etvSharePct: z.number().nullable(),
    competitorsChecked: z.number(),
    competitorsWithSignal: z.number(),
  }),
]);

const evidenceRecordSchema: z.ZodType<PageTypeEvidenceRecord> = z.object({
  exampleTitles: z.array(z.string()),
  kdBand: z.object({ p25: z.number(), p75: z.number() }).nullable(),
  competitor: competitorEvidenceSchema,
});

const templateContractSchema: z.ZodType<TemplateContract> = z.object({
  requiredBlocks: z.array(z.string()),
  wordBand: z.tuple([z.number(), z.number()]),
  h2Min: z.number(),
  faqMin: z.number(),
  internalLinksMin: z.number(),
  schemaType: z.string(),
  notes: z.array(z.string()),
});

const serpCheckSchema: z.ZodType<PageTypeSerpCheck> = z.object({
  status: z.enum(["ok", "caution", "kill", "unsampled"]),
  reason: z.string().nullable(),
  sampled: z.number(),
  hardSerps: z.number(),
  aiOverviews: z.number(),
  weakSlots: z.number(),
  winnable: z.number(),
  samples: z.array(
    z.object({
      keyword: z.string(),
      ugcTop5: z.number(),
      weakness: z.number(),
      aiOverview: z.boolean(),
      featuredSnippet: z.boolean(),
      winnableSignal: z.boolean(),
    }),
  ),
});

function parseJsonColumn<T>(
  schema: z.ZodType<T>,
  raw: string | null,
): T | null {
  if (!raw) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function parsePageTypeEvidence(
  json: string | null,
): PageTypeEvidenceRecord | null {
  return parseJsonColumn(evidenceRecordSchema, json);
}

export function parseTemplateContract(
  json: string | null,
): TemplateContract | null {
  return parseJsonColumn(templateContractSchema, json);
}

export function parsePageTypeSerpCheck(
  json: string | null,
): PageTypeSerpCheck | null {
  return parseJsonColumn(serpCheckSchema, json);
}

/**
 * page_types.dataSourceJson, read for the only thing S7a needs from it:
 * whether the type has a data source at all. S6b owns the rest of the config.
 *
 * A mode this code does not recognize reads as unset on purpose — the
 * no-data-no-page law is about whether a brief can ground every cell, and a
 * mode nothing in this build knows how to load grounds nothing.
 */
const dataSourceSchema = z.object({
  mode: z.enum(["dataset", "compiled"]).nullish(),
});

export function parsePageTypeDataSourceMode(
  json: string | null,
): "dataset" | "compiled" | null {
  return parseJsonColumn(dataSourceSchema, json)?.mode ?? null;
}

// ---------------------------------------------------------------------------
// API / UI types
// ---------------------------------------------------------------------------

/** A page_types row with its JSON columns parsed. A null on any of them means
 *  "nothing this code understands is stored" — the card renders that as an
 *  absence, never as a zero. */
export type PageTypeCard = PageType & {
  evidence: PageTypeEvidenceRecord | null;
  contract: TemplateContract | null;
  serpCheck: PageTypeSerpCheck | null;
};

/**
 * The one authority claim the plan is entitled to make: our own stored domain
 * rank against the tracked competitors' stored ones. rankloop does not know
 * each SERP result's authority, so this is deliberately a site-level
 * comparison — and it is absent entirely unless both sides were measured.
 */
export type PlanAuthority = {
  ourRank: number;
  competitorCount: number;
  lowestRank: number;
  highestRank: number;
  /** The strongest tracked competitor, named when it is the only one. */
  topDomain: string;
};

/** The polling payload behind the Page types tab. */
export type RankloopPagePlan = {
  lastRun: PagePlanRun | null;
  proposed: PageTypeCard[];
  approved: PageTypeCard[];
  /** Planner-killed and user-declined types — the "Not worth building (N)"
   *  panel shows them collapsed WITH their reasons. */
  declined: PageTypeCard[];
  /** Gated backlog rows still unclaimed. What the empty state keys on when it
   *  is zero — NOT what the run clustered, which the run row stores. */
  backlogCount: number;
  authority: PlanAuthority | null;
};

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

export const getRankloopPagePlanSchema = z.object({
  projectId: z.string().uuid(),
});

export const startRankloopPagePlanSchema = z.object({
  projectId: z.string().uuid(),
});

/** The instance list behind "More details". Bounded like every other paged
 *  read in the app — 50 is the largest page size the drawer offers. */
export const getRankloopPageTypeInstancesSchema = z.object({
  projectId: z.string().uuid(),
  pageTypeId: z.string().uuid(),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(50).default(10),
});

export const decideRankloopPageTypeSchema = z.object({
  projectId: z.string().uuid(),
  pageTypeId: z.string().uuid(),
  decision: z.enum(["approved", "declined"]),
});
