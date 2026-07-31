import type { IndexationThrottle } from "@/server/features/rankloop/indexation/indexation.logic";
import { IndexationService } from "@/server/features/rankloop/indexation/services/IndexationService";
import { ProposalsRepository } from "@/server/features/rankloop/proposals/repositories/ProposalsRepository";
import { PROPOSAL_TTL_DAYS } from "@/server/features/rankloop/proposals/services/ProposalsService";
import { DECISION_SUPPRESSION_DAYS } from "@/server/features/rankloop/proposals/suppression.logic";
import { readImpressions28 } from "@/server/features/rankloop/universe/notes.logic";
import { SelectionRepository } from "@/server/features/rankloop/writing/repositories/SelectionRepository";
import { WriterSettingsRepository } from "@/server/features/rankloop/writing/repositories/WriterSettingsRepository";
import {
  buildNetNewProposal,
  computeNetNewSlots,
  partitionCandidates,
  selectNetNew,
} from "@/server/features/rankloop/writing/selection";
import type {
  NetNewCandidate,
  NetNewExclusion,
} from "@/server/features/rankloop/writing/selection";
import { parsePageTypeDataSourceMode } from "@/types/schemas/rankloopPagePlan";
import { WRITER_SETTINGS_DEFAULTS } from "@/shared/rankloop-writing";

const MS_PER_DAY = 86_400_000;

/** What one net-new run did, in the terms the Articles header speaks. Every
 *  no-op carries its `reason` — a run that quietly creates nothing is
 *  indistinguishable from a broken one. */
type NetNewRunResult = {
  created: number;
  expired: number;
  reclaimed: number;
  /** Posts owed today; null when the quota is off. */
  owed: number | null;
  /** Net-new proposals already in flight before this run. */
  outstanding: number;
  reason: string | null;
  /** The indexation throttle when one is holding the run back — the run row
   *  states the cap rather than reporting a smaller number as though it were
   *  the quota. */
  throttle: IndexationThrottle | null;
  /** Approved page types that contributed nothing, and why — rendered next
   *  to the queue rather than swallowed. */
  exclusions: NetNewExclusion[];
};

/** What the Articles header renders before anything is proposed. */
type NetNewQuotaView = {
  owed: number | null;
  outstanding: number;
  slots: number;
  reason: string | null;
  throttle: IndexationThrottle | null;
  exclusions: NetNewExclusion[];
};

/** Trim a stored timestamp to the date the quota counts in. content_pages
 *  holds whatever the crawl or the publish adapter wrote — sometimes a bare
 *  date, sometimes a full ISO stamp — and the engine's quota only parses
 *  YYYY-MM-DD. */
function toIsoDate(value: string): string {
  return value.slice(0, 10);
}

/** The quota and the eligible/held-back split, computed without writing
 *  anything. The header polls this on every visit, and a read that created
 *  proposals as a side effect of being looked at would make the queue depend
 *  on who had the tab open. */
async function readQuota(projectId: string, now: Date, limit?: number) {
  const [stored, publishedAt, outstanding, indexation] = await Promise.all([
    WriterSettingsRepository.getSettings(projectId),
    SelectionRepository.getPublishedPostDates(projectId),
    SelectionRepository.countOutstandingNetNew(projectId),
    IndexationService.getIndexationStatus(projectId),
  ]);
  return computeNetNewSlots({
    settings: {
      postsPerDay: stored?.postsPerDay ?? WRITER_SETTINGS_DEFAULTS.postsPerDay,
      catchupCap: stored?.catchupCap ?? WRITER_SETTINGS_DEFAULTS.catchupCap,
      quotaStartDate:
        stored?.quotaStartDate ?? WRITER_SETTINGS_DEFAULTS.quotaStartDate,
    },
    publishedDates: publishedAt.map(toIsoDate),
    outstanding,
    today: toIsoDate(now.toISOString()),
    throttle: indexation.throttle,
    ...(limit === undefined ? {} : { limit }),
  });
}

async function getWritingQuota(projectId: string): Promise<NetNewQuotaView> {
  const [quota, rows] = await Promise.all([
    readQuota(projectId, new Date()),
    SelectionRepository.getPlannedCandidates(projectId),
  ]);
  const { eligible, exclusions } = partitionCandidates(rows.map(toCandidate));
  return {
    owed: quota.owed,
    outstanding: quota.outstanding,
    slots: quota.slots,
    // The held-back page types are worth saying even when the quota is off:
    // "nothing is being written" and "nothing CAN be written until this type
    // has a dataset" are different problems with different fixes.
    reason:
      quota.reason ??
      (eligible.length === 0
        ? "no planned keywords are bound to an approved page type"
        : null),
    throttle: quota.throttle,
    exclusions,
  };
}

/**
 * Open track 2 for one project: quota → slots, slots → picks, picks →
 * proposals.
 *
 * Idempotent by construction, three times over. The TTL sweep and the reclaim
 * sweep are both set-based; the slot arithmetic subtracts what is already in
 * flight; and the partial unique on (project, type, target) turns a duplicate
 * INSERT into a silent skip. Mashing "Propose now" cannot duplicate the queue.
 */
async function computeNetNewProposals(
  projectId: string,
  options: { limit?: number } = {},
): Promise<NetNewRunResult> {
  const now = new Date();
  const expired = await ProposalsRepository.expireStaleProposals(
    projectId,
    now.toISOString(),
  );
  // After the sweep, not before: a proposal that just expired has released
  // its keyword this instant, and the run that noticed should be the run that
  // can pick it again.
  const reclaimed =
    await SelectionRepository.reclaimAbandonedBacklogRows(projectId);

  const quota = await readQuota(projectId, now, options.limit);

  const base = {
    created: 0,
    expired,
    reclaimed,
    owed: quota.owed,
    outstanding: quota.outstanding,
    throttle: quota.throttle,
  };
  // No slots, no candidate read: the header's own quota endpoint computes the
  // exclusions on every visit, so making a cron tick pay for them too would be
  // buying the same answer twice a day for nobody.
  if (quota.slots === 0) {
    return { ...base, reason: quota.reason, exclusions: [] };
  }

  const rows = await SelectionRepository.getPlannedCandidates(projectId);
  const { eligible, exclusions } = partitionCandidates(rows.map(toCandidate));
  if (eligible.length === 0) {
    return {
      ...base,
      reason:
        exclusions.length > 0
          ? "every approved page type is still waiting on a data source"
          : "no planned keywords are bound to an approved page type",
      exclusions,
    };
  }

  const recentDecisions = await ProposalsRepository.getRecentDecisions(
    projectId,
    new Date(
      now.getTime() - DECISION_SUPPRESSION_DAYS * MS_PER_DAY,
    ).toISOString(),
  );
  const picks = selectNetNew({
    candidates: eligible,
    n: quota.slots,
    suppression: { recentDecisions, now: now.toISOString() },
  });
  if (picks.length === 0) {
    return {
      ...base,
      reason: "every candidate is inside its decision-suppression window",
      exclusions,
    };
  }

  const expiresAt = new Date(
    now.getTime() + PROPOSAL_TTL_DAYS * MS_PER_DAY,
  ).toISOString();
  const claimed: string[] = [];
  for (const pick of picks) {
    const draft = buildNetNewProposal(pick);
    const inserted = await ProposalsRepository.tryInsertProposal({
      id: crypto.randomUUID(),
      projectId,
      type: "write_new",
      track: "net_new",
      target: draft.target,
      title: draft.title,
      pageTypeId: draft.pageTypeId,
      keywordBacklogId: draft.keywordBacklogId,
      score: draft.score,
      factorsJson: JSON.stringify(draft.factors),
      evidenceJson: JSON.stringify(draft.evidence),
      expiresAt,
    });
    // A blocked INSERT means this keyword already has an active proposal —
    // its backlog row is already claimed, so claiming it again would only
    // rewrite updatedAt.
    if (inserted) claimed.push(draft.keywordBacklogId);
  }
  await SelectionRepository.markBacklogProposed(projectId, claimed);

  return { ...base, created: claimed.length, reason: null, exclusions };
}

type PlannedRow = Awaited<
  ReturnType<typeof SelectionRepository.getPlannedCandidates>
>[number];

/** The join row as selection wants it: notesJson and dataSourceJson parsed
 *  once here so every pure function downstream reads plain values. */
function toCandidate(row: PlannedRow): NetNewCandidate {
  return {
    backlogId: row.backlogId,
    keyword: row.keyword,
    source: row.source,
    score: row.score,
    searchVolume: row.searchVolume,
    keywordDifficulty: row.keywordDifficulty,
    impressions28: readImpressions28(row.notesJson),
    createdAt: row.createdAt,
    pageTypeId: row.pageTypeId,
    pageTypeName: row.pageTypeName,
    pageTypeKind: row.pageTypeKind,
    dataSourceMode: parsePageTypeDataSourceMode(row.dataSourceJson),
  };
}

export const NetNewProposalsService = {
  getWritingQuota,
  computeNetNewProposals,
};
