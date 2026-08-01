import { createServerFn } from "@tanstack/react-start";
import { waitUntil } from "cloudflare:workers";
import { ProposalsService } from "@/server/features/rankloop/proposals/services/ProposalsService";
import { captureServerEvent } from "@/server/lib/posthog";
import { requireProjectContext } from "@/serverFunctions/middleware";
import {
  decideRankloopProposalSchema,
  getRankloopProposalsSchema,
  refreshRankloopProposalsSchema,
} from "@/types/schemas/rankloopProposals";

export const getRankloopProposals = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(getRankloopProposalsSchema)
  .handler(async ({ context, data }) => {
    return ProposalsService.getProposals(context.projectId, data.status);
  });

export const decideRankloopProposal = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(decideRankloopProposalSchema)
  .handler(async ({ context, data }) => {
    const decided = await ProposalsService.decideProposal({
      projectId: context.projectId,
      proposalId: data.proposalId,
      decision: data.decision,
      // A signed-in person clicked the button. The only other value comes
      // from the routine, which never arrives through a server function.
      decidedBy: "human",
    });
    waitUntil(
      captureServerEvent({
        distinctId: context.userId,
        event: "rankloop_proposals:proposal_decide",
        organizationId: context.organizationId,
        properties: {
          project_id: context.projectId,
          proposal_id: decided.id,
          proposal_type: decided.type,
          decision: data.decision,
        },
      }),
    );
    return decided;
  });

// The manual trigger; the routine path is the compute step that rides every
// successful GscSyncWorkflow run. Both funnel into the same idempotent
// computeProposals, so mashing this button can't duplicate the queue.
export const refreshRankloopProposals = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(refreshRankloopProposalsSchema)
  .handler(async ({ context }) => {
    const result = await ProposalsService.computeProposals(context.projectId);
    waitUntil(
      captureServerEvent({
        distinctId: context.userId,
        event: "rankloop_proposals:refresh",
        organizationId: context.organizationId,
        properties: {
          project_id: context.projectId,
          created: result.created,
          expired: result.expired,
        },
      }),
    );
    return result;
  });
