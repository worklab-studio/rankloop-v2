import { env } from "cloudflare:workers";
import { PagePlanRepository } from "@/server/features/rankloop/page-plan/repositories/PagePlanRepository";
import { deriveTemplateContract } from "@/server/features/rankloop/page-plan/contracts.logic";
import {
  computeCandidateEvidence,
  type EvidenceCompetitor,
} from "@/server/features/rankloop/page-plan/evidence.logic";
import {
  detectCandidates,
  pickSerpSampleKeywords,
  type PageTypeCandidate,
  type PlannerBacklogRow,
} from "@/server/features/rankloop/page-plan/planner.logic";
import { unsampledSerpCheck } from "@/server/features/rankloop/page-plan/serpVerdict.logic";
import { getStaleRunReason } from "@/server/features/rankloop/staleRunProbe";
// The impr28 reader lives with the writer: S5's upsert path and this
// imputation are two halves of one notesJson contract, and a key renamed on
// one side alone would stop the planner imputing demand without failing
// anything.
import { readImpressions28 } from "@/server/features/rankloop/universe/notes.logic";
import { AppError } from "@/server/lib/errors";
import { parseCompetitorPlaybook } from "@/types/schemas/rankloopCompetitors";
import {
  parsePageTypeEvidence,
  parsePageTypeSerpCheck,
  parseTemplateContract,
  type PageType,
  type PageTypeCard,
  type PageTypeEvidenceRecord,
  type PlanAuthority,
  type RankloopPagePlan,
} from "@/types/schemas/rankloopPagePlan";

// The free half of a plan run: clustering, evidence, contracts, the page_types
// write, and the approval that binds keywords to a type. Everything metered
// lives next door in planSerpSampling.ts.

/** What the propose step hands the workflow: one entry per type this run
 *  wrote, carrying everything a SERP step needs and nothing it doesn't. */
export type PlanCandidateEntry = {
  pageTypeId: string;
  name: string;
  sampleKeywords: string[];
  kdBandP75: number | null;
};

// ---------------------------------------------------------------------------
// Run lifecycle
// ---------------------------------------------------------------------------

/**
 * Start a plan run, or return the one already active. Coordination mirrors
 * site-study: workflow instance id === run row id, and the partial unique on
 * page_plan_runs(project_id) WHERE status IN ('pending','running') is the
 * only lock — a blocked INSERT means a plan is underway, which callers treat
 * as success. A blocker whose workflow instance is dead is flipped to error
 * and the start retried, so one corpse can't wedge a project forever.
 */
async function startPlan(
  projectId: string,
): Promise<{ runId: string; alreadyRunning: boolean }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const runId = crypto.randomUUID();
    const inserted = await PagePlanRepository.tryCreateRun({
      id: runId,
      projectId,
    });

    if (!inserted) {
      const active = await PagePlanRepository.getActiveRunForProject(projectId);
      if (!active) continue;
      if (attempt === 0) {
        const staleReason = await getStaleRunReason({
          workflow: env.PAGE_PLAN_WORKFLOW,
          runId: active.id,
          ageMs: Date.now() - new Date(active.startedAt).getTime(),
        });
        if (staleReason) {
          await PagePlanRepository.updateRun(active.id, {
            status: "error",
            error: staleReason,
            finishedAt: new Date().toISOString(),
          });
          continue; // slot is free now — retry the insert
        }
      }
      return { runId: active.id, alreadyRunning: true };
    }

    try {
      await env.PAGE_PLAN_WORKFLOW.create({
        id: runId,
        params: { runId, projectId },
      });
    } catch (error) {
      await PagePlanRepository.updateRun(runId, {
        status: "error",
        error: "Failed to start page plan workflow",
        finishedAt: new Date().toISOString(),
      });
      try {
        const instance = await env.PAGE_PLAN_WORKFLOW.get(runId);
        await instance.terminate();
      } catch {
        // Workflow may not have been created.
      }
      throw error;
    }
    return { runId, alreadyRunning: false };
  }

  throw new AppError("CONFLICT", "Could not start the page plan. Try again.");
}

// ---------------------------------------------------------------------------
// Detect → evidence → contracts → write (the workflow's propose step)
// ---------------------------------------------------------------------------

async function loadPlannerRows(
  projectId: string,
): Promise<PlannerBacklogRow[]> {
  const rows = await PagePlanRepository.getPlannableBacklog(projectId);
  return rows.map((row) => ({
    id: row.id,
    keyword: row.keyword,
    searchVolume: row.searchVolume,
    keywordDifficulty: row.keywordDifficulty,
    impressions28: readImpressions28(row.notesJson),
  }));
}

function medianOf(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = values.toSorted((a, b) => a - b);
  const middle = sorted.length / 2;
  return sorted.length % 2 === 1
    ? sorted[(sorted.length - 1) / 2]
    : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

/**
 * Cluster the backlog, attach competitor evidence and a template contract to
 * every candidate, and write them as proposed types.
 *
 * Proposal happens before sampling on purpose: a keyless project — or one
 * whose SERP steps all fail — still ends the run with real types, real demand
 * and real evidence, every verdict honestly marked 'unsampled'. The SERP
 * steps then refine what they can afford to.
 */
async function proposeTypes(input: { projectId: string }): Promise<{
  candidates: PlanCandidateEntry[];
  typesProposed: number;
  keywordsClustered: number;
}> {
  const plannerRows = await loadPlannerRows(input.projectId);
  const candidates = detectCandidates(plannerRows);
  const [{ tracked, pages }, wordCountRows, existing] = await Promise.all([
    PagePlanRepository.getEvidenceCompetitors(input.projectId),
    PagePlanRepository.getPostWordCounts(input.projectId),
    PagePlanRepository.getPageTypes(input.projectId),
  ]);

  const competitors: EvidenceCompetitor[] = tracked.map((competitor) => ({
    domain: competitor.domain,
    studied: competitor.studySummaryJson !== null,
    pages: pages
      .filter((page) => page.competitorId === competitor.id)
      .map((page) => ({ url: page.url, etv: page.etv })),
  }));
  const playbookByDomain = new Map(
    tracked.map((competitor) => [
      competitor.domain,
      parseCompetitorPlaybook(competitor.studySummaryJson),
    ]),
  );
  const ourMedianWordCount = medianOf(
    wordCountRows.flatMap((row) =>
      row.wordCount === null ? [] : [row.wordCount],
    ),
  );
  // A type the user already ruled on is theirs, but the two rulings mean
  // different things to this loop: a hand-declined row stays declined however
  // strongly this run would re-propose it, while an approved row is never
  // re-written yet still owns whatever keywords the shape has picked up since.
  const approvedByName = new Map(
    existing
      .filter((row) => row.status === "approved")
      .map((row) => [row.name, row]),
  );
  const userDeclined = new Set(
    existing
      .filter((row) => row.status !== "approved" && row.decidedAt !== null)
      .map((row) => row.name),
  );

  const entries: PlanCandidateEntry[] = [];
  const written: string[] = [];
  for (const candidate of candidates) {
    if (userDeclined.has(candidate.name)) continue;
    const approved = approvedByName.get(candidate.name);
    if (approved) {
      // This is the repair decidePageType promises when it says "the next
      // recompute repairs its counts". The row is left exactly as the user
      // approved it — no upsert, no SERP entry, not in `written` — but the
      // keywords admitted since approval are bound, or the flywheel's output
      // never reaches the writer. The bind only claims unclaimed 'discovered'
      // rows, so re-running it is free.
      await PagePlanRepository.bindKeywordsToPageType({
        projectId: input.projectId,
        pageTypeId: approved.id,
        keywordIds: candidate.instances.map((row) => row.id),
      });
      // instanceCount is read back from the bound rows, never accumulated, so
      // a retry of this FREE_IDEMPOTENT step lands the same number. `demand`
      // is deliberately untouched: on a top-up the candidate holds only the
      // newly admitted rows, and writing its demand would replace the type's
      // total with the increment and reorder the tab.
      await PagePlanRepository.updatePageType(approved.id, {
        instanceCount: await PagePlanRepository.countBoundKeywords(approved.id),
      });
      continue;
    }
    const pageTypeId = await writeCandidate({
      projectId: input.projectId,
      candidate,
      competitors,
      playbookByDomain,
      ourMedianWordCount,
    });
    written.push(pageTypeId);
    entries.push({
      pageTypeId,
      name: candidate.name,
      sampleKeywords: pickSerpSampleKeywords(candidate),
      kdBandP75: candidate.kdBand?.p75 ?? null,
    });
  }

  await PagePlanRepository.deleteUndetectedPlannerTypes(
    input.projectId,
    written,
  );
  // The whole pool the clustering read, not the rows that ended up in a type:
  // the stamp's claim is what the plan was derived from, and a keyword no
  // shape wanted still argued for the shapes that won.
  return {
    candidates: entries,
    typesProposed: entries.length,
    keywordsClustered: plannerRows.length,
  };
}

async function writeCandidate(input: {
  projectId: string;
  candidate: PageTypeCandidate;
  competitors: EvidenceCompetitor[];
  playbookByDomain: Map<string, ReturnType<typeof parseCompetitorPlaybook>>;
  ourMedianWordCount: number | null;
}): Promise<string> {
  const { candidate } = input;
  const competitor = computeCandidateEvidence({
    candidate,
    competitors: input.competitors,
  });
  // The contract is derived from the competitor the evidence sentence names:
  // one site's winners against its own median is a comparison that holds,
  // and deltas pooled across sites are not.
  const playbook = competitor.hasCompetitorSignal
    ? (input.playbookByDomain.get(competitor.leadDomain) ?? null)
    : null;
  const contract = deriveTemplateContract({
    format: candidate.format,
    deltas: playbook?.featureDeltas ?? [],
    winnersMedianWordCount: playbook?.winnersMedianWordCount ?? null,
    ourMedianWordCount: input.ourMedianWordCount,
    competitorDomain: competitor.hasCompetitorSignal
      ? competitor.leadDomain
      : null,
  });
  const evidence: PageTypeEvidenceRecord = {
    exampleTitles: candidate.exampleTitles,
    kdBand: candidate.kdBand,
    competitor,
  };

  return PagePlanRepository.upsertPageType({
    projectId: input.projectId,
    name: candidate.name,
    kind: candidate.kind,
    urlPattern: candidate.urlPattern,
    keywordPattern: candidate.keywordPattern,
    templateContractJson: JSON.stringify(contract),
    evidenceJson: JSON.stringify(evidence),
    serpCheckJson: JSON.stringify(
      unsampledSerpCheck("No SERP sample yet for this type."),
    ),
    demand: Math.round(candidate.demand),
    instanceCount: candidate.instances.length,
  });
}

// ---------------------------------------------------------------------------
// Read + decide
// ---------------------------------------------------------------------------

function toCard(row: PageType): PageTypeCard {
  return {
    ...row,
    evidence: parsePageTypeEvidence(row.evidenceJson),
    contract: parseTemplateContract(row.templateContractJson),
    serpCheck: parsePageTypeSerpCheck(row.serpCheckJson),
  };
}

/**
 * The authority comparison the approval card is allowed to make, or null.
 *
 * Both halves must be stored measurements: without our own snapshot, or with
 * no tracked competitor carrying a rank, the card says nothing rather than
 * estimating one side of a comparison the user would read as measured.
 */
function readAuthority(input: {
  ourRank: number | null;
  competitors: { domain: string; rank: number | null }[];
}): PlanAuthority | null {
  const ranked = input.competitors.flatMap((competitor) =>
    competitor.rank === null
      ? []
      : [{ domain: competitor.domain, rank: competitor.rank }],
  );
  if (input.ourRank === null || ranked.length === 0) return null;
  const ranks = ranked
    .map((competitor) => competitor.rank)
    .toSorted((a, b) => a - b);
  return {
    ourRank: input.ourRank,
    competitorCount: ranked.length,
    lowestRank: ranks[0],
    highestRank: ranks[ranks.length - 1],
    topDomain:
      ranked.find((competitor) => competitor.rank === ranks[ranks.length - 1])
        ?.domain ?? ranked[0].domain,
  };
}

async function getPlan(projectId: string): Promise<RankloopPagePlan> {
  const [lastRun, rows, backlogCount, authority] = await Promise.all([
    PagePlanRepository.getLatestRunForProject(projectId),
    PagePlanRepository.getPageTypes(projectId),
    PagePlanRepository.countPlannableBacklog(projectId),
    PagePlanRepository.getAuthorityComparison(projectId),
  ]);
  const cards = rows.map(toCard);
  return {
    lastRun,
    proposed: cards.filter((card) => card.status === "proposed"),
    approved: cards.filter((card) => card.status === "approved"),
    declined: cards.filter((card) => card.status === "declined"),
    backlogCount,
    authority: readAuthority(authority),
  };
}

type PageTypeInstanceRow = {
  id: string;
  keyword: string;
  searchVolume: number | null;
  keywordDifficulty: number | null;
};

/**
 * One page of the keywords behind a type.
 *
 * Two sources, because a type means two different things either side of
 * approval: an approved type has rows actually bound to it (the truth), while
 * a proposed one has only the rows detection would bind if it were approved —
 * so the drawer re-clusters the current backlog rather than showing an empty
 * list under a type nobody has said yes to yet.
 */
async function getPageTypeInstances(input: {
  projectId: string;
  pageTypeId: string;
  page: number;
  pageSize: number;
}): Promise<{ rows: PageTypeInstanceRow[]; totalCount: number }> {
  const pageType = await PagePlanRepository.getPageTypeById(
    input.projectId,
    input.pageTypeId,
  );
  if (!pageType) throw new AppError("NOT_FOUND", "Page type not found.");
  const offset = (input.page - 1) * input.pageSize;

  if (pageType.status === "approved") {
    const [rows, totalCount] = await Promise.all([
      PagePlanRepository.getBoundKeywords(pageType.id, input.pageSize, offset),
      PagePlanRepository.countBoundKeywords(pageType.id),
    ]);
    return { rows, totalCount };
  }

  const candidate = detectCandidates(
    await loadPlannerRows(input.projectId),
  ).find((entry) => entry.name === pageType.name);
  if (!candidate) return { rows: [], totalCount: 0 };
  return {
    rows: candidate.instances
      .slice(offset, offset + input.pageSize)
      .map(({ id, keyword, searchVolume, keywordDifficulty }) => ({
        id,
        keyword,
        searchVolume,
        keywordDifficulty,
      })),
    totalCount: candidate.instances.length,
  };
}

/**
 * Approve or decline a proposed type. Approval binds the keywords: detection
 * is re-run over the current backlog rather than re-matching the stored
 * keywordPattern, because which type a keyword belongs to is decided by the
 * pattern table's precedence — re-matching one regex in isolation would let a
 * blog cluster quietly claim rows that belong to Comparisons.
 */
async function decidePageType(input: {
  projectId: string;
  pageTypeId: string;
  decision: "approved" | "declined";
}): Promise<{ boundKeywords: number }> {
  const decided = await PagePlanRepository.updateDecision({
    projectId: input.projectId,
    pageTypeId: input.pageTypeId,
    status: input.decision,
    decidedAt: new Date().toISOString(),
  });
  if (!decided) {
    const existing = await PagePlanRepository.getPageTypeById(
      input.projectId,
      input.pageTypeId,
    );
    if (!existing) throw new AppError("NOT_FOUND", "Page type not found.");
    throw new AppError("CONFLICT", `This type is already ${existing.status}.`);
  }
  if (input.decision !== "approved") return { boundKeywords: 0 };

  const candidate = detectCandidates(
    await loadPlannerRows(input.projectId),
  ).find((entry) => entry.name === decided.name);
  // The backlog moved under the approval (a recompute, a skip) and this shape
  // no longer clusters. The type stays approved with nothing bound — the next
  // recompute repairs its counts.
  if (!candidate) return { boundKeywords: 0 };

  await PagePlanRepository.bindKeywordsToPageType({
    projectId: input.projectId,
    pageTypeId: decided.id,
    keywordIds: candidate.instances.map((row) => row.id),
  });
  const boundKeywords = await PagePlanRepository.countBoundKeywords(decided.id);
  await PagePlanRepository.updatePageType(decided.id, {
    instanceCount: boundKeywords,
    demand: Math.round(candidate.demand),
  });
  return { boundKeywords };
}

export const PagePlanService = {
  startPlan,
  getPlan,
  getPageTypeInstances,
  proposeTypes,
  decidePageType,
};
