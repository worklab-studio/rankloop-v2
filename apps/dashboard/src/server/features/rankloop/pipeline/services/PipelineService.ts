import { hasSelfHostedGscConfig } from "@/server/features/gsc/oauth-config";
import { GscService } from "@/server/features/gsc/services/GscService";
import { CompetitorsService } from "@/server/features/rankloop/competitors/services/CompetitorsService";
import { GscSyncService } from "@/server/features/rankloop/gsc-sync/services/GscSyncService";
import { PagePlanService } from "@/server/features/rankloop/page-plan/services/PagePlanService";
import {
  buildPipeline,
  type Pipeline,
  type PipelineFacts,
} from "@/server/features/rankloop/pipeline/pipeline.logic";
import { ProposalsService } from "@/server/features/rankloop/proposals/services/ProposalsService";
import { PublishConnectionService } from "@/server/features/rankloop/publish/services/PublishConnectionService";
import { PublishPlanService } from "@/server/features/rankloop/publish/services/PublishPlanService";
import { SiteStudyService } from "@/server/features/rankloop/site-study/services/SiteStudyService";
import { UniverseRepository } from "@/server/features/rankloop/universe/repositories/UniverseRepository";
import { UniverseRunsRepository } from "@/server/features/rankloop/universe/repositories/UniverseRunsRepository";
import { AiAccessService } from "@/server/features/rankloop/verdict/services/AiAccessService";
import { isHostedServerAuthMode } from "@/server/lib/runtime-env";

// Gathers the facts the stage model reads (spec 0028).
//
// Everything here is a read that some screen already performs; the value is
// doing them once, together, so the spine, the gates and the cascade share
// one answer instead of three surfaces each assembling their own.
//
// Every fetch is independently failure-tolerant. A pipeline that 500s
// because one competitor query timed out would take down the only screen
// that could tell the user what is wrong.

async function safe<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    console.warn(
      `[rankloop-pipeline] ${label} unavailable:`,
      error instanceof Error ? error.message : error,
    );
    return fallback;
  }
}

async function gatherFacts(projectId: string): Promise<PipelineFacts> {
  const [
    study,
    access,
    gscConnection,
    hosted,
    selfHostedGsc,
    memory,
    competitors,
    universeRun,
    backlog,
    plan,
    proposals,
    publishConnection,
    publishedArticles,
  ] = await Promise.all([
    safe("site study", () => SiteStudyService.getStudy(projectId), null),
    safe("ai access", () => AiAccessService.getCard(projectId), null),
    safe("gsc connection", () => GscService.getConnection(projectId), null),
    safe("auth mode", () => isHostedServerAuthMode(), false),
    safe("gsc config", () => hasSelfHostedGscConfig(), false),
    safe("gsc memory", () => GscSyncService.getMemory(projectId), null),
    safe("competitors", () => CompetitorsService.getCompetitors(projectId), null),
    safe(
      "universe run",
      () => UniverseRunsRepository.getLatestRunForProject(projectId),
      null,
    ),
    safe("backlog", () => UniverseRepository.countBacklog(projectId), 0),
    safe("page plan", () => PagePlanService.getPlan(projectId), null),
    safe("proposals", () => ProposalsService.getProposals(projectId), []),
    safe(
      "publish connection",
      () => PublishConnectionService.getMaskedConnection(projectId),
      null,
    ),
    safe("published", () => PublishPlanService.getPublishedArticles(projectId), []),
  ]);

  const tracked = competitors?.tracked ?? [];
  const suggested = competitors?.suggested ?? [];
  // Titles the user has yet to answer versus ones they have. `approved` is
  // what releases the publish stage, so a pile of proposals is not progress.
  const proposedTitles = proposals.filter((p) => p.status === "proposed").length;
  const approvedTitles = proposals.filter((p) => p.status === "approved").length;

  return {
    siteStudy: {
      status: study?.lastRun?.status ?? null,
      pages: study?.inventory?.totalPages ?? 0,
      posts: study?.inventory?.kindCounts.post ?? 0,
      crawled: study?.auditProgress?.pagesCrawled ?? 0,
      total: study?.auditProgress?.pagesTotal ?? 0,
    },
    aiAccess: {
      checked: access?.state === "ready",
      blockedAgents: access?.agents.filter((a) => !a.allowed).length ?? 0,
      findings: access?.findings.length ?? 0,
    },
    gsc: {
      oauthConfigured: hosted || selfHostedGsc,
      connected: Boolean(gscConnection),
      status: memory?.lastRun?.status ?? null,
      dayCount: memory?.dayCount ?? 0,
    },
    competitors: {
      suggested: suggested.length,
      tracked: tracked.length,
      studied: tracked.filter((row) => row.lastStudiedAt !== null).length,
      running: tracked.some(
        (row) => row.studyStatus === "pending" || row.studyStatus === "running",
      ),
      anyError: tracked.some((row) => row.studyStatus === "error"),
    },
    keywords: { status: universeRun?.status ?? null, backlog },
    plan: {
      status: plan?.lastRun?.status ?? null,
      proposed: plan?.proposed.length ?? 0,
      approved: plan?.approved.length ?? 0,
    },
    titles: { proposed: proposedTitles, approved: approvedTitles },
    publish: {
      configured: Boolean(publishConnection),
      published: publishedArticles.length,
    },
  };
}

async function getPipeline(projectId: string): Promise<Pipeline> {
  return buildPipeline(await gatherFacts(projectId));
}

export const PipelineService = {
  gatherFacts,
  getPipeline,
};
