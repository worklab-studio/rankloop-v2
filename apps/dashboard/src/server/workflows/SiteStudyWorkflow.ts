import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { withPgClient } from "@/db";
import { AuditService } from "@/server/features/audit/services/AuditService";
import { ProjectRepository } from "@/server/features/projects/repositories/ProjectRepository";
import { SiteStudyRepository } from "@/server/features/rankloop/site-study/repositories/SiteStudyRepository";
import { SiteStudyService } from "@/server/features/rankloop/site-study/services/SiteStudyService";
import { parseAuditConfig } from "@/server/lib/audit/types";
import { pgStep } from "@/server/workflows/pgStep";

// Reads and derive upserts are free and idempotent (upsert on (projectId,
// url), marker-scoped delete), so they get a small retry budget.
const FREE_IDEMPOTENT_STEP_CONFIG = {
  retries: { limit: 2, delay: "10 seconds" as const },
  timeout: "5 minutes" as const,
};

// Starting an audit spends crawl compute and creates a run row — a blind
// retry would start a second crawl. Single attempt; a failed start fails the
// study and the next study simply tries again.
const SINGLE_ATTEMPT_STEP_CONFIG = {
  retries: { limit: 0, delay: "1 second" as const },
  timeout: "2 minutes" as const,
};

// A completed audit this recent is reused instead of re-crawling: content
// inventories don't move meaningfully inside a week, and the weekly re-study
// cadence in the scheduler matches this window on purpose.
const AUDIT_FRESH_MS = 7 * 24 * 60 * 60 * 1000;

// Poll the ensured audit every 30 seconds, give up after 30 minutes (60
// polls) — a healthy crawl finishes well inside that; past it the audit is
// wedged and the study errors rather than sleeping forever.
const AUDIT_POLL_INTERVAL = "30 seconds";
const MAX_AUDIT_POLLS = 60;

interface SiteStudyParams {
  runId: string;
  projectId: string;
}

export class SiteStudyWorkflow extends WorkflowEntrypoint<
  Env,
  SiteStudyParams
> {
  async run(event: WorkflowEvent<SiteStudyParams>, step: WorkflowStep) {
    // Scope a per-request Postgres client for this workflow invocation (no-op in
    // D1 mode). The socket is reclaimed when the invocation ends, so there is
    // nothing to tear down here.
    return withPgClient(() => this.runScoped(event, step));
  }

  private async runScoped(
    event: WorkflowEvent<SiteStudyParams>,
    step: WorkflowStep,
  ) {
    const { runId, projectId } = event.payload;

    try {
      await pgStep(step, "prepare", FREE_IDEMPOTENT_STEP_CONFIG, async () => {
        const run = await SiteStudyRepository.getRunById(runId);
        if (!run || run.status === "done" || run.status === "error") {
          throw new NonRetryableError(
            `Run ${runId} is no longer active (status=${run?.status ?? "missing"})`,
          );
        }
        await SiteStudyRepository.updateRun(runId, { status: "running" });
      });

      const audit = await this.ensureAudit(step, runId, projectId);
      const completedAt = audit.completedAt
        ? audit.completedAt
        : await this.awaitAuditCompletion(step, projectId, audit.auditId);

      const pagesDerived = await pgStep(
        step,
        "derive",
        FREE_IDEMPOTENT_STEP_CONFIG,
        () =>
          SiteStudyService.deriveFromAudit({
            projectId,
            auditId: audit.auditId,
            crawlMark: completedAt,
          }),
      );

      await pgStep(step, "finish", FREE_IDEMPOTENT_STEP_CONFIG, async () => {
        await SiteStudyRepository.updateRun(runId, {
          status: "done",
          auditRunId: audit.auditId,
          pagesDerived,
          finishedAt: new Date().toISOString(),
        });
      });

      console.log(
        `[site-study] ${runId} completed project=${projectId} audit=${audit.auditId} pages=${pagesDerived}`,
      );
    } catch (error) {
      console.error(`[site-study] ${runId} failed:`, error);
      await pgStep(
        step,
        "mark-failed",
        SINGLE_ATTEMPT_STEP_CONFIG,
        async () => {
          const run = await SiteStudyRepository.getRunById(runId);
          // Don't overwrite a terminal status a concurrent cleanup wrote.
          if (!run || run.status === "done" || run.status === "error") return;
          const message =
            error instanceof Error ? error.message : "Unknown error";
          await SiteStudyRepository.updateRun(runId, {
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
   * Reuse a completed audit ≤7 days old, or start a fresh one through the
   * audit feature's own service (its capacity/billing gates apply — the
   * study never gets a side door around them). Returns the audit to derive
   * from; completedAt is null when the audit was just started and must be
   * polled.
   */
  private async ensureAudit(
    step: WorkflowStep,
    runId: string,
    projectId: string,
  ): Promise<{ auditId: string; completedAt: string | null }> {
    return pgStep(
      step,
      "ensure-audit",
      SINGLE_ATTEMPT_STEP_CONFIG,
      async () => {
        const latest =
          await SiteStudyRepository.getLatestCompletedAuditForProject(
            projectId,
          );
        if (
          latest?.completedAt &&
          Date.now() - new Date(latest.completedAt).getTime() < AUDIT_FRESH_MS
        ) {
          return { auditId: latest.id, completedAt: latest.completedAt };
        }

        const project = await ProjectRepository.getProjectById(projectId);
        if (!project) {
          throw new NonRetryableError(`Project ${projectId} not found`);
        }
        // Prefer the last audited start URL — a re-study should walk the
        // same ground — and fall back to the project domain for first runs.
        const startUrl =
          latest?.startUrl ??
          (project.domain ? `https://${project.domain}` : null);
        if (!startUrl) {
          throw new NonRetryableError(
            "Project has no domain to study — run a site audit first",
          );
        }

        // The synthetic system actor, same as the scheduled rank checks: the
        // study has no acting user, but audits require one for billing and
        // attribution.
        const limitTier = await AuditService.resolveAuditLimitTier(
          project.organizationId,
        );
        const { auditId } = await AuditService.startAudit({
          actorUserId: "system",
          billingCustomer: {
            userId: "system",
            userEmail: "system@openseo.so",
            organizationId: project.organizationId,
            projectId,
          },
          projectId,
          startUrl,
          // Re-crawl at the size the user last chose; undefined falls back
          // to the audit default for never-audited projects.
          maxPages: latest
            ? parseAuditConfig(latest.config)?.maxPages
            : undefined,
          // The study only needs crawl data — Lighthouse would burn ~20
          // metered checks per run for numbers the derive never reads.
          lighthouseStrategy: "none",
          limitTier,
        });
        console.log(
          `[site-study] ${runId} started audit ${auditId} for project ${projectId}`,
        );
        return { auditId, completedAt: null };
      },
    );
  }

  /** Sleep-poll the audit to completion. Returns its completedAt, which the
   *  derive uses as the lastCrawledAt marker. */
  private async awaitAuditCompletion(
    step: WorkflowStep,
    projectId: string,
    auditId: string,
  ): Promise<string> {
    for (let round = 0; round < MAX_AUDIT_POLLS; round++) {
      // getStatus also runs the audit feature's self-heal, so a crawl whose
      // workflow died flips to failed here instead of pinning us to the
      // 30-minute ceiling.
      const status = await pgStep(
        step,
        `check-audit-${round}`,
        FREE_IDEMPOTENT_STEP_CONFIG,
        async () => {
          const audit = await AuditService.getStatus(auditId, projectId);
          return { status: audit.status, completedAt: audit.completedAt };
        },
      );
      if (status.status === "completed") {
        return status.completedAt ?? new Date().toISOString();
      }
      if (status.status === "failed") {
        throw new NonRetryableError(`Audit ${auditId} failed`);
      }
      await step.sleep(`wait-audit-${round}`, AUDIT_POLL_INTERVAL);
    }
    throw new NonRetryableError(
      `Audit ${auditId} did not complete within 30 minutes`,
    );
  }
}
