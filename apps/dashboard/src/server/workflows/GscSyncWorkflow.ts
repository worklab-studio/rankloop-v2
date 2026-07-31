import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { withPgClient } from "@/db";
import { GscConnectionRepository } from "@/server/features/gsc/repositories/GscConnectionRepository";
import { GscSyncRepository } from "@/server/features/rankloop/gsc-sync/repositories/GscSyncRepository";
import {
  enumerateDates,
  GscSyncService,
} from "@/server/features/rankloop/gsc-sync/services/GscSyncService";
import { ProposalsService } from "@/server/features/rankloop/proposals/services/ProposalsService";
import { createGscClient } from "@/server/lib/gscClient";
import { pgStep } from "@/server/workflows/pgStep";

// GSC reads are unmetered and every fact write is an idempotent upsert on the
// 5-column unique, so every step gets a small free retry budget — there are
// no metered steps in this workflow.
const FREE_IDEMPOTENT_STEP_CONFIG = {
  retries: { limit: 2, delay: "10 seconds" as const },
  timeout: "5 minutes" as const,
};

const SINGLE_ATTEMPT_STEP_CONFIG = {
  retries: { limit: 0, delay: "1 second" as const },
  timeout: "2 minutes" as const,
};

interface GscSyncParams {
  runId: string;
  projectId: string;
  mode: "backfill" | "daily";
}

export class GscSyncWorkflow extends WorkflowEntrypoint<Env, GscSyncParams> {
  async run(event: WorkflowEvent<GscSyncParams>, step: WorkflowStep) {
    // Scope a per-request Postgres client for this workflow invocation (no-op in
    // D1 mode). The socket is reclaimed when the invocation ends, so there is
    // nothing to tear down here.
    return withPgClient(() => this.runScoped(event, step));
  }

  private async runScoped(
    event: WorkflowEvent<GscSyncParams>,
    step: WorkflowStep,
  ) {
    const { runId, projectId, mode } = event.payload;

    const prepared = await pgStep(
      step,
      "prepare",
      FREE_IDEMPOTENT_STEP_CONFIG,
      async () => {
        const run = await GscSyncRepository.getRunById(runId);
        if (!run || run.status === "done" || run.status === "error") {
          throw new NonRetryableError(
            `Run ${runId} is no longer active (status=${run?.status ?? "missing"})`,
          );
        }
        const connection =
          await GscConnectionRepository.getByProjectId(projectId);
        if (!connection) {
          // Disconnected between dispatch and here — the run can never make
          // progress, so record why and free the partial-index slot.
          await GscSyncRepository.updateRun(runId, {
            status: "error",
            error: "Search Console is not connected for this project",
            finishedAt: new Date().toISOString(),
          });
          return null;
        }
        await GscSyncRepository.updateRun(runId, { status: "running" });
        return {
          rangeStart: run.rangeStart,
          rangeEnd: run.rangeEnd,
          siteUrl: connection.siteUrl,
          connectedByUserId: connection.connectedByUserId,
          gscAccountId: connection.gscAccountId,
        };
      },
    );
    if (!prepared) return;

    try {
      // The range was fixed when the run row was inserted (the eager
      // watermark); recomputing here would let a delayed start silently
      // widen what this run claims to have covered.
      const dates = enumerateDates(prepared.rangeStart, prepared.rangeEnd);
      console.log(
        `[gsc-sync] ${runId} starting (mode=${mode}, ${dates.length} days ${prepared.rangeStart}..${prepared.rangeEnd})`,
      );

      let rowsWritten = 0;
      for (const [index, date] of dates.entries()) {
        const writtenBefore = rowsWritten;
        const isFinal = index === dates.length - 1;
        rowsWritten += await pgStep(
          step,
          `sync-${date}`,
          FREE_IDEMPOTENT_STEP_CONFIG,
          async () => {
            const client = createGscClient({
              userId: prepared.connectedByUserId,
              gscAccountId: prepared.gscAccountId ?? undefined,
            });
            const written = await GscSyncService.syncDay({
              projectId,
              runId,
              siteUrl: prepared.siteUrl,
              date,
              client,
            });
            // The done-flip rides in the same step as the final batch, so a
            // crash between "last write" and "mark done" can't strand a
            // finished sync in running.
            if (isFinal) {
              await GscSyncRepository.updateRun(runId, {
                status: "done",
                rowsWritten: writtenBefore + written,
                finishedAt: new Date().toISOString(),
              });
            }
            return written;
          },
        );
      }

      console.log(
        `[gsc-sync] ${runId} completed project=${projectId} mode=${mode} days=${dates.length} rows=${rowsWritten}`,
      );

      // Proposal compute rides every successful sync so the queue always
      // reflects the freshest memory. Non-fatal by design: the sync's job —
      // the memory — is already durable and marked done above, so a compute
      // failure is recorded on the run row (error text, status stays done)
      // instead of failing the run. Safe to retry: duplicate proposal
      // inserts skip on the partial unique, and the TTL sweep is idempotent.
      try {
        const computed = await pgStep(
          step,
          "compute-proposals",
          FREE_IDEMPOTENT_STEP_CONFIG,
          async () => {
            const result = await ProposalsService.computeProposals(projectId);
            return result.created;
          },
        );
        console.log(
          `[gsc-sync] ${runId} proposals computed project=${projectId} created=${computed}`,
        );
      } catch (computeError) {
        console.error(
          `[gsc-sync] ${runId} proposal compute failed:`,
          computeError,
        );
        const message =
          computeError instanceof Error
            ? computeError.message
            : "Unknown error";
        try {
          await pgStep(
            step,
            "record-compute-failure",
            SINGLE_ATTEMPT_STEP_CONFIG,
            async () => {
              await GscSyncRepository.updateRun(runId, {
                // Error text can echo vendor content — one line, bounded.
                error: `Proposal compute failed: ${message.replace(/\s+/g, " ").slice(0, 300)}`,
              });
            },
          );
        } catch {
          // Recording the failure is best-effort too — the console line
          // above already carries it, and failing here would fail the run
          // this block exists to protect.
        }
      }
    } catch (error) {
      console.error(`[gsc-sync] ${runId} failed:`, error);
      await pgStep(
        step,
        "mark-failed",
        SINGLE_ATTEMPT_STEP_CONFIG,
        async () => {
          const run = await GscSyncRepository.getRunById(runId);
          // Don't overwrite a terminal status a concurrent cleanup wrote.
          if (!run || run.status === "done" || run.status === "error") return;
          const message =
            error instanceof Error ? error.message : "Unknown error";
          await GscSyncRepository.updateRun(runId, {
            status: "error",
            // Error text can echo vendor content — keep it one line and bounded.
            error: message.replace(/\s+/g, " ").slice(0, 500),
            finishedAt: new Date().toISOString(),
          });
        },
      );
      throw error;
    }
  }
}
