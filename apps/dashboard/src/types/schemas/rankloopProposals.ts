import type { InferSelectModel } from "drizzle-orm";
import { z } from "zod";
import { proposals } from "@/db/schema";

// ---------------------------------------------------------------------------
// DB-derived types
// ---------------------------------------------------------------------------

export type RankloopProposal = InferSelectModel<typeof proposals>;

// ---------------------------------------------------------------------------
// API / UI types
// ---------------------------------------------------------------------------

/** One named input to a proposal's score. Stored as factorsJson and parsed
 *  back through this schema on read — the factor breakdown row renders these
 *  verbatim, which is why compute always populates them. */
export const proposalFactorSchema = z.object({
  name: z.string(),
  value: z.union([z.string(), z.number()]),
  note: z.string(),
});

export type ProposalFactor = z.infer<typeof proposalFactorSchema>;

/** Evidence chips are plain strings, pre-formatted at compute time so the
 *  table renders them without re-deriving anything. */
export const proposalEvidenceSchema = z.array(z.string());

/** A proposal row with its JSON columns parsed into typed arrays, plus the
 *  name of the page type it was written against — null on every optimize row,
 *  and on a net-new row whose type has since been deleted. */
export type RankloopProposalListItem = RankloopProposal & {
  pageTypeName: string | null;
  factors: ProposalFactor[];
  evidence: string[];
};

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

export const getRankloopProposalsSchema = z.object({
  projectId: z.string().uuid(),
  status: z.enum(proposals.status.enumValues).optional(),
});

export const decideRankloopProposalSchema = z.object({
  projectId: z.string().uuid(),
  proposalId: z.string().uuid(),
  decision: z.enum(["approved", "declined"]),
});

export const refreshRankloopProposalsSchema = z.object({
  projectId: z.string().uuid(),
});
