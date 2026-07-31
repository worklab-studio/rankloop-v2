import { env } from "cloudflare:workers";
import { BacklinksService } from "@/server/features/backlinks/services/BacklinksService";
import { ProjectRepository } from "@/server/features/projects/repositories/ProjectRepository";
import {
  computeLinkGap,
  matchAssetPage,
  type LinkGapTarget,
} from "@/server/features/rankloop/outreach/linkGap.logic";
import { OutreachRepository } from "@/server/features/rankloop/outreach/repositories/OutreachRepository";
import type { OutreachTargetUpsert } from "@/server/features/rankloop/outreach/repositories/OutreachRepository";
import {
  chooseTemplateKind,
  renderDraftMessage,
} from "@/server/features/rankloop/outreach/templates.logic";
import { AppError } from "@/server/lib/errors";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import {
  parseOutreachEvidence,
  parseOutreachMatchType,
  type OutreachStatus,
  type RankloopOutreach,
} from "@/types/schemas/rankloopOutreach";

// Our own referring domains are only needed to subtract them from the gap, so
// the top 200 by rank is the same window the competitors get. This read is
// served from the backlinks feature's 6-hour R2 cache on every run after the
// first, which is why the gap can be recomputed after every study without
// paying for it every time.
const OUR_REFERRING_DOMAINS_PAGE_SIZE = 200;

type ProjectContext = {
  id: string;
  name: string;
  domain: string | null;
  organizationId: string;
};

function hasDataforseoKey(): boolean {
  return Boolean(env.DATAFORSEO_API_KEY?.trim());
}

/** The actor a study-triggered recompute bills through: a scheduled study has
 *  no acting user, but metering needs one. An on-demand recompute passes the
 *  real caller instead. */
function systemBillingCustomer(
  project: ProjectContext,
): BillingCustomerContext {
  return {
    userId: "system",
    userEmail: "system@openseo.so",
    organizationId: project.organizationId,
    projectId: project.id,
  };
}

/**
 * The domains already linking to us, which are the ones the gap must not
 * offer as work.
 *
 * Key-gated and non-fatal, and the failure mode is deliberate: with no key
 * this returns an empty list, so a domain that already links to you can
 * surface as a target. That costs a wasted minute of a human's reading. The
 * alternative — refusing to compute a gap without the exclusion — would hide
 * a board that a keyless deployment can still fill from seeded rows.
 */
async function ourReferringDomains(
  project: ProjectContext,
  billingCustomer: BillingCustomerContext,
): Promise<string[]> {
  if (!project.domain || !hasDataforseoKey()) return [];

  const page = await BacklinksService.profileReferringDomainsPage(
    {
      target: project.domain,
      scope: "domain",
      page: 1,
      pageSize: OUR_REFERRING_DOMAINS_PAGE_SIZE,
      sortField: "rank",
      sortOrder: "desc",
      filters: {},
    },
    billingCustomer,
  ).catch((error: unknown) => {
    console.warn(
      `[outreach] ${project.domain} referring domains failed:`,
      error,
    );
    return null;
  });

  return page?.rows.flatMap((row) => (row.domain ? [row.domain] : [])) ?? [];
}

type AssetRow = {
  id: string;
  url: string;
  path: string;
  title: string | null;
};

/** One target, matched and drafted. `existingDraft` decides whether a draft
 *  is written at all: a row that already carries one keeps it, edited or
 *  not — see upsertTargets for why there is no third option. */
function buildTargetRow(input: {
  projectId: string;
  siteName: string;
  target: LinkGapTarget;
  pages: AssetRow[];
  existingDraft: string | null;
}): OutreachTargetUpsert {
  const match = matchAssetPage({ target: input.target, pages: input.pages });
  const asset = match
    ? (input.pages.find((page) => page.id === match.pageId) ?? null)
    : null;
  const kind = chooseTemplateKind(
    asset ? (match?.matchType.shape ?? null) : null,
  );
  const draft =
    kind && asset
      ? renderDraftMessage({
          kind,
          siteName: input.siteName,
          target: input.target,
          asset,
        })
      : null;

  return {
    projectId: input.projectId,
    domain: input.target.domain,
    domainRank: input.target.domainRank,
    competitorCount: input.target.competitorCount,
    evidenceJson: JSON.stringify(input.target.evidence),
    matchedAssetPageId: asset?.id ?? null,
    matchTypeJson: match ? JSON.stringify(match.matchType) : null,
    // A draft that came back null (the reserved broken_link branch) leaves
    // the kind off too — a template nothing can render is not a template.
    templateKind: draft === null ? null : kind,
    draftMessage: input.existingDraft === null ? draft : null,
  };
}

/** Has a human put anything of their own into this row? Status and notes are
 *  the only two they can move that the recompute can see — an edited draft is
 *  indistinguishable from a generated one, so it deliberately doesn't count
 *  as ownership here. */
function isHumanOwned(row: { status: OutreachStatus; notes: string | null }) {
  return row.status !== "to_contact" || row.notes !== null;
}

/**
 * Recompute the whole board.
 *
 * Whole-project, not per-competitor: the gap is "two or more of them", so
 * whichever study finishes last is the one that sees all of them. Running it
 * after every study is therefore correct rather than wasteful, and the only
 * paid read inside it is cached for six hours.
 */
async function recomputeTargets(input: {
  projectId: string;
  billingCustomer?: BillingCustomerContext;
}): Promise<{ targets: number }> {
  const project = await ProjectRepository.getProjectById(input.projectId);
  // Archived or deleted between the study starting and this step running.
  if (!project) return { targets: 0 };

  const [sourceRows, pages, existing] = await Promise.all([
    OutreachRepository.listGapSourceRows(input.projectId),
    OutreachRepository.listAssetPages(input.projectId),
    OutreachRepository.listTargetStates(input.projectId),
  ]);

  const ourDomains = await ourReferringDomains(
    project,
    input.billingCustomer ?? systemBillingCustomer(project),
  );

  const targets = computeLinkGap({
    competitorDomains: sourceRows,
    ourDomains,
    ourDomain: project.domain,
  });

  const stateByDomain = new Map(existing.map((row) => [row.domain, row]));
  const rows = targets.map((target) =>
    buildTargetRow({
      projectId: input.projectId,
      siteName: project.name,
      target,
      pages,
      existingDraft: stateByDomain.get(target.domain)?.draftMessage ?? null,
    }),
  );

  const now = new Date().toISOString();
  await OutreachRepository.upsertTargets(rows, now);

  // A domain that has fallen out of the gap (a competitor was untracked, its
  // link was lost) is dropped only while nobody has touched it. The moment a
  // human moved its status or wrote a note, the row is theirs and outlives
  // the computation that produced it — but its computed columns stop being
  // true the moment it leaves, so it is stamped rather than skipped. Skipping
  // is what froze a two-competitor count on screen forever.
  const live = new Set(targets.map((target) => target.domain));
  const fallen = existing.filter((row) => !live.has(row.domain));

  await OutreachRepository.deleteTargets(
    input.projectId,
    fallen.flatMap((row) => (isHumanOwned(row) ? [] : [row.id])),
  );

  // Only rows without a stamp: staleAsOf answers "when did this leave the
  // gap", so a monthly refresh must not walk that date forward every time it
  // sees the same absent domain.
  await OutreachRepository.setTargetsStale(
    input.projectId,
    fallen.flatMap((row) =>
      isHumanOwned(row) && row.staleAsOf === null ? [row.id] : [],
    ),
    now,
  );

  // And the other direction: a stamped target whose domain is back in the gap
  // has fresh computed columns again, so the chip and the dimming go away.
  await OutreachRepository.setTargetsStale(
    input.projectId,
    existing.flatMap((row) =>
      row.staleAsOf !== null && live.has(row.domain) ? [row.id] : [],
    ),
    null,
  );

  return { targets: rows.length };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** The Outreach tab payload: the board plus the two counts its empty states
 *  branch on. */
async function getOutreach(projectId: string): Promise<RankloopOutreach> {
  const [rows, trackedCompetitors, linkDomainsKnown] = await Promise.all([
    OutreachRepository.listTargets(projectId),
    OutreachRepository.countTrackedCompetitors(projectId),
    OutreachRepository.countGapSourceRows(projectId),
  ]);

  return {
    targets: rows.map((row) => ({
      ...row.target,
      evidence: parseOutreachEvidence(row.target.evidenceJson),
      matchType: parseOutreachMatchType(row.target.matchTypeJson),
      assetPath: row.assetPath,
      assetUrl: row.assetUrl,
      assetTitle: row.assetTitle,
    })),
    trackedCompetitors,
    linkDomainsKnown,
  };
}

// ---------------------------------------------------------------------------
// The human-owned columns
// ---------------------------------------------------------------------------

/** Move a target on the board. rankloop cannot observe any of these
 *  transitions — nothing here contacts anyone — so this is the only way the
 *  status ever changes. */
async function updateStatus(input: {
  projectId: string;
  targetId: string;
  status: OutreachStatus;
}): Promise<void> {
  const updated = await OutreachRepository.updateTargetStatus({
    ...input,
    updatedAt: new Date().toISOString(),
  });
  if (updated.length === 0) {
    throw new AppError("NOT_FOUND", "Outreach target not found");
  }
}

/** Persist an edited draft. From here on the recompute leaves the text
 *  alone. */
async function saveDraft(input: {
  projectId: string;
  targetId: string;
  draftMessage: string;
}): Promise<void> {
  const updated = await OutreachRepository.updateTargetDraft({
    ...input,
    updatedAt: new Date().toISOString(),
  });
  if (updated.length === 0) {
    throw new AppError("NOT_FOUND", "Outreach target not found");
  }
}

export const OutreachService = {
  recomputeTargets,
  getOutreach,
  updateStatus,
  saveDraft,
};
