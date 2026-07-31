import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { withPgClient } from "@/db";
import { UniverseRunsRepository } from "@/server/features/rankloop/universe/repositories/UniverseRunsRepository";
import type { AdmissionResult } from "@/server/features/rankloop/universe/services/keywordAdmission";
import { UniverseRunService } from "@/server/features/rankloop/universe/services/UniverseRunService";
import { pgStep } from "@/server/workflows/pgStep";
import {
  isMeteredUniverseSource,
  type HarvestConfig,
  type UniverseSource,
} from "@/types/schemas/rankloopUniverse";

// The free steps read public endpoints and upsert on (project_id, keyword),
// so a retry re-reads the same feeds and lands on the same rows rather than
// duplicating them. Two retries covers a suggest endpoint having a bad
// minute; ten minutes covers the harvest step's pacing (20s per subreddit,
// with one 40s backoff) plus the reading.
const FREE_IDEMPOTENT_STEP_CONFIG = {
  retries: { limit: 2, delay: "10 seconds" as const },
  timeout: "10 minutes" as const,
};

// The metered steps spend real money per call. A blind retry pays twice for
// the same keywords, and a failed source is not fatal — the run keeps what
// the other sources found and says so in its counts.
const SINGLE_ATTEMPT_STEP_CONFIG = {
  retries: { limit: 0, delay: "1 second" as const },
  timeout: "5 minutes" as const,
};

interface KeywordUniverseParams {
  runId: string;
  projectId: string;
  sources: UniverseSource[];
  harvest: HarvestConfig | null;
}

export class KeywordUniverseWorkflow extends WorkflowEntrypoint<
  Env,
  KeywordUniverseParams
> {
  async run(event: WorkflowEvent<KeywordUniverseParams>, step: WorkflowStep) {
    // Scope a per-request Postgres client for this workflow invocation (no-op
    // in D1 mode). The socket is reclaimed when the invocation ends.
    return withPgClient(() => this.runScoped(event, step));
  }

  private async runScoped(
    event: WorkflowEvent<KeywordUniverseParams>,
    step: WorkflowStep,
  ) {
    const { runId, projectId, sources, harvest } = event.payload;

    try {
      const context = await pgStep(
        step,
        "prepare",
        FREE_IDEMPOTENT_STEP_CONFIG,
        () => UniverseRunService.prepare({ runId, projectId }),
      );

      // One step per source, in the order the payload asked for. Steps are
      // independently persisted, so a run that dies mid-harvest resumes
      // without re-reading the sources that already landed — and the totals
      // below are replayed from those persisted step results, not recounted.
      let seen = 0;
      let kept = 0;
      for (const source of sources) {
        const outcome = await pgStep(
          step,
          `source-${source}`,
          isMeteredUniverseSource(source)
            ? SINGLE_ATTEMPT_STEP_CONFIG
            : FREE_IDEMPOTENT_STEP_CONFIG,
          async () => {
            try {
              return await UniverseRunService.runSource({
                context,
                source,
                harvest,
              });
            } catch (error) {
              // A source that cannot be read is a source this run has no
              // keywords from; the other four still ran. Failing the whole
              // run over one sulking endpoint would make the free half of
              // this product the unreliable half.
              console.warn(`[universe] ${runId} ${source} step failed:`, error);
              return { seen: 0, kept: 0 } satisfies AdmissionResult;
            }
          },
        );
        seen += outcome.seen;
        kept += outcome.kept;
      }

      await pgStep(step, "finish", FREE_IDEMPOTENT_STEP_CONFIG, () =>
        UniverseRunService.finish({ runId, outcome: { seen, kept } }),
      );

      console.log(
        `[universe] ${runId} completed project=${projectId} sources=${sources.join(",")} seen=${seen} kept=${kept}`,
      );
    } catch (error) {
      console.error(`[universe] ${runId} failed:`, error);
      await pgStep(
        step,
        "mark-failed",
        SINGLE_ATTEMPT_STEP_CONFIG,
        async () => {
          const run = await UniverseRunsRepository.getRunById(runId);
          // Don't overwrite a terminal status a concurrent cleanup wrote.
          if (!run || run.status === "done" || run.status === "error") return;
          const message =
            error instanceof Error ? error.message : "Unknown error";
          await UniverseRunsRepository.updateRun(runId, {
            status: "error",
            // Error text can echo feed or provider payloads — one line,
            // bounded.
            error: message.replace(/\s+/g, " ").slice(0, 500),
            finishedAt: new Date().toISOString(),
          });
        },
      );
      throw error;
    }
  }
}
