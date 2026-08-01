import { env } from "cloudflare:workers";
import { mergeContractLaws } from "@/server/features/rankloop/writing/brief";
import {
  hasWriterProvider,
  runWriterCall,
  type DraftContract,
  type WriterOperation,
} from "@/server/features/rankloop/writing/draft";
import type { RepairPayload } from "@/server/features/rankloop/writing/repair.logic";
import { ArticleRepository } from "@/server/features/rankloop/writing/repositories/ArticleRepository";
import { BriefService } from "@/server/features/rankloop/writing/services/BriefService";
import { PagePlanRepository } from "@/server/features/rankloop/page-plan/repositories/PagePlanRepository";
import { ProjectRepository } from "@/server/features/projects/repositories/ProjectRepository";
import { ProposalsRepository } from "@/server/features/rankloop/proposals/repositories/ProposalsRepository";
import { getStaleRunReason } from "@/server/features/rankloop/staleRunProbe";
import { WriterSettingsRepository } from "@/server/features/rankloop/writing/repositories/WriterSettingsRepository";
import {
  checkUsageCreditsDepleted,
  trackUsageCreditSpend,
} from "@/server/billing/subscription";
import { AppError } from "@/server/lib/errors";
import { isHostedServerAuthMode } from "@/server/lib/runtime-env";
import { landingStatus, type TrustDial } from "@/shared/rankloop-writer";
import { WRITER_SETTINGS_DEFAULTS } from "@/shared/rankloop-writing";
import { parseTemplateContract } from "@/types/schemas/rankloopPagePlan";
import type {
  RankloopLawReport,
  RankloopWriteFailure,
} from "@/types/schemas/rankloopWriter";

// The writer's lifecycle: claim an article, freeze its brief, spend one call
// per attempt, land it. The gate is deliberately not in this file — grading
// lives in ArticleGateService, which reaches @rankloop/engine and nothing
// else. Keeping the two apart is what makes "the grader is never the author"
// a property of the import graph rather than a promise in a comment.

/**
 * Everything a draft attempt needs, resolved once and carried through the
 * workflow.
 *
 * Frozen on purpose: the brief, the laws and the date are read in `prepare`
 * and never re-read. A SERP refresh or a page-type edit landing mid-article
 * would otherwise produce a law report that cannot be explained by the
 * document the writer was actually handed.
 */
export type ArticleWriteContext = {
  articleId: string;
  projectId: string;
  /** Who the generation is billed to. Resolved once in `prepare`, where the
   *  project is already loaded, rather than re-read per attempt: it rides the
   *  frozen context the same way the brief does. */
  organizationId: string;
  briefMd: string;
  modelOverride: string | null;
  trustDial: TrustDial;
  contract: DraftContract;
};

type DraftAttemptResult =
  | { ok: true; markdown: string }
  | { ok: false; failure: RankloopWriteFailure };

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

type StartResult = { articleId: string; alreadyWriting: boolean };

/**
 * Put an approved net-new proposal in front of the writer.
 *
 * Refuses without a key rather than creating a row that can only fail: a
 * half-written article in the Failed tab is a worse answer to "you have not
 * configured a provider" than not starting. The one-in-flight rule is the
 * partial unique on `articles`, so a second click lands on the article the
 * first one created instead of racing it.
 */
async function startArticle(input: {
  projectId: string;
  proposalId: string;
}): Promise<StartResult> {
  if (!(await hasWriterProvider())) {
    throw new AppError(
      "WRITER_NOT_CONFIGURED",
      "Add OPENROUTER_API_KEY to your deployment before OpenSEO can write drafts.",
    );
  }

  const proposal = await ProposalsRepository.getProposalById(
    input.projectId,
    input.proposalId,
  );
  if (!proposal) throw new AppError("NOT_FOUND", "Proposal not found.");
  if (proposal.track !== "net_new" || proposal.type !== "write_new") {
    throw new AppError(
      "VALIDATION_ERROR",
      "Only net-new proposals are written by the writer.",
    );
  }
  if (proposal.status !== "approved") {
    throw new AppError(
      "VALIDATION_ERROR",
      "Approve this proposal before writing it.",
    );
  }
  if (!proposal.keywordBacklogId || !proposal.pageTypeId) {
    throw new AppError(
      "VALIDATION_ERROR",
      "This proposal has no keyword or page type to write from.",
    );
  }

  // The preflight every other paid path already runs, in the one place that
  // covers both entry points: the Write button gets the error code the client
  // already renders, and the unattended run's writePhase logs the refusal by
  // name. Checked before the claim so a broke organization never gets an
  // article row that could only ever fail.
  await assertHostedCreditsAvailable(input.projectId);

  // At most two attempts: the retry only fires after a dead blocker has been
  // landed, which is the same shape CompetitorsService.startStudy uses.
  for (let attempt = 0; attempt < 2; attempt++) {
    const articleId = crypto.randomUUID();
    const claimed = await ArticleRepository.tryCreateArticle({
      id: articleId,
      projectId: input.projectId,
      proposalId: input.proposalId,
      pageTypeId: proposal.pageTypeId,
      keyword: proposal.target,
      // 'api' is the whole point of this path: this app makes the calls, so
      // every one of them is metered into llm_spend against this row.
      writerMode: "api",
      status: "briefing",
    });

    if (!claimed) {
      const active = await ArticleRepository.getActiveArticleForProposal(
        input.projectId,
        input.proposalId,
      );
      if (!active) {
        throw new AppError(
          "CONFLICT",
          "Could not start the writer. Try again.",
        );
      }
      if (attempt === 0 && (await healDeadWriterRun(active))) continue;
      return { articleId: active.id, alreadyWriting: true };
    }

    try {
      await env.ARTICLE_WRITE_WORKFLOW.create({
        id: articleId,
        params: { articleId, projectId: input.projectId },
      });
    } catch (error) {
      // Free the in-flight slot: an article stuck in 'briefing' behind a
      // workflow that never started would block every retry of this proposal.
      await ArticleRepository.updateArticle(articleId, {
        status: "failed",
        lawReportJson: JSON.stringify(
          failureReport({
            reason: "provider_error",
            detail: "The writer workflow could not be started.",
          }),
        ),
      });
      throw error;
    }

    return { articleId, alreadyWriting: false };
  }

  throw new AppError("CONFLICT", "Could not start the writer. Try again.");
}

/** The four statuses a live ARTICLE_WRITE_WORKFLOW owns. The other three
 *  non-terminal ones outlive it on purpose — review and approved are waiting
 *  for a human behind a *completed* instance, and publishing belongs to a
 *  different binding — so probing those would call a paid-for draft stale. */
const WORKFLOW_OWNED_STATUSES = new Set([
  "briefing",
  "writing",
  "gate",
  "fixing",
]);

/**
 * Land a blocker whose workflow is dead, so the partial unique lets the next
 * claim through. Returns whether anything was freed.
 *
 * Every other rankloop lock probes before conceding; this one could not,
 * because `articles` is not a run table — four of its statuses legitimately
 * outlive the workflow, and agent-mode rows carry an id no workflow ever saw.
 * Both mitigations `startArticle` already has share one failure mode: the
 * brief step and the crash landing use the same retry budget, so a ~25-second
 * database outage exhausts both and leaves an article in `briefing` behind an
 * errored instance that nothing — no button, no sweep — can clear.
 */
async function healDeadWriterRun(active: {
  id: string;
  status: string;
  writerMode: string;
  createdAt: string;
}): Promise<boolean> {
  if (active.writerMode !== "api") return false;
  if (!WORKFLOW_OWNED_STATUSES.has(active.status)) return false;

  const staleReason = await getStaleRunReason({
    workflow: env.ARTICLE_WRITE_WORKFLOW,
    runId: active.id,
    ageMs: Date.now() - new Date(active.createdAt).getTime(),
  });
  if (!staleReason) return false;

  console.info(
    `[rankloop-writer] ${active.id} was wedged in ${active.status}: ${staleReason}`,
  );
  await fail({
    articleId: active.id,
    failure: { reason: "internal_error", detail: staleReason },
    report: null,
  });
  return true;
}

// ---------------------------------------------------------------------------
// Step 1: the frozen brief
// ---------------------------------------------------------------------------

/** The system actor a writer run bills through. A workflow has no acting
 *  user, and the brief is assembled with fetching off, so nothing here ever
 *  reaches a paid provider — but the type is honest about who is asking. */
function systemBillingCustomer(projectId: string, organizationId: string) {
  return {
    userId: "system",
    userEmail: "system@openseo.so",
    organizationId,
    projectId,
  };
}

/** The same actor for the metered half, or null when this deployment has no
 *  credit pool to draw on. Null is the whole self-host branch, expressed once
 *  so both call sites below read as "if there is somebody to bill". */
async function billingCustomerFor(context: {
  projectId: string;
  organizationId: string;
}) {
  if (!(await isHostedServerAuthMode())) return null;
  return systemBillingCustomer(context.projectId, context.organizationId);
}

/**
 * Refuse a draft a hosted organization cannot pay for, before anything is
 * claimed.
 *
 * Reads the project for its organization only in hosted mode: self-host has no
 * Autumn customer, and an unconditional read would add a query to every start
 * for an answer that is always the same.
 */
async function assertHostedCreditsAvailable(projectId: string): Promise<void> {
  if (!(await isHostedServerAuthMode())) return;
  const project = await ProjectRepository.getProjectById(projectId);
  if (!project) throw new AppError("NOT_FOUND", "Project not found.");
  const { depleted } = await checkUsageCreditsDepleted(
    systemBillingCustomer(projectId, project.organizationId),
  );
  if (depleted) throw new AppError("INSUFFICIENT_CREDITS");
}

/**
 * Assemble the brief and store it verbatim.
 *
 * `allowSerpFetch: false` is the free half of S7a: a writer run buys no SERP.
 * The user already saw what a fresh SERP costs in the brief drawer, and
 * spending it silently inside a workflow is exactly the surprise the "~"
 * price idiom exists to prevent.
 */
async function prepare(input: {
  articleId: string;
  projectId: string;
}): Promise<ArticleWriteContext> {
  const article = await ArticleRepository.getArticleById(
    input.projectId,
    input.articleId,
  );
  if (!article) throw new AppError("NOT_FOUND", "Article not found.");

  const project = await ProjectRepository.getProjectById(input.projectId);
  if (!project) throw new AppError("NOT_FOUND", "Project not found.");

  const brief = await BriefService.buildBrief({
    projectId: input.projectId,
    proposalId: article.proposalId,
    billingCustomer: systemBillingCustomer(
      input.projectId,
      project.organizationId,
    ),
    allowSerpFetch: false,
  });

  const [pageType, settings] = await Promise.all([
    article.pageTypeId
      ? PagePlanRepository.getPageTypeById(input.projectId, article.pageTypeId)
      : null,
    WriterSettingsRepository.getSettings(input.projectId),
  ]);

  const contract = parseTemplateContract(
    pageType?.templateContractJson ?? null,
  );
  const draftContract: DraftContract = {
    pageTypeName: pageType?.name ?? "Blog",
    contract,
    // One definition of the merged numbers, shared with the brief and with
    // the gate. A second `defaultLaws()` spread here is how the prompt and
    // the report start disagreeing about what 850 means.
    laws: mergeContractLaws(contract),
    voiceCardMd: settings?.voiceCardMd ?? null,
    keyword: article.keyword,
    today: new Date().toISOString().slice(0, 10),
  };

  await ArticleRepository.updateArticle(input.articleId, {
    briefMd: brief.markdown,
    status: "writing",
  });

  return {
    articleId: input.articleId,
    projectId: input.projectId,
    organizationId: project.organizationId,
    briefMd: brief.markdown,
    modelOverride: settings?.model ?? null,
    trustDial: settings?.trustDial ?? WRITER_SETTINGS_DEFAULTS.trustDial,
    contract: draftContract,
  };
}

// ---------------------------------------------------------------------------
// Step 2 and 4: one metered attempt
// ---------------------------------------------------------------------------

/**
 * One generation, its ledger row, and the article's running totals.
 *
 * The spend is written before the outcome is inspected, because a truncated
 * or unparseable response cost exactly as much as a good one. `costUsd` is
 * re-summed from the ledger rather than incremented, so a replayed step can
 * never inflate the total it reports to the user.
 *
 * Hosted, the same call also draws on the organization's credit pool, the way
 * DataForSEO and SAM already do — the model key is the platform's, so an
 * unmetered generation is the operator's bill, not the tenant's. The balance
 * is re-checked per attempt rather than once per article: attempts 2 and 3 are
 * two more charges, and a balance can reach zero between them. Self-hosted
 * deployments have no Autumn customer and bring their own key, so neither
 * branch runs for them; `llm_spend` is written either way, because it is what
 * the article's cost stamp reads.
 */
async function runAttempt(input: {
  context: ArticleWriteContext;
  attempt: number;
  repair: { previousMarkdown: string; payload: RepairPayload } | null;
}): Promise<DraftAttemptResult> {
  const operation: WriterOperation = input.repair ? "fix" : "draft";
  await ArticleRepository.updateArticle(input.context.articleId, {
    status: input.repair ? "fixing" : "writing",
    attempts: input.attempt,
  });

  const customer = await billingCustomerFor(input.context);
  let monthlyRemaining: number | null = null;
  if (customer) {
    const balance = await checkUsageCreditsDepleted(customer);
    // Returned as data, not thrown: this step has no retries, so a throw
    // would land the article as `internal_error` and erase the one thing the
    // person reading it needs to know.
    if (balance.depleted) {
      return {
        ok: false,
        failure: {
          reason: "insufficient_credits",
          detail:
            "This organization is out of credits, so the draft was not generated.",
        },
      };
    }
    monthlyRemaining = balance.monthlyRemaining;
  }

  const outcome = await runWriterCall({
    briefMd: input.context.briefMd,
    contract: input.context.contract,
    modelOverride: input.context.modelOverride,
    repair: input.repair,
  });

  if (outcome.spend) {
    await ArticleRepository.insertSpend({
      projectId: input.context.projectId,
      operation,
      model: outcome.spend.model,
      inputTokens: outcome.spend.inputTokens,
      outputTokens: outcome.spend.outputTokens,
      costUsd: outcome.spend.costUsd,
      articleId: input.context.articleId,
    });
    if (customer && monthlyRemaining !== null) {
      await trackUsageCreditSpend({
        customer,
        customerId: input.context.organizationId,
        creditFeature: "writer",
        costUsd: outcome.spend.costUsd,
        monthlyRemaining,
        properties: { provider: "openrouter" },
      });
    }
    await ArticleRepository.updateArticle(input.context.articleId, {
      model: outcome.spend.model,
      costUsd: await ArticleRepository.getSpendForArticle(
        input.context.articleId,
      ),
    });
  }

  if (!outcome.result.ok) return outcome.result;

  await ArticleRepository.updateArticle(input.context.articleId, {
    content: outcome.result.markdown,
    status: "gate",
  });
  return outcome.result;
}

// ---------------------------------------------------------------------------
// Step 5: land
// ---------------------------------------------------------------------------

async function land(input: {
  context: ArticleWriteContext;
  attempts: number;
}): Promise<{ status: "approved" | "review" }> {
  const status = landingStatus(input.context.trustDial);
  await ArticleRepository.updateArticle(input.context.articleId, {
    status,
    attempts: input.attempts,
  });
  return { status };
}

/**
 * The terminal failure.
 *
 * The proposal is left `approved` on purpose — declining it here would decide
 * on the user's behalf that a keyword the engine ranked is not worth writing,
 * when all that actually happened is that three generations missed a
 * measurable bar. The report stays whatever the gate last wrote, or becomes a
 * report whose only content is why no draft was ever gradeable.
 */
async function fail(input: {
  articleId: string;
  /** Omitted on a crash landing, where the count already on the row is the
   *  true one and writing a fresh number would erase it. */
  attempts?: number;
  failure: RankloopWriteFailure;
  /** The last graded report, when one exists. */
  report: RankloopLawReport | null;
}): Promise<void> {
  const report: RankloopLawReport = input.report
    ? { ...input.report, failure: input.failure }
    : failureReport(input.failure);
  await ArticleRepository.updateArticle(input.articleId, {
    status: "failed",
    ...(input.attempts === undefined ? {} : { attempts: input.attempts }),
    lawReportJson: JSON.stringify(report),
  });
}

/** A report for an article no law ever got to grade. Empty `laws` is the
 *  honest answer: nothing was checked, so nothing is claimed. */
function failureReport(failure: RankloopWriteFailure): RankloopLawReport {
  return {
    passed: false,
    checkedAt: new Date().toISOString(),
    laws: [],
    failure,
  };
}

export const ArticleWriteService = {
  startArticle,
  prepare,
  runAttempt,
  land,
  fail,
};
