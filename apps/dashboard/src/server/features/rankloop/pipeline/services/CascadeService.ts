import { eq } from "drizzle-orm";
import { db } from "@/db";
import { projects } from "@/db/schema";
import { CompetitorDiscoveryService } from "@/server/features/rankloop/competitors/services/CompetitorDiscoveryService";
import { CompetitorsRepository } from "@/server/features/rankloop/competitors/repositories/CompetitorsRepository";
import { PagePlanService } from "@/server/features/rankloop/page-plan/services/PagePlanService";
import {
  startableStages,
  type Pipeline,
  type StageId,
} from "@/server/features/rankloop/pipeline/pipeline.logic";
import { PipelineService } from "@/server/features/rankloop/pipeline/services/PipelineService";
import { SiteStudyService } from "@/server/features/rankloop/site-study/services/SiteStudyService";
import { UniverseRunService } from "@/server/features/rankloop/universe/services/UniverseRunService";
import { AiAccessService } from "@/server/features/rankloop/verdict/services/AiAccessService";
import { NetNewProposalsService } from "@/server/features/rankloop/writing/services/NetNewProposalsService";
import { FREE_UNIVERSE_SOURCES } from "@/types/schemas/rankloopUniverse";

// The Day-0 cascade (spec 0028).
//
// One rule: start every stage that is `idle` and whose prerequisites are
// `done`. The list comes from `startableStages` over the same model the UI
// renders, so there is no second definition of "what comes next" to drift
// from the one users can see.
//
// Every start below is idempotent — each is guarded by its own partial
// unique index — so calling advance() repeatedly while stages are in flight
// returns the running run rather than stacking duplicates. That is what lets
// the spine simply poll this endpoint.

export interface CascadeContext {
  projectId: string;
  userId: string;
  userEmail: string;
  organizationId: string;
}

export interface CascadeResult {
  pipeline: Pipeline;
  /** What this call actually started, for the spine's narration. */
  started: StageId[];
  /** Stages we tried and could not start, with the reason. Surfaced rather
   *  than swallowed: a cascade that silently skips a stage looks identical
   *  to one that is still thinking about it. */
  skipped: { stage: StageId; reason: string }[];
}

/**
 * Metered work the cascade is allowed to do once, and only once.
 *
 * The repo's standing law is that metered sources never auto-run, and the
 * reason given is precise: "a schedule that quietly bills someone weekly is
 * how a tool loses trust." A one-time competitor discovery, triggered by the
 * user adding a domain and capped by the existing spend ledger, is not that
 * — but a re-discovery on every later visit would become exactly that.
 *
 * So discovery is attempted only when the project has never had a competitor
 * row. After that it is a button.
 */
async function discoveryIsFirstEver(projectId: string): Promise<boolean> {
  const existing = await CompetitorsRepository.listCompetitors(projectId);
  return existing.length === 0;
}

const STARTERS: Record<
  StageId,
  ((ctx: CascadeContext) => Promise<void>) | null
> = {
  site: async (ctx) => {
    await SiteStudyService.startStudy(ctx.projectId);
  },

  access: async (ctx) => {
    await AiAccessService.runProbe(ctx.projectId);
  },

  // Never started here. Connecting Search Console is a human act, and the
  // stage model reports it as `needs_you` precisely so the cascade routes
  // around it instead of stalling.
  memory: null,

  market: async (ctx) => {
    if (!(await discoveryIsFirstEver(ctx.projectId))) {
      throw new Error("competitors already discovered once; re-discovery is manual");
    }
    const [project] = await db
      .select({
        domain: projects.domain,
        locationCode: projects.locationCode,
        languageCode: projects.languageCode,
      })
      .from(projects)
      .where(eq(projects.id, ctx.projectId))
      .limit(1);
    if (!project?.domain) throw new Error("project has no domain");

    await CompetitorDiscoveryService.discoverCompetitors({
      projectId: ctx.projectId,
      organizationId: ctx.organizationId,
      domain: project.domain,
      locationCode: project.locationCode ?? 2840,
      languageCode: project.languageCode ?? "en",
      billingCustomer: {
        userId: ctx.userId,
        userEmail: ctx.userEmail,
        organizationId: ctx.organizationId,
        projectId: ctx.projectId,
      },
    });
  },

  keywords: async (ctx) => {
    // FREE sources only. `gap` and `expansion` bill per call and stay
    // manual-only — the dispatcher refuses them and so does this.
    await UniverseRunService.startRun({
      projectId: ctx.projectId,
      sources: [...FREE_UNIVERSE_SOURCES],
    });
  },

  plan: async (ctx) => {
    await PagePlanService.startPlan(ctx.projectId);
  },

  titles: async (ctx) => {
    await NetNewProposalsService.computeNetNewProposals(ctx.projectId);
  },

  // Publishing is never automatic from here. Where posts go is a decision,
  // and the first one going live is a decision too.
  publish: null,
};

/**
 * Start what can be started, then report the resulting state.
 *
 * A single pass, not a loop to completion: the stages it starts are
 * asynchronous, so their prerequisites do not become `done` within this
 * call. The spine polls, and each poll advances the chain one link.
 */
async function advance(ctx: CascadeContext): Promise<CascadeResult> {
  const pipeline = await PipelineService.getPipeline(ctx.projectId);
  const startable = startableStages(pipeline.stages);

  const started: StageId[] = [];
  const skipped: { stage: StageId; reason: string }[] = [];

  await Promise.all(
    startable.map(async (id) => {
      const starter = STARTERS[id];
      if (starter === null) return;
      try {
        await starter(ctx);
        started.push(id);
      } catch (error) {
        // A stage that cannot start must not take the cascade down with it.
        // A missing DataForSEO key stops competitor discovery and nothing
        // else; the site still gets crawled and the backlog still fills.
        skipped.push({
          stage: id,
          reason: error instanceof Error ? error.message : "could not start",
        });
      }
    }),
  );

  // Re-read so the caller sees the stages it just started as `running`
  // rather than the `idle` they were a moment ago.
  const after =
    started.length > 0
      ? await PipelineService.getPipeline(ctx.projectId)
      : pipeline;

  return { pipeline: after, started, skipped };
}

export const CascadeService = {
  advance,
};
