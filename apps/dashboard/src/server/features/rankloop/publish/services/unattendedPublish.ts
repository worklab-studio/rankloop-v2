import { ProposalsRepository } from "@/server/features/rankloop/proposals/repositories/ProposalsRepository";
import { AutopilotService } from "@/server/features/rankloop/routines/services/AutopilotService";
import type { TrustDial } from "@/shared/rankloop-writer";

// Who is allowed to publish this article, and from which status — the whole
// trust-dial decision, in one place, so preflight reads as the sequence of
// checks it is. Nothing here writes and nothing here touches an adapter.

/**
 * The status this run may claim the article from, or null when the trust dial
 * forbids publishing it at all.
 *
 * `autopilot` is the only setting that lets an article publish without a human
 * having opened it, which is exactly what the user chose when they moved the
 * dial there. Everything else means someone approved this draft, and `review`
 * is not that. Returning the status rather than a boolean is what lets the
 * claim compare-and-set against the same value this decision was made on — a
 * separate re-read could be a different row.
 */
function claimableStatus(
  trustDial: TrustDial,
  status: string,
): "approved" | "review" | null {
  if (status === "approved") return "approved";
  if (status === "review" && trustDial === "autopilot") return "review";
  return null;
}

/**
 * Why this article may not publish unattended today, or null when it may.
 *
 * The dial says the machine is allowed to publish; the receipts say whether it
 * is allowed to publish THIS, per action type, over the 90-day settled cohort
 * (spec 0024 §3). Anything short of `autopilot` behavior falls back to the
 * refusal a `drafts` project gets, carrying the eligibility clause as its
 * reason so the article's own screen states the number rather than the word
 * "blocked".
 *
 * It is also what keeps merge and prune attended: `getActionBehavior` never
 * answers `autopilot` for them, whatever their receipts say.
 */
async function unattendedBlockedReason(input: {
  projectId: string;
  proposalId: string;
  now: Date;
}): Promise<string | null> {
  const proposal = await ProposalsRepository.getProposalById(
    input.projectId,
    input.proposalId,
  );
  const earned = await AutopilotService.getActionBehavior({
    projectId: input.projectId,
    // A missing proposal row is not a reason to publish unattended: the
    // service answers `drafts` for a type it has never heard of, which is the
    // refusal this wants.
    actionType: proposal?.type ?? "",
    now: input.now,
  });
  if (earned.behavior === "autopilot") return null;
  return `Autopilot has not earned this action yet — ${earned.fallbackReason ?? "it is not eligible"}. Approve this draft to publish it.`;
}

type PublishClaim =
  | { ok: true; claimFrom: "approved" | "review" }
  | { ok: false; detail: string };

/**
 * The dial decision for one article: may this publish, and from where.
 *
 * The eligibility read only happens on the unattended path (`review`), which
 * is the only one nobody looked at. An `approved` article is a human saying
 * yes, and re-litigating that against a receipt cohort would be the product
 * overruling its own user.
 */
export async function resolvePublishClaim(input: {
  projectId: string;
  proposalId: string;
  trustDial: TrustDial;
  status: string;
  now: Date;
}): Promise<PublishClaim> {
  const claimFrom = claimableStatus(input.trustDial, input.status);
  if (claimFrom === null) {
    return {
      ok: false,
      detail:
        input.trustDial === "autopilot"
          ? `This article is ${input.status}; only a finished draft can publish.`
          : "Approve this draft before publishing it.",
    };
  }
  if (claimFrom === "approved") return { ok: true, claimFrom };

  const notEarned = await unattendedBlockedReason({
    projectId: input.projectId,
    proposalId: input.proposalId,
    now: input.now,
  });
  return notEarned === null
    ? { ok: true, claimFrom }
    : { ok: false, detail: notEarned };
}
