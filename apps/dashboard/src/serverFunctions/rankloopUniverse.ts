import { createServerFn } from "@tanstack/react-start";
import { waitUntil } from "cloudflare:workers";
import { CurationRepository } from "@/server/features/rankloop/universe/repositories/CurationRepository";
import { UniverseRepository } from "@/server/features/rankloop/universe/repositories/UniverseRepository";
import { UniverseRunsRepository } from "@/server/features/rankloop/universe/repositories/UniverseRunsRepository";
import { CurationService } from "@/server/features/rankloop/universe/services/CurationService";
import { RelevanceGateService } from "@/server/features/rankloop/universe/services/RelevanceGateService";
import {
  hasKeywordProvider,
  UniverseRunService,
} from "@/server/features/rankloop/universe/services/UniverseRunService";
import { captureServerEvent } from "@/server/lib/posthog";
import { requireProjectContext } from "@/serverFunctions/middleware";
import {
  getRankloopBacklogSchema,
  getRankloopGateSchema,
  getRankloopUniverseRunSchema,
  parseUniverseRunSources,
  skipRankloopKeywordsSchema,
  startRankloopUniverseSchema,
  updateRankloopGateSchema,
} from "@/types/schemas/rankloopUniverse";

/**
 * The Keywords tab's polling payload: the latest run with its seen/kept
 * counts, the harvest configuration the last harvesting run used (so the
 * Collapsible prefills instead of asking twice), and whether metered sources
 * can run at all — the buttons need a setup pitch, not a failed request.
 */
export const getRankloopUniverseRun = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(getRankloopUniverseRunSchema)
  .handler(async ({ context }) => {
    const [latestRun, lastHarvestRun, backlogCount] = await Promise.all([
      UniverseRunsRepository.getLatestRunForProject(context.projectId),
      UniverseRunsRepository.getLatestHarvestRunForProject(context.projectId),
      // The whole backlog, not the filtered table's total: the progress spine
      // reads this payload too, and its "Keywords · 312 in the backlog" row
      // must not shrink because somebody typed in a search box on the tab.
      UniverseRepository.countBacklog(context.projectId),
    ]);
    return {
      latestRun,
      sources: parseUniverseRunSources(latestRun?.sourcesJson ?? null),
      harvest:
        parseUniverseRunSources(lastHarvestRun?.sourcesJson ?? null)?.harvest ??
        null,
      backlogCount,
      hasKeywordProvider: hasKeywordProvider(),
    };
  });

// Idempotent, and the same endpoint for every source button: clicking one
// while a run is active returns that run (alreadyRunning: true) instead of
// erroring — the partial unique index on keyword_universe_runs is the
// arbiter, not a client-side disable.
export const startRankloopUniverse = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(startRankloopUniverseSchema)
  .handler(async ({ context, data }) => {
    const result = await UniverseRunService.startRun({
      projectId: context.projectId,
      sources: data.sources,
      ...(data.harvest ? { harvest: data.harvest } : {}),
    });

    if (!result.alreadyRunning) {
      waitUntil(
        captureServerEvent({
          distinctId: context.userId,
          event: "rankloop_universe:run_start",
          organizationId: context.organizationId,
          properties: {
            project_id: context.projectId,
            sources: data.sources,
          },
        }),
      );
    }
    return result;
  });

/**
 * One page of the backlog behind the Keywords table.
 *
 * The count is returned alongside the rows because the table's pager and its
 * "N in the backlog" line have to agree with the filter the user is looking
 * at — a total taken from a separate unfiltered read would claim rows the
 * table cannot show.
 */
export const getRankloopBacklog = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(getRankloopBacklogSchema)
  .handler(async ({ context, data }) => {
    const query = {
      projectId: context.projectId,
      sources: data.sources ?? null,
      search: data.search ?? null,
      page: data.page,
      pageSize: data.pageSize,
      sort: data.sort,
      order: data.order,
    };
    const [rows, totalCount, sourceCounts] = await Promise.all([
      CurationRepository.listBacklog(query),
      CurationRepository.countBacklogRows(query),
      CurationRepository.countBacklogBySource(context.projectId),
    ]);
    return { rows, totalCount, sourceCounts };
  });

/** The gate card's payload. Null means this project has never derived a
 *  gate — the card says so and offers the derive, rather than rendering an
 *  empty token list that looks like a gate admitting nothing. */
export const getRankloopGate = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(getRankloopGateSchema)
  .handler(async ({ context }) => {
    return CurationService.getGateCard(context.projectId);
  });

// Every save flips user_edited, which permanently retires the Re-derive
// button for this project. That is the point of the flag, so the tab warns
// before the first edit rather than treating it as an undoable toggle.
export const updateRankloopGate = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(updateRankloopGateSchema)
  .handler(async ({ context, data }) => {
    const result = await CurationService.editGate({
      projectId: context.projectId,
      positives: data.positives,
      negatives: data.negatives,
    });
    waitUntil(
      captureServerEvent({
        distinctId: context.userId,
        event: "rankloop_universe:gate_edit",
        organizationId: context.organizationId,
        properties: {
          project_id: context.projectId,
          positives: result.positives,
          negatives: result.negatives,
        },
      }),
    );
    return result;
  });

// Re-derive is deliberately not idempotent-by-flag here: the repository's
// UPDATE predicate refuses an edited gate, so this returns derived:false and
// the tab reports it instead of silently doing nothing.
export const rederiveRankloopGate = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(getRankloopGateSchema)
  .handler(async ({ context }) => {
    return RelevanceGateService.deriveGate(context.projectId);
  });

export const skipRankloopKeywords = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(skipRankloopKeywordsSchema)
  .handler(async ({ context, data }) => {
    const result = await CurationService.skipKeywords({
      projectId: context.projectId,
      keywordIds: data.keywordIds,
    });
    waitUntil(
      captureServerEvent({
        distinctId: context.userId,
        event: "rankloop_universe:keywords_skip",
        organizationId: context.organizationId,
        properties: { project_id: context.projectId, count: result.skipped },
      }),
    );
    return result;
  });
