import { env } from "cloudflare:workers";
import { CompetitorsRepository } from "@/server/features/rankloop/competitors/repositories/CompetitorsRepository";
import { getStaleRunReason } from "@/server/features/rankloop/staleRunProbe";
import { normalizeDomainInput } from "@/server/lib/domainUtils";
import { AppError } from "@/server/lib/errors";
import {
  parseCompetitorPlaybook,
  type CompetitorRow,
  type RankloopCompetitorDetail,
  type RankloopCompetitors,
} from "@/types/schemas/rankloopCompetitors";

type StudyStartResult = {
  runId: string;
  alreadyRunning: boolean;
};

// ---------------------------------------------------------------------------
// Run lifecycle
// ---------------------------------------------------------------------------

/**
 * Start a study for one competitor, or return the study already in flight.
 * Coordination mirrors site-study: workflow instance id === run row id, and
 * the partial unique on competitor_study_runs(competitor_id) WHERE status IN
 * ('pending','running') is the only lock — a blocked INSERT means a study is
 * underway, which callers treat as success. A blocker whose workflow instance
 * is dead (deploy reset, create-then-crash) is flipped to error and the start
 * retried, so one corpse can't wedge a competitor forever.
 */
async function startStudy(input: {
  projectId: string;
  competitorId: string;
}): Promise<StudyStartResult> {
  // At most two attempts: the retry only fires after clearing a stale
  // blocker, or when the blocking run finished between INSERT and SELECT.
  for (let attempt = 0; attempt < 2; attempt++) {
    const runId = crypto.randomUUID();
    const inserted = await CompetitorsRepository.tryCreateStudyRun({
      id: runId,
      projectId: input.projectId,
      competitorId: input.competitorId,
    });

    if (!inserted) {
      const active = await CompetitorsRepository.getActiveStudyRunForCompetitor(
        input.competitorId,
      );
      if (!active) continue;
      if (attempt === 0) {
        const staleReason = await getStaleRunReason({
          workflow: env.COMPETITOR_STUDY_WORKFLOW,
          runId: active.id,
          ageMs: Date.now() - new Date(active.startedAt).getTime(),
        });
        if (staleReason) {
          await CompetitorsRepository.updateStudyRun(active.id, {
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
      await env.COMPETITOR_STUDY_WORKFLOW.create({
        id: runId,
        params: { runId, ...input },
      });
    } catch (error) {
      // Workflow couldn't start — flip the run to error so the partial-index
      // slot is released. Best-effort cleanup of any zombie instance.
      await CompetitorsRepository.updateStudyRun(runId, {
        status: "error",
        error: "Failed to start competitor study workflow",
        finishedAt: new Date().toISOString(),
      });
      try {
        const instance = await env.COMPETITOR_STUDY_WORKFLOW.get(runId);
        await instance.terminate();
      } catch {
        // Workflow may not have been created.
      }
      throw error;
    }
    return { runId, alreadyRunning: false };
  }

  throw new AppError(
    "CONFLICT",
    "Could not start the competitor study. Try again.",
  );
}

// ---------------------------------------------------------------------------
// Tracking decisions
// ---------------------------------------------------------------------------

/**
 * Add a competitor by hand — the path that works with no API key at all.
 * A domain already suggested (or previously skipped) is promoted in place
 * rather than duplicated: the unique on (project_id, domain) makes a second
 * row impossible anyway, and reusing the row keeps whatever discovery
 * measured about it.
 */
async function addCompetitor(input: {
  projectId: string;
  domain: string;
}): Promise<{ competitorId: string; runId: string }> {
  const domain = normalizeDomainInput(input.domain, false);

  const existing = await CompetitorsRepository.getCompetitorByDomain(
    input.projectId,
    domain,
  );
  let competitorId: string;
  if (existing) {
    competitorId = existing.id;
    if (existing.status !== "tracked") {
      await CompetitorsRepository.updateCompetitor(existing.id, {
        status: "tracked",
      });
    }
  } else {
    competitorId = crypto.randomUUID();
    await CompetitorsRepository.createTrackedCompetitor({
      id: competitorId,
      projectId: input.projectId,
      domain,
      discoveredVia: "manual",
    });
  }

  const study = await startStudy({ projectId: input.projectId, competitorId });
  return { competitorId, runId: study.runId };
}

/**
 * "Track" / "Skip" on a suggested row. Tracking kicks the study immediately —
 * the decision and the work are one action, so the row never sits tracked but
 * unstudied. Skipping is terminal enough that discovery leaves the row alone
 * from then on.
 */
async function decide(input: {
  projectId: string;
  competitorId: string;
  decision: "tracked" | "skipped";
}): Promise<{ runId: string | null }> {
  const competitor = await CompetitorsRepository.getCompetitorById(
    input.competitorId,
    input.projectId,
  );
  if (!competitor) {
    throw new AppError("NOT_FOUND", "Competitor not found");
  }

  await CompetitorsRepository.updateCompetitor(competitor.id, {
    status: input.decision,
  });
  if (input.decision !== "tracked") return { runId: null };

  const study = await startStudy({
    projectId: input.projectId,
    competitorId: competitor.id,
  });
  return { runId: study.runId };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** The Competitors tab payload: tracked rows with their live study state,
 *  suggested rows still awaiting a decision. Skipped rows are gone from the
 *  UI by design — skipping is the user saying "stop showing me this". */
async function getCompetitors(projectId: string): Promise<RankloopCompetitors> {
  const [rows, runs] = await Promise.all([
    CompetitorsRepository.listCompetitors(projectId),
    CompetitorsRepository.getLatestStudyRunsForProject(projectId),
  ]);

  // Runs arrive newest first, so the first sighting of a competitor id is its
  // latest run — one query instead of one per competitor.
  const latestRun = new Map<string, (typeof runs)[number]>();
  for (const run of runs) {
    if (!latestRun.has(run.competitorId)) latestRun.set(run.competitorId, run);
  }

  const decorate = (row: (typeof rows)[number]): CompetitorRow => {
    const run = latestRun.get(row.id);
    return {
      ...row,
      pagesStudied: run?.pagesStudied ?? null,
      studyStatus: run?.status ?? null,
      overlapKeywords: row.status === "suggested" ? row.organicKeywords : null,
    };
  };

  return {
    tracked: rows.filter((row) => row.status === "tracked").map(decorate),
    suggested: rows.filter((row) => row.status === "suggested").map(decorate),
  };
}

/**
 * The detail drill-in. Null — not a NOT_FOUND — for a competitor that isn't
 * there: the drill-in is a bookmarkable URL and a deleted competitor should
 * read as "no longer tracked", not as a broken page.
 *
 * `playbook` is null whenever the stored JSON is missing or no longer parses,
 * so an older summary shape degrades to "nothing studied yet".
 */
async function getCompetitor(input: {
  projectId: string;
  competitorId: string;
}): Promise<RankloopCompetitorDetail | null> {
  const competitor = await CompetitorsRepository.getCompetitorById(
    input.competitorId,
    input.projectId,
  );
  if (!competitor) return null;

  const [pages, lastRun] = await Promise.all([
    CompetitorsRepository.getCompetitorPages(competitor.id),
    CompetitorsRepository.getLatestStudyRunForCompetitor(competitor.id),
  ]);

  return {
    competitor: { ...competitor, studyStatus: lastRun?.status ?? null },
    playbook: parseCompetitorPlaybook(competitor.studySummaryJson),
    // Split here rather than in two queries: the page set is capped at ~100
    // rows, and the detail needs both halves on every render anyway.
    topPages: pages.filter((page) => page.status === "active"),
    decayedPages: pages.filter((page) => page.status !== "active"),
  };
}

export const CompetitorsService = {
  startStudy,
  addCompetitor,
  decide,
  getCompetitors,
  getCompetitor,
};
