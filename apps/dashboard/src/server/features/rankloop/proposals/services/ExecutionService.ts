// The execution half of the proposals feature (spec 0013): approved retitle
// and push proposals leave the queue through here — either through the
// WordPress adapter or a manual attestation — and every departure opens a
// receipt. Split from ProposalsService the same way the repositories split:
// signal computation and execution share the proposals table and nothing
// else.

import {
  computeInlinkCandidates,
  headlineQuery,
  slugFromPath,
} from "@/server/features/rankloop/proposals/execution.logic";
import { ExecutionRepository } from "@/server/features/rankloop/proposals/repositories/ExecutionRepository";
import { ProposalsRepository } from "@/server/features/rankloop/proposals/repositories/ProposalsRepository";
import { PublishConnectionService } from "@/server/features/rankloop/publish/services/PublishConnectionService";
import { WordPressClient } from "@/server/features/rankloop/publish/services/wordpressClient";
import { ReceiptsService } from "@/server/features/rankloop/receipts/services/ReceiptsService";
import { AppError } from "@/server/lib/errors";
import type { RankloopProposal } from "@/types/schemas/rankloopProposals";

/** Load + gate: execution and attestation are valid only from 'approved',
 *  and only for the proposal type the calling flow serves. */
async function getApprovedProposal(
  projectId: string,
  proposalId: string,
  type: "retitle" | "push",
) {
  const proposal = await ProposalsRepository.getProposalById(
    projectId,
    proposalId,
  );
  if (!proposal) {
    throw new AppError("NOT_FOUND", "Proposal not found.");
  }
  if (proposal.type !== type) {
    throw new AppError(
      "VALIDATION_ERROR",
      `This flow executes ${type} proposals only.`,
    );
  }
  if (proposal.status !== "approved") {
    throw new AppError(
      "CONFLICT",
      `This proposal is ${proposal.status}, not approved.`,
    );
  }
  return proposal;
}

/** The optimize signals always pin their content page; a row without one
 *  can't be executed or measured, so it is a data bug worth failing on. */
function requireContentPageId(
  proposal: Pick<RankloopProposal, "contentPageId">,
): string {
  if (!proposal.contentPageId) {
    throw new AppError(
      "VALIDATION_ERROR",
      "This proposal has no content page to act on.",
    );
  }
  return proposal.contentPageId;
}

/**
 * Apply an approved retitle through the WordPress adapter. The adapter write
 * happens before any row changes: if WordPress rejects it the proposal stays
 * 'approved' and the user retries — there is nothing to roll back. On
 * success, ONE atomic write set flips the proposal to done, updates the
 * manifest title, and opens the receipt.
 */
async function executeRetitleProposal(input: {
  projectId: string;
  proposalId: string;
  newTitle: string;
  newMetaDescription?: string;
}) {
  const proposal = await getApprovedProposal(
    input.projectId,
    input.proposalId,
    "retitle",
  );
  const contentPageId = requireContentPageId(proposal);
  const page = await ExecutionRepository.getContentPageById(
    input.projectId,
    contentPageId,
  );
  if (!page) {
    throw new AppError(
      "NOT_FOUND",
      "The target page is no longer in the site manifest.",
    );
  }
  const config = await PublishConnectionService.getDecryptedConfig(
    input.projectId,
  );
  if (!config) {
    throw new AppError(
      "PUBLISH_NOT_CONNECTED",
      "Connect WordPress before applying retitles from here.",
    );
  }
  const slug = slugFromPath(page.path);
  const post = slug ? await WordPressClient.findPostBySlug(config, slug) : null;
  if (!post) {
    throw new AppError(
      "NOT_FOUND",
      "No WordPress post matches this page's slug.",
    );
  }
  const updateResult = await WordPressClient.updatePost(config, {
    postId: post.id,
    title: input.newTitle,
    metaDescription: input.newMetaDescription,
    metaDescriptionField: post.metaDescriptionField,
  });
  const executedAt = new Date().toISOString();
  const receipt = await ReceiptsService.openReceipt({
    projectId: input.projectId,
    actionType: proposal.type,
    contentPageId: page.id,
    targetQuery: headlineQuery(proposal.title),
    executedAt,
  });
  await ExecutionRepository.markDoneWithReceipt({
    projectId: input.projectId,
    proposalId: proposal.id,
    executedAt,
    receipt,
    retitle: { contentPageId: page.id, title: input.newTitle },
  });
  return {
    id: proposal.id,
    target: proposal.target,
    metaDescriptionApplied: updateResult.metaDescriptionApplied,
  };
}

/** Shared by both "Mark done" paths: the user made the change by hand, the
 *  system records it and opens the receipt — the same transition as an
 *  adapter execution, minus the adapter. */
async function attestProposalDone(input: {
  projectId: string;
  proposalId: string;
  type: "retitle" | "push";
}) {
  const proposal = await getApprovedProposal(
    input.projectId,
    input.proposalId,
    input.type,
  );
  const executedAt = new Date().toISOString();
  const receipt = await ReceiptsService.openReceipt({
    projectId: input.projectId,
    actionType: proposal.type,
    contentPageId: requireContentPageId(proposal),
    targetQuery: headlineQuery(proposal.title),
    executedAt,
  });
  await ExecutionRepository.markDoneWithReceipt({
    projectId: input.projectId,
    proposalId: proposal.id,
    executedAt,
    receipt,
  });
  return { id: proposal.id, type: proposal.type, target: proposal.target };
}

async function attestPushProposal(input: {
  projectId: string;
  proposalId: string;
}) {
  return attestProposalDone({ ...input, type: "push" });
}

/** The manual retitle path ("Mark done (applied manually)"). The manifest
 *  title is deliberately NOT updated here: we don't know what the user
 *  typed into their site, and the next site study crawl reads the truth off
 *  the live page. */
async function attestRetitleProposal(input: {
  projectId: string;
  proposalId: string;
}) {
  return attestProposalDone({ ...input, type: "retitle" });
}

/** The push detail's inlink guidance: top source candidates plus the anchor
 *  text (the winning query) to link them with. */
async function getPushGuidance(input: {
  projectId: string;
  proposalId: string;
}) {
  const proposal = await ProposalsRepository.getProposalById(
    input.projectId,
    input.proposalId,
  );
  if (!proposal) {
    throw new AppError("NOT_FOUND", "Proposal not found.");
  }
  if (proposal.type !== "push") {
    throw new AppError(
      "VALIDATION_ERROR",
      "Inlink guidance only exists for push proposals.",
    );
  }
  const target = proposal.contentPageId
    ? await ExecutionRepository.getContentPageById(
        input.projectId,
        proposal.contentPageId,
      )
    : null;
  if (!target) {
    return { anchorQuery: headlineQuery(proposal.title), candidates: [] };
  }
  const pages = await ExecutionRepository.getInlinkSourcePages(input.projectId);
  return {
    anchorQuery: headlineQuery(proposal.title),
    candidates: computeInlinkCandidates({
      target: { path: target.path, category: target.category },
      pages,
    }),
  };
}

/** What the Apply modal opens with. The stored manifest title is the
 *  fallback; when a connection exists the live WordPress title wins, because
 *  the manifest can be a crawl behind reality and editing against a stale
 *  title looks broken. Adapter failures fall back silently — the modal must
 *  open either way. */
async function getRetitleContext(input: {
  projectId: string;
  proposalId: string;
}) {
  const proposal = await ProposalsRepository.getProposalById(
    input.projectId,
    input.proposalId,
  );
  if (!proposal) {
    throw new AppError("NOT_FOUND", "Proposal not found.");
  }
  if (proposal.type !== "retitle") {
    throw new AppError(
      "VALIDATION_ERROR",
      "Only retitle proposals have an editor context.",
    );
  }
  const page = proposal.contentPageId
    ? await ExecutionRepository.getContentPageById(
        input.projectId,
        proposal.contentPageId,
      )
    : null;
  const config = await PublishConnectionService.getDecryptedConfig(
    input.projectId,
  );
  let currentTitle = page?.title ?? null;
  let currentDescription = page?.description ?? null;
  let source: "manifest" | "wordpress" = "manifest";
  const slug = page ? slugFromPath(page.path) : null;
  if (config && slug) {
    try {
      const post = await WordPressClient.findPostBySlug(config, slug);
      if (post) {
        currentTitle = post.title;
        currentDescription = post.metaDescription ?? currentDescription;
        source = "wordpress";
      }
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
    }
  }
  return {
    path: proposal.target,
    currentTitle,
    currentDescription,
    source,
    connected: config !== null,
  };
}

export const ExecutionService = {
  executeRetitleProposal,
  attestPushProposal,
  attestRetitleProposal,
  getPushGuidance,
  getRetitleContext,
};
