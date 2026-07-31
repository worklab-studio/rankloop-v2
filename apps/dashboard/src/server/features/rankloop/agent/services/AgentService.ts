import { AgentRepository } from "@/server/features/rankloop/agent/repositories/AgentRepository";
import { ProposalsRepository } from "@/server/features/rankloop/proposals/repositories/ProposalsRepository";
import { ArticleGateService } from "@/server/features/rankloop/writing/services/ArticleGateService";
import { NetNewProposalsService } from "@/server/features/rankloop/writing/services/NetNewProposalsService";
import { WriterSettingsRepository } from "@/server/features/rankloop/writing/repositories/WriterSettingsRepository";
import { AppError } from "@/server/lib/errors";
import { WRITER_SETTINGS_DEFAULTS } from "@/shared/rankloop-writing";
import type { IndexationThrottle } from "@/server/features/rankloop/indexation/indexation.logic";
import type { LawReport } from "@/server/features/rankloop/writing/gate";

// The read half of the agent path (spec 0023): what the loop owes, what is
// approved and unwritten, and what the laws say about a draft.
//
// Every answer is assembled from the services the dashboard already reads —
// the quota is `getWritingQuota`, the grader is `ArticleGateService.gradeDraft`
// — because an agent and a browser looking at the same project must be looking
// at the same project. Nothing here calls a model; `checkDraft` in particular
// is the engine and only the engine, which is what makes it free to call in a
// loop until it passes.

// ---------------------------------------------------------------------------
// rankloop_status
// ---------------------------------------------------------------------------

type AgentStatus = {
  projectId: string;
  /** 'agent' when this project's Write button has been handed to an agent. */
  writerMode: "api" | "agent";
  quota: {
    /** Posts owed today; null when the quota is off. */
    owed: number | null;
    /** Net-new proposals already in flight. */
    outstanding: number;
    /** How many the next selection run may create. */
    slots: number;
    /** Why there is nothing to do. Null whenever `slots` is positive. */
    reason: string | null;
    /** Carried whenever indexation is capping the loop, including on a day it
     *  is not what binds — a smaller number with no stated cause is a bug
     *  report waiting to happen. */
    throttle: IndexationThrottle | null;
  };
  /** Approved page types contributing nothing, and why. */
  exclusions: {
    pageTypeId: string;
    pageTypeName: string;
    keywordCount: number;
    reason: string;
  }[];
  articles: Record<string, number>;
  proposals: Record<string, number>;
  /** USD this deployment's own writer has spent on this project, ever. Zero
   *  in agent mode: the ledger records calls made from here, and an agent
   *  writing in its own repo makes none. */
  spendToDateUsd: number;
};

async function getStatus(projectId: string): Promise<AgentStatus> {
  const [quota, settings, articles, proposals, spendToDateUsd] =
    await Promise.all([
      NetNewProposalsService.getWritingQuota(projectId),
      WriterSettingsRepository.getSettings(projectId),
      AgentRepository.getArticleStatusCounts(projectId),
      AgentRepository.getProposalStatusCounts(projectId),
      AgentRepository.getSpendToDate(projectId),
    ]);

  return {
    projectId,
    writerMode: settings?.writerMode ?? WRITER_SETTINGS_DEFAULTS.writerMode,
    quota: {
      owed: quota.owed,
      outstanding: quota.outstanding,
      slots: quota.slots,
      reason: quota.reason,
      throttle: quota.throttle,
    },
    exclusions: quota.exclusions,
    articles,
    proposals,
    spendToDateUsd,
  };
}

// ---------------------------------------------------------------------------
// rankloop_proposals
// ---------------------------------------------------------------------------

type AgentProposal = {
  proposalId: string;
  keyword: string;
  workingTitle: string;
  score: number;
  pageTypeId: string | null;
  pageTypeName: string | null;
  urlPattern: string | null;
  /** The one-line chips the queue explains itself with. */
  evidence: string[];
  createdAt: string;
  expiresAt: string | null;
  /** Non-null when something is already written against this proposal — an
   *  agent that cannot see an in-flight draft writes a second one. */
  article: { id: string; status: string; writerMode: string } | null;
};

/** Stored as JSON because a proposal's evidence is a list of sentences, not a
 *  relation. A row an older shape wrote degrades to no chips rather than
 *  failing the whole queue an agent is trying to pull. */
function parseEvidence(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

async function listProposals(projectId: string): Promise<AgentProposal[]> {
  const rows = await AgentRepository.getApprovedNetNewProposals(projectId);
  return rows.map((row) => ({
    proposalId: row.id,
    keyword: row.target,
    workingTitle: row.title ?? row.target,
    score: row.score,
    pageTypeId: row.pageTypeId,
    pageTypeName: row.pageTypeName,
    urlPattern: row.pageTypeUrlPattern,
    evidence: parseEvidence(row.evidenceJson),
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    article:
      row.articleId && row.articleStatus
        ? {
            id: row.articleId,
            status: row.articleStatus,
            writerMode: row.articleWriterMode ?? "api",
          }
        : null,
  }));
}

// ---------------------------------------------------------------------------
// rankloop_check
// ---------------------------------------------------------------------------

type AgentCheckResult = {
  proposalId: string;
  keyword: string;
  /** The slug the site would serve this draft at, derived from its own
   *  frontmatter title exactly as a publish would derive it. */
  slug: string;
  report: LawReport;
};

/**
 * Grade a submitted draft. No write, no model, no charge.
 *
 * The page type comes from the proposal rather than from the caller, so an
 * agent cannot ask to be graded against an easier contract than the brief it
 * was given — and so the report it iterates against is the report publishing
 * will re-run.
 *
 * `checkedAt` is injected by the caller for the same reason `runGate` takes
 * one: two callers grading the same bytes must be able to prove they agree,
 * and a clock read inside would be the one field that could never match.
 */
async function checkDraft(input: {
  projectId: string;
  proposalId: string;
  draft: string;
  checkedAt: string;
}): Promise<AgentCheckResult> {
  const proposal = await ProposalsRepository.getProposalById(
    input.projectId,
    input.proposalId,
  );
  if (!proposal) throw new AppError("NOT_FOUND", "Proposal not found.");
  if (proposal.track !== "net_new" || proposal.type !== "write_new") {
    throw new AppError(
      "VALIDATION_ERROR",
      "Only net-new proposals are graded against the publish laws.",
    );
  }

  const { slug, report } = await ArticleGateService.gradeDraft({
    projectId: input.projectId,
    pageTypeId: proposal.pageTypeId,
    keyword: proposal.target,
    markdown: input.draft,
    checkedAt: input.checkedAt,
  });

  return {
    proposalId: proposal.id,
    keyword: proposal.target,
    slug,
    report,
  };
}

export const AgentService = {
  getStatus,
  listProposals,
  checkDraft,
};
