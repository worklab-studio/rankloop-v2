import { env } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { ProjectRepository } from "@/server/features/projects/repositories/ProjectRepository";
import { CompetitorsRepository } from "@/server/features/rankloop/competitors/repositories/CompetitorsRepository";
import { getStaleRunReason } from "@/server/features/rankloop/staleRunProbe";
import { UniverseRunsRepository } from "@/server/features/rankloop/universe/repositories/UniverseRunsRepository";
import { RelevanceGateService } from "@/server/features/rankloop/universe/services/RelevanceGateService";
import { admitAndStore } from "@/server/features/rankloop/universe/services/keywordAdmission";
import type {
  AdmissionResult,
  UniverseCandidate,
} from "@/server/features/rankloop/universe/services/keywordAdmission";
import { collectUnservedCandidates } from "@/server/features/rankloop/universe/services/unservedQueries";
import {
  AUTOCOMPLETE_SEED_LIMIT,
  expandWithAutocomplete,
} from "@/server/features/rankloop/universe/sources/autocomplete";
import { collectCompetitorGap } from "@/server/features/rankloop/universe/sources/competitorGap";
import { harvestQuestions } from "@/server/features/rankloop/universe/sources/harvest";
import {
  EXPANSION_SEED_LIMIT,
  expandSeeds,
} from "@/server/features/rankloop/universe/sources/seedExpansion";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import { AppError } from "@/server/lib/errors";
import {
  hasHarvestSources,
  isMeteredUniverseSource,
  type HarvestConfig,
  type UniverseSource,
} from "@/types/schemas/rankloopUniverse";

// Dispatch and the per-source steps. Everything here produces candidates and
// hands them to one shared admit path — the gate, the classifier, the scorer
// and the (project_id, keyword) upsert live there, so no source in this file
// can write a row that skipped the gate, and the seen/kept pair the run
// reports is counted in exactly one place.

type UniverseContext = {
  projectId: string;
  organizationId: string;
  /** Null on a project that never told us its domain — the gap source needs
   *  a "we" to be absent from, so it skips rather than guessing. */
  siteDomain: string | null;
  locationCode: number;
  languageCode: string;
};

/** The system actor every scheduled rankloop job bills through: a universe
 *  run has no acting user, but metering needs one. */
function systemBillingCustomer(
  context: UniverseContext,
): BillingCustomerContext {
  return {
    userId: "system",
    userEmail: "system@openseo.so",
    organizationId: context.organizationId,
    projectId: context.projectId,
  };
}

export function hasKeywordProvider(): boolean {
  return Boolean(env.DATAFORSEO_API_KEY?.trim());
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

type UniverseStartResult = { runId: string; alreadyRunning: boolean };

/**
 * Start a universe run, or return the one that's already active.
 *
 * Coordination mirrors every other rankloop run: workflow instance id === run
 * row id, and the partial unique on keyword_universe_runs(project_id) WHERE
 * status IN ('pending','running') is the only lock — a blocked INSERT means a
 * run is underway, which callers treat as success. A blocker whose workflow
 * instance is missing or terminally failed (past the startup grace) is a
 * zombie: it flips to error and the retry claims the freed slot.
 */
async function startRun(input: {
  projectId: string;
  sources: UniverseSource[];
  harvest?: HarvestConfig;
}): Promise<UniverseStartResult> {
  if (input.sources.some(isMeteredUniverseSource) && !hasKeywordProvider()) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Add a DataForSEO key to find competitor gaps or expand seeds.",
    );
  }
  if (
    input.sources.includes("harvest") &&
    !hasHarvestSources(input.harvest ?? null)
  ) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Add a StackExchange site with tags, or a subreddit, before harvesting questions.",
    );
  }

  const sourcesJson = JSON.stringify({
    sources: input.sources,
    ...(input.harvest ? { harvest: input.harvest } : {}),
  });

  // At most two attempts: the retry fires when the blocking run finished
  // between our INSERT and the follow-up SELECT, or after a stale blocker was
  // flipped to error below.
  for (let attempt = 0; attempt < 2; attempt++) {
    const runId = crypto.randomUUID();
    const inserted = await UniverseRunsRepository.tryCreateRun({
      id: runId,
      projectId: input.projectId,
      sourcesJson,
    });

    if (!inserted) {
      const active = await UniverseRunsRepository.getActiveRunForProject(
        input.projectId,
      );
      if (!active) continue;
      if (attempt === 0) {
        const staleReason = await getStaleRunReason({
          workflow: env.KEYWORD_UNIVERSE_WORKFLOW,
          runId: active.id,
          ageMs: Date.now() - new Date(active.startedAt).getTime(),
        });
        if (staleReason) {
          await UniverseRunsRepository.updateRun(active.id, {
            status: "error",
            error: staleReason,
            finishedAt: new Date().toISOString(),
          });
          continue;
        }
      }
      return { runId: active.id, alreadyRunning: true };
    }

    try {
      await env.KEYWORD_UNIVERSE_WORKFLOW.create({
        id: runId,
        params: {
          runId,
          projectId: input.projectId,
          sources: input.sources,
          harvest: input.harvest ?? null,
        },
      });
    } catch (error) {
      // Workflow couldn't start — flip the run to error so the partial-index
      // slot is released. Best-effort cleanup of any zombie instance.
      await UniverseRunsRepository.updateRun(runId, {
        status: "error",
        error: "Failed to start keyword universe workflow",
        finishedAt: new Date().toISOString(),
      });
      try {
        const instance = await env.KEYWORD_UNIVERSE_WORKFLOW.get(runId);
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
    "Could not start the keyword sync. Try again.",
  );
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/**
 * Flip the run to running, refresh the difficulty ceiling, and gather what
 * every source step needs.
 *
 * The ceiling is recomputed here rather than after the sources on purpose: it
 * is a fact about what the site already ranks for, which no candidate this run
 * admits can change, and computing it up front is what makes the +5-per-run
 * clamp mean "at most five points a week" for a project on the weekly block.
 */
async function prepare(input: {
  runId: string;
  projectId: string;
}): Promise<UniverseContext> {
  const run = await UniverseRunsRepository.getRunById(input.runId);
  if (!run || run.status === "done" || run.status === "error") {
    throw new NonRetryableError(
      `Run ${input.runId} is no longer active (status=${run?.status ?? "missing"})`,
    );
  }
  const project = await ProjectRepository.getProjectById(input.projectId);
  if (!project) {
    throw new NonRetryableError(`Project ${input.projectId} not found`);
  }

  await UniverseRunsRepository.updateRun(input.runId, { status: "running" });
  await RelevanceGateService.refreshKdCeiling(input.projectId);

  return {
    projectId: input.projectId,
    organizationId: project.organizationId,
    siteDomain: project.domain,
    locationCode: project.locationCode,
    languageCode: project.languageCode,
  };
}

/**
 * Run one source and admit whatever it found.
 *
 * Every branch returns candidates and nothing else — `admitAndStore` is the
 * only writer in this file, so "no source can write a row that fails the gate"
 * is a property of this function's shape rather than of five separate good
 * intentions. That one call owns the gate, the classifier, the scorer, the
 * volume imputation (`vol = max(volume ?? 0, impr28)`) and the
 * (project_id, keyword) upsert; the seen/kept pair it returns is the run's
 * whole honesty, counted where the rejections happen and nowhere else.
 */
async function runSource(input: {
  context: UniverseContext;
  source: UniverseSource;
  harvest: HarvestConfig | null;
}): Promise<AdmissionResult> {
  const candidates = await collectCandidates(input);
  if (candidates.length === 0) return { seen: 0, kept: 0 };
  return admitAndStore({
    projectId: input.context.projectId,
    candidates,
  });
}

async function collectCandidates(input: {
  context: UniverseContext;
  source: UniverseSource;
  harvest: HarvestConfig | null;
}): Promise<UniverseCandidate[]> {
  const { context } = input;
  switch (input.source) {
    case "gsc":
      return collectUnservedCandidates(context.projectId);

    case "gap": {
      if (!hasKeywordProvider() || !context.siteDomain) {
        console.info(
          `[universe] gap skipped for ${context.projectId} — ${context.siteDomain ? "no DataForSEO key" : "project has no domain"}`,
        );
        return [];
      }
      const tracked = (
        await CompetitorsRepository.listCompetitors(context.projectId)
      ).filter((competitor) => competitor.status === "tracked");
      if (tracked.length === 0) return [];
      return collectCompetitorGap({
        siteDomain: context.siteDomain,
        competitorDomains: tracked.map((competitor) => competitor.domain),
        locationCode: context.locationCode,
        languageCode: context.languageCode,
        billingCustomer: systemBillingCustomer(context),
      });
    }

    case "expansion": {
      if (!hasKeywordProvider()) {
        console.info(
          `[universe] expansion skipped for ${context.projectId} — no DataForSEO key`,
        );
        return [];
      }
      const seeds = await UniverseRunsRepository.getSeedKeywords(
        context.projectId,
        EXPANSION_SEED_LIMIT,
      );
      if (seeds.length === 0) return [];
      return expandSeeds({
        seeds,
        locationCode: context.locationCode,
        languageCode: context.languageCode,
        billingCustomer: systemBillingCustomer(context),
      });
    }

    case "autocomplete": {
      const seeds = await UniverseRunsRepository.getSeedKeywords(
        context.projectId,
        AUTOCOMPLETE_SEED_LIMIT,
      );
      if (seeds.length === 0) return [];
      return expandWithAutocomplete({
        seeds,
        languageCode: context.languageCode,
      });
    }

    case "harvest":
      // Nothing configured is not a failure — it is a project that hasn't
      // told us where to read questions from, and the dispatcher already
      // refuses a manual harvest without a config.
      return input.harvest && hasHarvestSources(input.harvest)
        ? harvestQuestions(input.harvest)
        : [];
  }
}

/** Settle the run. seen/kept are summed across steps rather than queried back
 *  out of keyword_backlog — rejected candidates are counted and written
 *  nowhere, which is the whole point of reporting both numbers. */
async function finish(input: {
  runId: string;
  outcome: AdmissionResult;
}): Promise<void> {
  await UniverseRunsRepository.updateRun(input.runId, {
    status: "done",
    seenCount: input.outcome.seen,
    keptCount: input.outcome.kept,
    finishedAt: new Date().toISOString(),
  });
}

export const UniverseRunService = {
  startRun,
  prepare,
  runSource,
  finish,
};
