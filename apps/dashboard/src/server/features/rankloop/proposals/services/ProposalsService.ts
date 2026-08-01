import { z } from "zod";
import { GscSyncRepository } from "@/server/features/rankloop/gsc-sync/repositories/GscSyncRepository";
import {
  addDays,
  GSC_SYNC_SENTINEL,
} from "@/server/features/rankloop/gsc-sync/services/GscSyncService";
import { ProposalsRepository } from "@/server/features/rankloop/proposals/repositories/ProposalsRepository";
import {
  aggregatePageQueryWindows,
  brandTokens,
  computePushCandidates,
  computeRefreshCandidates,
  computeRetitleCandidates,
  SIGNAL_WINDOW_DAYS,
} from "@/server/features/rankloop/proposals/signals.logic";
import type {
  SignalCandidate,
  SignalPageMeta,
} from "@/server/features/rankloop/proposals/signals.logic";
import { DECISION_SUPPRESSION_DAYS } from "@/server/features/rankloop/proposals/suppression.logic";
import { SelectionRepository } from "@/server/features/rankloop/writing/repositories/SelectionRepository";
import { ProjectRepository } from "@/server/features/projects/repositories/ProjectRepository";
import { AppError } from "@/server/lib/errors";
import {
  proposalEvidenceSchema,
  proposalFactorSchema,
} from "@/types/schemas/rankloopProposals";
import type {
  ProposalFactor,
  RankloopProposal,
  RankloopProposalListItem,
} from "@/types/schemas/rankloopProposals";

/** Ten days of relevance: signals recompute after every sync, so a proposal
 *  nobody acted on for 10 days is describing data two windows stale — expire
 *  it rather than let the queue accrete zombie advice. Net-new proposals
 *  (S7a) age on the same clock, and share the constant so the two tracks
 *  can't drift into different definitions of stale. */
export const PROPOSAL_TTL_DAYS = 10;

const MS_PER_DAY = 86_400_000;

type ComputeResult = { created: number; expired: number };

/**
 * Evaluate the optimize signals against stored memory and insert what they
 * find. Idempotent by construction — the partial unique on (project_id, type,
 * target) turns a duplicate INSERT into a silent skip — so the workflow step
 * wrapping this is safe to retry.
 */
async function computeProposals(projectId: string): Promise<ComputeResult> {
  const now = new Date();
  const expired = await ProposalsRepository.expireStaleProposals(
    projectId,
    now.toISOString(),
  );

  const project = await ProjectRepository.getProjectById(projectId);
  // Archived mid-flight, or no memory / no inventory yet: nothing to evaluate
  // against. The TTL sweep above still ran — old proposals age out either way.
  if (!project) return { created: 0, expired };
  const windowEnd = await GscSyncRepository.getLatestStoredDate(projectId);
  if (windowEnd === null) return { created: 0, expired };
  const pages = await ProposalsRepository.getContentPagesForSignals(projectId);
  if (pages.length === 0) return { created: 0, expired };

  const pagesByUrl = new Map<string, SignalPageMeta>(
    pages.map((page) => [page.url, page]),
  );
  const tokens = brandTokens(project.name, project.domain);

  // Windows anchor on the watermark (the newest stored PT date), not on
  // today — GSC data ends 4 days back, and anchoring on today would silently
  // shrink every window by the finalization lag.
  const since = addDays(windowEnd, -(SIGNAL_WINDOW_DAYS - 1));
  // One cutoff for all three signals: 60 days is the widest suppression
  // window, so the 42-day receipt window it also has to cover falls inside it.
  const [dayRows, pageDays, earliestStoredDate, recentDecisions] =
    await Promise.all([
      ProposalsRepository.getDailyPageQueryRows(projectId, since),
      ProposalsRepository.getDailyPageTotals(projectId, tokens),
      ProposalsRepository.getEarliestStoredDate(projectId),
      ProposalsRepository.getRecentDecisions(
        projectId,
        new Date(
          now.getTime() - DECISION_SUPPRESSION_DAYS * MS_PER_DAY,
        ).toISOString(),
      ),
    ]);

  const aggregates = aggregatePageQueryWindows(dayRows, GSC_SYNC_SENTINEL);
  const candidates: SignalCandidate[] = [
    ...computeRetitleCandidates({
      aggregates,
      pagesByUrl,
      brandTokens: tokens,
      recentDecisions,
      now: now.toISOString(),
    }),
    ...computePushCandidates({
      aggregates,
      pagesByUrl,
      brandTokens: tokens,
      recentDecisions,
      now: now.toISOString(),
    }),
    ...computeRefreshCandidates({
      pageDays,
      pagesByUrl,
      earliestStoredDate,
      windowEnd,
      sentinel: GSC_SYNC_SENTINEL,
      recentDecisions,
      now: now.toISOString(),
    }),
  ];

  // Insert best-first: push emits one candidate per (page, query), several of
  // which can share a target path, and the partial unique admits only one
  // active row per (type, target) — score order makes the survivor the
  // strongest one.
  const ordered = candidates.toSorted((a, b) => b.score - a.score);
  const expiresAt = new Date(
    now.getTime() + PROPOSAL_TTL_DAYS * MS_PER_DAY,
  ).toISOString();
  let created = 0;
  for (const candidate of ordered) {
    const inserted = await ProposalsRepository.tryInsertProposal({
      id: crypto.randomUUID(),
      projectId,
      type: candidate.type,
      track: "optimize",
      target: candidate.target,
      title: candidate.title,
      contentPageId: candidate.contentPageId,
      score: candidate.score,
      factorsJson: JSON.stringify(candidate.factors),
      evidenceJson: JSON.stringify(candidate.evidence),
      expiresAt,
    });
    if (inserted) created++;
  }
  return { created, expired };
}

/**
 * Approve or decline — valid only from 'proposed', enforced by the CAS update
 * itself so two racing decisions can't both win.
 *
 * `decidedBy` has no default. Once autopilot can approve without a human, the
 * one thing a receipt must never do is imply a person looked at something a
 * machine waved through, and a defaulted parameter is how that happens: the
 * one caller that forgets it is the one that most needed to say 'autopilot'.
 */
async function decideProposal(input: {
  projectId: string;
  proposalId: string;
  decision: "approved" | "declined";
  decidedBy: "human" | "autopilot";
}) {
  const decided = await ProposalsRepository.updateDecision({
    projectId: input.projectId,
    proposalId: input.proposalId,
    status: input.decision,
    decidedAt: new Date().toISOString(),
    decidedBy: input.decidedBy,
  });
  if (decided) {
    // A declined net-new keyword goes back to 'planned', not 'discovered':
    // the page type binding was a separate human decision and survives a no
    // about this one batch. Suppression is what stops it coming straight
    // back; without the release it would never come back at all.
    if (
      input.decision === "declined" &&
      decided.track === "net_new" &&
      decided.keywordBacklogId !== null
    ) {
      await SelectionRepository.releaseBacklogRow(
        input.projectId,
        decided.keywordBacklogId,
      );
    }
    return decided;
  }

  const existing = await ProposalsRepository.getProposalById(
    input.projectId,
    input.proposalId,
  );
  if (!existing) {
    throw new AppError("NOT_FOUND", "Proposal not found.");
  }
  throw new AppError(
    "CONFLICT",
    `This proposal is already ${existing.status}.`,
  );
}

const factorsColumnSchema = z.array(proposalFactorSchema);

function parseJsonColumn<T>(
  schema: z.ZodType<T>,
  raw: string | null,
  fallback: T,
): T {
  if (!raw) return fallback;
  try {
    const parsed: unknown = JSON.parse(raw);
    const validated = schema.safeParse(parsed);
    return validated.success ? validated.data : fallback;
  } catch {
    return fallback;
  }
}

/** Proposal rows with factors/evidence parsed into typed arrays. Malformed
 *  JSON degrades to empty arrays instead of failing the whole list — one bad
 *  row must not blank the queue. */
async function getProposals(
  projectId: string,
  status?: RankloopProposal["status"],
): Promise<RankloopProposalListItem[]> {
  const rows = await ProposalsRepository.getProposalsForProject(
    projectId,
    status,
  );
  return rows.map((row) => ({
    ...row,
    factors: parseJsonColumn<ProposalFactor[]>(
      factorsColumnSchema,
      row.factorsJson,
      [],
    ),
    evidence: parseJsonColumn(proposalEvidenceSchema, row.evidenceJson, []),
  }));
}

export const ProposalsService = {
  computeProposals,
  decideProposal,
  getProposals,
};
