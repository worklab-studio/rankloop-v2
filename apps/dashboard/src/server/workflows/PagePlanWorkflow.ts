import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { withPgClient } from "@/db";
import { ProjectRepository } from "@/server/features/projects/repositories/ProjectRepository";
import { PagePlanRepository } from "@/server/features/rankloop/page-plan/repositories/PagePlanRepository";
import {
  PagePlanService,
  type PlanCandidateEntry,
} from "@/server/features/rankloop/page-plan/services/PagePlanService";
import {
  hasSerpProvider,
  markUnsampled,
  sampleCandidate,
} from "@/server/features/rankloop/page-plan/services/planSerpSampling";
import { allocateSerpBudget } from "@/server/features/rankloop/page-plan/planner.logic";
import { pgStep } from "@/server/workflows/pgStep";

// Detection, evidence and the page_types write are free, and every write in
// them is an upsert on (project_id, name) — so a retry re-derives the same
// rows rather than duplicating them.
const FREE_IDEMPOTENT_STEP_CONFIG = {
  retries: { limit: 2, delay: "10 seconds" as const },
  timeout: "5 minutes" as const,
};

// The SERP steps spend real money per call. A blind retry pays twice for the
// same six SERPs, and a candidate that fails is not fatal — it stays proposed
// and says 'unsampled', which is the honest outcome.
const SINGLE_ATTEMPT_STEP_CONFIG = {
  retries: { limit: 0, delay: "1 second" as const },
  timeout: "2 minutes" as const,
};

interface PagePlanParams {
  runId: string;
  projectId: string;
}

export class PagePlanWorkflow extends WorkflowEntrypoint<Env, PagePlanParams> {
  async run(event: WorkflowEvent<PagePlanParams>, step: WorkflowStep) {
    // Scope a per-request Postgres client for this workflow invocation (no-op
    // in D1 mode). The socket is reclaimed when the invocation ends.
    return withPgClient(() => this.runScoped(event, step));
  }

  private async runScoped(
    event: WorkflowEvent<PagePlanParams>,
    step: WorkflowStep,
  ) {
    const { runId, projectId } = event.payload;

    try {
      const organizationId = await pgStep(
        step,
        "prepare",
        FREE_IDEMPOTENT_STEP_CONFIG,
        async () => {
          const run = await PagePlanRepository.getRunById(runId);
          if (!run || run.status === "done" || run.status === "error") {
            throw new NonRetryableError(
              `Run ${runId} is no longer active (status=${run?.status ?? "missing"})`,
            );
          }
          const project = await ProjectRepository.getProjectById(projectId);
          if (!project) {
            throw new NonRetryableError(`Project ${projectId} not found`);
          }
          await PagePlanRepository.updateRun(runId, { status: "running" });
          return project.organizationId;
        },
      );

      const { candidates, typesProposed, keywordsClustered } = await pgStep(
        step,
        "propose",
        FREE_IDEMPOTENT_STEP_CONFIG,
        () => PagePlanService.proposeTypes({ projectId }),
      );

      const spend = await this.sampleSerps(step, {
        runId,
        projectId,
        organizationId,
        candidates,
      });

      await pgStep(step, "finish", FREE_IDEMPOTENT_STEP_CONFIG, async () => {
        await PagePlanRepository.updateRun(runId, {
          status: "done",
          typesProposed,
          keywordsClustered,
          serpSampled: spend.sampled,
          costUsd: spend.costUsd,
          finishedAt: new Date().toISOString(),
        });
      });

      console.log(
        `[page-plan] ${runId} completed project=${projectId} types=${typesProposed} serps=${spend.sampled} cost=${spend.costUsd.toFixed(4)}`,
      );
    } catch (error) {
      console.error(`[page-plan] ${runId} failed:`, error);
      await pgStep(
        step,
        "mark-failed",
        SINGLE_ATTEMPT_STEP_CONFIG,
        async () => {
          const run = await PagePlanRepository.getRunById(runId);
          // Don't overwrite a terminal status a concurrent cleanup wrote.
          if (!run || run.status === "done" || run.status === "error") return;
          const message =
            error instanceof Error ? error.message : "Unknown error";
          await PagePlanRepository.updateRun(runId, {
            status: "error",
            // Error text can echo provider payloads — one line, bounded.
            error: message.replace(/\s+/g, " ").slice(0, 500),
            finishedAt: new Date().toISOString(),
          });
        },
      );
      throw error;
    }
  }

  /**
   * Spend the run's SERP budget, cheapest candidates first, one metered step
   * per candidate.
   *
   * Keyless, nothing is sampled and every type says so — detection is free
   * and still ran. A candidate whose step fails is marked unsampled rather
   * than failing the plan: six SERPs are worth a verdict, not a run.
   */
  private async sampleSerps(
    step: WorkflowStep,
    input: {
      runId: string;
      projectId: string;
      organizationId: string;
      candidates: PlanCandidateEntry[];
    },
  ): Promise<{ sampled: number; costUsd: number }> {
    if (!hasSerpProvider()) {
      await pgStep(
        step,
        "serp-skipped",
        FREE_IDEMPOTENT_STEP_CONFIG,
        async () => {
          for (const candidate of input.candidates) {
            await markUnsampled(
              candidate.pageTypeId,
              "Not sampled — no SERP provider is connected.",
            );
          }
        },
      );
      return { sampled: 0, costUsd: 0 };
    }

    const budget = allocateSerpBudget(input.candidates);
    if (budget.unsampled.length > 0) {
      await pgStep(
        step,
        "serp-budget-exhausted",
        FREE_IDEMPOTENT_STEP_CONFIG,
        async () => {
          for (const candidate of budget.unsampled) {
            await markUnsampled(
              candidate.pageTypeId,
              "Not sampled — this run's SERP budget went to the cheaper types first.",
            );
          }
        },
      );
    }

    // The system actor every scheduled rankloop job bills through: a plan run
    // has no acting user, but metering needs one.
    const billingCustomer = {
      userId: "system",
      userEmail: "system@openseo.so",
      organizationId: input.organizationId,
      projectId: input.projectId,
    };

    let sampled = 0;
    let costUsd = 0;
    for (const [index, entry] of budget.sampled.entries()) {
      const result = await pgStep(
        step,
        `serp-${index}`,
        SINGLE_ATTEMPT_STEP_CONFIG,
        async () => {
          try {
            return await sampleCandidate({
              projectId: input.projectId,
              entry,
              billingCustomer,
            });
          } catch (error) {
            console.warn(
              `[page-plan] ${input.runId} serp sample failed for ${entry.name}:`,
              error,
            );
            await markUnsampled(
              entry.pageTypeId,
              "Not sampled — the SERP provider did not answer for this type.",
            );
            return { sampled: 0, costUsd: 0 };
          }
        },
      );
      sampled += result.sampled;
      costUsd += result.costUsd;
    }
    return { sampled, costUsd };
  }
}
