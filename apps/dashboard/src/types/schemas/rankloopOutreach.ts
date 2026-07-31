import type { InferSelectModel } from "drizzle-orm";
import { z } from "zod";
import { outreachTargets } from "@/db/schema";

// ---------------------------------------------------------------------------
// DB-derived types
// ---------------------------------------------------------------------------

export type OutreachTarget = InferSelectModel<typeof outreachTargets>;

export type OutreachStatus = OutreachTarget["status"];
export type OutreachTemplateKind = NonNullable<OutreachTarget["templateKind"]>;

// ---------------------------------------------------------------------------
// Stored JSON (outreach_targets.evidenceJson / matchTypeJson)
// ---------------------------------------------------------------------------

/**
 * One competitor's share of why a domain is a target. Written by the gap
 * recompute, quoted verbatim by the draft and by the modal's evidence list —
 * the target exists because of these rows, so nothing downstream may say more
 * than they contain.
 *
 * `targetUrl` and `anchor` are null for everything S4b collects: the
 * referring-domains endpoint reports one row per linking DOMAIN, not per link,
 * so a study knows that acme-blog.com links to rival.example and not which
 * page it links to. The fields ship anyway because both readers already know
 * how to use a URL the moment a per-link source provides one, and because a
 * seeded row can carry it today.
 */
export type OutreachEvidence = {
  competitorId: string;
  competitorDomain: string;
  /** Links into that competitor, as the provider counted them. */
  backlinks: number | null;
  targetUrl: string | null;
  anchor: string | null;
};

/** Why an asset was matched — the modal shows it so a human can disagree with
 *  the machine before sending anything. */
export type OutreachMatchType = {
  /** 'linked_url_tokens' when the competitor URLs named the topic,
   *  'domain_tokens' when only the linking domain's own name did. */
  reason: "linked_url_tokens" | "domain_tokens";
  /** The asset's shape, which is also what picks the template. */
  shape: "data" | "guide" | "page";
  /** The overlapping tokens, so "why this page?" has a literal answer. */
  tokens: string[];
};

const outreachEvidenceSchema = z.array(
  z.object({
    competitorId: z.string(),
    competitorDomain: z.string(),
    backlinks: z.number().nullable(),
    targetUrl: z.string().nullable(),
    anchor: z.string().nullable(),
  }),
);

const outreachMatchTypeSchema = z.object({
  reason: z.enum(["linked_url_tokens", "domain_tokens"]),
  shape: z.enum(["data", "guide", "page"]),
  tokens: z.array(z.string()),
});

/** Read a stored evidence list. An unreadable column degrades to an empty
 *  list — the row still renders as a target, with nothing quoted under it. */
export function parseOutreachEvidence(json: string): OutreachEvidence[] {
  try {
    const parsed = outreachEvidenceSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

/** Read a stored match reason, or null when there isn't one this code
 *  understands. */
export function parseOutreachMatchType(
  json: string | null,
): OutreachMatchType | null {
  if (!json) return null;
  try {
    const parsed = outreachMatchTypeSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// API / UI types
// ---------------------------------------------------------------------------

/** One row of the Outreach table: the stored target with its JSON columns
 *  parsed and the matched asset resolved to something renderable. */
export type OutreachTargetRow = OutreachTarget & {
  evidence: OutreachEvidence[];
  matchType: OutreachMatchType | null;
  assetPath: string | null;
  assetUrl: string | null;
  assetTitle: string | null;
};

export type RankloopOutreach = {
  targets: OutreachTargetRow[];
  /** Drives the stamp ("link gap from N tracked competitors") and the
   *  first empty state — no competitors, no gap to have. */
  trackedCompetitors: number;
  /**
   * Referring-domain rows stored across those competitors. Zero while
   * competitors are tracked is precisely the keyless case: the study's
   * referring-domains step is key-gated and non-fatal, so it skipped rather
   * than failed, and the tab shows the setup pitch instead of "no targets".
   */
  linkDomainsKnown: number;
};

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

export const getRankloopOutreachSchema = z.object({
  projectId: z.string().uuid(),
});

export const recomputeRankloopOutreachSchema = z.object({
  projectId: z.string().uuid(),
});

export const updateRankloopOutreachStatusSchema = z.object({
  projectId: z.string().uuid(),
  targetId: z.string().uuid(),
  status: z.enum(outreachTargets.status.enumValues),
});

// A draft is a plain-text message a human edits and copies out by hand.
// 8000 characters is far past the ~120-word template and still short of
// anything that could be a payload rather than an email.
export const saveRankloopOutreachDraftSchema = z.object({
  projectId: z.string().uuid(),
  targetId: z.string().uuid(),
  draftMessage: z.string().max(8000),
});
