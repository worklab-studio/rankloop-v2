import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { withPgClient } from "@/db";
import {
  ArticleWriteService,
  type ArticleWriteContext,
} from "@/server/features/rankloop/writing/services/ArticleWriteService";
import { ArticleGateService } from "@/server/features/rankloop/writing/services/ArticleGateService";
import type { LawReport } from "@/server/features/rankloop/writing/gate";
import type { RepairPayload } from "@/server/features/rankloop/writing/repair.logic";
import { pgStep } from "@/server/workflows/pgStep";
import { MAX_WRITE_ATTEMPTS } from "@/shared/rankloop-writer";
import type { RankloopWriteFailure } from "@/types/schemas/rankloopWriter";

// brief -> draft -> gate -> (fix -> gate)* -> land.
//
// The shape of this file is the argument the product makes: exactly one kind
// of step spends money, the step that judges the result is a different step
// calling a different package, and the loop between them is bounded by a
// constant rather than by a model deciding it is finished.

// Reading rows and rendering a brief from them is free and idempotent, so it
// gets a small retry budget.
const FREE_STEP_CONFIG = {
  retries: { limit: 2, delay: "5 seconds" as const },
  timeout: "2 minutes" as const,
};

// Generation spends the user's key. A blind retry pays twice for a call whose
// failure is already a terminal state with a reason attached, so there is no
// retry at all — the outcome comes back as data and the workflow lands it.
const METERED_STEP_CONFIG = {
  retries: { limit: 0, delay: "1 second" as const },
  timeout: "5 minutes" as const,
};

// The gate is pure functions over a string; it fails only if the DB does.
const GATE_STEP_CONFIG = {
  retries: { limit: 2, delay: "5 seconds" as const },
  timeout: "1 minute" as const,
};

interface ArticleWriteParams {
  articleId: string;
  projectId: string;
}

/** What one attempt (generate, then grade) concluded. */
type AttemptOutcome =
  | { kind: "passed" }
  | {
      kind: "laws_unmet";
      report: LawReport;
      payload: RepairPayload;
      markdown: string;
    }
  | {
      kind: "terminal";
      failure: RankloopWriteFailure;
      report: LawReport | null;
    };

type Repair = { previousMarkdown: string; payload: RepairPayload };

export class ArticleWriteWorkflow extends WorkflowEntrypoint<
  Env,
  ArticleWriteParams
> {
  async run(event: WorkflowEvent<ArticleWriteParams>, step: WorkflowStep) {
    // Scope a per-request Postgres client for this invocation (no-op in D1
    // mode); step bodies open their own via pgStep.
    return withPgClient(() => this.runScoped(event, step));
  }

  private async runScoped(
    event: WorkflowEvent<ArticleWriteParams>,
    step: WorkflowStep,
  ) {
    try {
      await this.write(event.payload, step);
    } catch (error) {
      // Anything that threw past the steps' own retries: land the article
      // terminally before rethrowing. An article left in `briefing` holds its
      // proposal's one in-flight slot forever, so the human who wanted this
      // keyword written could never ask again.
      console.error(
        `[rankloop-writer] ${event.payload.articleId} crashed:`,
        error,
      );
      await pgStep(step, "land-crashed", FREE_STEP_CONFIG, () =>
        ArticleWriteService.fail({
          articleId: event.payload.articleId,
          failure: { reason: "internal_error", detail: errorLine(error) },
          report: null,
        }),
      );
      throw error;
    }
  }

  private async write(
    payload: ArticleWriteParams,
    step: WorkflowStep,
  ): Promise<void> {
    const { articleId, projectId } = payload;

    const context = await pgStep(step, "brief", FREE_STEP_CONFIG, () =>
      ArticleWriteService.prepare({ articleId, projectId }),
    );

    let repair: Repair | null = null;
    let lastReport: LawReport | null = null;

    for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt++) {
      const outcome = await this.attempt(step, context, attempt, repair);

      if (outcome.kind === "passed") {
        const { status } = await pgStep(step, "land", FREE_STEP_CONFIG, () =>
          ArticleWriteService.land({ context, attempts: attempt }),
        );
        console.info(
          `[rankloop-writer] ${articleId} passed on attempt ${attempt} -> ${status}`,
        );
        return;
      }

      if (outcome.kind === "terminal") {
        await this.landFailed(
          step,
          articleId,
          attempt,
          outcome.failure,
          outcome.report,
        );
        return;
      }

      lastReport = outcome.report;
      repair = { previousMarkdown: outcome.markdown, payload: outcome.payload };
    }

    // Out of attempts. The report from the last gate is kept exactly as it
    // was written: the human opening this article needs to see which laws are
    // still unmet, not a summary of them.
    const unmet = repair?.payload.violations.length ?? 0;
    await this.landFailed(
      step,
      articleId,
      MAX_WRITE_ATTEMPTS,
      {
        reason: "laws_unmet",
        detail: `${MAX_WRITE_ATTEMPTS} attempts left ${unmet} law${unmet === 1 ? "" : "s"} unmet.`,
      },
      lastReport,
    );
  }

  /**
   * Generate, then grade. Two steps, never one: a single step would let a
   * gate failure replay the generation, and a replayed generation is a second
   * charge for a draft the user already paid for.
   */
  private async attempt(
    step: WorkflowStep,
    context: ArticleWriteContext,
    attempt: number,
    repair: Repair | null,
  ): Promise<AttemptOutcome> {
    const label = repair ? `fix-${attempt}` : `draft-${attempt}`;
    const draft = await pgStep(step, label, METERED_STEP_CONFIG, () =>
      ArticleWriteService.runAttempt({ context, attempt, repair }),
    );
    if (!draft.ok) {
      return { kind: "terminal", failure: draft.failure, report: null };
    }

    const outcome = await pgStep(
      step,
      `gate-${attempt}`,
      GATE_STEP_CONFIG,
      () =>
        ArticleGateService.gate({
          projectId: context.projectId,
          articleId: context.articleId,
          markdown: draft.markdown,
        }),
    );
    if (outcome.passed) return { kind: "passed" };

    // Frontmatter the engine could not read fails every metadata law at once
    // for one upstream reason. Spending the remaining attempts arguing about
    // a title length that has no title behind it would burn the budget on a
    // symptom, so this lands terminally with the cause named.
    if (!outcome.report.frontmatterParsed) {
      return {
        kind: "terminal",
        failure: {
          reason: "unparseable_frontmatter",
          detail:
            "The draft carried no frontmatter block the engine could read, so none of the metadata laws could be graded.",
        },
        report: outcome.report,
      };
    }

    return {
      kind: "laws_unmet",
      report: outcome.report,
      payload: outcome.payload,
      markdown: draft.markdown,
    };
  }

  private async landFailed(
    step: WorkflowStep,
    articleId: string,
    attempts: number,
    failure: RankloopWriteFailure,
    report: LawReport | null,
  ): Promise<void> {
    await pgStep(step, "land-failed", FREE_STEP_CONFIG, () =>
      ArticleWriteService.fail({ articleId, attempts, failure, report }),
    );
    console.info(
      `[rankloop-writer] ${articleId} failed after ${attempts} attempt${attempts === 1 ? "" : "s"}: ${failure.reason}`,
    );
  }
}

/** One bounded line. Errors from this path can echo brief or draft text, and
 *  the detail is rendered back to the user. */
function errorLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").slice(0, 300);
}
