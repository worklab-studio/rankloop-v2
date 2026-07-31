import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { withPgClient } from "@/db";
import { CompetitorsRepository } from "@/server/features/rankloop/competitors/repositories/CompetitorsRepository";
import {
  CRAWL_BATCH_SIZE,
  crawlFeatureBatch,
  isBlockedBatch,
  studySitemap,
  type CrawledFeature,
  type SitemapStudy,
} from "@/server/features/rankloop/competitors/services/competitorCrawl";
import {
  CompetitorStudyService,
  type StudyContext,
} from "@/server/features/rankloop/competitors/services/CompetitorStudyService";
import type { SnapshotPage } from "@/server/features/rankloop/competitors/study.logic";
import { OutreachService } from "@/server/features/rankloop/outreach/services/OutreachService";
import { pgStep } from "@/server/workflows/pgStep";

// Sitemap reads, HTML fetches and the summarize write are free and idempotent
// (upserts on (competitor_id, url), a status recompute, one JSON column), so
// they get a small retry budget.
const FREE_IDEMPOTENT_STEP_CONFIG = {
  retries: { limit: 2, delay: "10 seconds" as const },
  timeout: "5 minutes" as const,
};

// The metered steps spend real money per call. A blind retry pays twice for
// the same numbers; both are non-fatal anyway, so a failure costs the study
// its metrics, not the study.
const SINGLE_ATTEMPT_STEP_CONFIG = {
  retries: { limit: 0, delay: "1 second" as const },
  timeout: "2 minutes" as const,
};

interface CompetitorStudyParams {
  runId: string;
  projectId: string;
  competitorId: string;
}

export class CompetitorStudyWorkflow extends WorkflowEntrypoint<
  Env,
  CompetitorStudyParams
> {
  async run(event: WorkflowEvent<CompetitorStudyParams>, step: WorkflowStep) {
    // Scope a per-request Postgres client for this workflow invocation (no-op in
    // D1 mode). The socket is reclaimed when the invocation ends, so there is
    // nothing to tear down here.
    return withPgClient(() => this.runScoped(event, step));
  }

  private async runScoped(
    event: WorkflowEvent<CompetitorStudyParams>,
    step: WorkflowStep,
  ) {
    const { runId, projectId, competitorId } = event.payload;

    try {
      const context = await pgStep(
        step,
        "prepare",
        FREE_IDEMPOTENT_STEP_CONFIG,
        () =>
          CompetitorStudyService.prepare({ runId, projectId, competitorId }),
      );

      // Both metered steps are best-effort: a keyless deployment (or a
      // DataForSEO subscription that doesn't cover the endpoint) loses the
      // numbers, not the study. The sitemap half below always runs.
      await pgStep(step, "metrics", SINGLE_ATTEMPT_STEP_CONFIG, async () => {
        try {
          return {
            recorded: await CompetitorStudyService.recordMetrics(context),
          };
        } catch (error) {
          console.warn(`[competitors] ${runId} metrics step failed:`, error);
          return { recorded: false };
        }
      });

      const earning = await pgStep(
        step,
        "top-pages",
        SINGLE_ATTEMPT_STEP_CONFIG,
        async () => {
          try {
            return {
              pages: await CompetitorStudyService.studyTopPages(context),
            };
          } catch (error) {
            console.warn(
              `[competitors] ${runId} top-pages step failed:`,
              error,
            );
            return { pages: [] as SnapshotPage[] };
          }
        },
      );

      const links = await pgStep(
        step,
        "referring-domains",
        SINGLE_ATTEMPT_STEP_CONFIG,
        async () => {
          try {
            return {
              domains:
                await CompetitorStudyService.studyReferringDomains(context),
            };
          } catch (error) {
            console.warn(
              `[competitors] ${runId} referring-domains step failed:`,
              error,
            );
            return { domains: 0 };
          }
        },
      );

      const sitemap = await pgStep(
        step,
        "sitemap",
        FREE_IDEMPOTENT_STEP_CONFIG,
        () =>
          studySitemap({
            domain: context.domain,
            earningUrls: earning.pages.map((page) => page.url),
          }),
      );

      const crawl = await this.crawlCohorts(step, runId, context, sitemap);

      const { pagesStudied } = await pgStep(
        step,
        "summarize",
        FREE_IDEMPOTENT_STEP_CONFIG,
        () =>
          CompetitorStudyService.summarize({
            context,
            sitemap,
            crawled: crawl.results,
            coverage: crawl.coverage,
            current: earning.pages,
          }),
      );

      // The link gap spans every tracked competitor, so it is recomputed here
      // rather than owned by any one study — whichever study finishes last
      // sees them all. Non-fatal: this study measured its competitor either
      // way. Single-attempt because the recompute reads our own referring
      // domains, and a retry inside the cache window is free but outside it
      // is not.
      await pgStep(step, "outreach", SINGLE_ATTEMPT_STEP_CONFIG, async () => {
        try {
          await OutreachService.recomputeTargets({ projectId });
        } catch (error) {
          console.warn(
            `[competitors] ${runId} outreach recompute failed:`,
            error,
          );
        }
      });

      await pgStep(step, "finish", FREE_IDEMPOTENT_STEP_CONFIG, async () => {
        await CompetitorsRepository.updateStudyRun(runId, {
          status: "done",
          coverage: crawl.coverage,
          pagesStudied,
          finishedAt: new Date().toISOString(),
        });
      });

      console.log(
        `[competitors] ${runId} completed ${context.domain} coverage=${crawl.coverage} pages=${pagesStudied} crawled=${crawl.results.length} linkDomains=${links.domains}`,
      );
    } catch (error) {
      console.error(`[competitors] ${runId} failed:`, error);
      await pgStep(
        step,
        "mark-failed",
        SINGLE_ATTEMPT_STEP_CONFIG,
        async () => {
          const run = await CompetitorsRepository.getStudyRunById(runId);
          // Don't overwrite a terminal status a concurrent cleanup wrote.
          if (!run || run.status === "done" || run.status === "error") return;
          const message =
            error instanceof Error ? error.message : "Unknown error";
          await CompetitorsRepository.updateStudyRun(runId, {
            status: "error",
            // Error text can echo crawled content — keep it one line and bounded.
            error: message.replace(/\s+/g, " ").slice(0, 500),
            finishedAt: new Date().toISOString(),
          });
        },
      );
      throw error;
    }
  }

  /**
   * Crawl the winners then the median sample, 25 fetches per step. The first
   * batch that comes back measuring nothing while being actively blocked ends
   * the crawl: a site behind a WAF will block every remaining batch too, and
   * spending twenty more minutes proving it just delays the playbook the
   * sitemap already earned.
   */
  private async crawlCohorts(
    step: WorkflowStep,
    runId: string,
    context: StudyContext,
    sitemap: SitemapStudy,
  ): Promise<{ results: CrawledFeature[]; coverage: "full" | "sitemap_only" }> {
    const plan: Array<{ url: string; cohort: "winner" | "sample" }> = [
      ...sitemap.winnerUrls.map((url) => ({ url, cohort: "winner" as const })),
      ...sitemap.sampleUrls.map((url) => ({ url, cohort: "sample" as const })),
    ];
    // Nothing crawlable (robots disallow, or an empty sitemap on a keyless
    // run) is not a block — there is simply no page-level evidence to have.
    if (plan.length === 0) return { results: [], coverage: "sitemap_only" };

    const results: CrawledFeature[] = [];
    for (let offset = 0; offset < plan.length; offset += CRAWL_BATCH_SIZE) {
      const index = offset / CRAWL_BATCH_SIZE;
      const batch = await pgStep(
        step,
        `crawl-${index}`,
        FREE_IDEMPOTENT_STEP_CONFIG,
        () =>
          crawlFeatureBatch({
            competitorId: context.competitorId,
            batch: plan.slice(offset, offset + CRAWL_BATCH_SIZE),
          }),
      );
      results.push(...batch);

      if (isBlockedBatch(batch)) {
        console.log(
          `[competitors] ${runId} ${context.domain} blocked at batch ${index} — falling back to sitemap only`,
        );
        return { results, coverage: "sitemap_only" };
      }
    }

    // Every page could be a 404 or a timeout without a single block; that is
    // still no evidence, so it reads as sitemap-only rather than a full study.
    const measured = results.some((result) => result.features !== null);
    return { results, coverage: measured ? "full" : "sitemap_only" };
  }
}
